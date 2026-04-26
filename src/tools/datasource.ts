import { BwClient } from '../bw-client.js';

const BASE = '/sap/bw/modeling/repo/datasourcestructure';
const BASE_PREFIX = `${BASE}/`;

interface ParsedEntry {
  objectName: string;
  objectType: string;
  objectSubtype: string | null;
  objectStatus: string | null;
  displayObjectName: string | null;
  title: string;
  selfHref: string | null;
  childrenHref: string | null;
}

function parseEntries(xml: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const entryRegex = /<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g;
  let em: RegExpExecArray | null;

  while ((em = entryRegex.exec(xml)) !== null) {
    const body = em[1];

    const bwObjMatch = body.match(/<bwModel:object\b([\s\S]*?)(?:\/>|>)/);
    const bwAttrs = bwObjMatch?.[1] ?? '';
    const objectName = bwAttrs.match(/\bobjectName="([^"]*)"/)?.[1] ?? '';
    const objectType = bwAttrs.match(/\bobjectType="([^"]*)"/)?.[1] ?? '';
    const objectSubtype = bwAttrs.match(/\bobjectSubtype="([^"]*)"/)?.[1] ?? null;
    const objectStatus = bwAttrs.match(/\bobjectStatus="([^"]*)"/)?.[1] ?? null;
    const displayObjectName = bwAttrs.match(/\bdisplayObjectName="([^"]*)"/)?.[1] ?? null;

    const title = body.match(/<atom:title[^>]*>([^<]*)<\/atom:title>/)?.[1] ?? '';

    let selfHref: string | null = null;
    let childrenHref: string | null = null;

    const linkRegex = /<atom:link\b([\s\S]*?)(?:\/>|>)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(body)) !== null) {
      const attrs = lm[1];
      const rel = attrs.match(/\brel="([^"]*)"/)?.[1] ?? '';
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1] ?? '';
      if (rel === 'self') selfHref = href || null;
      else if (rel === 'http://www.sap.com/bw/modeling/relations:children') childrenHref = href || null;
    }

    entries.push({ objectName, objectType, objectSubtype, objectStatus, displayObjectName, title, selfHref, childrenHref });
  }

  return entries;
}

function stripBase(href: string): string {
  return href.startsWith(BASE_PREFIX) ? href.slice(BASE_PREFIX.length) : href;
}

export async function bwListSourceSystems(
  client: BwClient,
  sourceSystemType?: string
): Promise<string> {
  const ssysUrls: string[] = [];

  if (sourceSystemType) {
    ssysUrls.push(`${BASE}/ssys/${sourceSystemType.toLowerCase()}`);
  } else {
    const { body: rootBody } = await client.get(BASE, 'application/atom+xml');
    for (const e of parseEntries(rootBody)) {
      if (e.childrenHref) ssysUrls.push(e.childrenHref);
    }
  }

  const sourceSystems: object[] = [];
  for (const url of ssysUrls) {
    const { body } = await client.get(url, 'application/atom+xml');
    for (const e of parseEntries(body)) {
      if (e.objectType !== 'LSYS') continue;
      sourceSystems.push({
        name: e.objectName,
        description: e.title,
        source_system_type: e.objectSubtype,
        status: e.objectStatus,
        self_url: e.selfHref,
        children_path: e.childrenHref ? stripBase(e.childrenHref) : null,
      });
    }
  }

  return JSON.stringify({ count: sourceSystems.length, source_systems: sourceSystems }, null, 2);
}

export async function bwListDatasources(
  client: BwClient,
  sourceSystem: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  interface DatasourceEntry {
    name: string;
    description: string;
    status: string | null;
    self_url: string | null;
    apco_path: string[];
  }

  const datasources: DatasourceEntry[] = [];
  const rawBlocks: string[] = [];
  const sourceSystemUpper = sourceSystem.toUpperCase();

  async function recurse(url: string, apcoPath: string[]): Promise<void> {
    const { body } = await client.get(url, 'application/atom+xml');
    if (format === 'raw') {
      rawBlocks.push(`Source System: ${sourceSystemUpper}\n${body}`);
      for (const e of parseEntries(body)) {
        if (e.objectType === 'APCO' && e.childrenHref) {
          await recurse(e.childrenHref, []);
        }
      }
      return;
    }
    for (const e of parseEntries(body)) {
      if (e.objectType === 'RSDS') {
        const name = e.displayObjectName
          ? e.displayObjectName.split(' (')[0]
          : e.objectName.trim().split(' ')[0];
        datasources.push({
          name,
          description: e.title,
          status: e.objectStatus,
          self_url: e.selfHref,
          apco_path: [...apcoPath],
        });
      } else if (e.objectType === 'APCO' && e.childrenHref) {
        await recurse(e.childrenHref, [...apcoPath, e.title]);
      }
    }
  }

  await recurse(`${BASE}/lsys/${sourceSystem.toLowerCase()}`, []);

  if (format === 'raw') return rawBlocks.join('\n\n');

  const p = (s: string, n: number) => s.padEnd(n);
  const header = `${p('NAME', 30)} ${p('STATUS', 9)} ${p('APCO PATH', 32)} ${p('DESCRIPTION', 36)} URL`;
  const sep = '-'.repeat(header.length);

  const lines: string[] = [
    `Source System: ${sourceSystemUpper}`,
    `DataSources: ${datasources.length}`,
    '',
    header,
    sep,
  ];

  for (const ds of datasources) {
    const apco = ds.apco_path.join(' > ');
    lines.push(
      `${p(ds.name, 30)} ${p(ds.status ?? '', 9)} ${p(apco, 32)} ${p(ds.description, 36)} ${ds.self_url ?? ''}`
    );
  }

  return lines.join('\n');
}

const RSDS_ACCEPT =
  'application/vnd.sap.bw.modeling.rsds-v1_0_0+xml, application/vnd.sap.bw.modeling.rsds-v1_1_0+xml';

interface DatasourceField {
  name: string;
  description: string | null;
  type: string | null;
  length: number | null;
  transfer: boolean | null;
  selection_options: number | null;
  position: number | null;
  is_key: boolean;
  precision?: number;
  scale?: number;
  conversion_exit?: string;
  unit_currency_ref?: string;
}

interface DatasourceData {
  name: string | null;
  source_system: string | null;
  type: string | null;
  application_component: string | null;
  direct_access: string | null;
  delta: string | null;
  description: string | null;
  status: string | null;
  changed_at: string | null;
  changed_by: string | null;
  created_at: string | null;
  created_by: string | null;
  package: string | null;
  field_count: number;
  fields: DatasourceField[];
  adapter: Record<string, unknown>;
}

function summarizeDatasource(d: DatasourceData): string {
  const lines: string[] = [];

  lines.push(`DataSource: ${d.name ?? ''}`);
  lines.push(`Source System: ${d.source_system ?? ''}`);
  lines.push(`Status: ${d.status ?? ''} | Type: ${d.type ?? ''} | Delta: ${d.delta ?? ''} | Direct Access: ${d.direct_access ?? ''}`);
  lines.push(`Description: ${d.description ?? ''}`);
  lines.push(`Application Component: ${d.application_component ?? ''}`);
  lines.push(`Changed: ${d.changed_at ?? ''} by ${d.changed_by ?? ''}`);
  lines.push(`Created: ${d.created_at ?? ''} by ${d.created_by ?? ''}`);
  lines.push(`Package: ${d.package ?? ''}`);

  // ── Fields ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(`── Fields (${d.field_count}) ──`);

  const compactLabel = (f: DatasourceField): string => {
    const len = f.length !== null
      ? String(f.length)
      : (f.precision !== undefined && f.scale !== undefined ? `P${f.precision}/S${f.scale}` : '');
    return `${f.name}(${f.type ?? ''}/${len})`;
  };

  const notTransferred = d.fields.filter(f => f.transfer === false);
  const keyFields      = d.fields.filter(f => f.is_key);
  const transferred    = d.fields.filter(f => f.transfer === true)
                                  .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const ntLabels = notTransferred.map(compactLabel);
  if (ntLabels.length === 0) {
    lines.push(`Not transferred (0):`);
  } else {
    const chunks: string[][] = [];
    for (let i = 0; i < ntLabels.length; i += 10) chunks.push(ntLabels.slice(i, i + 10));
    if (chunks.length === 1) {
      lines.push(`Not transferred (${notTransferred.length}): ${chunks[0].join(', ')}`);
    } else {
      lines.push(`Not transferred (${notTransferred.length}):`);
      for (const chunk of chunks) lines.push(`  ${chunk.join(', ')}`);
    }
  }

  lines.push(`Key fields (${keyFields.length}): ${keyFields.map(compactLabel).join(', ')}`);

  lines.push('');
  lines.push(`Transferred (${transferred.length}):`);

  const pe = (s: string, n: number) => s.padEnd(n);
  const pr = (s: string, n: number) => s.padStart(n);
  lines.push(`  ${'POS'.padEnd(4)}  ${'NAME'.padEnd(30)} ${'TYPE'.padEnd(7)} ${'LEN'.padStart(5)}  ${'KEY'.padEnd(4)} ${'SEL'.padEnd(4)} DESCRIPTION`);

  for (const f of transferred) {
    const pos    = String(f.position ?? 0).padStart(4, '0');
    const lenStr = f.length !== null
      ? String(f.length)
      : (f.precision !== undefined && f.scale !== undefined ? `P${f.precision}/S${f.scale}` : '');
    const keyStr = f.is_key ? 'key' : '';
    const selStr = String(f.selection_options ?? '');
    let desc = f.description ?? '';
    if (f.conversion_exit)   desc += ` [conv: ${f.conversion_exit}]`;
    if (f.unit_currency_ref) desc += ` [unit: ${f.unit_currency_ref}]`;

    lines.push(`  ${pos}  ${pe(f.name, 30)} ${pe(f.type ?? '', 7)} ${pr(lenStr, 5)}  ${pe(keyStr, 4)} ${pe(selStr, 4)} ${desc}`);
  }

  // ── Adapter ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('── Adapter ──');
  for (const [key, value] of Object.entries(d.adapter)) {
    lines.push(`${key}: ${value ?? ''}`);
  }

  return lines.join('\n');
}

function parseDescLabel(xml: string): string | null {
  const re = /<description\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    if (attrs.includes('textType="3"')) return attrs.match(/\blabel="([^"]*)"/)?.[1] ?? null;
  }
  return null;
}

export async function bwGetDatasource(
  client: BwClient,
  datasourceName: string,
  sourceSystem: string,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const url = `/sap/bw/modeling/rsds/${datasourceName}/${sourceSystem.toUpperCase()}/m`;
  const { body, headers } = await client.get(url, RSDS_ACCEPT);

  if (format === 'raw') return body;

  // Root element attributes
  const rootMatch = body.match(/<rsds:dataSource\b([\s\S]*?)>/);
  const rootAttrs = rootMatch?.[1] ?? '';
  const name = rootAttrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? null;
  const sourceSystemAttr = rootAttrs.match(/\bsourceSystemName="([^"]*)"/)?.[1] ?? null;
  const type = rootAttrs.match(/(?<![a-zA-Z:])type="([^"]*)"/)?.[1] ?? null;
  const applicationComponent = rootAttrs.match(/\bapplicationComponent="([^"]*)"/)?.[1] ?? null;
  const directAccess = rootAttrs.match(/\bdirectAccess="([^"]*)"/)?.[1] ?? null;

  // delta from <deltaProperties>
  const delta = body.match(/<deltaProperties\b[\s\S]*?\bdelta="([^"]*)"/)?.[1] ?? null;

  // DataSource-level description (header section, before first <segment>)
  const segStart = body.indexOf('<segment');
  const headerSection = segStart >= 0 ? body.slice(0, segStart) : body;
  const description = parseDescLabel(headerSection);

  // Status from response header (axios lowercases all header names)
  const status = (headers['object_status'] as string | undefined) ?? null;

  // tlogoProperties
  const tlogoMatch = body.match(/<tlogoProperties\b([\s\S]*?)>/);
  const tlogoAttrs = tlogoMatch?.[1] ?? '';
  const changedAt = tlogoAttrs.match(/\badtcore:changedAt="([^"]*)"/)?.[1] ?? null;
  const changedBy = tlogoAttrs.match(/\badtcore:changedBy="([^"]*)"/)?.[1] ?? null;
  const createdAt = tlogoAttrs.match(/\badtcore:createdAt="([^"]*)"/)?.[1] ?? null;
  const createdBy = tlogoAttrs.match(/\badtcore:createdBy="([^"]*)"/)?.[1] ?? null;

  // Package from <adtcore:packageRef adtcore:name="...">
  const pkg = body.match(/<adtcore:packageRef\b[\s\S]*?\badtcore:name="([^"]*)"/)?.[1] ?? null;

  // Segment ID="0001" — key fields and field list
  const segMatch = body.match(/<segment\b[^>]*ID="0001"[^>]*>([\s\S]*?)<\/segment>/);
  const segBody = segMatch?.[1] ?? '';

  const keyFields = new Set<string>();
  const kfRe = /<keyField>([^<]*)<\/keyField>/g;
  let kfm: RegExpExecArray | null;
  while ((kfm = kfRe.exec(segBody)) !== null) {
    const kv = kfm[1].trim().match(/^#\/\/\/0001\/(.+)$/);
    if (kv) keyFields.add(kv[1]);
  }

  const fields: DatasourceField[] = [];
  const fieldRe = /<field\b([\s\S]*?)>([\s\S]*?)<\/field>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(segBody)) !== null) {
    const fTag = fm[1];
    const fBody = fm[2];

    const fieldName = fTag.match(/\bname="([^"]*)"/)?.[1] ?? '';

    const itMatch = fBody.match(/<inlineType\b([\s\S]*?)(?:\/>|>)/);
    const itAttrs = itMatch?.[1] ?? '';
    const fType = itAttrs.match(/\bname="([^"]*)"/)?.[1] ?? null;
    const lengthRaw = itAttrs.match(/\blength="([^"]*)"/)?.[1];
    const length = lengthRaw !== undefined ? parseInt(lengthRaw, 10) : null;
    const precisionRaw = itAttrs.match(/\bprecision="([^"]*)"/)?.[1];
    const scaleRaw = itAttrs.match(/\bscale="([^"]*)"/)?.[1];

    const fpMatch = fBody.match(/<fieldProperties\b([\s\S]*?)(?:\/>|>)/);
    const fpAttrs = fpMatch?.[1] ?? '';
    const transferRaw = fpAttrs.match(/\btransfer="([^"]*)"/)?.[1];
    const selOptRaw = fpAttrs.match(/\bselectionOptions="([^"]*)"/)?.[1];
    const posRaw = fpAttrs.match(/\bposition="([^"]*)"/)?.[1];
    const convExit = fpAttrs.match(/\bconversionExitSource="([^"]*)"/)?.[1] || undefined;

    const ucRaw = fBody.match(/<unitCurrencyElement>([^<]*)<\/unitCurrencyElement>/)?.[1];

    const field: Record<string, unknown> = {
      name: fieldName,
      description: parseDescLabel(fBody),
      type: fType,
      length,
      transfer: transferRaw === 'true' ? true : transferRaw === 'false' ? false : null,
      selection_options: selOptRaw !== undefined ? parseInt(selOptRaw, 10) : null,
      position: posRaw !== undefined ? parseInt(posRaw, 10) : null,
      is_key: keyFields.has(fieldName),
    };
    if (precisionRaw !== undefined) field['precision'] = parseInt(precisionRaw, 10);
    if (scaleRaw !== undefined) field['scale'] = parseInt(scaleRaw, 10);
    if (convExit) field['conversion_exit'] = convExit;
    if (ucRaw) field['unit_currency_ref'] = ucRaw.replace(/^#\/\/\/0001\//, '');

    fields.push(field as unknown as DatasourceField);
  }

  // Active adapter(s)
  const adapter: Record<string, unknown> = {};
  const adapterTagRe = /<adapter\b([\s\S]*?)(?:\/>|>)/g;
  let adm: RegExpExecArray | null;
  while ((adm = adapterTagRe.exec(body)) !== null) {
    const aAttrs = adm[1];
    if (!aAttrs.includes('currentlyUsed="true"')) continue;

    const rawAType = aAttrs.match(/\bxsi:type="([^"]*)"/)?.[1] ?? '';
    const aType = rawAType.replace(/^rsds:/, '');
    const extObj = aAttrs.match(/\bexternalObject="([^"]*)"/)?.[1] || null;

    if (aType === 'ConverterCSVFL') {
      const dataSep = aAttrs.match(/\bdataSeparator="([^"]*)"/)?.[1] ?? null;
      const escChar = aAttrs.match(/\bescapeCharacter="([^"]*)"/)?.[1] ?? null;
      if (dataSep !== null) adapter['data_separator'] = dataSep;
      if (escChar !== null) adapter['escape_character'] = escChar;
    } else {
      adapter['adapter_name'] = aAttrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? null;
      adapter['adapter_type'] = aType;
      if (extObj) adapter['external_object'] = extObj;

      if (aType === 'ExtractorODP') {
        adapter['context_description'] = aAttrs.match(/\bcontextDescription="([^"]*)"/)?.[1] ?? null;
        adapter['semantics'] = aAttrs.match(/\bsemantics="([^"]*)"/)?.[1] ?? null;
      } else if (aType === 'ExtractorHANA') {
        adapter['hana_type'] = aAttrs.match(/\bhanaType="([^"]*)"/)?.[1] ?? null;
        adapter['schema'] = aAttrs.match(/\bschema="([^"]*)"/)?.[1] ?? null;
        adapter['remote_source'] = aAttrs.match(/\bremoteSource="([^"]*)"/)?.[1] ?? null;
      } else if (aType.startsWith('ExtractorFile')) {
        const ignoreLines = aAttrs.match(/\bignoreLines="([^"]*)"/)?.[1] || null;
        if (ignoreLines !== null) adapter['ignore_lines'] = ignoreLines;
      }
    }
  }

  const data: DatasourceData = {
    name,
    source_system: sourceSystemAttr,
    type,
    application_component: applicationComponent,
    direct_access: directAccess,
    delta,
    description,
    status,
    changed_at: changedAt,
    changed_by: changedBy,
    created_at: createdAt,
    created_by: createdBy,
    package: pkg,
    field_count: fields.length,
    fields,
    adapter,
  };

  return summarizeDatasource(data);
}

const LSYS_ACCEPT =
  'application/vnd.sap.bw.modeling.lsys-v1_0_0+xml, application/vnd.sap.bw.modeling.lsys-v1_1_0+xml';

function deriveSourceSystemType(xsiType: string, context: string | null, hanaType: string | null): string {
  if (xsiType === 'SourceSystemFILE') return 'FILE';
  if (xsiType === 'SourceSystemHANA') {
    return hanaType === '1' ? 'HANA_LOCAL' : 'HANA_SDA';
  }
  if (xsiType === 'SourceSystemODP') {
    if (context === 'SAPI') return 'ODP_SAP';
    if (context === 'ABAP_CDS') return 'ODP_CDS';
    if (context === 'BW') return 'ODP_BW';
    return 'ODP';
  }
  return xsiType;
}

export async function bwGetSourceSystem(client: BwClient, sourceSystem: string): Promise<string> {
  const url = `/sap/bw/modeling/lsys/${sourceSystem.toLowerCase()}/a`;
  const { body, headers } = await client.get(url, LSYS_ACCEPT);

  // Root element opening tag attributes (up to first closing >)
  const rootMatch = body.match(/<lsys:sourceSystem\b([\s\S]*?)>/);
  const rootAttrs = rootMatch?.[1] ?? '';

  const name = rootAttrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? null;
  const rawXsiType = rootAttrs.match(/\bxsi:type="([^"]*)"/)?.[1] ?? '';
  const xsiType = rawXsiType.replace(/^lsys:/, '');
  // Use negative lookbehind to avoid matching xsi:type or adtcore:type
  const type = rootAttrs.match(/(?<![a-zA-Z:])type="([^"]*)"/)?.[1] ?? null;

  // ODP-specific root attributes
  const context = rootAttrs.match(/\bcontext="([^"]*)"/)?.[1] ?? null;
  const destination = rootAttrs.match(/\bdestination="([^"]*)"/)?.[1] ?? null;
  const destinationValid = rootAttrs.match(/\bdestinationValid="([^"]*)"/)?.[1] ?? null;
  const treeRemote = rootAttrs.match(/\btreeRemote="([^"]*)"/)?.[1] ?? null;
  const treeReplicatable = rootAttrs.match(/\btreeReplicatable="([^"]*)"/)?.[1] ?? null;

  // HANA-specific root attributes
  const hanaType = rootAttrs.match(/\bhanaType="([^"]*)"/)?.[1] ?? null;
  const remoteSource = rootAttrs.match(/\bremoteSource="([^"]*)"/)?.[1] ?? null;
  const database = rootAttrs.match(/\bdatabase="([^"]*)"/)?.[1] ?? null;
  const schema = rootAttrs.match(/\bschema="([^"]*)"/)?.[1] ?? null;
  const sdiAdapter = rootAttrs.match(/\bsdiAdapter="([^"]*)"/)?.[1] ?? null;

  // <description textType="3" label="..."/>
  let description: string | null = null;
  const descRegex = /<description\b([^>]*?)(?:\/>|>)/g;
  let dm: RegExpExecArray | null;
  while ((dm = descRegex.exec(body)) !== null) {
    const dAttrs = dm[1];
    if (dAttrs.includes('textType="3"')) {
      description = dAttrs.match(/\blabel="([^"]*)"/)?.[1] ?? null;
      break;
    }
  }

  // tlogoProperties attributes
  const tlogoMatch = body.match(/<tlogoProperties\b([\s\S]*?)>/);
  const tlogoAttrs = tlogoMatch?.[1] ?? '';
  const changedAt = tlogoAttrs.match(/\badtcore:changedAt="([^"]*)"/)?.[1] ?? null;
  const changedBy = tlogoAttrs.match(/\badtcore:changedBy="([^"]*)"/)?.[1] ?? null;

  // <objectStatus> text content
  const objectStatus = body.match(/<objectStatus>([^<]*)<\/objectStatus>/)?.[1] ?? null;

  // Response header (axios lowercases header names)
  const status = (headers['object_status'] as string | undefined) ?? null;

  const sourceSystemType = deriveSourceSystemType(xsiType, context, hanaType);

  const result: Record<string, unknown> = {
    name,
    xsi_type: xsiType,
    type,
    status,
    description,
    changed_at: changedAt,
    changed_by: changedBy,
    object_status: objectStatus,
    source_system_type: sourceSystemType,
  };

  if (xsiType === 'SourceSystemODP') {
    result['context'] = context;
    result['destination'] = destination;
    result['destination_valid'] = destinationValid === 'true' ? true : destinationValid === 'false' ? false : null;
    result['tree_remote'] = treeRemote === 'true' ? true : treeRemote === 'false' ? false : null;
    result['tree_replicatable'] = treeReplicatable === 'true' ? true : treeReplicatable === 'false' ? false : null;
  } else if (xsiType === 'SourceSystemHANA') {
    result['hana_type'] = hanaType;
    result['remote_source'] = remoteSource;
    result['database'] = database;
    result['schema'] = schema;
    result['sdi_adapter'] = sdiAdapter;
  }

  return JSON.stringify(result, null, 2);
}
