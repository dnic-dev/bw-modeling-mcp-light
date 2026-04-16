import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';
import { randomUUID } from 'crypto';

const ECLIPSE_USER_AGENT =
  'Eclipse/4.38.0.v20251201-0920 (win32; x86_64; Java 21.0.9) ADT/3.56.0 (devedition)';

// Media types for each BW object type (from BW/4HANA discovery)
// These hardcoded values serve as fallback defaults; loadMediaTypes() overwrites them at runtime.
export const MEDIA_TYPES: Record<string, string> = {
  adso: 'application/vnd.sap.bw.modeling.adso-v1_7_0+xml',
  iobj: 'application/vnd.sap-bw-modeling.iobj-v2_2_0+xml',
  trfn: 'application/vnd.sap.bw.modeling.trfn-v1_0_0+xml',
  dtpa: 'application/vnd.sap.bw.modeling.dtpa-v1_0_0+xml',
  area: 'application/vnd.sap.bw.modeling.area-v1_1_0+xml',
  trcs: 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml',
};

// DTPs do not need an unlock request after activation
const NO_UNLOCK_TYPES = new Set(['dtpa']);

function resolveMediaType(type: string): string {
  const mt = MEDIA_TYPES[type.toLowerCase()];
  if (!mt) {
    throw new Error(`Object type '${type}' is not supported on this system (not found in Discovery)`);
  }
  return mt;
}

export interface GetResult {
  body: string;
  headers: Record<string, string>;
}

export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private cookies: Map<string, string> = new Map();
  // Basic Auth is only sent during the initial CSRF fetch to establish the session.
  // All subsequent requests use the session cookie only — sending Basic Auth on PUT
  // causes SAP to create a new stateless session, invalidating the lock handle.
  private readonly basicAuth: string;

  constructor(url: string, user: string, password: string, client: string, language?: string) {
    this.basicAuth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.http = axios.create({
      baseURL: url,
      headers: {
        'sap-client': client,
        'X-sap-adt-sessiontype': 'stateful',
        ...(language ? { 'sap-language': language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      // Accept all HTTP status codes — we check them manually
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];

  }

  // ── Session info (debug) ──────────────────────────────────────────────────

  /** Returns a snapshot of the current session cookies — for debug assertions only. */
  public sessionInfo(): Record<string, string> {
    return Object.fromEntries(this.cookies.entries());
  }

  // ── Cookie management ──────────────────────────────────────────────────────

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private updateCookies(response: AxiosResponse): void {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    for (const c of setCookies) {
      const part = c.split(';')[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        this.cookies.set(
          part.substring(0, eqIdx).trim(),
          part.substring(eqIdx + 1).trim()
        );
      }
    }
  }

  // ── CSRF token ─────────────────────────────────────────────────────────────

  private async fetchCsrfToken(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/repo/is/systeminfo', {
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/xml',
        Authorization: this.basicAuth,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      throw new Error(
        `Failed to fetch CSRF token (HTTP ${response.status}). Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT.`
      );
    }
    this.csrfToken = token;
  }

  private async ensureCsrf(): Promise<void> {
    if (!this.csrfToken) {
      await this.fetchCsrfToken();
    }
  }

  private cookieHeaders(): Record<string, string> {
    const hdr = this.cookieHeader();
    return hdr ? { Cookie: hdr } : {};
  }

  // ── Public HTTP helpers ────────────────────────────────────────────────────

  async get(path: string, accept: string): Promise<GetResult> {
    await this.ensureCsrf();
    const IOBJ_ACCEPT_ALL = 'application/vnd.sap-bw-modeling.iobj-v1_0_0+xml, application/vnd.sap-bw-modeling.iobj-v1_1_0+xml, application/vnd.sap-bw-modeling.iobj-v1_2_0+xml, application/vnd.sap-bw-modeling.iobj-v1_3_0+xml, application/vnd.sap-bw-modeling.iobj-v1_4_0+xml, application/vnd.sap-bw-modeling.iobj-v1_5_0+xml, application/vnd.sap-bw-modeling.iobj-v1_6_0+xml, application/vnd.sap-bw-modeling.iobj-v1_7_0+xml, application/vnd.sap-bw-modeling.iobj-v1_8_0+xml, application/vnd.sap-bw-modeling.iobj-v1_9_0+xml, application/vnd.sap-bw-modeling.iobj-v2_0_0+xml, application/vnd.sap-bw-modeling.iobj-v2_1_0+xml, application/vnd.sap-bw-modeling.iobj-v2_2_0+xml, application/vnd.sap-bw-modeling.iobj-v2_3_0+xml, application/vnd.sap-bw-modeling.iobj-v2_4_0+xml';
    const resolvedAccept = accept.includes('iobj') ? IOBJ_ACCEPT_ALL : `application/xml, ${accept}`;
    const response = await this.http.get(path, {
      headers: {
        Accept: resolvedAccept,
        'bwmt-level': '50',
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Lock a BW object.
   * Returns the lockHandle string from the response body.
   * Pattern: POST /sap/bw/modeling/{type}/{name}?action=lock
   *
   * extraHeaders: optional additional headers, e.g. for creation mode:
   *   { 'activity_context': 'CREA', 'parent_name': 'MYAREA', 'parent_type': 'AREA' }
   */
  async lock(type: string, name: string, extraHeaders?: Record<string, string>, sessionType?: string, cleanHeaders?: boolean): Promise<string> {
    await this.ensureCsrf();
    const accept = type.toLowerCase() === 'area'
      ? 'application/vnd.sap.bw.modeling.area-v1_0_0+xml, application/vnd.sap.bw.modeling.area-v1_1_0+xml'
      : resolveMediaType(type);
    const headers: Record<string, any> = cleanHeaders
      ? {
          Accept: accept,
          'User-Agent': ECLIPSE_USER_AGENT,
          'X-sap-adt-profiling': 'server-time',
          'sap-adt-request-id': randomUUID(),
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
          ...extraHeaders,
          'Content-Type': undefined,
          'bwmt-level': undefined,
          'X-sap-adt-sessiontype': undefined,
          'sap-client': undefined,
          'sap-language': undefined,
        }
      : {
          Accept: accept,
          'bwmt-level': '50',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
          ...extraHeaders,
        };
    const response = await this.http.post(
      `/sap/bw/modeling/${type.toLowerCase()}/${name.toLowerCase()}?action=lock`,
      '',
      {
        headers,
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Lock ${type}/${name} → HTTP ${response.status}\n${response.data}`);
    }
    const body = response.data as string;
    // lockHandle is in <LOCK_HANDLE>...</LOCK_HANDLE> in the response body
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in lock response body:\n${body}`);
    }
    return match[1];
  }

  /**
   * Create a new BW object (POST, no /m in the URL).
   * Pattern: POST /sap/bw/modeling/{type}/{name}?lockHandle={handle}
   * Used for object creation from template; the lock must have been obtained
   * with activity_context=CREA headers.
   *
   * extraHeaders: e.g. { 'Development-Class': '$TMP' }
   */
  async create(
    type: string,
    name: string,
    lockHandle: string,
    body: string,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${name.toLowerCase()}?lockHandle=${lockHandle}`;
    const response = await this.http.post(path, body, {
      headers: {
        'Content-Type': `application/xml, ${mediaType}`,
        Accept: mediaType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...extraHeaders,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`POST ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * PUT (create/update) a BW object in its inactive version.
   * Pattern: PUT /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}
   * Always sends the complete object XML.
   */
  async put(
    type: string,
    name: string,
    lockHandle: string,
    body: string,
    timestamp?: string,
    corrNr?: string
  ): Promise<string> {
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const corrNrPrefix = corrNr ? `corrNr=${corrNr}&` : '';
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${name.toLowerCase()}/m?${corrNrPrefix}lockHandle=${lockHandle}`;
    const response = await this.http.put(path, body, {
      headers: {
        'Content-Type': `application/xml, ${mediaType}`,
        Accept: mediaType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...(timestamp ? { timestamp } : {}),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`PUT ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * Lock a BW object for deletion.
   * Differs from normal lock: URL includes /m before ?action=lock.
   * Pattern: POST /sap/bw/modeling/{type}/{name}/m?action=lock
   */
  async lockForDelete(type: string, name: string, mediaType: string): Promise<string> {
    await this.ensureCsrf();
    const response = await this.http.post(
      `/sap/bw/modeling/${type.toLowerCase()}/${name.toLowerCase()}/m?action=lock`,
      '',
      {
        headers: {
          Accept: mediaType,
          'bwmt-level': '50',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Delete-lock ${type}/${name} → HTTP ${response.status}\n${response.data}`);
    }
    const body = response.data as string;
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in delete-lock response:\n${body}`);
    }
    return match[1];
  }

  /**
   * Delete a BW object.
   * Pattern: DELETE /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}
   * Lock URL uses /m: POST /sap/bw/modeling/{type}/{name}/m?action=lock
   */
  async delete(
    type: string,
    name: string,
    lockHandle: string,
    mediaType: string
  ): Promise<string> {
    await this.ensureCsrf();
    const path = `/sap/bw/modeling/${type.toLowerCase()}/${name.toLowerCase()}/m?lockHandle=${lockHandle}`;
    const response = await this.http.delete(path, {
      headers: {
        'Content-Type': mediaType,
        Accept: mediaType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`DELETE ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * Activate one BW object.
   * Pattern: POST /sap/bw/modeling/activation
   * lockHandle is empty string for DTP activation.
   */
  async activate(type: string, name: string, lockHandle: string): Promise<string> {
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const nameLower = name.toLowerCase();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:bwModel="http://www.sap.com/bw/modeling">
  <atom:entry>
    <atom:content type="${mediaType}">
      <bwModel:checkProperties version="inactive" modelContent="" lockHandle="${lockHandle}"/>
    </atom:content>
    <atom:link href="/sap/bw/modeling/${type.toLowerCase()}/${nameLower}/m" type="application/*" rel="self"/>
  </atom:entry>
</atom:feed>`;
    const response = await this.http.post('/sap/bw/modeling/activation', body, {
      headers: {
        'Content-Type': 'application/atom+xml;type=entry',
        Accept: 'application/atom+xml;type=feed',
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(
        `Activation of ${type}/${name} → HTTP ${response.status}\n${response.data}`
      );
    }
    return response.data as string;
  }

  /**
   * Generic POST to an arbitrary BW modeling path.
   * Used for endpoints that don't follow the lock/create/unlock pattern
   * (e.g. move_requests).
   */
  /**
   * Like postRaw, but skips ensureCsrf() and uses the already-held CSRF token.
   * Throws if no token is available (caller must have triggered a CSRF fetch beforehand,
   * e.g. via lock()).
   */
  async postWithCsrf(path: string, body: string, contentType: string, extraHeaders?: Record<string, string | undefined>, stripInstanceHeaders?: boolean): Promise<string> {
    if (!this.csrfToken) {
      throw new Error('postWithCsrf: no CSRF token available. A prior lock() or get() must have established one.');
    }
    const response = await this.http.post(path, Buffer.from(body, 'utf-8'), {
      headers: {
        'Content-Type': contentType,
        Accept: contentType,
        'X-CSRF-Token': this.csrfToken,
        ...this.cookieHeaders(),
        ...extraHeaders,
        ...(stripInstanceHeaders ? {
          'User-Agent': ECLIPSE_USER_AGENT,
          'X-sap-adt-profiling': 'server-time',
          'sap-adt-request-id': randomUUID(),
          'bwmt-level': undefined,
          'X-sap-adt-sessiontype': undefined,
          'sap-client': undefined,
          'sap-language': undefined,
        } : {}),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`POST ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  async postRaw(path: string, body: string, contentType: string, extraHeaders?: Record<string, string>): Promise<string> {
    await this.ensureCsrf();
    const response = await this.http.post(path, body, {
      headers: {
        'Content-Type': contentType,
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...extraHeaders,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`POST ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /**
   * Unlock a BW object after activation.
   * DTPs (dtpa) are skipped — they require no unlock.
   * Pattern: POST /sap/bw/modeling/{type}/{name}?action=unlock
   */
  /**
   * Returns the current CSRF token, fetching it first if needed.
   * Callers that need to pass the token explicitly (e.g. rawPost) use this.
   */
  async getCsrfToken(): Promise<string> {
    await this.ensureCsrf();
    return this.csrfToken!;
  }

  /**
   * POST with a completely clean axios instance — no default headers at all.
   * Only sends Authorization (Basic Auth) + Cookie (session continuity) + the
   * headers explicitly passed by the caller.  Nothing else.
   *
   * Use this when you need to control the exact wire headers (e.g. for
   * Transformation creation where Eclipse sends a very specific header set).
   */
  async rawPost(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      // Wipe every axios default-header bucket so nothing leaks through
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });

    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.post(url, body, {
      headers: {
        Authorization: this.basicAuth,
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`POST ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * DELETE to an arbitrary path with a clean axios instance.
   * Fetches CSRF token automatically.
   */
  async rawDelete(
    url: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const csrfToken = await this.getCsrfToken();
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });
    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.delete(url, {
      headers: {
        Authorization: this.basicAuth,
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        'x-csrf-token': csrfToken,
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`DELETE ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Fetch the BW modeling discovery document and populate MEDIA_TYPES at runtime.
   * Entries returned by the server overwrite the hardcoded fallback defaults.
   * Entries not returned by the server are left unchanged.
   */
  async loadMediaTypes(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/discovery', {
      headers: {
        Accept: 'application/atomsvc+xml',
        Authorization: this.basicAuth,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Discovery GET → HTTP ${response.status}\n${response.data}`);
    }
    const xml: string = response.data as string;
    // Match <app:collection href="..."> ... <app:accept>...</app:accept> pairs.
    // Each collection block may span multiple lines, so we use [\s\S]*? for lazy matching.
    const collectionRe = /<app:collection\s+href="([^"]+)"[\s\S]*?<app:accept>([^<]+)<\/app:accept>/g;
    let match: RegExpExecArray | null;
    while ((match = collectionRe.exec(xml)) !== null) {
      const href = match[1];
      const mediaType = match[2].trim();
      // Extract last URL segment as the key (e.g. ".../adso" → "adso")
      const key = href.split('/').pop()?.toLowerCase();
      if (key && mediaType && mediaType.endsWith('+xml')) {
        // Only update if discovered version is >= hardcoded version (never downgrade)
        const extractVersion = (mt: string) => {
          const m = mt.match(/-v(\d+)_(\d+)_(\d+)\+xml$/);
          return m ? parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]) : 0;
        };
        const existing = MEDIA_TYPES[key];
        if (!existing || extractVersion(mediaType) >= extractVersion(existing)) {
          MEDIA_TYPES[key] = mediaType;
        }
      }
    }
    process.stderr.write(`[bw-modeling-mcp] Loaded media types from discovery: ${JSON.stringify(MEDIA_TYPES)}\n`);
  }

  // ── ADT class write flow (ABAP runtime only) ──────────────────────────────

  /** GET the ABAP class source (working area). Returns null if class does not exist yet (404). */
  async adtGetSource(classEncoded: string): Promise<string | null> {
    const token = await this.getCsrfToken();
    const response = await this.http.get(
      `/sap/bc/adt/oo/classes/${classEncoded}/source/main?version=workingArea`,
      {
        headers: {
          Accept: 'text/plain',
          'X-CSRF-Token': token,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
        transformResponse: [(data) => data],
      }
    );
    this.updateCookies(response);
    if (response.status === 404) {
      return null;
    }
    if (response.status >= 400) {
      throw new Error(`ADT GET source ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
    return response.data as string;
  }

  /** Lock the ABAP class for editing. Returns the ADT lock handle. */
  async adtLockClass(classEncoded: string): Promise<string> {
    const token = await this.getCsrfToken();
    const response = await this.http.post(
      `/sap/bc/adt/oo/classes/${classEncoded}?_action=LOCK&accessMode=MODIFY`,
      '',
      {
        headers: {
          Accept:
            'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8,' +
            'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
          'X-CSRF-Token': token,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`ADT LOCK ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
    const body = response.data as string;
    const match = body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (!match) {
      throw new Error(`No <LOCK_HANDLE> in ADT lock response:\n${body}`);
    }
    return match[1];
  }

  /** PUT updated ABAP class source. */
  async adtPutSource(classEncoded: string, lockHandle: string, source: string): Promise<void> {
    const token = await this.getCsrfToken();
    const response = await this.http.put(
      `/sap/bc/adt/oo/classes/${classEncoded}/source/main?lockHandle=${lockHandle}`,
      source,
      {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: 'text/plain',
          'X-CSRF-Token': token,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`ADT PUT source ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
  }

  /** Activate the ABAP class via ADT. */
  async adtActivate(classEncoded: string, classNameUpper: string): Promise<void> {
    await this.ensureCsrf();
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<adtcore:objectReference` +
      ` adtcore:uri="/sap/bc/adt/oo/classes/${classEncoded}"` +
      ` adtcore:name="${classNameUpper}"/>` +
      `</adtcore:objectReferences>`;
    const response = await this.http.post(
      '/sap/bc/adt/activation?method=activate&preauditRequested=true',
      body,
      {
        headers: {
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`ADT activate ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
  }

  /** Unlock the ABAP class after editing. */
  async adtUnlockClass(classEncoded: string, lockHandle: string): Promise<void> {
    await this.ensureCsrf();
    const response = await this.http.post(
      `/sap/bc/adt/oo/classes/${classEncoded}?_action=UNLOCK&lockHandle=${lockHandle}`,
      '',
      {
        headers: {
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`ADT UNLOCK ${classEncoded} → HTTP ${response.status}\n${response.data}`);
    }
  }

  async unlock(type: string, name: string): Promise<void> {
    if (NO_UNLOCK_TYPES.has(type.toLowerCase())) return;
    await this.ensureCsrf();
    const mediaType = resolveMediaType(type);
    const response = await this.http.post(
      `/sap/bw/modeling/${type.toLowerCase()}/${name.toLowerCase()}?action=unlock`,
      '',
      {
        headers: {
          'Content-Type': mediaType,
          'X-CSRF-Token': this.csrfToken!,
          ...this.cookieHeaders(),
        },
        responseType: 'text',
      }
    );
    this.updateCookies(response);
    this.csrfToken = null;
    if (response.status >= 400) {
      throw new Error(`UNLOCK ${type.toUpperCase()} ${name} → HTTP ${response.status}\n${response.data}`);
    }
  }
}

export function createClientFromEnv(): BwClient {
  const url = process.env.BW_URL;
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  const client = process.env.BW_CLIENT ?? '001';
  const language = process.env.BW_LANGUAGE;
  if (!url || !user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient(url, user, password, client, language);
}
