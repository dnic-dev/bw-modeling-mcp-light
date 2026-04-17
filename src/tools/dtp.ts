import { BwClient, MEDIA_TYPES, createClientFromEnv } from '../bw-client.js';
import { bwActivate } from './activation.js';

interface XrefEntry {
  objectName: string;
  objectType: string;
  objectStatus: string;
  title: string;
  href: string;
}

/**
 * Parse <atom:entry> elements from a BW Atom feed (xref / search responses).
 * Each entry contains a <bwModel:object> with objectName, objectType, objectStatus.
 */
function parseAtomEntries(xml: string): XrefEntry[] {
  const entries: XrefEntry[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const nameMatch = body.match(/objectName="([^"]+)"/);
    const typeMatch = body.match(/objectType="([^"]+)"/);
    const statusMatch = body.match(/objectStatus="([^"]+)"/);
    const titleMatch = body.match(/<atom:title>([^<]+)<\/atom:title>/);
    const hrefMatch = body.match(/href="([^"]+)"/);

    if (nameMatch && typeMatch) {
      entries.push({
        objectName: nameMatch[1],
        objectType: typeMatch[1],
        objectStatus: statusMatch?.[1] ?? 'unknown',
        title: titleMatch?.[1] ?? '',
        href: hrefMatch?.[1] ?? '',
      });
    }
  }
  return entries;
}

/**
 * bw_get_dtps — list DTPs that depend on an object (via xref).
 *
 * Uses the cross-reference endpoint to find all DTPA objects that use the given object.
 * Filters xref results to objectType=DTPA only.
 *
 * After activating a Transformation, the activation response lists deactivated DTPs.
 * This tool can be used independently to find dependent DTPs before activation.
 */
export async function bwGetDtps(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const path = `/sap/bw/modeling/repo/is/xref?objectType=${encodeURIComponent(objectType.toUpperCase())}&objectName=${encodeURIComponent(objectName.toUpperCase())}`;
  const result = await client.get(path, 'application/atom+xml;type=feed');

  const allEntries = parseAtomEntries(result.body);
  const dtps = allEntries.filter((e) => e.objectType === 'DTPA');

  if (dtps.length === 0) {
    return `No dependent DTPs found for ${objectType.toUpperCase()} ${objectName.toUpperCase()}.`;
  }

  const lines = [
    `Found ${dtps.length} DTP(s) dependent on ${objectType.toUpperCase()} ${objectName.toUpperCase()}:`,
    '',
    ...dtps.map(
      (d, i) =>
        `${i + 1}. ${d.objectName} — status: ${d.objectStatus}` +
        (d.title ? ` — "${d.title}"` : '')
    ),
    '',
    'To activate all inactive DTPs: call bw_activate for each with object_type="dtpa" and lock_handle="".',
  ];

  return lines.join('\n');
}

/**
 * bw_get_dtp_details — read a single DTP definition.
 * (Used internally; exposed via bw_get_dtps in index.ts if needed.)
 */
export async function bwGetDtpDetails(client: BwClient, dtpName: string): Promise<string> {
  const path = `/sap/bw/modeling/dtpa/${dtpName.toLowerCase()}/m`;
  const result = await client.get(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `DTP: ${dtpName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}

// ── bwGetDtp ──────────────────────────────────────────────────────────────────

interface DtpFilterSelection {
  operator: string;
  excluding: boolean;
  low: string;
}

interface DtpFilterField {
  name: string;
  dtaName: string;
  description: string;
  selected: boolean;
  selections: DtpFilterSelection[];
  hasRoutine: boolean;
  routineCode: string[];
}

interface DtpInfo {
  name: string;
  description: string;
  status: string;
  source: { type: string; name: string; description: string };
  target: { type: string; name: string; description: string };
  transformation: { name: string; description: string };
  extractionMode: string;
  packageSize: string;
  filterFields: DtpFilterField[];
  globalRoutineCode: string[];
}

function parseDtpXml(xml: string, status: string): DtpInfo {
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : '';
  };

  // Root attributes
  const rootMatch = xml.match(/<dtpa:dataTransferProcess([^>]*)>/);
  const rootAttrs = rootMatch?.[1] ?? '';
  const name = attr(rootAttrs, 'name');
  const description = attr(rootAttrs, 'description');

  // Extraction settings
  const extrMatch = xml.match(/<extractionSettings([^>]*)\/?>/);
  const extractionMode = attr(extrMatch?.[1] ?? '', 'extractionMode');
  const packageSize = attr(extrMatch?.[1] ?? '', 'packageSize');

  // Source / target
  const srcMatch = xml.match(/<source([^>]*)\/?>/);
  const tgtMatch = xml.match(/<target([^>]*)\/?>/);
  const source = {
    type: attr(srcMatch?.[1] ?? '', 'type'),
    name: attr(srcMatch?.[1] ?? '', 'name'),
    description: attr(srcMatch?.[1] ?? '', 'description'),
  };
  const target = {
    type: attr(tgtMatch?.[1] ?? '', 'type'),
    name: attr(tgtMatch?.[1] ?? '', 'name'),
    description: attr(tgtMatch?.[1] ?? '', 'description'),
  };

  // Transformation (overview/object)
  const ovMatch = xml.match(/<overview>[\s\S]*?<object([^>]*)\/?>[\s\S]*?<\/overview>/);
  const transformation = {
    name: attr(ovMatch?.[1] ?? '', 'name'),
    description: attr(ovMatch?.[1] ?? '', 'description'),
  };

  // Filter fields
  const filterFields: DtpFilterField[] = [];
  const fieldsRegex = /<fields([^>]*)>([\s\S]*?)<\/fields>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldsRegex.exec(xml)) !== null) {
    const fieldAttrs = fm[1];
    const fieldBody = fm[2];

    const selections: DtpFilterSelection[] = [];
    const selRegex = /<selection\b([^>]*)(?:\/>|>([\s\S]*?)<\/selection>)/g;
    let sm: RegExpExecArray | null;
    while ((sm = selRegex.exec(fieldBody)) !== null) {
      const selAttrs = sm[1];
      const selBody = sm[2] ?? '';
      const operator = selAttrs.match(/\boperator="([^"]*)"/)?.[1] ?? '';
      const excluding = selAttrs.includes('excluding="true"');
      const low = selBody.match(/<low[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
      selections.push({ operator, excluding, low });
    }

    const hasRoutine = /<routine[\s>]/.test(fieldBody) && !/<routine\s*\/>/.test(fieldBody);
    const routineCode: string[] = [];
    if (hasRoutine) {
      const codeRegex = /<code(?:\s[^>]*)?>([^<]*)<\/code>/g;
      let cm: RegExpExecArray | null;
      while ((cm = codeRegex.exec(fieldBody)) !== null) {
        routineCode.push(cm[1]);
      }
    }

    filterFields.push({
      name: attr(fieldAttrs, 'name'),
      dtaName: attr(fieldAttrs, 'dtaName'),
      description: attr(fieldAttrs, 'description'),
      selected: fieldAttrs.includes('selected="true"'),
      selections,
      hasRoutine,
      routineCode,
    });
  }

  // Global routine code
  const globalRoutineCode: string[] = [];
  const globalRegex = /<globalRoutineCode>([^<]*)<\/globalRoutineCode>/g;
  let gm: RegExpExecArray | null;
  while ((gm = globalRegex.exec(xml)) !== null) {
    globalRoutineCode.push(gm[1]);
  }

  return {
    name,
    description,
    status,
    source,
    target,
    transformation,
    extractionMode,
    packageSize,
    filterFields,
    globalRoutineCode,
  };
}

/**
 * bw_get_dtp — read a DTP definition and return a structured summary + raw XML.
 *
 * Flow:
 *   GET /sap/bw/modeling/dtpa/{dtpName}/m?forceCacheUpdate=true
 *   Parse key fields and return readable summary.
 */
export async function bwGetDtp(client: BwClient, dtpName: string): Promise<string> {
  const path = `/sap/bw/modeling/dtpa/${dtpName.toLowerCase()}/m?forceCacheUpdate=true`;
  const result = await client.get(path, MEDIA_TYPES['dtpa']);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';

  const info = parseDtpXml(result.body, status);

  const modeLabel = info.extractionMode === 'F' ? 'Full' : info.extractionMode === 'D' ? 'Delta' : info.extractionMode;

  const lines: string[] = [
    `DTP: ${info.name}`,
    `Status: ${info.status}`,
    `Description: ${info.description}`,
    '',
    `Source: ${info.source.type} ${info.source.name}` + (info.source.description ? ` — ${info.source.description}` : ''),
    `Target: ${info.target.type} ${info.target.name}` + (info.target.description ? ` — ${info.target.description}` : ''),
    `Transformation: ${info.transformation.name}` + (info.transformation.description ? ` — ${info.transformation.description}` : ''),
    '',
    `── Extraction Settings ──`,
    `  Mode:        ${modeLabel} (${info.extractionMode})`,
    `  Package Size: ${info.packageSize}`,
    '',
    `── Filter Fields (${info.filterFields.length}) ──`,
  ];

  if (info.filterFields.length === 0) {
    lines.push('  (no filter fields)');
  } else {
    for (const f of info.filterFields) {
      lines.push(`  [${f.selected ? 'selected' : 'inactive'}] ${f.name} (${f.dtaName})`);
      if (f.selections.length > 0) {
        for (const s of f.selections) {
          const sign = s.excluding ? '≠' : '=';
          const val = s.low === '' ? "''" : `"${s.low}"`;
          lines.push(`    → ${s.operator} ${sign} ${val}`);
        }
      }
      if (f.hasRoutine) {
        lines.push(`    → Routine (${f.routineCode.length} lines):`);
        for (const codeLine of f.routineCode) {
          lines.push(`       ${codeLine}`);
        }
      }
      if (!f.hasRoutine && f.selections.length === 0) {
        lines.push('    → (no selection / no routine)');
      }
    }
  }

  if (info.globalRoutineCode.length > 0) {
    lines.push('', '── Global Routine Code ──');
    for (const line of info.globalRoutineCode) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('', `── Raw XML ──`, result.body);

  return lines.join('\n');
}

// ── bwCreateDtp ───────────────────────────────────────────────────────────────

export interface CreateDtpArgs {
  trfn_name: string;
  trfn_name_2?: string;
  source_name: string;
  source_type: string;
  target_name: string;
  target_type: string;
  description?: string;
  package?: string;
  filter_field?: string;
  filter_dta_name?: string;
  filter_value?: string;
}

/**
 * bw_create_dtp — create a new DTP for an existing Transformation, then activate it.
 *
 * Flow:
 *   1. POST generateDtpId → DTP name from Location header
 *   2. Lock with activity_context: CREA (rawPost on lockClient = passed-in client)
 *   3. POST minimal XML with fresh createClientFromEnv() (session isolation)
 *   4. Explicit unlock (rawPost on lockClient)
 *   5a. If filter_field: Lock (new client) → GET (fresh) → PUT (fresh) → bwActivate
 *   5b. If no filter: bwActivate with empty lockHandle
 */
export async function bwCreateDtp(
  client: BwClient,
  args: CreateDtpArgs
): Promise<string> {
  const trfnName   = args.trfn_name.toUpperCase();
  const srcName    = args.source_name.toUpperCase();
  const srcType    = args.source_type.toUpperCase();
  const tgtName    = args.target_name.toUpperCase();
  const tgtType    = args.target_type.toUpperCase();
  const desc       = args.description ?? '';
  const pkg        = args.package ?? '$TMP';

  const language     = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = new URL(process.env.BW_URL ?? 'http://localhost').hostname.split('.')[0].toUpperCase();
  const responsible  = (process.env.BW_USER ?? '').toUpperCase();

  // Step 1: Generate DTP name via POST generateDtpId — DTP name is in Location header
  const csrfToken = await client.getCsrfToken();
  const genResponse = await client.rawPost(
    '/sap/bw/modeling/dtpa/generateDtpId',
    '',
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'Content-Type': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken,
    }
  );
  const location = genResponse.headers['location'] ?? genResponse.headers['Location'] ?? '';
  if (!location) {
    throw new Error(`generateDtpId returned no Location header. Response: ${JSON.stringify(genResponse.headers)}`);
  }
  const dtpName  = location.split('/').pop()!.toUpperCase();
  const dtpLower = dtpName.toLowerCase();

  // Step 2: Lock with CREA
  const csrfToken2 = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${dtpLower}?action=lock`,
    '',
    {
      'activity_context': 'CREA',
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken2,
    }
  );
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockResponse.body}`);
  }

  // Step 3: POST minimal XML — fresh session (same isolation as bwCreateTransformation)
  const postBody = `<?xml version="1.0" encoding="UTF-8"?>
<Dtpa:dataTransferProcess
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:Dtpa="http://www.sap.com/bw/modeling/DataTransferProcess.ecore"
  xmlns:adtcore="http://www.sap.com/adt/core"
  description="${desc}"
  name="${dtpName}">
  <generalInformation>
    <tlogoProperties
      adtcore:language="${language}"
      adtcore:name="${dtpName}"
      adtcore:type="DTPA"
      adtcore:masterLanguage="${language}"
      adtcore:masterSystem="${masterSystem}"
      adtcore:responsible="${responsible}"/>
  </generalInformation>
  <overview>
    <object xsi:type="Dtpa:DTPObject" name="${trfnName}" tlogo="TRFN"/>${args.trfn_name_2 ? `\n    <object xsi:type="Dtpa:DTPObject" name="${args.trfn_name_2.toUpperCase()}" tlogo="TRFN"/>` : ''}
  </overview>
  <source name="${srcName}" tlogo="${srcType}" type="${srcType}"/>
  <target name="${tgtName}" tlogo="${tgtType}" type="${tgtType}"/>
</Dtpa:dataTransferProcess>`;

  const createClient = createClientFromEnv();
  const createCsrf = await createClient.getCsrfToken();
  await createClient.rawPost(
    `/sap/bw/modeling/dtpa/${dtpLower}?lockHandle=${lockHandle}`,
    postBody,
    {
      'Development-Class': pkg,
      'Content-Type': MEDIA_TYPES['dtpa'],
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': createCsrf,
    }
  );

  // Step 4: Explicit unlock
  const csrfToken3 = await client.getCsrfToken();
  await client.rawPost(
    `/sap/bw/modeling/dtpa/${dtpLower}?action=unlock`,
    '',
    {
      'Content-Type': MEDIA_TYPES['dtpa'],
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': csrfToken3,
    }
  );

  // Step 4b: If description or filter provided, update via Lock → GET → PUT → unlock
  if (desc || (args.filter_field && args.filter_value)) {
    const descLockCsrf = await client.getCsrfToken();
    const descLockResponse = await client.rawPost(
      `/sap/bw/modeling/dtpa/${dtpLower}?action=lock`,
      '',
      {
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': descLockCsrf,
      }
    );
    const descLockHandle = descLockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
    if (!descLockHandle) {
      throw new Error(`No <LOCK_HANDLE> in description/filter lock response:\n${descLockResponse.body}`);
    }

    // GET DTP XML (fresh client) — read timestamp
    const descGetClient = createClientFromEnv();
    const descGetResponse = await descGetClient.get(`/sap/bw/modeling/dtpa/${dtpLower}/m`, MEDIA_TYPES['dtpa']);
    const descTimestamp = descGetResponse.headers['timestamp'] ?? '';

    let descXml = descGetResponse.body;

    // Update description attribute if provided
    if (desc) {
      descXml = descXml.replace(
        /(<dtpa:dataTransferProcess\b[^>]*\bdescription=)"[^"]*"/,
        `$1"${desc}"`
      );
    }

    // Inject filter if provided
    if (args.filter_field && args.filter_value) {
      const fieldBlockRegex = new RegExp(
        `(<fields[^>]*\\bname="${args.filter_field}"[^>]*>[\\s\\S]*?)<routine\\/>`
      );
      descXml = descXml.replace(fieldBlockRegex, `$1<routine/>\n      <selection excluding="false" operator="Equal">\n        <low description="${args.filter_value}" value="${args.filter_value}"/>\n      </selection>`);
    }

    // PUT with fresh client
    const descPutClient = createClientFromEnv();
    await descPutClient.put('dtpa', dtpName, descLockHandle, descXml, descTimestamp);

    // Unlock
    const descUnlockCsrf = await client.getCsrfToken();
    await client.rawPost(
      `/sap/bw/modeling/dtpa/${dtpLower}?action=unlock`,
      '',
      {
        'Content-Type': MEDIA_TYPES['dtpa'],
        'Accept': MEDIA_TYPES['dtpa'],
        'x-csrf-token': descUnlockCsrf,
      }
    );
  }

  // Step 5: Activate
  await bwActivate(client, 'dtpa', dtpName, '');

  return JSON.stringify({
    success: true,
    dtp_name: dtpName,
    transformation: trfnName,
    source: { type: srcType, name: srcName },
    target: { type: tgtType, name: tgtName },
    package: pkg,
    message: `DTP '${dtpName}' created and activated successfully.`,
  });
}

// ── bwUpdateDtp ───────────────────────────────────────────────────────────────

export interface UpdateDtpArgs {
  dtp_name: string;
  description?: string;
  filter_field?: string;
  filter_dta_name?: string;
  filter_value?: string;
  filter_excluding?: boolean;
  filter_clear_fields?: string;
  transport?: string;
  transport_lock_holder?: string;
}

/**
 * bw_update_dtp — update a DTP (description).
 *
 * Flow: Lock → GET (fresh) → PUT (fresh) → bwActivate (handles unlock).
 */
export async function bwUpdateDtp(
  client: BwClient,
  args: UpdateDtpArgs
): Promise<string> {
  const dtpName  = args.dtp_name.toUpperCase();
  const dtpLower = args.dtp_name.toLowerCase();

  // Lock (stateful_enqueue — same pattern as bwUpdateInfoObject)
  const lockHandle = await client.lock('dtpa', dtpLower, {}, 'stateful_enqueue');

  // GET current DTP XML (fresh client) — read timestamp
  const getClient = createClientFromEnv();
  const getResponse = await getClient.get(`/sap/bw/modeling/dtpa/${dtpLower}/m`, MEDIA_TYPES['dtpa']);
  const timestamp = getResponse.headers['timestamp'] ?? '';

  // Apply modifications
  let putXml = getResponse.body;
  if (args.description !== undefined) {
    putXml = putXml.replace(
      /(<dtpa:dataTransferProcess\b[^>]*\bdescription=)"[^"]*"/,
      `$1"${args.description}"`
    );
  }
  if (args.filter_field && args.filter_value !== undefined) {
    const excluding = args.filter_excluding ? 'true' : 'false';
    // Preserve empty string (= '' filter) — do not filter(Boolean); deduplicate via Set
    const values = [...new Set(args.filter_value.split(',').map((v) => v.trim()))];
    // Empty string → self-closing <selection> (no <low>); non-empty → <low value="..."/>
    const selectionsXml = values
      .map((v) => v === ''
        ? `<selection excluding="${excluding}" operator="Equal"/>`
        : `<selection excluding="${excluding}" operator="Equal">\n        <low description="${v}" value="${v}"/>\n      </selection>`)
      .join('\n      ') + '\n      ';
    // 1. Mark field as selected
    putXml = putXml.replace(
      new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"(?![^>]*\\bselected="true")[^>]*)(>)`),
      `$1 selected="true"$2`
    );
    // 2. Remove any existing <selection> elements
    putXml = putXml.replace(
      new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"[^>]*>)(<selection[^\\s/>][^>]*>[\\s\\S]*?<\\/selection>|<selection[^>]*\\/?>)\\s*(?=<(?:infoObject|operators))`,'g'),
      '$1'
    );
    // 3. Remove <routine/> if already present (to avoid duplicates)
    putXml = putXml.replace(
      new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"[^>]*>)<routine\\/>`),
      '$1'
    );
    // 4. Insert <routine/> + selections before <infoObject> (InfoObject fields) or <operators> (plain fields)
    putXml = putXml.replace(
      new RegExp(`(<fields[^>]*\\bname="${args.filter_field}"[^>]*>)(<(?:infoObject|operators))`),
      `$1<routine/>\n      ${selectionsXml}$2`
    );
  }

  if (args.filter_clear_fields) {
    const fieldsToClear = args.filter_clear_fields.split(',').map((f) => f.trim()).filter(Boolean);
    for (const fieldName of fieldsToClear) {
      // Remove selected="true"
      putXml = putXml.replace(
        new RegExp(`(<fields[^>]*\\bname="${fieldName}"[^>]*)\\s+selected="true"`),
        '$1'
      );
      // Remove all <selection> elements (self-closing and with body)
      putXml = putXml.replace(
        new RegExp(`(<fields[^>]*\\bname="${fieldName}"[^>]*>)([\\s\\S]*?)(<\\/fields>)`, 'g'),
        (_match, open, body, close) => {
          const cleaned = body
            .replace(/<selection\b[^>]*\/>/g, '')
            .replace(/<selection\b[^>]*>[\s\S]*?<\/selection>/g, '');
          return open + cleaned + close;
        }
      );
    }
  }

  // PUT on a fresh stateless client — Eclipse uses a separate stateless session for PUT
  const putClient = createClientFromEnv();
  await putClient.put('dtpa', dtpName, lockHandle, putXml, timestamp, args.transport, args.transport_lock_holder);

  // Activate — handles unlock
  await bwActivate(client, 'dtpa', dtpName, lockHandle, args.transport);

  return JSON.stringify({
    success: true,
    dtp_name: dtpName,
    message: `DTP '${dtpName}' updated and activated successfully.`,
  });
}

// ── bwSetDtpFilterRoutine ─────────────────────────────────────────────────────

export interface SetDtpFilterRoutineArgs {
  dtp_name: string;
  field_name: string;
  routine_code: string;
  global_code?: string;
}

/**
 * bw_set_dtp_filter_routine — set an ABAP filter routine on a DTP filter field.
 *
 * Flow:
 *   1. Lock (no CREA)
 *   2. POST generateRoutineProgram → ABAP program name from Location header
 *   3. ADT activate the ABAP program (fresh client)
 *   4. GET routineReports → read back routine XML
 *   5. DELETE routineReports (mandatory cleanup)
 *   6. GET DTP XML (fresh client, read timestamp)
 *   7. Convert routineReports XML → DTP PUT format, inject into <fields> block
 *   8. PUT DTP XML (fresh client)
 *   9. bwActivate with lockHandle
 */
export async function bwSetDtpFilterRoutine(
  client: BwClient,
  args: SetDtpFilterRoutineArgs
): Promise<string> {
  const dtpUpper = args.dtp_name.toUpperCase();
  const dtpLower = args.dtp_name.toLowerCase();
  const fieldName = args.field_name;

  // Step 1: Lock (no CREA)
  const lockCsrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${dtpLower}?action=lock`,
    '',
    {
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': lockCsrf,
    }
  );
  const lockHandle = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1] ?? '';
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }

  // Step 2: POST generateRoutineProgram
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const codeLines = args.routine_code.split('\n');
  const codeXml = codeLines.map(l => `    <line>${escapeXml(l)}</line>`).join('\n');

  let globalXml = '';
  if (args.global_code) {
    const globalLines = args.global_code.split('\n');
    globalXml = `  <globalCode>\n${globalLines.map(l => `    <line>${escapeXml(l)}</line>`).join('\n')}\n  </globalCode>\n`;
  }

  const routineBody = `<routine>\n${globalXml}  <code>\n${codeXml}\n  </code>\n</routine>`;

  const genCsrf = await client.getCsrfToken();
  const genResponse = await client.rawPost(
    `/sap/bw/modeling/dtpa/${dtpUpper}/${fieldName}/generateRoutineProgram`,
    routineBody,
    {
      'Content-Type': 'application/vnd.sap.bw.modeling.dtpa.routine.code-v1_0_0+xml',
      'Accept': MEDIA_TYPES['dtpa'],
      'x-csrf-token': genCsrf,
    }
  );

  const genLocation = genResponse.headers['location'] ?? genResponse.headers['Location'] ?? '';
  if (!genLocation) {
    throw new Error(`generateRoutineProgram returned no Location header. Headers: ${JSON.stringify(genResponse.headers)}`);
  }
  const encodedProgram = genLocation.split('/routineReports/').pop() ?? '';
  const programName = decodeURIComponent(encodedProgram);

  // Step 3: ADT activate ABAP program (fresh client for session isolation)
  const urlEncodedProgram = encodeURIComponent(programName).toLowerCase();
  const adtClient = createClientFromEnv();
  const adtCsrf = await adtClient.getCsrfToken();
  const adtBody =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
    `  <adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/${urlEncodedProgram}"\n` +
    `                           adtcore:name="${programName.toUpperCase()}"/>\n` +
    `</adtcore:objectReferences>`;
  await adtClient.rawPost(
    '/sap/bc/adt/activation?method=activate&preauditRequested=true',
    adtBody,
    {
      'Content-Type': 'application/xml',
      'Accept': 'application/xml',
      'x-csrf-token': adtCsrf,
    }
  );

  // Step 4: GET routineReports (read back routine code as XML)
  const routineGetClient = createClientFromEnv();
  const routineGetResponse = await routineGetClient.get(
    `/sap/bw/modeling/dtpa/${dtpUpper}/${fieldName}/routineReports/${encodedProgram}`,
    MEDIA_TYPES['dtpa']
  );
  const routineXml = routineGetResponse.body;

  // Step 5: DELETE routineReports (mandatory cleanup)
  await client.rawDelete(
    `/sap/bw/modeling/dtpa/${dtpUpper}/${fieldName}/routineReports/${encodedProgram}`,
    {
      'Content-Type': MEDIA_TYPES['dtpa'],
      'Accept': MEDIA_TYPES['dtpa'],
    }
  );

  // Step 6: GET current DTP XML (fresh client, read timestamp)
  const dtpGetClient = createClientFromEnv();
  const dtpGetResponse = await dtpGetClient.get(
    `/sap/bw/modeling/dtpa/${dtpLower}/m`,
    MEDIA_TYPES['dtpa']
  );
  const timestamp = dtpGetResponse.headers['timestamp'] ?? '';

  // Step 7: Convert routineReports XML → DTP PUT format
  // Extract code lines from <code>...</code>
  const codeSection = routineXml.match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? '';
  const extractedCodeLines = [...codeSection.matchAll(/<line>([\s\S]*?)<\/line>/g)].map(m => m[1]);

  // Extract global lines from <globalCode>...</globalCode>
  const globalSection = routineXml.match(/<globalCode>([\s\S]*?)<\/globalCode>/)?.[1] ?? '';
  const extractedGlobalLines = [...globalSection.matchAll(/<line>([\s\S]*?)<\/line>/g)].map(m => m[1]);

  // <line> → <code>, empty lines → <code xsi:nil="true"/>
  const codeElements = extractedCodeLines
    .map(line => (line ? `<code>${line}</code>` : `<code xsi:nil="true"/>`))
    .join('\n        ');

  const routineInjection = `<routine>\n        ${codeElements}\n      </routine>`;

  // <globalCode><line> → <globalRoutineCode>
  const globalElements = extractedGlobalLines
    .map(line => `    <globalRoutineCode>${line}</globalRoutineCode>`)
    .join('\n');

  // Step 8: Inject into DTP XML
  let putXml = dtpGetResponse.body;

  // Fix 3: Add selected="true" to the matching <fields> element if not already present
  putXml = putXml.replace(
    new RegExp(`(<fields[^>]*\\bname="${fieldName}"(?![^>]*\\bselected="true")[^>]*)(>)`),
    `$1 selected="true"$2`
  );

  // Fix 1: Inject <routine> before the first <operators> inside the matching fields block.
  // Remove any existing <routine/> or <routine>...</routine> first, then inject before <operators>.
  putXml = putXml.replace(
    new RegExp(`(<fields[^>]*\\bname="${fieldName}"[^>]*>[\\s\\S]*?)<routine\\s*\\/>`),
    '$1'
  );
  putXml = putXml.replace(
    new RegExp(`(<fields[^>]*\\bname="${fieldName}"[^>]*>[\\s\\S]*?)(<operators)`),
    `$1${routineInjection}\n      $2`
  );

  // Fix 2: Remove all existing <globalRoutineCode> elements before inserting new ones
  putXml = putXml.replace(/<globalRoutineCode>[^<]*<\/globalRoutineCode>\s*/g, '');

  // Append globalRoutineCode elements before </filter>
  if (globalElements) {
    putXml = putXml.replace('</filter>', `${globalElements}\n  </filter>`);
  }

  // PUT with fresh client
  const putClient = createClientFromEnv();
  await putClient.put('dtpa', dtpUpper, lockHandle, putXml, timestamp);

  // Step 9: Activate (activation framework handles unlock for dtpa)
  await bwActivate(client, 'dtpa', dtpUpper, lockHandle);

  return JSON.stringify({
    success: true,
    dtp_name: dtpUpper,
    field_name: fieldName,
    message: `Filter routine for field '${fieldName}' on DTP '${dtpUpper}' set and activated successfully.`,
  });
}
