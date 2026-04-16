import { BwClient, MEDIA_TYPES, createClientFromEnv } from '../bw-client.js';
import { parseInfoObjectProps } from './infoobject.js';

const TRFN_ACCEPT = MEDIA_TYPES['trfn'];

// ── bwCreateTransformation ────────────────────────────────────────────────────

export interface CreateTransformationArgs {
  source_object_type: string;
  source_object_name: string;
  target_object_type: string;
  target_object_name: string;
  package?: string;
  source_system?: string;
  copy_from_transformation?: string;
}

/**
 * bw_create_transformation — create a new Transformation (inactive).
 *
 * Flow:
 * 1. GET 8TRANSIENT → server generates the Transformation name
 * 2. Lock (CREA)    → lockHandle
 * 3. POST minimal XML (manually constructed, per payloads/trfn_create.md)
 *
 * Returns the generated Transformation name for use with bw_activate.
 */
export async function bwCreateTransformation(
  client: BwClient,
  args: CreateTransformationArgs
): Promise<string> {
  const srcType = args.source_object_type.toUpperCase();
  const srcName = args.source_object_name.toUpperCase();
  const tgtType = args.target_object_type.toUpperCase();
  const tgtName = args.target_object_name.toUpperCase();
  const pkg     = args.package ?? '$TMP';

  // For RSDS sources: encode sourceobjectname as datasourceName.padEnd(30) + sourceSystem.padEnd(10)
  // with spaces URL-encoded as '+' for the 8TRANSIENT query parameter.
  const srcNameForUrl = srcType === 'RSDS'
    ? encodeURIComponent(srcName.padEnd(30) + (args.source_system ?? '').toUpperCase().padEnd(10)).replace(/%20/g, '+')
    : srcName;

  // Step 1: GET 8TRANSIENT → generated Transformation name
  const transientPath =
    `/sap/bw/modeling/trfn/8transient?GetIdOnly=true` +
    `&sourceobjecttype=${srcType}` +
    `&targetobjecttype=${tgtType}` +
    `&sourceobjectname=${srcNameForUrl}` +
    `&targetobjectname=${tgtName}`;

  const { body: transientXml } = await client.get(transientPath, TRFN_ACCEPT);

  const nameMatch = transientXml.match(/\bname="([^"]+)"/);
  if (!nameMatch) {
    throw new Error(`Could not extract Transformation name from 8TRANSIENT response:\n${transientXml}`);
  }
  const trfnName  = nameMatch[1].toUpperCase();
  const trfnLower = trfnName.toLowerCase();

  const language     = process.env.BW_LANGUAGE ?? 'DE';
  const masterSystem = new URL(process.env.BW_URL ?? 'http://localhost').hostname.split('.')[0].toUpperCase();
  const responsible  = (process.env.BW_USER ?? '').toUpperCase();

  // Step 2: Lock with CREA — exact Eclipse header set, no SAP session headers
  const csrfToken = await client.getCsrfToken();
  const lockPath = `/sap/bw/modeling/trfn/${trfnLower}?action=lock`;
  const lockResponse = await client.rawPost(lockPath, '', {
    'activity_context': 'CREA',
    'Accept': TRFN_ACCEPT,
    'x-csrf-token': csrfToken,
  });
  const lockHandleMatch = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  if (!lockHandleMatch) {
    throw new Error(`No <LOCK_HANDLE> in lock response:\n${lockResponse.body}`);
  }
  const lockHandle = lockHandleMatch[1];

  // Step 3: POST minimal XML (manually constructed — see payloads/trfn_create.md)
  const postBody = `<?xml version="1.0" encoding="UTF-8"?>
<trfn:transformation
  xmlns:adtcore="http://www.sap.com/adt/core"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:trfn="http://www.sap.com/bw/modeling/Trfn.ecore"
  description=""
  endRoutine=""
  expertRoutine=""
  name="${trfnName}"
  startRoutine="">
  <tlogoProperties
    adtcore:language="${language}"
    adtcore:name="${trfnName}"
    adtcore:type="TRFN"
    adtcore:version="inactive"
    adtcore:masterLanguage="${language}"
    adtcore:masterSystem="${masterSystem}"
    adtcore:responsible="${responsible}">
    <atom:link
      href="/sap/bw/modeling/trfn/${trfnLower}/m"
      rel="self"
      type="application/vnd.sap-bw-modeling.trfn+xml"/>
    <objectVersion>M</objectVersion>
    <objectStatus>inactive</objectStatus>
    <contentState>NEW</contentState>
  </tlogoProperties>
  <source description="" id="0" name="${srcType === 'RSDS' ? srcName.padEnd(30) + (args.source_system ?? '').toUpperCase().padEnd(10) : srcName}" type="${srcType}"/>
  <target description="" id="0" name="${tgtName}" type="${tgtType}"/>
</trfn:transformation>`;

  const copyParams = args.copy_from_transformation
    ? `&copyFromObjectName=${args.copy_from_transformation.toUpperCase()}&copyFromObjectType=TRFN`
    : '';
  const createPath = `/sap/bw/modeling/trfn/${trfnLower}?lockHandle=${lockHandle}${copyParams}`;

  // Session B: eigene Session + CSRF-Token, POST mit lockHandle aus Session A
  const client2 = createClientFromEnv();
  await client2.getCsrfToken();
  await client2.postWithCsrf(
    createPath,
    postBody,
    TRFN_ACCEPT,
    { 'Development-Class': pkg },
    true,
  );

  // Step 4: Verify persisted
  try {
    await client.get(`/sap/bw/modeling/trfn/${trfnLower}/m`, TRFN_ACCEPT);
  } catch {
    throw new Error(
      `Transformation '${trfnName}' was not persisted after creation ` +
      `(GET /sap/bw/modeling/trfn/${trfnLower}/m returned 404).`
    );
  }

  // Step 5: Unlock (CREA lock is no longer needed after successful creation)
  try {
    await client.unlock('trfn', trfnLower);
  } catch (unlockErr) {
    process.stderr.write(`Warning: failed to unlock trfn/${trfnLower} after creation: ${unlockErr}\n`);
  }

  return JSON.stringify({
    success: true,
    transformation_name: trfnName,
    source: { type: srcType, name: srcName },
    target: { type: tgtType, name: tgtName },
    package: pkg,
    message: `Transformation '${trfnName}' created inactive. Call bw_activate with object_type "trfn" to activate.`,
  });
}

/**
 * bw_get_transformation — read a Transformation (inactive version).
 * Returns raw XML + status + timestamp.
 * Note: Transformation name is a UUID-like generated key, not human-readable.
 */
export async function bwGetTransformation(
  client: BwClient,
  transformationName: string,
  raw?: boolean,
): Promise<string> {
  const path = `/sap/bw/modeling/trfn/${transformationName.toLowerCase()}/m`;
  const result = await client.get(path, TRFN_ACCEPT);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  const xml = result.body;
  if (raw) {
    return `Transformation: ${transformationName.toUpperCase()}\nStatus: ${status}\nTimestamp: ${ts}\n\n${xml}`;
  }
  return summarizeTransformation(transformationName.toUpperCase(), status, ts, xml);
}

/**
 * Parse the transformation XML and return a compact human-readable summary.
 * Extracts: source/target, routine info, and per-field mapping rules.
 */
function summarizeTransformation(
  name: string,
  status: string,
  timestamp: string,
  xml: string
): string {
  const lines: string[] = [];
  lines.push(`Transformation: ${name}`);
  lines.push(`Status: ${status}`);
  lines.push(`Timestamp: ${timestamp}`);

  // ── Header attributes ─────────────────────────────────────────────────────
  const attr = (key: string) =>
    xml.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '';

  const description      = attr('description');
  const startRoutine     = attr('startRoutine');
  const endRoutine       = attr('endRoutine');
  const expertRoutine    = attr('expertRoutine');
  const abapProgram      = attr('abapProgram');
  const hanaExec         = attr('sapHANAExecutionPossible');

  if (description)  lines.push(`Description: ${description}`);
  if (abapProgram)  lines.push(`ABAP Program: ${abapProgram}`);
  if (hanaExec)     lines.push(`HANA Execution: ${hanaExec}`);

  // ── Source / Target ───────────────────────────────────────────────────────
  const srcMatch = xml.match(/<source\b[^>]*id="0"[^>]*name="([^"]+)"[^>]*(?:description="([^"]*)")?[^>]*type="([^"]+)"/);
  const tgtMatch = xml.match(/<target\b[^>]*id="0"[^>]*name="([^"]+)"[^>]*(?:description="([^"]*)")?[^>]*type="([^"]+)"/);
  if (srcMatch) lines.push(`Source: ${srcMatch[3]} ${srcMatch[1]}${srcMatch[2] ? ' (' + srcMatch[2] + ')' : ''}`);
  if (tgtMatch) lines.push(`Target: ${tgtMatch[3]} ${tgtMatch[1]}${tgtMatch[2] ? ' (' + tgtMatch[2] + ')' : ''}`);

  // ── Routines ──────────────────────────────────────────────────────────────
  // Also scan rule groups for routinetype=START/END/EXPERT (modern BW/4 style)
  const ruleMatches = [...xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)];

  function findGroupRoutine(type: string): string {
    for (const rm of ruleMatches) {
      const rt = rm[1].match(/routinetype="([^"]*)"/)?.[1] ?? '';
      if (rt.toUpperCase() !== type) continue;
      const sAttrs = rm[2].match(/<step\b([^>]*)/)?.[1] ?? '';
      const cls    = sAttrs.match(/classNameM="([^"]*)"/)?.[1] ?? '';
      const mth    = sAttrs.match(/methodNameM="([^"]*)"/)?.[1] ?? '';
      if (cls) return `${cls}.${mth}`;
    }
    return '';
  }

  const startRef  = startRoutine  || findGroupRoutine('START');
  const endRef    = endRoutine    || findGroupRoutine('END');
  const expertRef = expertRoutine || findGroupRoutine('EXPERT');

  lines.push('');
  lines.push('── Routines ──');
  lines.push(`  startRoutine:  ${startRef  || '(none)'}`);
  lines.push(`  endRoutine:    ${endRef    || '(none)'}`);
  lines.push(`  expertRoutine: ${expertRef || '(none)'}`);

  if (ruleMatches.length > 0) {
    lines.push('');
    lines.push('── Field Mappings ──');
    for (const rm of ruleMatches) {
      const ruleAttrs   = rm[1];
      const ruleBody    = rm[2];
      const routinetype = ruleAttrs.match(/routinetype="([^"]*)"/)?.[1] ?? '';

      // Step attributes — use [^>]* so slashes in classNameM paths don't break capture
      const stepMatch   = ruleBody.match(/<step\b([^>]*)/);
      const stepAttrs   = stepMatch?.[1] ?? '';
      const xsiType     = stepAttrs.match(/xsi:type="trfn:Step([^"]+)"/)?.[1] ?? '';
      const stepType    = (stepAttrs.match(/\btype="([^"]*)"/)?.[1] ?? routinetype) || xsiType;
      const classNameM  = stepAttrs.match(/classNameM="([^"]*)"/)?.[1] ?? '';
      const methodNameM = stepAttrs.match(/methodNameM="([^"]*)"/)?.[1] ?? '';
      const constant    = stepAttrs.match(/\bconstant="([^"]*)"/)?.[1] ?? '';

      // Extract source fields from <elementRef>#///source/segment1/FIELD
      const srcFields = [...ruleBody.matchAll(/elementRef>#\/\/\/source\/[^/]+\/([^<]+)<\/elementRef>/g)]
        .map(m => m[1]);
      // Extract target fields from <elementRef>#///target/segment1/FIELD
      const tgtFields = [...ruleBody.matchAll(/elementRef>#\/\/\/target\/[^/]+\/([^<]+)<\/elementRef>/g)]
        .map(m => m[1]);

      const src = srcFields.length > 0 ? srcFields.join(', ') : '(none)';
      const tgt = tgtFields.length > 0 ? tgtFields.join(', ') : '(none)';

      let label = stepType || xsiType || '?';
      // Show routinetype when it adds info not already in the label
      if (routinetype && !label.toUpperCase().includes(routinetype.toUpperCase())) {
        label += ` [${routinetype}]`;
      }
      if (classNameM)  label += ` | ${classNameM}.${methodNameM}`;
      if (constant)    label += ` = "${constant}"`;

      // Extract filter conditions on this rule
      const filterParts: string[] = [];
      for (const fm of ruleBody.matchAll(/<filter\b([^>]*?)(?:\/>|>)/g)) {
        const fa   = fm[1];
        const sign = fa.match(/\bsign="([^"]+)"/)?.[1] ?? '';
        const opt  = fa.match(/\boption="([^"]+)"/)?.[1] ?? '';
        const low  = fa.match(/\blow="([^"]+)"/)?.[1] ?? '';
        const high = fa.match(/\bhigh="([^"]+)"/)?.[1] ?? '';
        const part = high ? `${sign}${opt}[${low},${high}]` : `${sign}${opt}${low}`;
        if (part.trim()) filterParts.push(part);
      }
      const filterSuffix = filterParts.length > 0 ? `  {FILTER: ${filterParts.join('; ')}}` : '';

      lines.push(`  [${label}]  ${src}  →  ${tgt}${filterSuffix}`);

      // Show formula code inline (StepFormula)
      // Formula can be an attribute on <step formula="..."> or a child <formula> element
      const formulaCode = stepAttrs.match(/\bformula="([^"]*)"/)?.[1]?.trim()
        ?? ruleBody.match(/<formula\b[^>]*>([\s\S]*?)<\/formula>/)?.[1]?.trim()
        ?? ruleBody.match(/<code\b[^>]*>([\s\S]*?)<\/code>/)?.[1]?.trim()
        ?? '';
      if (formulaCode) {
        for (const codeLine of formulaCode.split('\n')) {
          lines.push(`      ${codeLine}`);
        }
      }

      // For StepRoutine: show class/method prominently if not already in label
      if (!classNameM && (xsiType === 'Routine' || routinetype === 'ROUTINE')) {
        const routineRef = ruleBody.match(/routineName="([^"]+)"/)?.[1]
          ?? ruleBody.match(/className="([^"]+)"/)?.[1]
          ?? '';
        if (routineRef) lines.push(`      → Routine: ${routineRef}`);
      }
    }
  }

  // ── Source fields ─────────────────────────────────────────────────────────
  // Drill into the first <segment> inside <source> to get all available source fields
  const srcSegContent = xml.match(/<source\b[^>]*>[\s\S]*?<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  if (srcSegContent) {
    const srcElems = [...srcSegContent.matchAll(/<element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g)];
    if (srcElems.length > 0) {
      lines.push('');
      lines.push(`── Source Fields (${srcElems.length}) ──`);
      const keys: string[] = [];
      const vals: string[] = [];
      for (const m of srcElems) {
        const attrs  = m[1];
        const body   = m[2] ?? '';
        const name   = attrs.match(/\bname="([^"]+)"/)?.[1] ?? '';
        const isKey  = attrs.match(/\bkey="([^"]+)"/)?.[1] === 'true';
        const dt     = body.match(/<inlineType\b[^>]*name="([^"]+)"/)?.[1] ?? '';
        const entry  = dt ? `${name}(${dt})` : name;
        if (isKey) keys.push(entry); else vals.push(entry);
      }
      if (keys.length) lines.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
      if (vals.length) lines.push(`  Value fields (${vals.length}): ${vals.join(', ')}`);
    }
  }

  // ── Target fields ─────────────────────────────────────────────────────────
  const tgtSegContent = xml.match(/<target\b[^>]*>[\s\S]*?<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  if (tgtSegContent) {
    const tgtElems = [...tgtSegContent.matchAll(/<element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/element>)/g)];
    if (tgtElems.length > 0) {
      lines.push('');
      lines.push(`── Target Fields (${tgtElems.length}) ──`);
      const keys: string[] = [];
      const vals: string[] = [];
      for (const m of tgtElems) {
        const attrs  = m[1];
        const body   = m[2] ?? '';
        const name   = attrs.match(/\bname="([^"]+)"/)?.[1] ?? '';
        const isKey  = attrs.match(/\bkey="([^"]+)"/)?.[1] === 'true';
        const dt     = body.match(/<inlineType\b[^>]*name="([^"]+)"/)?.[1] ?? '';
        const conv   = attrs.match(/\bconversionRoutine="([^"]+)"/)?.[1] ?? '';
        const entry  = [name, dt ? `(${dt})` : '', conv ? `[${conv}]` : ''].filter(Boolean).join('');
        if (isKey) keys.push(entry); else vals.push(entry);
      }
      if (keys.length) lines.push(`  Key fields (${keys.length}): ${keys.join(', ')}`);
      if (vals.length) lines.push(`  Value fields (${vals.length}): ${vals.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ── XML helpers ──────────────────────────────────────────────────────────────

/**
 * Extract source field properties from the transformation's <source><segment> section.
 */
function extractSourceFieldProps(
  xml: string,
  fieldName: string
): { dataType: string; length: string } {
  // Match the first <source> > <segment> block
  const srcSegMatch = xml.match(/<source\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!srcSegMatch) return { dataType: 'CHAR', length: '20' };

  const segContent = srcSegMatch[1];
  // Find the element with the matching name
  const elemRegex = new RegExp(
    `<element\\b[^>]*name="${fieldName.toUpperCase()}"[^>]*>([\\s\\S]*?)<\\/element>`
  );
  const elemMatch = segContent.match(elemRegex);
  if (!elemMatch) return { dataType: 'CHAR', length: '20' };

  const inlineMatch = elemMatch[1].match(
    /<inlineType[^>]*name="([^"]+)"[^>]*length="([^"]+)"/
  );
  return {
    dataType: inlineMatch?.[1] ?? 'CHAR',
    length: inlineMatch?.[2] ?? '20',
  };
}

/**
 * Extract target InfoObject properties from the transformation's <target><segment> section.
 */
function extractTargetElemProps(
  xml: string,
  iObjName: string
): { convRoutine: string; dataType: string; length: string } {
  const tgtSegMatch = xml.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!tgtSegMatch) return { convRoutine: '', dataType: 'CHAR', length: '20' };

  const segContent = tgtSegMatch[1];
  const elemRegex = new RegExp(
    `<element\\b([^>]*infoObjectName="${iObjName.toUpperCase()}"[^>]*)>([\\s\\S]*?)<\\/element>`
  );
  const elemMatch = segContent.match(elemRegex);
  if (!elemMatch) return { convRoutine: '', dataType: 'CHAR', length: '20' };

  const attrStr = elemMatch[1];
  const bodyStr = elemMatch[2];
  const convMatch = attrStr.match(/conversionRoutine="([^"]+)"/);
  const inlineMatch = bodyStr.match(/<inlineType[^>]*name="([^"]+)"[^>]*length="([^"]+)"/);

  return {
    convRoutine: convMatch?.[1] ?? '',
    dataType: inlineMatch?.[1] ?? 'CHAR',
    length: inlineMatch?.[2] ?? '20',
  };
}

/**
 * Find the rule that targets the given InfoObject with a StepNoUpdate step,
 * and return its id, its group id, and the full original rule XML to replace.
 */
function findNoUpdateRule(
  xml: string,
  targetInfoObject: string
): { ruleId: string; groupId: string; oldRuleXml: string } | null {
  // Extract group element and its id
  const groupMatch = xml.match(/<group\s+id="(\d+)"[^>]*>([\s\S]*?)<\/group>/);
  if (!groupMatch) return null;
  const groupId = groupMatch[1];
  const groupContent = groupMatch[0]; // full <group>...</group> including tags

  const target = targetInfoObject.toUpperCase();
  const ruleRegex = /<rule(\s[^>]*)>([\s\S]*?)<\/rule>/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(groupContent)) !== null) {
    const attrStr = match[1];
    const body = match[2];
    const ruleIdMatch = attrStr.match(/id="(\d+)"/);

    const targetsIObj = body.includes(`/target/segment1/${target}</elementRef>`);
    const isNoUpdate =
      body.includes('StepNoUpdate') || body.includes('NO_UPDATE') ||
      body.includes('StepInitial')  || body.includes('type="INITIAL"');

    if (targetsIObj && isNoUpdate) {
      return {
        ruleId: ruleIdMatch?.[1] ?? '',
        groupId,
        oldRuleXml: match[0],
      };
    }
  }
  return null;
}

type StepType = 'DIRECT' | 'INITIAL' | 'NO_UPDATE' | 'ROUTINE' | 'FORMULA' | 'CONSTANT' | 'READ';

/**
 * Find any rule that targets the given InfoObject (any known step type).
 * Used by the routine/formula/direct conversion paths.
 */
function findRuleForTarget(
  xml: string,
  targetInfoObject: string
): { ruleId: string; groupId: string; oldRuleXml: string; stepType: StepType } | null {
  const groupMatch = xml.match(/<group\s+id="(\d+)"[^>]*>([\s\S]*?)<\/group>/);
  if (!groupMatch) return null;
  const groupId = groupMatch[1];
  const groupContent = groupMatch[0];

  const target = targetInfoObject.toUpperCase();
  const ruleRegex = /<rule(\s[^>]*)>([\s\S]*?)<\/rule>/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(groupContent)) !== null) {
    const attrStr = match[1];
    const body = match[2];
    const ruleIdMatch = attrStr.match(/id="(\d+)"/);

    const targetsIObj = body.includes(`/target/segment1/${target}</elementRef>`);
    if (!targetsIObj) continue;

    let stepType: StepType | null = null;
    if (body.includes('StepNoUpdate') || body.includes('type="NO_UPDATE"')) stepType = 'NO_UPDATE';
    else if (body.includes('StepInitial') || body.includes('type="INITIAL"')) stepType = 'INITIAL';
    else if (body.includes('StepDirect') || body.includes('type="DIRECT"')) stepType = 'DIRECT';
    else if (body.includes('StepRoutine') || body.includes('type="ROUTINE"')) stepType = 'ROUTINE';
    else if (body.includes('StepFormula') || body.includes('type="FORMULA"')) stepType = 'FORMULA';
    else if (body.includes('StepConstant') || body.includes('type="CONSTANT"')) stepType = 'CONSTANT';
    else if (body.includes('StepRead') || body.includes('type="READ"')) stepType = 'READ';

    if (stepType) {
      return {
        ruleId: ruleIdMatch?.[1] ?? '',
        groupId,
        oldRuleXml: match[0],
        stepType,
      };
    }
  }
  return null;
}

/** Escape a string for use in an XML attribute value. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a StepDirect or StepInitial rule to StepRoutine via string replacements.
 * Input/output element content stays identical — only step type, id, and references change.
 */
function convertDirectOrInitialRuleToRoutine(ruleXml: string): string {
  let r = ruleXml;
  // 1. Update step1 → step2 in all #/// references within the rule
  r = r.replace(/\/step1\//g, '/step2/');
  // 2. Add performConversionExit to <target id="1">
  r = r.replace(/<target(\s+id="1")[^>]*>/, '<target$1 performConversionExit="NOT_SUPPORTED">');
  // 3. Change xsi:type on the step element
  r = r.replace('xsi:type="trfn:StepDirect"', 'xsi:type="trfn:StepRoutine"');
  r = r.replace('xsi:type="trfn:StepInitial"', 'xsi:type="trfn:StepRoutine"');
  // 4. Change id="1" → id="2" on the <step element only (requires leading space before id)
  r = r.replace(/(<step\b[^>]*\s)id="1"/, '$1id="2"');
  // 5. Change type="DIRECT"/"INITIAL" → type="ROUTINE" on the <step element
  //    Use \s before type= to avoid matching xsi:type=
  r = r.replace(/(<step\b[^>]*\s)type="(?:DIRECT|INITIAL)"/, '$1type="ROUTINE"');
  return r;
}

/**
 * Convert a StepDirect or StepInitial rule to StepFormula via string replacements.
 * Structurally identical to the routine conversion but sets StepFormula + formula attribute.
 */
function convertDirectOrInitialRuleToFormula(ruleXml: string, formula: string): string {
  let r = ruleXml;
  // 1. Update step1 → step2 in all #/// references within the rule
  r = r.replace(/\/step1\//g, '/step2/');
  // 2. Add performConversionExit to <target id="1">
  r = r.replace(/<target(\s+id="1")[^>]*>/, '<target$1 performConversionExit="NOT_SUPPORTED">');
  // 3. Change xsi:type on the step element
  r = r.replace('xsi:type="trfn:StepDirect"', 'xsi:type="trfn:StepFormula"');
  r = r.replace('xsi:type="trfn:StepInitial"', 'xsi:type="trfn:StepFormula"');
  // 4. Change id="1" → id="2" on the <step element only
  r = r.replace(/(<step\b[^>]*\s)id="1"/, '$1id="2"');
  // 5. Change type="DIRECT"/"INITIAL" → type="FORMULA" and append formula attribute
  r = r.replace(
    /(<step\b[^>]*\s)type="(?:DIRECT|INITIAL)"/,
    `$1type="FORMULA" formula="${escapeXmlAttr(formula)}"`,
  );
  return r;
}

/**
 * Build a StepFormula rule from a StepNoUpdate rule.
 * Reuses the existing step output element and adds a new source input element.
 */
function buildNoUpdateToFormulaRule(
  ruleXml: string,
  groupId: string,
  ruleId: string,
  targetInfoObject: string,
  sourceField: string,
  srcType: string,
  srcLength: string,
  formula: string,
): string {
  // Extract the step <output> block — its content stays unchanged
  const stepMatch = ruleXml.match(/<step\b[^>]*>([\s\S]*?)<\/step>/);
  if (!stepMatch) throw new Error('Cannot parse step from StepNoUpdate rule');
  const stepOutputBlock = stepMatch[1].trim();

  const src = sourceField.toUpperCase();
  const tgt = targetInfoObject.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  return `<rule id="${rv}" description="">
      <source id="1">
        <input>#///group${g}/rule${rv}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target id="1" performConversionExit="NOT_SUPPORTED">
        <output>#///group${g}/rule${rv}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepFormula" id="2" rank="MAIN" type="FORMULA" formula="${escapeXmlAttr(formula)}">
        <input id="1">
          <output>#///group${g}/rule${rv}/source1</output>
          <element name="${src}">
            <endUserTexts label="${src}"/>
            <inlineType name="${srcType}" length="${srcLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <associationType>1</associationType>
            <associationValid>false</associationValid>
          </element>
        </input>
        ${stepOutputBlock}
      </step>
    </rule>`;
}

/**
 * Convert any rule (StepDirect, StepInitial, StepNoUpdate) to StepConstant.
 * - Removes the <source> element from the rule (constants have no source)
 * - Removes the <input id="..."> element from within the step
 * - Keeps the step <output> element unchanged
 * - Sets xsi:type="trfn:StepConstant", id="2", type="CONSTANT", constant="<value>"
 * - Adds performConversionExit="NOT_SUPPORTED" to <target>
 * - Updates step1 → step2 references
 */
function convertRuleToConstant(ruleXml: string, constantValue: string): string {
  let r = ruleXml;
  // 1. Remove <source ...>...</source> element from the rule (not needed for constants)
  r = r.replace(/<source\b[^>]*>[\s\S]*?<\/source>/, '');
  // 2. Update step1 → step2 in all #/// references
  r = r.replace(/\/step1\//g, '/step2/');
  // 3. Add performConversionExit to <target id="1">
  r = r.replace(/<target(\s+id="1")[^>]*>/, '<target$1 performConversionExit="NOT_SUPPORTED">');
  // 4. Remove <input id="...">...</input> block from inside the step
  //    Only matches step-level inputs (id attribute present); the <input>ref</input> inside
  //    <output> elements has no attributes and is NOT affected.
  r = r.replace(
    /(<step\b[^>]*>)([\s\S]*?)(<\/step>)/,
    (_match, open, body, close) => {
      const cleanBody = body.replace(/<input\b[^>]*id="[^"]*"[^>]*>[\s\S]*?<\/input>/g, '');
      return open + cleanBody + close;
    },
  );
  // 5. Change xsi:type on the step element
  r = r.replace(
    /xsi:type="trfn:Step(?:Direct|Initial|NoUpdate)"/,
    'xsi:type="trfn:StepConstant"',
  );
  // 6. Change id="1" → id="2" on the <step element
  r = r.replace(/(<step\b[^>]*\s)id="1"/, '$1id="2"');
  // 7. Change type → CONSTANT and append constant attribute
  r = r.replace(
    /(<step\b[^>]*\s)type="(?:DIRECT|INITIAL|NO_UPDATE)"/,
    `$1type="CONSTANT" constant="${escapeXmlAttr(constantValue)}"`,
  );
  return r;
}

/**
 * Build a StepRoutine rule from a StepNoUpdate rule.
 * Reuses the existing step output element and adds a new source input element.
 */
function buildNoUpdateToRoutineRule(
  ruleXml: string,
  groupId: string,
  ruleId: string,
  targetInfoObject: string,
  sourceField: string,
  srcType: string,
  srcLength: string,
): string {
  // Extract the step <output> block — its content (element + input ref to target1) stays unchanged
  const stepMatch = ruleXml.match(/<step\b[^>]*>([\s\S]*?)<\/step>/);
  if (!stepMatch) throw new Error('Cannot parse step from StepNoUpdate rule');
  const stepOutputBlock = stepMatch[1].trim();

  const src = sourceField.toUpperCase();
  const tgt = targetInfoObject.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  return `<rule id="${rv}" description="">
      <source id="1">
        <input>#///group${g}/rule${rv}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target id="1" performConversionExit="NOT_SUPPORTED">
        <output>#///group${g}/rule${rv}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepRoutine" id="2" rank="MAIN" type="ROUTINE">
        <input id="1">
          <output>#///group${g}/rule${rv}/source1</output>
          <element name="${src}">
            <endUserTexts label="${src}"/>
            <inlineType name="${srcType}" length="${srcLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <associationType>1</associationType>
            <associationValid>false</associationValid>
          </element>
        </input>
        ${stepOutputBlock}
      </step>
    </rule>`;
}

/**
 * Build a StepRead (Nachlesen) rule to replace any existing rule.
 */
function buildLookupRule(
  _ruleXml: string,
  groupId: string,
  ruleId: string,
  targetInfoObject: string,
  sourceField: string,
  lookupObject: string,
  lookupObjectType: string,
): string {
  const src = sourceField.toUpperCase();
  const tgt = targetInfoObject.toUpperCase();
  const g = groupId;
  const rv = ruleId;

  return `<rule id="${rv}" description="">
      <source id="1">
        <input>#///group${g}/rule${rv}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target id="1" performConversionExit="NOT_SUPPORTED">
        <output>#///group${g}/rule${rv}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepRead" id="2" rank="MAIN" type="READ" objectName="${lookupObject}" objectType="${lookupObjectType}">
        <input id="1">
          <output>#///group${g}/rule${rv}/source1</output>
          <element name="${src}" infoObjectName="${src}">
            <inlineType name="CHAR" length="22" semanticType="date" globalElementName="${src}"/>
          </element>
        </input>
        <output id="1">
          <input>#///group${g}/rule${rv}/target1</input>
          <element name="${tgt}" infoObjectName="${tgt}">
            <inlineType name="CHAR" length="1" semanticType="date" globalElementName="${tgt}"/>
          </element>
        </output>
      </step>
    </rule>`;
}

/**
 * Build a StepDirect rule XML to replace an existing StepNoUpdate rule.
 * Based on the exact structure from adso_workflow.md Block 6b.
 */
function buildStepDirectRule(params: {
  groupId: string;
  ruleId: string;
  sourceField: string;
  targetIObj: string;
  srcType: string;
  srcLength: string;
  tgtConvRoutine: string;
  tgtType: string;
  tgtLength: string;
  tgtLabel: string;
}): string {
  const {
    groupId, ruleId, sourceField, targetIObj,
    srcType, srcLength, tgtConvRoutine, tgtType, tgtLength, tgtLabel,
  } = params;

  const src = sourceField.toUpperCase();
  const tgt = targetIObj.toUpperCase();
  const tgtLower = targetIObj.toLowerCase();
  const convAttr = tgtConvRoutine ? ` conversionRoutine="${tgtConvRoutine}"` : '';

  return `<rule id="${ruleId}" description="">
      <source id="1">
        <input>#///group${groupId}/rule${ruleId}/step2/input1</input>
        <elementRef>#///source/segment1/${src}</elementRef>
      </source>
      <target performConversionExit="NO" id="1">
        <output>#///group${groupId}/rule${ruleId}/step2/output1</output>
        <elementRef>#///target/segment1/${tgt}</elementRef>
      </target>
      <step xsi:type="trfn:StepDirect" id="2" type="DIRECT" rank="MAIN">
        <input id="1">
          <output>#///group${groupId}/rule${ruleId}/source1</output>
          <element name="${src}">
            <endUserTexts label="${src}"/>
            <inlineType name="${srcType}" length="${srcLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <associationType>1</associationType>
            <associationValid>false</associationValid>
          </element>
        </input>
        <output id="1">
          <input>#///group${groupId}/rule${ruleId}/target1</input>
          <element xsi:type="trfn:TransformationElement" name="${tgt}"
            infoObjectName="${tgt}"${convAttr}
            dimension="#///target/segment1/ALL§">
            <endUserTexts label="${tgtLabel}"/>
            <inlineType name="${tgtType}" length="${tgtLength}" semanticType="empty"/>
            <localProperties xsi:type="BwCore:LocalCharacteristicProperties"/>
            <atom:link href="/sap/bw/modeling/iobj/${tgtLower}/a" rel="self" xmlns:atom="http://www.w3.org/2005/Atom"/>
            <associationType>1</associationType>
            <associationValid>true</associationValid>
          </element>
        </output>
      </step>
    </rule>`;
}

/**
 * Convert any existing rule back to StepNoUpdate (no mapping).
 * Preserves the target reference and step output element from the existing rule.
 */
function buildNoUpdateRule(ruleXml: string, ruleId: string): string {
  // Extract <target ...>...</target> block
  const targetMatch = ruleXml.match(/<target\b[^>]*>[\s\S]*?<\/target>/);
  if (!targetMatch) throw new Error('Cannot parse target block from rule');
  const targetBlock = targetMatch[0];

  // Extract <output id="1">...</output> from within the step
  const stepMatch = ruleXml.match(/<step\b[^>]*>([\s\S]*?)<\/step>/);
  if (!stepMatch) throw new Error('Cannot parse step from rule');
  const outputMatch = stepMatch[1].match(/<output\b[^>]*id="1"[^>]*>[\s\S]*?<\/output>/);
  if (!outputMatch) throw new Error('Cannot parse output block from step');
  const outputBlock = outputMatch[0];

  return `<rule id="${ruleId}" description="">${targetBlock}` +
    `<step xsi:type="trfn:StepNoUpdate" id="1" type="NO_UPDATE" rank="MAIN">` +
    `${outputBlock}</step></rule>`;
}

/**
 * bw_update_transformation — map a source field to a target InfoObject,
 * or convert an existing rule to a field routine (StepRoutine).
 *
 * rule_type="direct" (default):
 *   Finds any existing rule for the target InfoObject (any step type) and
 *   replaces it with StepDirect. source_field is required unless it can be
 *   inferred from the existing rule.
 *
 * rule_type="routine":
 *   Finds the rule for the target InfoObject (StepDirect, StepInitial, or
 *   StepNoUpdate) and converts it to StepRoutine. The server generates the
 *   ABAP AMDP class automatically. For StepNoUpdate rules, source_field is
 *   required; for StepDirect/StepInitial it is ignored.
 *
 * rule_type="formula":
 *   Finds the rule for the target InfoObject (StepDirect, StepInitial, or
 *   StepNoUpdate) and converts it to StepFormula. The formula parameter is
 *   required. For StepNoUpdate rules, source_field is also required.
 *   No ABAP class is generated — the BW runtime evaluates the formula natively.
 *   Use /BIC/FIELDNAME for custom InfoObject fields in the formula expression.
 *
 * Workflow: read InfoObject → GET Transformation → Lock → replace rule → PUT
 * Returns lockHandle for bw_activate.
 */
export async function bwUpdateTransformation(
  client: BwClient,
  transformationName: string,
  sourceField: string | undefined,
  targetInfoObject: string,
  ruleType: 'direct' | 'routine' | 'formula' | 'constant' | 'lookup' | 'no_update' = 'direct',
  formula?: string,
  constantValue?: string,
  lookupObject?: string,
  lookupObjectType?: string,
  transport?: string,
): Promise<string> {
  const tgtUpper = targetInfoObject.toUpperCase();
  let srcUpper = sourceField?.toUpperCase() ?? '';

  // Step 1: Read current Transformation (get full XML + timestamp)
  const trfnPath = `/sap/bw/modeling/trfn/${transformationName.toLowerCase()}/m`;
  const trfnResult = await client.get(trfnPath, TRFN_ACCEPT);
  const timestamp = trfnResult.headers['timestamp'] ?? trfnResult.headers['TIMESTAMP'];
  const originalXml = trfnResult.body;

  let updatedXml: string;

  if (ruleType === 'routine') {
    // ── Routine path ────────────────────────────────────────────────────────
    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    let newRule: string;
    if (ruleInfo.stepType === 'NO_UPDATE') {
      if (!srcUpper) {
        return JSON.stringify({
          success: false,
          message:
            `source_field is required when converting a StepNoUpdate rule to StepRoutine ` +
            `(target InfoObject ${tgtUpper} has no source mapping yet).`,
        });
      }
      const srcProps = extractSourceFieldProps(originalXml, srcUpper);
      newRule = buildNoUpdateToRoutineRule(
        ruleInfo.oldRuleXml,
        ruleInfo.groupId,
        ruleInfo.ruleId,
        tgtUpper,
        srcUpper,
        srcProps.dataType,
        srcProps.length,
      );
    } else {
      // StepDirect or StepInitial — source is already mapped, just convert the step type
      newRule = convertDirectOrInitialRuleToRoutine(ruleInfo.oldRuleXml);
    }

    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Routine rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepRoutine. The server has generated the ABAP AMDP class. ` +
        `Call bw_activate to activate.`,
      amdp_note:
        'AMDP SQLSCRIPT methods only allow ASCII 7-bit characters. ' +
        'Do NOT use non-ASCII characters (e.g. German umlauts like ä/ö/ü or symbols like <=) ' +
        'in SQLSCRIPT code or comments — they will cause a syntax error.',
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  if (ruleType === 'formula') {
    // ── Formula path ────────────────────────────────────────────────────────
    if (!formula) {
      return JSON.stringify({
        success: false,
        message: 'formula is required for rule_type="formula".',
      });
    }

    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    let newRule: string;
    if (ruleInfo.stepType === 'NO_UPDATE') {
      if (!srcUpper) {
        return JSON.stringify({
          success: false,
          message:
            `source_field is required when converting a StepNoUpdate rule to StepFormula ` +
            `(target InfoObject ${tgtUpper} has no source mapping yet).`,
        });
      }
      const srcProps = extractSourceFieldProps(originalXml, srcUpper);
      newRule = buildNoUpdateToFormulaRule(
        ruleInfo.oldRuleXml,
        ruleInfo.groupId,
        ruleInfo.ruleId,
        tgtUpper,
        srcUpper,
        srcProps.dataType,
        srcProps.length,
        formula,
      );
    } else {
      // StepDirect or StepInitial — source already mapped, just convert the step type
      newRule = convertDirectOrInitialRuleToFormula(ruleInfo.oldRuleXml, formula);
    }

    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Formula rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepFormula. Call bw_activate to activate.`,
      formula,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  if (ruleType === 'constant') {
    // ── Constant path ───────────────────────────────────────────────────────
    if (!constantValue) {
      return JSON.stringify({
        success: false,
        message: 'constant_value is required for rule_type="constant".',
      });
    }

    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    const newRule = convertRuleToConstant(ruleInfo.oldRuleXml, constantValue);
    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Constant rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepConstant with value "${constantValue}". Call bw_activate to activate.`,
      constant_value: constantValue,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  // ── Lookup path (Nachlesen) ──────────────────────────────────────────────
  if (ruleType === 'lookup') {
    if (!lookupObject || !lookupObjectType) {
      return JSON.stringify({
        success: false,
        message: 'lookup_object and lookup_object_type are required for rule_type="lookup".',
      });
    }
    if (!srcUpper) {
      return JSON.stringify({
        success: false,
        message: 'source_field is required for rule_type="lookup".',
      });
    }

    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}. ` +
          `The field may not exist in the target segment.`,
      });
    }

    const newRule = buildLookupRule(
      ruleInfo.oldRuleXml,
      ruleInfo.groupId,
      ruleInfo.ruleId,
      tgtUpper,
      srcUpper,
      lookupObject.toUpperCase(),
      lookupObjectType.toUpperCase(),
    );

    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('Lookup rule replacement failed — XML unchanged.');
    }

    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }

    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `converted to StepRead (Nachlesen) from ${lookupObjectType.toUpperCase()} ${lookupObject.toUpperCase()}. Call bw_activate to activate.`,
      lookup_object: lookupObject.toUpperCase(),
      lookup_object_type: lookupObjectType.toUpperCase(),
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  if (ruleType === 'no_update') {
    // ── No-update path — remove any mapping, revert to StepNoUpdate ─────────
    const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
    if (!ruleInfo) {
      return JSON.stringify({
        success: false,
        message:
          `No rule found for target InfoObject ${tgtUpper} in ` +
          `transformation ${transformationName.toUpperCase()}.`,
      });
    }
    if (ruleInfo.stepType === 'NO_UPDATE') {
      return JSON.stringify({
        success: true,
        message: `InfoObject ${tgtUpper} is already StepNoUpdate — nothing to do.`,
        lock_handle: '',
        transformation_name: transformationName.toUpperCase(),
        object_type: 'trfn',
      });
    }
    const newRule = buildNoUpdateRule(ruleInfo.oldRuleXml, ruleInfo.ruleId);
    updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
    if (updatedXml === originalXml) {
      throw new Error('no_update replacement failed — XML unchanged.');
    }
    const lockHandle = await client.lock('trfn', transformationName);
    try {
      await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp, transport);
    } catch (err) {
      await client.unlock('trfn', transformationName).catch(() => {/* ignore */});
      throw err;
    }
    return JSON.stringify({
      success: true,
      message:
        `InfoObject ${tgtUpper} in transformation ${transformationName.toUpperCase()} ` +
        `reverted to StepNoUpdate (no mapping). Call bw_activate to activate.`,
      lock_handle: lockHandle,
      transformation_name: transformationName.toUpperCase(),
      object_type: 'trfn',
      converted_from: ruleInfo.stepType,
    });
  }

  // ── Direct path (default) ────────────────────────────────────────────────

  // Read InfoObject to get label and type info
  const iObjPath = `/sap/bw/modeling/iobj/${targetInfoObject.toLowerCase()}/m`;
  const iObjResult = await client.get(iObjPath, MEDIA_TYPES['iobj']);
  const iObjProps = parseInfoObjectProps(iObjResult.body);

  // Find any existing rule for the target InfoObject
  const ruleInfo = findRuleForTarget(originalXml, tgtUpper);
  if (!ruleInfo) {
    return JSON.stringify({
      success: false,
      message:
        `No rule found for target InfoObject ${tgtUpper} in ` +
        `transformation ${transformationName.toUpperCase()}.`,
    });
  }

  // Resolve the effective source field: explicit arg takes priority,
  // otherwise infer from the first <element name="..."> inside the <step> block.
  if (!srcUpper) {
    const inferredMatch = ruleInfo.oldRuleXml.match(/<step\b[^>]*>[\s\S]*?<element\s+[^>]*name="([^"]+)"/);
    if (inferredMatch) {
      srcUpper = inferredMatch[1].toUpperCase();
    } else {
      return JSON.stringify({
        success: false,
        message:
          `source_field is required — no source mapping could be inferred from the existing rule for ${tgtUpper}.`,
      });
    }
  }

  const srcProps = extractSourceFieldProps(originalXml, srcUpper);
  const tgtProps = extractTargetElemProps(originalXml, tgtUpper);

  const newRule = buildStepDirectRule({
    groupId: ruleInfo.groupId,
    ruleId: ruleInfo.ruleId,
    sourceField: srcUpper,
    targetIObj: tgtUpper,
    srcType: srcProps.dataType,
    srcLength: srcProps.length,
    tgtConvRoutine: tgtProps.convRoutine || iObjProps.conversionRoutine,
    tgtType: tgtProps.dataType,
    tgtLength: tgtProps.length,
    tgtLabel: iObjProps.label,
  });

  updatedXml = originalXml.replace(ruleInfo.oldRuleXml, newRule);
  if (updatedXml === originalXml) {
    throw new Error('Rule replacement failed — XML unchanged. The rule text may have unexpected formatting.');
  }

  const lockHandle = await client.lock('trfn', transformationName);
  try {
    await client.put('trfn', transformationName, lockHandle, updatedXml, timestamp);
  } catch (err) {
    await client.unlock('trfn', transformationName).catch(() => {/* ignore unlock error */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Source field ${srcUpper} mapped to InfoObject ${tgtUpper} in ` +
      `transformation ${transformationName.toUpperCase()}. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    transformation_name: transformationName.toUpperCase(),
    object_type: 'trfn',
  });
}

// ── bwSetTransformationRoutine ───────────────────────────────────────────────

/**
 * bwSetTransformationRoutine — add a Start, End, or Expert routine to a Transformation.
 *
 * Flow:
 * 1. GET XML — derive classNameM from classNameA (_A → _M), error if missing
 * 2. Guard: group id="0" must not already exist
 * 3. Extract fields: source fields for START, target fields for END/EXPERT
 * 4. Build group id="0" block with full step (classNameM + methodNameM included)
 *    - START: <source id="N"> elements, no sourceSegment on group
 *    - END/EXPERT: <target id="N"> elements, sourceSegment="#///source/segment1" on group
 * 5. Lock → single PUT (session-isolated)
 * 6. Return lock_handle for bw_activate
 */

/**
 * Convert a BW InfoObject name to the corresponding HANA SQL column name.
 * Standard objects (starting with "0"): strip the leading "0", no quoting needed.
 * Custom BIC objects: prefix "/BIC/", wrap in double quotes for SQL.
 */
function ioBwNameToHanaSqlColumn(name: string): string {
  if (name.startsWith('0')) {
    return name.substring(1); // e.g. 0RECORDMODE → RECORDMODE
  }
  return `"/BIC/${name}"`; // e.g. NLPLSTID → "/BIC/NLPLSTID"
}

/**
 * Extract target fields from the transformation XML in posit order and build
 * a HANA SQLScript SELECT statement for a GLOBAL_END / GLOBAL_EXPERT skeleton.
 * Appends RECORD and SQL__PROCEDURE__SOURCE__RECORD at the end.
 */
function buildHanaEndSelect(xml: string): string {
  const tgtSegMatch = xml.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
  if (!tgtSegMatch) return 'outTab = SELECT * FROM :inTab;';

  // Collect fields with their posit for ordering
  const elemRegex = /<element\b[^>]*\bposit="(\d+)"[^>]*\bname="([^"]+)"[^>]*/g;
  const fields: { posit: number; col: string }[] = [];
  let em: RegExpExecArray | null;
  while ((em = elemRegex.exec(tgtSegMatch[1])) !== null) {
    fields.push({ posit: parseInt(em[1], 10), col: ioBwNameToHanaSqlColumn(em[2]) });
  }
  fields.sort((a, b) => a.posit - b.posit);

  const cols = [
    ...fields.map(f => `  ${f.col}`),
    '  RECORD',
    '  SQL__PROCEDURE__SOURCE__RECORD',
  ];
  return `outTab = SELECT\n${cols.join(',\n')}\nFROM :inTab;`;
}

export async function bwSetTransformationRoutine(
  client: BwClient,
  transformationName: string,
  routineType: 'start' | 'end' | 'expert',
  transport?: string
): Promise<string> {
  const trfnUpper = transformationName.toUpperCase();
  const trfnLower = transformationName.toLowerCase();
  const routineTypeUpper = routineType.toUpperCase() as 'START' | 'END' | 'EXPERT';
  const methodName = `GLOBAL_${routineTypeUpper}`;

  // Step 1: GET current XML
  const { body: xml1, headers: headers1 } = await client.get(
    `/sap/bw/modeling/trfn/${trfnLower}/m`,
    TRFN_ACCEPT
  );
  const timestamp1 = headers1['timestamp'] ?? '';

  // Step 2: Derive classNameM — from classNameA on root, from any existing StepRoutine, or
  //         from the transformation name itself (ABAP mode, no routines yet: /BIC/{last20}_M)
  const classNameAMatch = xml1.match(/\bclassNameA="([^"]+)"/);
  let classNameM: string;
  if (classNameAMatch) {
    classNameM = classNameAMatch[1].replace(/_A$/, '_M');
  } else {
    const classNameMMatch = xml1.match(/\bclassNameM="([^"]+)"/);
    if (classNameMMatch) {
      classNameM = classNameMMatch[1];
    } else {
      // ABAP runtime, no routines yet — derive from transformation name
      classNameM = `/BIC/${trfnUpper.slice(-20)}_M`;
    }
  }

  // Step 3: Guard — reject only if this specific routine type already exists
  const group0Exists = /<group\b[^>]*\bid="0"/.test(xml1);
  if (group0Exists) {
    const routineTypeExists = new RegExp(`<rule\\b[^>]*\\broutinetype="${routineTypeUpper}"`).test(xml1);
    if (routineTypeExists) {
      return JSON.stringify({
        success: false,
        message:
          `Transformation ${trfnUpper} already has a ${routineTypeUpper} routine. ` +
          `Cannot add another one.`,
      });
    }
  }

  // Step 4: Detect runtime from HANARuntime attribute on root element
  const hanaRuntimeAttr = /\bHANARuntime="([^"]+)"/.exec(xml1);
  const hanaRuntime = hanaRuntimeAttr ? hanaRuntimeAttr[1] : 'true';

  // Step 5: Determine next free rule ID (max existing + 1)
  const ruleIds: number[] = [];
  const ruleIdRegex = /<rule\b[^>]*\bid="(\d+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = ruleIdRegex.exec(xml1)) !== null) {
    ruleIds.push(parseInt(rm[1], 10));
  }
  const nextRuleId = ruleIds.length > 0 ? Math.max(...ruleIds) + 1 : 1;

  // Step 6: Build rule content based on routine type
  const stepAttrs =
    `xsi:type="trfn:StepRoutine" id="1" rank="MAIN" type="ROUTINE"` +
    ` classNameM="${classNameM}" hanaRuntime="${hanaRuntime}" methodNameM="${methodName}"`;

  let ruleContent: string;
  if (routineType === 'start') {
    // START: source fields from <source>/<segment>/<element>
    const srcSegMatch = xml1.match(/<source\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
    if (!srcSegMatch) {
      throw new Error(`Could not extract source segment from transformation ${trfnUpper}.`);
    }
    const sourceFields: string[] = [];
    const elemRegex = /<element\b[^>]*\bname="([^"]+)"[^>]*>/g;
    let em: RegExpExecArray | null;
    while ((em = elemRegex.exec(srcSegMatch[1])) !== null) {
      sourceFields.push(em[1]);
    }
    const sourceRefs = sourceFields
      .map((f, i) => `<source id="${i + 1}"><elementRef>#///source/segment1/${f}</elementRef></source>`)
      .join('');
    ruleContent =
      `<rule id="${nextRuleId}" routinetype="${routineTypeUpper}">` +
      sourceRefs +
      `<step ${stepAttrs}/>` +
      `</rule>`;
  } else {
    // END / EXPERT: target fields from <target>/<segment>/<element>
    const tgtSegMatch = xml1.match(/<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/);
    if (!tgtSegMatch) {
      throw new Error(`Could not extract target segment from transformation ${trfnUpper}.`);
    }
    const targetFields: string[] = [];
    const elemRegex = /<element\b[^>]*\bname="([^"]+)"[^>]*>/g;
    let em: RegExpExecArray | null;
    while ((em = elemRegex.exec(tgtSegMatch[1])) !== null) {
      targetFields.push(em[1]);
    }
    const targetRefs = targetFields
      .map((f, i) => `<target id="${i + 1}"><elementRef>#///target/segment1/${f}</elementRef></target>`)
      .join('');
    ruleContent =
      `<rule id="${nextRuleId}" routinetype="${routineTypeUpper}">` +
      targetRefs +
      `<step ${stepAttrs}/>` +
      `</rule>`;
  }

  // Step 7: Insert rule — append inside existing group id="0", or create new group before group id="1"
  let xmlWithGroup: string;
  if (group0Exists) {
    xmlWithGroup = xml1.replace(
      /(<group\b[^>]*\bid="0"[^>]*>)([\s\S]*?)(<\/group>)/,
      `$1$2${ruleContent}$3`
    );
    if (xmlWithGroup === xml1) {
      throw new Error('Could not append rule to existing group id="0".');
    }
  } else {
    const groupAttrs = routineType === 'start' ? '' : ` sourceSegment="#///source/segment1"`;
    const group0Block = `<group id="0"${groupAttrs} type="G">${ruleContent}</group>`;
    xmlWithGroup = xml1.replace(/<group\s+id="1"/, `${group0Block}<group id="1"`);
    if (xmlWithGroup === xml1) {
      throw new Error('Could not insert group id="0" — group id="1" not found in Transformation XML.');
    }
  }

  // Lock → single PUT (session-isolated)
  const lockHandle = await client.lock('trfn', trfnLower);
  const putClient = createClientFromEnv();
  try {
    await putClient.put('trfn', trfnLower, lockHandle, xmlWithGroup, timestamp1, transport);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  // ADT class write flow — activate the generated _M class and inject a proper skeleton.
  // For ABAP: BW generates the class only after activation — skip if 404.
  // For HANA END/EXPERT: BW auto-generates the class; inject the correct SELECT column list
  //   so the user has the right structure when adding custom logic.
  {
    const classEncoded = encodeURIComponent(classNameM).toLowerCase();
    const source = await client.adtGetSource(classEncoded);
    if (source !== null) {
      let updatedSource = source;

      if (hanaRuntime === 'true' && (routineType === 'end' || routineType === 'expert')) {
        // Replace the commented stub SELECT with a proper explicit column list
        const selectStmt = buildHanaEndSelect(xmlWithGroup);
        updatedSource = source.replace(
          /-- outTab = SELECT \* FROM :inTab;/,
          selectStmt
        );
      }

      const adtLock = await client.adtLockClass(classEncoded);
      try {
        await client.adtPutSource(classEncoded, adtLock, updatedSource);
        await client.adtActivate(classEncoded, classNameM);
      } finally {
        await client.adtUnlockClass(classEncoded, adtLock).catch(() => {/* ignore */});
      }
    }
  }

  return JSON.stringify({
    success: true,
    message:
      `${routineTypeUpper} routine added to transformation ${trfnUpper}. ` +
      `ABAP method ${classNameM}->${methodName} generated. Call bw_activate to activate.`,
    routine_type: routineTypeUpper,
    class_name: classNameM,
    method_name: methodName,
    lock_handle: lockHandle,
    transformation_name: trfnUpper,
    object_type: 'trfn',
  });
}

// ── bwDeleteTransformationRoutine ────────────────────────────────────────────

/**
 * bw_delete_transformation_routine — remove a Start, End, or Expert routine.
 *
 * Removes the <rule routinetype="START|END|EXPERT"> from <group id="0">.
 * If no rules remain in group id="0" afterwards, removes the entire group.
 * Single PUT (session-isolated). Returns lock_handle for bw_activate.
 */
export async function bwDeleteTransformationRoutine(
  client: BwClient,
  transformationName: string,
  routineType: 'start' | 'end' | 'expert'
): Promise<string> {
  const trfnUpper = transformationName.toUpperCase();
  const trfnLower = transformationName.toLowerCase();
  const routineTypeUpper = routineType.toUpperCase();

  // Step 1: GET current XML
  const { body: xml, headers } = await client.get(
    `/sap/bw/modeling/trfn/${trfnLower}/m`,
    TRFN_ACCEPT
  );
  const timestamp = headers['timestamp'] ?? '';

  // Step 2: Guard — group id="0" must exist
  if (!/<group\s+id="0"/.test(xml)) {
    return JSON.stringify({
      success: false,
      message: `Transformation ${trfnUpper} has no global routine group (group id="0").`,
    });
  }

  // Step 3: Extract the full <group id="0">...</group> block
  const group0Regex = /(<group\s+id="0"[^>]*>)([\s\S]*?)(<\/group>)/;
  const group0Match = xml.match(group0Regex);
  if (!group0Match) {
    throw new Error(`Could not parse group id="0" from transformation ${trfnUpper}.`);
  }
  const [fullGroup0, groupOpen, groupBody, groupClose] = group0Match;

  // Step 4: Find the rule with matching routinetype and remove it
  // Rules look like: <rule id="N" routinetype="START">...</rule>
  const ruleRegex = new RegExp(
    `<rule\\b[^>]*\\broutinetype="${routineTypeUpper}"[^>]*>[\\s\\S]*?<\\/rule>`,
    'i'
  );
  if (!ruleRegex.test(groupBody)) {
    return JSON.stringify({
      success: false,
      message:
        `No ${routineTypeUpper} routine found in group id="0" of transformation ${trfnUpper}.`,
    });
  }
  const newGroupBody = groupBody.replace(ruleRegex, '');

  // Step 5: If group is now empty (no remaining <rule> elements), remove the entire group
  const hasRemainingRules = /<rule\b/.test(newGroupBody);
  let updatedXml: string;
  if (!hasRemainingRules) {
    updatedXml = xml.replace(fullGroup0, '');
  } else {
    updatedXml = xml.replace(fullGroup0, groupOpen + newGroupBody + groupClose);
  }

  if (updatedXml === xml) {
    throw new Error('XML unchanged after routine removal — replacement failed.');
  }

  // Step 6: Lock → PUT (session-isolated)
  const lockHandle = await client.lock('trfn', trfnLower);
  const putClient = createClientFromEnv();
  try {
    await putClient.put('trfn', trfnLower, lockHandle, updatedXml, timestamp);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `${routineTypeUpper} routine removed from transformation ${trfnUpper}.` +
      (!hasRemainingRules ? ' Group id="0" removed (no remaining routines).' : '') +
      ' Call bw_activate to activate.',
    routine_type: routineTypeUpper,
    group_removed: !hasRemainingRules,
    lock_handle: lockHandle,
    transformation_name: trfnUpper,
    object_type: 'trfn',
  });
}

// ── bwSetTransformationRuntime ────────────────────────────────────────────────

/**
 * bw_set_transformation_runtime — toggle HANARuntime on a Transformation.
 *
 * Only changes the HANARuntime attribute on the root <trfn:transformation>
 * element. All rules and segments are passed through unchanged.
 * Returns lock_handle for bw_activate.
 */
export async function bwSetTransformationRuntime(
  client: BwClient,
  transformationName: string,
  runtime: 'hana' | 'abap',
  transport?: string
): Promise<string> {
  const trfnUpper = transformationName.toUpperCase();
  const trfnLower = transformationName.toLowerCase();

  // Step 1: Lock
  const lockHandle = await client.lock('trfn', trfnLower);

  try {
    // Step 2: GET current XML
    const { body: xml, headers } = await client.get(
      `/sap/bw/modeling/trfn/${trfnLower}/m`,
      TRFN_ACCEPT
    );
    const timestamp = headers['timestamp'] ?? '';

    // Step 3: Check current value — early return if already correct
    const currentMatch = xml.match(/\bHANARuntime="(true|false)"/);
    const currentValue = currentMatch?.[1] ?? 'true';
    const targetValue  = runtime.toLowerCase() === 'hana' ? 'true' : 'false';

    if (currentValue === targetValue) {
      await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
      return JSON.stringify({
        success: true,
        already_set: true,
        message:
          `Transformation ${trfnUpper} already has HANARuntime="${targetValue}". No change needed.`,
        runtime,
        transformation_name: trfnUpper,
        object_type: 'trfn',
      });
    }

    // Step 4: Replace HANARuntime attribute
    const updatedXml = xml.replace(
      /\bHANARuntime="(true|false)"/,
      `HANARuntime="${targetValue}"`
    );

    if (updatedXml === xml) {
      throw new Error('HANARuntime replacement failed — XML unchanged.');
    }

    // Step 5: PUT
    await client.put('trfn', trfnLower, lockHandle, updatedXml, timestamp, transport);
  } catch (err) {
    await client.unlock('trfn', trfnLower).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message:
      `Transformation ${trfnUpper} runtime switched to "${runtime}" (HANARuntime="${runtime === 'hana' ? 'true' : 'false'}"). Call bw_activate to activate.`,
    runtime,
    lock_handle: lockHandle,
    transformation_name: trfnUpper,
    object_type: 'trfn',
  });
}
