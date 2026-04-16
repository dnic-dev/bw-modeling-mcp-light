import { BwClient, MEDIA_TYPES } from '../bw-client.js';

const TRCS_MEDIA = 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml';

// ── bwGetInfosource ───────────────────────────────────────────────────────────

/**
 * bw_get_infosource — read the structure of an InfoSource (TRCS).
 *
 * GET /sap/bw/modeling/trcs/{name}/m
 */
export async function bwGetInfosource(client: BwClient, name: string): Promise<string> {
  const nameLower = name.toLowerCase();
  const result = await client.get(`/sap/bw/modeling/trcs/${nameLower}/m`, TRCS_MEDIA);
  const xml = result.body;

  // Root attributes
  const rootName = (xml.match(/trcs:infoSource[^>]+\bname="([^"]+)"/) ?? [])[1] ?? name.toUpperCase();
  const aggregationAttr = (xml.match(/trcs:infoSource[^>]+\baggregation="([^"]+)"/) ?? [])[1];
  const aggregation = aggregationAttr === 'true';

  // endUserTexts label (top-level)
  const labelMatch = xml.match(/^[\s\S]*?<endUserTexts label="([^"]*)"/);
  const label = labelMatch ? labelMatch[1] : '';

  // tlogoProperties
  const tlogoPart = (xml.match(/<tlogoProperties([^>]*)>/) ?? [])[1] ?? '';
  const description = (tlogoPart.match(/adtcore:description="([^"]*)"/) ?? [])[1] ?? '';
  const objectStatus = (tlogoPart.match(/adtcore:version="([^"]*)"/) ?? [])[1] ?? '';

  // <infoArea>
  const infoArea = (xml.match(/<infoArea>([^<]*)<\/infoArea>/) ?? [])[1] ?? '';

  // Collect keyElement names: #///NAME → NAME
  const keyElements = new Set<string>();
  const keyRe = /<keyElement>#\/\/\/([^<]+)<\/keyElement>/g;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(xml)) !== null) {
    keyElements.add(km[1].toUpperCase());
  }

  // Parse <element> blocks
  const fields: Record<string, unknown>[] = [];
  const elemRe = /<element\b([\s\S]*?)<\/element>/g;
  let em: RegExpExecArray | null;
  while ((em = elemRe.exec(xml)) !== null) {
    const block = em[1];
    const fieldName = (block.match(/\bname="([^"]+)"/) ?? [])[1];
    if (!fieldName) continue;

    const iObjName = (block.match(/\binfoObjectName="([^"]+)"/) ?? [])[1];
    const fieldLabel = (block.match(/<endUserTexts label="([^"]*)"/) ??
                        block.match(/<descriptions label="([^"]*)"/) ?? [])[1] ?? '';
    const dataType = (block.match(/<inlineType\b[^>]*\bname="([^"]+)"/) ?? [])[1] ?? '';
    const lengthStr = (block.match(/<inlineType\b[^>]*\blength="([^"]+)"/) ?? [])[1];
    const aggrBehav = (block.match(/\baggregationBehavior="([^"]+)"/) ?? [])[1];

    const field: Record<string, unknown> = {
      name: fieldName,
      label: fieldLabel,
      data_type: dataType,
      is_key: keyElements.has(fieldName.toUpperCase()),
    };
    if (iObjName) field['infoobject_name'] = iObjName;
    if (lengthStr !== undefined) field['length'] = Number(lengthStr);
    if (aggrBehav) field['aggregation_behavior'] = aggrBehav;

    fields.push(field);
  }

  return JSON.stringify({
    name: rootName,
    label,
    description,
    info_area: infoArea,
    object_status: objectStatus,
    aggregation,
    fields,
  }, null, 2);
}

// ── Field building ────────────────────────────────────────────────────────────

export interface InfosourceField {
  name: string;
  infoObjectName?: string;
  type: string;
  length: number;
  label: string;
  isKey?: boolean;
  aggregationBehavior?: string;
}

function buildElement(field: InfosourceField): string {
  const name = field.name.toUpperCase();
  const aggr = field.aggregationBehavior ?? 'NONE';

  if (field.infoObjectName) {
    const iobj = field.infoObjectName.toUpperCase();
    return (
      `  <element xsi:type="BwCore:BwElement"\n` +
      `    name="${name}"\n` +
      `    keep="false"\n` +
      `    aggregationBehavior="${aggr}"\n` +
      `    attributeHierarchyDefaultMember=""\n` +
      `    infoObjectName="${iobj}"\n` +
      `    displayFolder="">\n` +
      `    <endUserTexts label="${field.label}"/>\n` +
      `    <inlineType name="${field.type}" length="${field.length}" globalElementName="${iobj}"/>\n` +
      `    <fixedCurrency></fixedCurrency>\n` +
      `    <fixedUnit></fixedUnit>\n` +
      `    <associationType>1</associationType>\n` +
      `  </element>`
    );
  } else {
    return (
      `  <element xsi:type="BwCore:BwElement"\n` +
      `    name="${name}"\n` +
      `    aggregationBehavior="${aggr}"\n` +
      `    conversionRoutine="">\n` +
      `    <inlineType name="${field.type}" length="${field.length}" precision="0" scale="0" semanticType="empty"/>\n` +
      `    <localProperties xsi:type="BwCore:LocalCharacteristicProperties">\n` +
      `      <descriptions label="${field.label}"/>\n` +
      `    </localProperties>\n` +
      `  </element>`
    );
  }
}

// ── bw_create_infosource ──────────────────────────────────────────────────────

/**
 * bw_create_infosource — create a new InfoSource (TRCS) shell.
 *
 * Optionally copies fields from an existing object (aDSO, CompositeProvider,
 * DataSource, or InfoObject) via copyFrom* parameters.
 *
 * Workflow: Lock (CREA) → POST → Unlock
 * After creation the InfoSource is inactive — call bw_activate with object_type "trcs".
 */
export async function bwCreateInfosource(
  client: BwClient,
  name: string,
  description: string,
  infoArea: string,
  pkg: string = '$TMP',
  copyFromObjectName?: string,
  copyFromObjectType?: string,
  copyFromObjectSubType?: string,
  copyFromSourceSystem?: string
): Promise<string> {
  const nameUpper = name.toUpperCase();
  const infoAreaUpper = infoArea.toUpperCase();

  const lockHandle = await client.lock('trcs', name, { 'activity_context': 'CREA' });

  // Build URL — add copyFrom params before lockHandle when provided
  let url = `/sap/bw/modeling/trcs/${name.toLowerCase()}`;
  const qs: string[] = [];
  if (copyFromObjectType && copyFromObjectName) {
    let encodedName = copyFromObjectName;
    if (copyFromObjectType === 'RSDS' && copyFromSourceSystem) {
      encodedName = copyFromObjectName.padEnd(30) + copyFromSourceSystem.padEnd(10);
    }
    qs.push(`copyFromObjectName=${encodeURIComponent(encodedName)}`);
    qs.push(`copyFromObjectType=${encodeURIComponent(copyFromObjectType)}`);
    if (copyFromObjectSubType) {
      qs.push(`copyFromObjectSubType=${encodeURIComponent(copyFromObjectSubType)}`);
    }
  }
  qs.push(`lockHandle=${lockHandle}`);
  url += '?' + qs.join('&');

  const language = process.env.BW_LANGUAGE ?? 'DE';
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<trcs:infoSource\n` +
    `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
    `  xmlns:trcs="http://www.sap.com/bw/modeling/trcs.ecore"\n` +
    `  name="${nameUpper}">\n` +
    `  <endUserTexts label="${description}"/>\n` +
    `  <tlogoProperties\n` +
    `    adtcore:language="${language}"\n` +
    `    adtcore:name="${nameUpper}"\n` +
    `    adtcore:type="TRCS"\n` +
    `    adtcore:masterLanguage="${language}">\n` +
    `    <infoArea>${infoAreaUpper}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `</trcs:infoSource>`;

  try {
    await client.postWithCsrf(url, body, `application/xml, ${TRCS_MEDIA}`, {
      'Development-Class': pkg,
      Accept: TRCS_MEDIA,
    });
  } catch (err) {
    await client.unlock('trcs', name).catch(() => {/* ignore */});
    throw err;
  }
  await client.unlock('trcs', name);

  const fromParts: string[] = [];
  if (copyFromObjectType && copyFromObjectName) {
    fromParts.push(` from ${copyFromObjectType} ${copyFromObjectName.toUpperCase()}`);
    if (copyFromObjectSubType) fromParts.push(` (${copyFromObjectSubType})`);
  }
  return JSON.stringify({
    success: true,
    message: `InfoSource ${nameUpper} created${fromParts.join('')} in package ${pkg}. Call bw_activate to activate.`,
    infosource_name: nameUpper,
    object_type: 'trcs',
  });
}

// ── bw_update_infosource ──────────────────────────────────────────────────────

/**
 * bw_update_infosource — replace the field list of an InfoSource.
 *
 * Workflow: Lock → GET full XML → replace element/keyElement sections → PUT
 * tlogoProperties are passed through unchanged.
 * Returns lock_handle for bw_activate.
 */
export async function bwUpdateInfosource(
  client: BwClient,
  name: string,
  description?: string,
  fields?: InfosourceField[],
  transport?: string
): Promise<string> {
  const nameUpper = name.toUpperCase();
  const trcsPath = `/sap/bw/modeling/trcs/${name.toLowerCase()}/m`;

  // 1. Lock (no activity_context = update mode)
  const lockHandle = await client.lock('trcs', name);

  // 2. GET current XML
  const getResult = await client.get(trcsPath, TRCS_MEDIA);
  const timestamp = getResult.headers['timestamp'] ?? getResult.headers['TIMESTAMP'];
  let xml = getResult.body;

  // 3. Update description
  if (description !== undefined) {
    xml = xml.replace(/<endUserTexts label="[^"]*"\s*\/>/, `<endUserTexts label="${description}"/>`);
  }

  // 4. Replace elements and keyElements
  if (fields !== undefined) {
    // Strip all existing <element> blocks (may span multiple lines)
    xml = xml.replace(/[ \t]*<element\b[\s\S]*?<\/element>\n?/g, '');
    // Strip all existing <keyElement> entries
    xml = xml.replace(/[ \t]*<keyElement>[^<]*<\/keyElement>\n?/g, '');

    const elementBlocks = fields.map(buildElement);
    const keyBlocks = fields
      .filter((f) => f.isKey)
      .map((f) => `  <keyElement>#///${f.name.toUpperCase()}</keyElement>`);

    const insertBlock = [...elementBlocks, ...keyBlocks].join('\n') + '\n';
    if (xml.includes('<tlogoProperties')) {
      xml = xml.replace('<tlogoProperties', insertBlock + '  <tlogoProperties');
    } else {
      xml = xml.replace('</trcs:infoSource>', insertBlock + '</trcs:infoSource>');
    }
  }

  // 5. PUT
  try {
    await client.put('trcs', name, lockHandle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('trcs', name).catch(() => {/* ignore */});
    throw err;
  }

  return JSON.stringify({
    success: true,
    message: `InfoSource ${nameUpper} updated. Call bw_activate to activate.`,
    lock_handle: lockHandle,
    infosource_name: nameUpper,
    object_type: 'trcs',
  });
}
