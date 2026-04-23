import io
import json
import re
import urllib3
import zipfile
from datetime import datetime, timezone

import requests
from flask import Flask, redirect, render_template, request, send_file, session, url_for

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)
app.secret_key = 'bw-exporter-change-in-production'

ECLIPSE_USER_AGENT = (
    'Eclipse/4.38.0.v20251201-0920 (win32; x86_64; Java 21.0.9) ADT/3.56.0 (devedition)'
)

MEDIA_TYPES = {
    'adso': 'application/vnd.sap.bw.modeling.adso-v1_7_0+xml',
    'iobj': 'application/vnd.sap-bw-modeling.iobj-v2_2_0+xml',
    'trfn': 'application/vnd.sap.bw.modeling.trfn-v1_0_0+xml',
    'dtpa': 'application/vnd.sap.bw.modeling.dtpa-v1_0_0+xml',
    'area': 'application/vnd.sap.bw.modeling.area-v1_1_0+xml',
    'trcs': 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml',
}

IOBJ_ACCEPT = ', '.join([
    f'application/vnd.sap-bw-modeling.iobj-v{major}_{minor}_0+xml'
    for major, minor in [
        (1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (1, 7),
        (1, 8), (1, 9), (2, 0), (2, 1), (2, 2), (2, 3), (2, 4),
    ]
])

QUERY_ACCEPT = ', '.join([
    f'application/vnd.sap.bw.modeling.query-v1_{v}_0+xml'
    for v in [8, 9, 10, 11]
])

OBJECT_TYPES = ['ADSO', 'IOBJ', 'AREA', 'TRCS', 'TRFN', 'DTPA', 'QERY']


class BwClient:
    def __init__(self, url, user, password, client, language=None):
        self.base_url = url.rstrip('/')
        self._basic = (user, password)
        self._sess = requests.Session()
        self._sess.verify = False
        self._sess.headers.update({
            'sap-client': client,
            'X-sap-adt-sessiontype': 'stateful',
            'User-Agent': ECLIPSE_USER_AGENT,
        })
        if language:
            self._sess.headers['sap-language'] = language
        self._csrf = None

    def connect(self):
        """Fetch CSRF token to validate credentials and establish session."""
        r = self._sess.get(
            self.base_url + '/sap/bw/modeling/repo/is/systeminfo',
            headers={'X-CSRF-Token': 'Fetch', 'Accept': 'application/xml'},
            auth=self._basic,
        )
        token = r.headers.get('x-csrf-token') or r.headers.get('X-CSRF-Token', '')
        if not token or token.lower() == 'fetch':
            raise RuntimeError(
                f'Verbindung fehlgeschlagen (HTTP {r.status_code}). '
                'Bitte URL, Benutzer, Passwort und Mandant prüfen.'
            )
        self._csrf = token

    def _ensure_csrf(self):
        if not self._csrf:
            self.connect()

    def _get_raw(self, path, accept):
        self._ensure_csrf()
        r = self._sess.get(
            self.base_url + path,
            headers={
                'Accept': accept,
                'bwmt-level': '50',
                'X-CSRF-Token': self._csrf,
            },
        )
        if r.status_code >= 400:
            raise RuntimeError(f'GET {path} → HTTP {r.status_code}\n{r.text[:500]}')
        return r.text

    def search(self, search_term, object_type=None):
        self._ensure_csrf()
        from_dt = '1970-01-01T00%3A00%3A00Z'
        to_dt = '2099-12-31T23%3A59%3A59Z'
        obj_type_param = object_type.upper() if object_type else ''
        path = (
            '/sap/bw/modeling/repo/is/bwsearch'
            f'?searchTerm={requests.utils.quote(search_term)}'
            '&searchInName=true&searchInDescription=true'
            f'&objectType={obj_type_param}'
            f'&createdOnFrom={from_dt}&createdOnTo={to_dt}'
            f'&changedOnFrom={from_dt}&changedOnTo={to_dt}'
        )
        r = self._sess.get(
            self.base_url + path,
            headers={
                'Accept': 'application/atom+xml;type=feed',
                'bwmt-level': '50',
                'X-CSRF-Token': self._csrf,
            },
        )
        if r.status_code >= 400:
            raise RuntimeError(f'Suche fehlgeschlagen: HTTP {r.status_code}\n{r.text[:500]}')
        return _parse_atom_entries(r.text)

    def get_object(self, obj_type, obj_name):
        t = obj_type.lower()
        n = obj_name.lower()
        if t == 'area':
            # InfoArea has no /m version path
            accept = f'application/xml, {MEDIA_TYPES["area"]}'
            return self._get_raw(f'/sap/bw/modeling/area/{n}', accept)
        elif t == 'qery':
            # Queries: try active version first, fall back to inactive
            try:
                return self._get_raw(f'/sap/bw/modeling/query/{n}/a', QUERY_ACCEPT)
            except RuntimeError:
                return self._get_raw(f'/sap/bw/modeling/query/{n}/m', QUERY_ACCEPT)
        elif t == 'iobj':
            return self._get_raw(f'/sap/bw/modeling/iobj/{n}/m', IOBJ_ACCEPT)
        else:
            accept = f'application/xml, {MEDIA_TYPES.get(t, "application/xml")}'
            return self._get_raw(f'/sap/bw/modeling/{t}/{n}/m', accept)


def _parse_atom_entries(xml_text):
    results = []
    for m in re.finditer(r'<atom:entry>([\s\S]*?)</atom:entry>', xml_text):
        body = m.group(1)
        name_m = re.search(r'objectName="([^"]+)"', body)
        type_m = re.search(r'objectType="([^"]+)"', body)
        status_m = re.search(r'objectStatus="([^"]+)"', body)
        title_m = re.search(r'<atom:title>([^<]+)</atom:title>', body)
        if name_m and type_m:
            results.append({
                'name': name_m.group(1),
                'type': type_m.group(1),
                'status': status_m.group(1) if status_m else 'unknown',
                'description': title_m.group(1) if title_m else '',
            })
    return results


def _parse_metadata(obj_type, xml_text):
    """Extract structured metadata from object XML using attribute regex."""
    t = obj_type.upper()
    meta = {}

    def grab(attr):
        m = re.search(rf'\b{re.escape(attr)}="([^"]*)"', xml_text)
        return m.group(1) if m else None

    if t == 'ADSO':
        for attr in ['activateData', 'directUpdate', 'isReportingObject',
                     'writeChangelog', 'pushMode', 'objectStatus', 'infoArea']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v
        fields = []
        for fm in re.finditer(r'<[^/][^>]*\belement\b[^>]*>', xml_text):
            tag = fm.group(0)
            fn = re.search(r'\bname="([^"]+)"', tag)
            dt = re.search(r'\bdatatype="([^"]+)"', tag)
            ln = re.search(r'\blength="([^"]+)"', tag)
            if fn:
                fields.append({
                    'name': fn.group(1),
                    'datatype': dt.group(1) if dt else '',
                    'length': ln.group(1) if ln else '',
                })
        if fields:
            meta['fields'] = fields

    elif t == 'IOBJ':
        for attr in ['infoObjectType', 'dataType', 'length',
                     'conversionRoutine', 'objectStatus']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v

    elif t == 'AREA':
        for attr in ['parentInfoArea', 'objectStatus']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v

    elif t == 'TRCS':
        for attr in ['aggregation', 'objectStatus', 'infoArea']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v

    elif t == 'TRFN':
        for attr in ['sourceType', 'sourceName', 'targetType', 'targetName', 'objectStatus']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v

    elif t == 'DTPA':
        for attr in ['sourceType', 'sourceName', 'targetType', 'targetName',
                     'extractionMode', 'objectStatus']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v

    elif t == 'QERY':
        for attr in ['queryName', 'infoProvider', 'objectStatus']:
            v = grab(attr)
            if v is not None:
                meta[attr] = v

    return meta


def _make_client():
    creds = session.get('bw_creds')
    if not creds:
        return None
    return BwClient(
        creds['url'], creds['user'], creds['password'],
        creds['client'], creds.get('language'),
    )


@app.route('/')
def index():
    connected = 'bw_creds' in session
    return render_template(
        'index.html',
        connected=connected,
        creds=session.get('bw_creds', {}),
        object_types=OBJECT_TYPES,
        results=None,
        error=None,
        search_term='',
        search_type='',
    )


@app.route('/connect', methods=['POST'])
def connect():
    url = request.form.get('url', '').strip().rstrip('/')
    user = request.form.get('user', '').strip()
    password = request.form.get('password', '')
    client = request.form.get('client', '001').strip()
    language = request.form.get('language', '').strip() or None

    try:
        bw = BwClient(url, user, password, client, language)
        bw.connect()
    except Exception as e:
        return render_template(
            'index.html',
            connected=False,
            creds={},
            object_types=OBJECT_TYPES,
            results=None,
            error=str(e),
            search_term='',
            search_type='',
        )

    session['bw_creds'] = {
        'url': url,
        'user': user,
        'password': password,
        'client': client,
        'language': language,
    }
    return redirect(url_for('index'))


@app.route('/disconnect')
def disconnect():
    session.pop('bw_creds', None)
    return redirect(url_for('index'))


@app.route('/search')
def search():
    if 'bw_creds' not in session:
        return redirect(url_for('index'))

    term = request.args.get('q', '').strip()
    obj_type = request.args.get('type', '').strip() or None

    if not term:
        return render_template(
            'index.html',
            connected=True,
            creds=session['bw_creds'],
            object_types=OBJECT_TYPES,
            results=[],
            error=None,
            search_term=term,
            search_type=obj_type or '',
        )

    try:
        bw = _make_client()
        results = bw.search(term, obj_type)
    except Exception as e:
        return render_template(
            'index.html',
            connected=True,
            creds=session['bw_creds'],
            object_types=OBJECT_TYPES,
            results=None,
            error=str(e),
            search_term=term,
            search_type=obj_type or '',
        )

    return render_template(
        'index.html',
        connected=True,
        creds=session['bw_creds'],
        object_types=OBJECT_TYPES,
        results=results,
        error=None,
        search_term=term,
        search_type=obj_type or '',
    )


@app.route('/export', methods=['POST'])
def export():
    if 'bw_creds' not in session:
        return redirect(url_for('index'))

    selected = request.form.getlist('selected')
    fmt = request.form.get('format', 'json')

    if not selected:
        return render_template(
            'index.html',
            connected=True,
            creds=session['bw_creds'],
            object_types=OBJECT_TYPES,
            results=None,
            error='Keine Objekte ausgewählt.',
            search_term='',
            search_type='',
        )

    bw = _make_client()
    objects = []
    for item in selected:
        if ':' not in item:
            continue
        obj_type, obj_name = item.split(':', 1)
        try:
            xml_text = bw.get_object(obj_type, obj_name)
            objects.append({
                'type': obj_type,
                'name': obj_name,
                'metadata': _parse_metadata(obj_type, xml_text),
                'raw_xml': xml_text,
            })
        except Exception as e:
            objects.append({
                'type': obj_type,
                'name': obj_name,
                'error': str(e),
            })

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')

    if fmt == 'xml':
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for obj in objects:
                if 'raw_xml' in obj:
                    zf.writestr(f"{obj['type']}_{obj['name']}.xml", obj['raw_xml'])
        buf.seek(0)
        return send_file(
            buf,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'bw_export_{timestamp}.zip',
        )

    payload = {
        'export_timestamp': datetime.now(timezone.utc).isoformat(),
        'bw_url': session['bw_creds']['url'],
        'objects': objects,
    }
    buf = io.BytesIO(json.dumps(payload, indent=2, ensure_ascii=False).encode('utf-8'))
    buf.seek(0)
    return send_file(
        buf,
        mimetype='application/json',
        as_attachment=True,
        download_name=f'bw_export_{timestamp}.json',
    )


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
