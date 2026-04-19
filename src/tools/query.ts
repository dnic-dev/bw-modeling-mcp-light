import { XMLParser } from 'fast-xml-parser';
import { createClientFromEnv } from '../bw-client.js';

const QUERY_ACCEPT =
  'application/vnd.sap.bw.modeling.query-v1_8_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_9_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_10_0+xml, ' +
  'application/vnd.sap.bw.modeling.query-v1_11_0+xml';

function ensureArray(val: unknown): unknown[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function renderFormula(
  token: Record<string, unknown>,
  variableMap: Map<string, { technicalName: string }>,
  ckfMap: Map<string, { technicalName: string }>,
  rkfMap: Map<string, { technicalName: string }>,
  localMemberMap: Map<string, string>,
  depth = 0
): string {
  if (depth > 50) return '...';
  if (!token) return '?';
  const type = token['@_xsi:type'] as string | undefined;
  switch (type) {
    case 'Qry:FormulaInfixOperator': {
      const children = ensureArray(token['Qry:childToken']) as Record<string, unknown>[];
      if (children.length >= 2) {
        const left = renderFormula(children[0], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1);
        const right = renderFormula(children[1], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1);
        return `(${left} ${token['@_code']} ${right})`;
      }
      return `(${token['@_code']})`;
    }
    case 'Qry:FormulaPrefixOperator': {
      const children = ensureArray(token['Qry:childToken']) as Record<string, unknown>[];
      const code = token['@_code'] as string;
      if (code === 'IF' && children.length === 3) {
        return (
          `IF(${renderFormula(children[0], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)}, ` +
          `${renderFormula(children[1], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)}, ` +
          `${renderFormula(children[2], variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)})`
        );
      }
      return `${code}(${children.map((c) => renderFormula(c, variableMap, ckfMap, rkfMap, localMemberMap, depth + 1)).join(', ')})`;
    }
    case 'Qry:FormulaIObjectOperand':
      return (token['@_infoObject'] as string) ?? '?';
    case 'Qry:FormulaMemberOperand': {
      const memberId = token['@_member'] as string;
      const opType = token['@_operandType'] as string;
      if (opType === 'Variable') {
        return variableMap.get(memberId)?.technicalName ?? memberId;
      }
      if (opType === 'Member') {
        return localMemberMap.get(memberId) ?? ckfMap.get(memberId)?.technicalName ?? rkfMap.get(memberId)?.technicalName ?? memberId;
      }
      return ckfMap.get(memberId)?.technicalName ?? rkfMap.get(memberId)?.technicalName ?? memberId;
    }
    case 'Qry:FormulaConstant':
      return String(token['@_value'] ?? '');
    default:
      return '?';
  }
}

function countMembersRecursive(node: Record<string, unknown>): number {
  const children = ensureArray(node['Qry:childMembers']) as Record<string, unknown>[];
  let count = children.length;
  for (const c of children) {
    count += countMembersRecursive(c);
  }
  return count;
}

function buildLocalMemberMap(members: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  function collect(memberList: unknown[]) {
    for (const m of memberList as Record<string, unknown>[]) {
      const id = m['@_id'] as string | undefined;
      const desc = ((m['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? id ?? '';
      if (id) map.set(id, desc);
      const children = ensureArray(m['Qry:childMembers']);
      if (children.length > 0) collect(children);
    }
  }
  collect(members);
  return map;
}

function parseSelectionGroups(
  groups: unknown[],
  ckfMap: Map<string, { technicalName: string; description: string }>,
  rkfMap: Map<string, { technicalName: string; description: string }>
): Record<string, unknown>[] {
  return (groups as Record<string, unknown>[]).map((g) => {
    const tokens = ensureArray(g['Qry:tokens']) as Record<string, unknown>[];
    const parsedTokens = tokens.map((t) => {
      const tType = t['@_xsi:type'] as string;
      if (tType === 'Qry:SelectionTokenForComponent') {
        const compId = t['@_component'] as string;
        const ckfEntry = ckfMap.get(compId);
        const rkfEntry = rkfMap.get(compId);
        const entry = ckfEntry ?? rkfEntry;
        return {
          tokenType: 'SelectionTokenForComponent',
          componentId: compId,
          componentTechnicalName: entry?.technicalName ?? compId,
          componentType: ckfEntry ? 'CKF' : 'RKF',
        };
      }
      const fromValue = t['Qry:fromValue'] as Record<string, unknown> | undefined;
      const tok: Record<string, unknown> = {
        tokenType: 'SelectionRange',
        selectionType: (t['@_selectionType'] as string) ?? '',
        operator: (t['@_operator'] as string) ?? '',
        exclude: t['@_exclude'] === 'true' || t['@_exclude'] === true,
        value: (fromValue?.['Qry:value'] as string) ?? '',
      };
      const internalValue = fromValue?.['@_internalValue'] as string | undefined;
      if (internalValue) tok['internalValue'] = internalValue;
      const fromValueDesc = t['@_fromValueDesc'] as string | undefined;
      if (fromValueDesc) tok['valueDesc'] = fromValueDesc;
      return tok;
    });
    return {
      infoObject: (g['@_infoObject'] as string) ?? '',
      description: (g['@_description'] as string) ?? '',
      constantSelection: g['@_constantSelection'] === 'true' || g['@_constantSelection'] === true,
      tokens: parsedTokens,
    };
  });
}

function parseMemberRecursive(
  member: Record<string, unknown>,
  variableMap: Map<string, { technicalName: string }>,
  ckfMap: Map<string, { technicalName: string; description: string }>,
  rkfMap: Map<string, { technicalName: string; description: string }>,
  localMemberMap: Map<string, string>
): Record<string, unknown> {
  const mType = member['@_xsi:type'] as string;
  const id = (member['@_id'] as string) ?? '';
  const descNode = member['Qry:description'] as Record<string, unknown> | undefined;
  const desc = (descNode?.['@_value'] as string) ?? '';
  const shortDesc = descNode?.['@_shortValue'] as string | undefined;
  const visibility = ((member['Qry:hidden'] as Record<string, unknown> | undefined)?.['@_type'] as string) ?? 'showAlways';

  const result: Record<string, unknown> = {
    id,
    type: mType === 'Qry:MemberFormula' ? 'MemberFormula' : 'MemberSelection',
    description: desc,
    visibility,
  };
  if (shortDesc) result['shortDescription'] = shortDesc;

  if (mType === 'Qry:MemberFormula') {
    const formulaDef = member['Qry:formulaDefinition'] as Record<string, unknown> | undefined;
    const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
    result['formula'] = formulaToken ? renderFormula(formulaToken, variableMap, ckfMap, rkfMap, localMemberMap) : '';
  } else {
    result['selections'] = parseSelectionGroups(ensureArray(member['Qry:groups']), ckfMap, rkfMap);
    const defaultHint = member['Qry:defaultHint'] as Record<string, unknown> | undefined;
    if ((defaultHint?.['Qry:type'] as string) === 'CINLink') {
      const hintValue = defaultHint?.['Qry:value'] as string | undefined;
      if (hintValue) {
        const ckfEntry = ckfMap.get(hintValue);
        const rkfEntry = rkfMap.get(hintValue);
        const entry = ckfEntry ?? rkfEntry;
        if (entry) {
          result['referencedComponent'] = {
            technicalName: entry.technicalName,
            description: entry.description,
            componentType: ckfEntry ? 'CKF' : 'RKF',
          };
        }
      }
    }
  }

  const childMembersRaw = ensureArray(member['Qry:childMembers']) as Record<string, unknown>[];
  if (childMembersRaw.length > 0) {
    result['childMembers'] = childMembersRaw.map((cm) =>
      parseMemberRecursive(cm, variableMap, ckfMap, rkfMap, localMemberMap)
    );
  }

  return result;
}

function parseDimElement(
  elem: Record<string, unknown>,
  variableMap: Map<string, { technicalName: string }>,
  ckfMap: Map<string, { technicalName: string; description: string }>,
  rkfMap: Map<string, { technicalName: string; description: string }>
): Record<string, unknown> {
  const type = elem['@_xsi:type'] as string;
  if (type === 'Qry:CustomDimension') {
    const membersRaw = ensureArray(elem['Qry:members']) as Record<string, unknown>[];
    const localMemberMap = buildLocalMemberMap(membersRaw);
    let memberCount = membersRaw.length;
    for (const m of membersRaw) {
      memberCount += countMembersRecursive(m);
    }
    const members = membersRaw.map((m) => parseMemberRecursive(m, variableMap, ckfMap, rkfMap, localMemberMap));
    return {
      type: 'CustomDimension',
      technicalName: (elem['@_technicalName'] as string) ?? '',
      description: ((elem['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      reusable: elem['@_reusable'] === 'true' || elem['@_reusable'] === true,
      suppressZeros: elem['@_suppressZeros'] === 'true' || elem['@_suppressZeros'] === true,
      memberCount,
      members,
    };
  }
  const additionalInfo = elem['Qry:additionalInfo'] as Record<string, unknown> | undefined;
  const kvPairs = ensureArray(additionalInfo?.['Qry:keyValuePairs']) as Record<string, unknown>[];
  const infoObjectTypeKv = kvPairs.find((kv) => kv['@_key'] === 'infoObjectType');
  const result: Record<string, unknown> = {
    type: 'Dimension',
    infoObjectName: (elem['@_infoObjectName'] as string) ?? '',
    description: ((elem['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
  };
  if (infoObjectTypeKv) result.infoObjectType = infoObjectTypeKv['@_value'];
  return result;
}

export async function bwGetQuery(queryName: string): Promise<string> {
  const client = createClientFromEnv();

  const basePath = `/sap/bw/modeling/query/${queryName.toLowerCase()}`;
  let xmlBody: string;
  let versionNote: string | undefined;

  try {
    const result = await client.get(`${basePath}/a`, QUERY_ACCEPT);
    xmlBody = result.body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 404')) {
      const result = await client.get(`${basePath}/m`, QUERY_ACCEPT);
      xmlBody = result.body;
      versionNote = 'inactive version returned';
    } else {
      throw err;
    }
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) =>
      [
        'Qry:subComponents',
        'Qry:selections',
        'Qry:tokens',
        'Qry:members',
        'Qry:childMembers',
        'Qry:childFormulas',
        'Qry:free',
        'Qry:rows',
        'Qry:columns',
        'Qry:exceptions',
        'Qry:conditions',
        'Qry:gridCells',
        'Qry:helpCells',
        'Qry:groups',
        'Qry:childToken',
        'Qry:referenceCharacteristic',
        'atom:link',
      ].includes(tagName),
  });

  const parsed = parser.parse(xmlBody);
  const root = parsed['Qry:queryResource'] as Record<string, unknown>;

  // Step 1: Build subComponent maps
  const variableMap = new Map<string, { technicalName: string; description: string; infoObject: string; type: string; procType: string; inputType: string; represents: string; defaultSelection: unknown }>();
  const ckfMap = new Map<string, { technicalName: string; description: string; formulaDefinition: unknown }>();
  const rkfMap = new Map<string, { technicalName: string; description: string; member: Record<string, unknown> | undefined }>();

  const subComponents = ensureArray(root['Qry:subComponents']) as Record<string, unknown>[];
  for (const sc of subComponents) {
    const scType = sc['@_xsi:type'] as string;
    const id = sc['@_id'] as string;
    if (scType === 'Qry:Variable') {
      variableMap.set(id, {
        technicalName: (sc['@_technicalName'] as string) ?? '',
        description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
        infoObject: (sc['@_infoObject'] as string) ?? '',
        type: (sc['Qry:type'] as string) ?? '',
        procType: (sc['Qry:procType'] as string) ?? '',
        inputType: (sc['Qry:inputType'] as string) ?? '',
        represents: (sc['Qry:represents'] as string) ?? '',
        defaultSelection: sc['Qry:defaultSelection'],
      });
    } else if (scType === 'Qry:CalculatedMeasure') {
      const member = sc['Qry:member'] as Record<string, unknown> | undefined;
      ckfMap.set(id, {
        technicalName: (sc['@_technicalName'] as string) ?? '',
        description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
        formulaDefinition: member?.['Qry:formulaDefinition'],
      });
    } else if (scType === 'Qry:RestrictedMeasure') {
      rkfMap.set(id, {
        technicalName: (sc['@_technicalName'] as string) ?? '',
        description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
        member: sc['Qry:member'] as Record<string, unknown> | undefined,
      });
    }
  }

  // Step 3: Parse mainComponent metadata
  const mainComp = root['Qry:mainComponent'] as Record<string, unknown>;
  const entityProps = mainComp['Qry:entityProperties'] as Record<string, unknown>;
  const links = ensureArray(entityProps['atom:link']) as Record<string, unknown>[];
  const relatedLink = links.find((l) => l['@_rel'] === 'related');
  const href = (relatedLink?.['@_href'] as string) ?? '';

  let providerType: string;
  if (href.includes('/hcpr/')) providerType = 'CompositeProvider';
  else if (href.includes('/alvl/')) providerType = 'AggregationLevel';
  else if (href.includes('/adso/')) providerType = 'aDSO';
  else providerType = 'Unknown';

  const packageRef = entityProps['adtCore:packageRef'] as Record<string, unknown> | undefined;

  // Step 4: Variables in order of subComponents appearance
  const variables: Record<string, unknown>[] = [];
  for (const sc of subComponents) {
    if (sc['@_xsi:type'] !== 'Qry:Variable') continue;
    const v: Record<string, unknown> = {
      technicalName: (sc['@_technicalName'] as string) ?? '',
      description: ((sc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      infoObject: (sc['@_infoObject'] as string) ?? '',
      type: (sc['Qry:type'] as string) ?? '',
      procType: (sc['Qry:procType'] as string) ?? '',
      inputType: (sc['Qry:inputType'] as string) ?? '',
      represents: (sc['Qry:represents'] as string) ?? '',
    };
    const defaultSel = sc['Qry:defaultSelection'] as Record<string, unknown> | undefined;
    if (defaultSel && defaultSel['@_fromValue'] !== undefined) {
      v['defaultValue'] = String(defaultSel['@_fromValue']);
    }
    variables.push(v);
  }

  // Step 5: Parse filter
  const filterSection = mainComp['Qry:filter'] as Record<string, unknown> | undefined;
  const selections = ensureArray(filterSection?.['Qry:selections']) as Record<string, unknown>[];
  const filter: Record<string, unknown>[] = [];
  for (const sel of selections) {
    const usageType = (sel['@_usageType'] as string) ?? '';
    const tokens = ensureArray(sel['Qry:tokens']) as Record<string, unknown>[];
    if (usageType === 'asStartValue' && tokens.length === 0) continue;

    const infoObject = (sel['@_infoObject'] as string) ?? '';
    const localDim = sel['Qry:localDimension'] as Record<string, unknown> | undefined;
    const description = localDim
      ? ((localDim['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? infoObject
      : infoObject;

    const item: Record<string, unknown> = { infoObject, description, usageType };

    const fixedValues = tokens
      .filter((t) => t['@_xsi:type'] === 'Qry:SelectionRange')
      .map((t) => {
        const fromValue = t['Qry:fromValue'] as Record<string, unknown> | undefined;
        const fv: Record<string, unknown> = {
          operator: (t['@_operator'] as string) ?? '',
          exclude: t['@_exclude'] === 'true' || t['@_exclude'] === true,
          value: (fromValue?.['Qry:value'] as string) ?? '',
        };
        const fromValueDesc = t['@_fromValueDesc'] as string | undefined;
        if (fromValueDesc) fv['valueDesc'] = fromValueDesc;
        return fv;
      });

    if (fixedValues.length > 0) item['fixedValues'] = fixedValues;

    const varToken = tokens.find((t) => t['@_xsi:type'] === 'Qry:SelectionVariable');
    if (varToken) {
      const varId = varToken['@_variable'] as string;
      const varInfo = variableMap.get(varId);
      item['variable'] = {
        technicalName: varInfo?.technicalName ?? varId,
        description: varInfo?.description ?? '',
      };
    }

    filter.push(item);
  }

  // Step 6: Parse layout
  const columnsRaw = ensureArray(mainComp['Qry:columns']) as Record<string, unknown>[];
  const rowsRaw = ensureArray(mainComp['Qry:rows']) as Record<string, unknown>[];
  const freeRaw = ensureArray(mainComp['Qry:free']) as Record<string, unknown>[];

  const columns = columnsRaw.map((elem) => parseDimElement(elem, variableMap, ckfMap, rkfMap));
  const rows = rowsRaw.map((elem) => parseDimElement(elem, variableMap, ckfMap, rkfMap));
  const freeCharacteristics = freeRaw.map((elem) => {
    const additionalInfo = elem['Qry:additionalInfo'] as Record<string, unknown> | undefined;
    const kvPairs = ensureArray(additionalInfo?.['Qry:keyValuePairs']) as Record<string, unknown>[];
    const infoObjectTypeKv = kvPairs.find((kv) => kv['@_key'] === 'infoObjectType');
    const result: Record<string, unknown> = {
      infoObjectName: (elem['@_infoObjectName'] as string) ?? '',
      description: ((elem['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    };
    if (infoObjectTypeKv) result['infoObjectType'] = infoObjectTypeKv['@_value'];
    return result;
  });

  // Step 7: Calculated Measures (CKFs only)
  const calculatedMeasures: Record<string, unknown>[] = [];
  for (const [, ckf] of ckfMap) {
    const formulaDef = ckf.formulaDefinition as Record<string, unknown> | undefined;
    const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
    calculatedMeasures.push({
      technicalName: ckf.technicalName,
      description: ckf.description,
      formula: formulaToken ? renderFormula(formulaToken, variableMap, ckfMap, rkfMap, new Map()) : '',
    });
  }

  // Step 8: Restricted Measures
  const restrictedMeasures: Record<string, unknown>[] = [];
  for (const [, rkf] of rkfMap) {
    restrictedMeasures.push({
      technicalName: rkf.technicalName,
      description: rkf.description,
      selections: parseSelectionGroups(ensureArray(rkf.member?.['Qry:groups']), ckfMap, rkfMap),
    });
  }

  // Step 9: Exceptions
  const exceptionsRaw = ensureArray(mainComp['Qry:exceptions']) as Record<string, unknown>[];
  const exceptions = exceptionsRaw.map((ex) => {
    const exTokens = ensureArray(ex['Qry:tokens']) as Record<string, unknown>[];
    const thresholds = exTokens.map((t) => {
      const fromValue = t['Qry:fromValue'] as Record<string, unknown> | undefined;
      const toValueNode = t['Qry:toValue'] as Record<string, unknown> | undefined;
      const threshold: Record<string, unknown> = {
        alertLevel: (t['@_alertLevel'] as string) ?? '',
        operator: (t['@_operator'] as string) ?? '',
        value: (fromValue?.['Qry:value'] as string) ?? '',
      };
      const toVal = toValueNode?.['Qry:value'] as string | undefined;
      if (toVal !== undefined) threshold['toValue'] = toVal;
      return threshold;
    });
    const exception: Record<string, unknown> = {
      id: (ex['@_id'] as string) ?? '',
      active: ex['@_active'] === 'true' || ex['@_active'] === true,
      evaluateBeforeListCalc: ex['@_evaluateBeforeListCalc'] === 'true' || ex['@_evaluateBeforeListCalc'] === true,
      affectsChasNotListed: (ex['@_affectsChasNotListed'] as string) ?? '',
      affectsDataCells: ex['@_affectsDataCells'] === 'true' || ex['@_affectsDataCells'] === true,
      description: ((ex['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      thresholds,
    };
    const firstStruc = ex['Qry:definedCellFirstStruc'] as Record<string, unknown> | undefined;
    const firstMember = firstStruc?.['Qry:member'] as string | undefined;
    if (firstMember) exception['firstStructureMember'] = firstMember;
    const secondStruc = ex['Qry:definedCellSecondStruc'] as Record<string, unknown> | undefined;
    const secondMember = secondStruc?.['Qry:member'] as string | undefined;
    if (secondMember) exception['secondStructureMember'] = secondMember;
    return exception;
  });

  // Step 10: Cell definitions
  const gridCellsRaw = ensureArray(mainComp['Qry:gridCells']) as Record<string, unknown>[];
  const helpCellsRaw = ensureArray(mainComp['Qry:helpCells']) as Record<string, unknown>[];
  const hasCellDefinitions = gridCellsRaw.length > 0 || helpCellsRaw.length > 0;

  const gridCells = gridCellsRaw.map((gc) => {
    const gcType = gc['@_xsi:type'] as string;
    const cell: Record<string, unknown> = {
      id: (gc['@_id'] as string) ?? '',
      type: gcType === 'Qry:FormulaCell' ? 'FormulaCell' : 'ReferenceCell',
      description: ((gc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
      coordinateMember1: (gc['Qry:coordinateMember1'] as string) ?? '',
      coordinateMember2: (gc['Qry:coordinateMember2'] as string) ?? '',
    };
    if (gcType === 'Qry:FormulaCell') {
      const formulaDef = gc['Qry:formulaDefinition'] as Record<string, unknown> | undefined;
      const formulaToken = formulaDef?.['Qry:formulaToken'] as Record<string, unknown> | undefined;
      cell['formula'] = formulaToken ? renderFormula(formulaToken, variableMap, ckfMap, rkfMap, new Map()) : '';
    }
    return cell;
  });

  const helpCells = helpCellsRaw.map((hc) => ({
    id: (hc['@_id'] as string) ?? '',
    description: ((hc['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    selections: parseSelectionGroups(ensureArray(hc['Qry:groups']), ckfMap, rkfMap),
  }));

  // Step 11: Query-level settings
  const zeroSuppr = mainComp['Qry:zeroSuppression'] as Record<string, unknown> | undefined;
  const planningNode = mainComp['Qry:planning'] as Record<string, unknown> | undefined;
  const resultPosNode = mainComp['Qry:resultPosition'] as Record<string, unknown> | undefined;
  const zeroSuppression: Record<string, unknown> = {
    rows: zeroSuppr?.['@_rows'] === 'true' || zeroSuppr?.['@_rows'] === true,
    columns: zeroSuppr?.['@_columns'] === 'true' || zeroSuppr?.['@_columns'] === true,
  };
  if (zeroSuppr?.['@_mode']) zeroSuppression['mode'] = zeroSuppr['@_mode'] as string;
  const settings: Record<string, unknown> = {
    rfcEnabled: mainComp['@_rfcEnabled'] === 'true' || mainComp['@_rfcEnabled'] === true,
    easyQuery: mainComp['@_easyQuery'] === 'true' || mainComp['@_easyQuery'] === true,
    odataSupport: mainComp['@_odataSupport'] === 'true' || mainComp['@_odataSupport'] === true,
    suppressRepeatedKeyValues: mainComp['@_suppressRepeatedKeyValues'] === 'true' || mainComp['@_suppressRepeatedKeyValues'] === true,
    showScalingFactor: mainComp['@_showScalingFactor'] === 'true' || mainComp['@_showScalingFactor'] === true,
    signPresentation: (mainComp['@_signPresentation'] as string) ?? '',
    zeroSuppression,
    planning: {
      inputMode: planningNode?.['@_inputMode'] === 'true' || planningNode?.['@_inputMode'] === true,
      symmetrical: planningNode?.['@_symmetrical'] === 'true' || planningNode?.['@_symmetrical'] === true,
    },
    resultPosition: {
      onTop: resultPosNode?.['@_onTop'] === 'true' || resultPosNode?.['@_onTop'] === true,
      onLeft: resultPosNode?.['@_onLeft'] === 'true' || resultPosNode?.['@_onLeft'] === true,
    },
  };

  const output: Record<string, unknown> = {
    name: (mainComp['@_technicalName'] as string) ?? queryName.toUpperCase(),
    description: ((mainComp['Qry:description'] as Record<string, unknown> | undefined)?.['@_value'] as string) ?? '',
    infoProvider: (mainComp['@_providerName'] as string) ?? '',
    providerType,
    package: (packageRef?.['@_adtCore:name'] as string) ?? '',
    infoArea: (entityProps['infoArea'] as string) ?? '',
    status: (entityProps['objectStatus'] as string) ?? '',
    responsible: (entityProps['@_adtCore:responsible'] as string) ?? '',
    changedAt: (entityProps['@_adtCore:changedAt'] as string) ?? '',
    createdAt: (entityProps['@_adtCore:createdAt'] as string) ?? '',
    timestamp: (mainComp['@_timestamp'] as string) ?? '',
    settings,
    variables,
    filter,
    columns,
    rows,
    freeCharacteristics,
    calculatedMeasures,
    restrictedMeasures,
    exceptions,
    hasCellDefinitions,
    gridCells,
    helpCells,
  };

  if (versionNote) output['versionNote'] = versionNote;

  return JSON.stringify(output, null, 2);
}
