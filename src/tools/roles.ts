import { BwClient } from '../bw-client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoleNode {
  nodeid: string;
  role: string;
  name: string;
  type: 'FOLDER' | 'ROLE';
  txt: string;
  attribKey?: string;
  attribTxt?: string;
  children: RoleNode[];
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function xmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = xmlDecode(m[2]);
  }
  return attrs;
}

// ── Recursive XML node parser ─────────────────────────────────────────────────

function parseNodes(xml: string): RoleNode[] {
  const nodes: RoleNode[] = [];
  let pos = 0;

  while (pos < xml.length) {
    const nodeStart = xml.indexOf('<node', pos);
    if (nodeStart === -1) break;

    const tagEnd = xml.indexOf('>', nodeStart);
    if (tagEnd === -1) break;

    const tagInner = xml.substring(nodeStart + 5, tagEnd);
    const isSelfClosing = tagInner.trimEnd().endsWith('/');
    const attrStr = isSelfClosing ? tagInner.trimEnd().slice(0, -1) : tagInner;
    const attrs = parseAttrs(attrStr);

    const node: RoleNode = {
      nodeid: attrs['nodeid'] ?? '',
      role: attrs['role'] ?? '',
      name: attrs['name'] ?? '',
      type: (attrs['type'] as 'FOLDER' | 'ROLE') ?? 'FOLDER',
      txt: attrs['txt'] ?? '',
      children: [],
    };
    if (attrs['attribKey'] !== undefined) node.attribKey = attrs['attribKey'];
    if (attrs['attribTxt'] !== undefined) node.attribTxt = attrs['attribTxt'];

    if (isSelfClosing) {
      pos = tagEnd + 1;
    } else {
      // Find the matching </node> tracking nesting depth
      let depth = 1;
      let searchPos = tagEnd + 1;
      let closingPos = -1;

      while (depth > 0 && searchPos < xml.length) {
        const nextOpen = xml.indexOf('<node', searchPos);
        const nextClose = xml.indexOf('</node>', searchPos);

        if (nextClose === -1) break;

        if (nextOpen !== -1 && nextOpen < nextClose) {
          const innerTagEnd = xml.indexOf('>', nextOpen);
          const innerTagInner = xml.substring(nextOpen + 5, innerTagEnd);
          if (!innerTagInner.trimEnd().endsWith('/')) {
            depth++;
          }
          searchPos = innerTagEnd + 1;
        } else {
          depth--;
          if (depth === 0) {
            closingPos = nextClose;
          }
          searchPos = nextClose + 7; // '</node>'.length === 7
        }
      }

      if (closingPos !== -1) {
        const childXml = xml.substring(tagEnd + 1, closingPos);
        node.children = parseNodes(childXml);
        pos = closingPos + 7;
      } else {
        pos = tagEnd + 1;
      }
    }

    nodes.push(node);
  }

  return nodes;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderFolderChild(node: RoleNode, indent: string, lines: string[]): void {
  lines.push(`${indent}[FOLDER] ${node.txt} (nodeid: ${node.nodeid})`);
  for (const child of node.children) {
    renderFolderChild(child, indent + '  ', lines);
  }
}

function renderTreeNode(node: RoleNode, indent: string, lines: string[]): void {
  if (node.type === 'ROLE') {
    lines.push(`${indent}[ROLE] ${node.name} — ${node.txt}`);
    lines.push(`${indent}  nodeid: ${node.nodeid}`);
    for (const child of node.children) {
      renderFolderChild(child, indent + '    ', lines);
    }
  } else {
    // Top-level FOLDER wrapper — show name (txt is empty at this level)
    lines.push(`${indent}[FOLDER] ${node.name || node.txt}`);
    for (const child of node.children) {
      renderTreeNode(child, indent + '  ', lines);
    }
  }
}

// ── PUT body builders ─────────────────────────────────────────────────────────

function buildFolderChildXml(node: RoleNode, indent: string): string[] {
  const lines: string[] = [];
  if (node.children.length === 0) {
    lines.push(
      `${indent}<node nodeid="${node.nodeid}" role="${xmlEscape(node.role)}" ` +
      `state="unchanged" type="${node.type}" txt="${xmlEscape(node.txt)}"/>`
    );
  } else {
    lines.push(
      `${indent}<node nodeid="${node.nodeid}" role="${xmlEscape(node.role)}" ` +
      `state="unchanged" type="${node.type}" txt="${xmlEscape(node.txt)}">`
    );
    for (const child of node.children) {
      lines.push(...buildFolderChildXml(child, indent + '  '));
    }
    lines.push(`${indent}</node>`);
  }
  return lines;
}

function buildAddFolderBody(queryName: string, node: RoleNode): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<tree type="SAP_BW_QUERY" viewType="ancestors" refName="${xmlEscape(queryName)}">`,
    `  <node nodeid="${node.nodeid}" role="${xmlEscape(node.role)}" state="added" type="FOLDER" txt="${xmlEscape(node.txt)}">`,
    `  </node>`,
    `</tree>`,
  ].join('\n');
}

function buildAddRoleBody(queryName: string, node: RoleNode): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<tree type="SAP_BW_QUERY" viewType="ancestors" refName="${xmlEscape(queryName)}">`,
    `  <node nodeid="${node.nodeid}" role="${xmlEscape(node.role)}" state="added" type="ROLE" ` +
      `txt="${xmlEscape(node.txt)}" name="${xmlEscape(node.name)}">`,
  ];
  for (const child of node.children) {
    lines.push(...buildFolderChildXml(child, '    '));
  }
  lines.push(`  </node>`);
  lines.push(`</tree>`);
  return lines.join('\n');
}

function buildDeleteBody(queryName: string, node: RoleNode): string {
  const attribKey = xmlEscape(node.attribKey ?? '');
  const attribTxt = xmlEscape(node.attribTxt ?? '');
  const nodeAttrs = node.type === 'ROLE'
    ? `nodeid="${node.nodeid}" role="${xmlEscape(node.role)}" state="deleted" type="ROLE" ` +
      `txt="${xmlEscape(node.txt)}" attribKey="${attribKey}" attribTxt="${attribTxt}" name="${xmlEscape(node.name)}"`
    : `nodeid="${node.nodeid}" role="${xmlEscape(node.role)}" state="deleted" type="FOLDER" ` +
      `txt="${xmlEscape(node.txt)}" attribKey="${attribKey}" attribTxt="${attribTxt}"`;
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<tree type="SAP_BW_QUERY" viewType="ancestors" refName="${xmlEscape(queryName)}">`,
    `  <node ${nodeAttrs}>`,
    `  </node>`,
    `</tree>`,
  ].join('\n');
}

// ── PUT response parser ───────────────────────────────────────────────────────

function parsePutResponse(xml: string): string {
  // The response is an atom:feed; the entry-level title/summary carry the actual message.
  const entryMatch = xml.match(/<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/);
  const entryXml = entryMatch?.[1] ?? xml;
  const summary = entryXml.match(/<atom:summary[^>]*>([^<]*)<\/atom:summary>/)?.[1] ?? '';
  const title = entryXml.match(/<atom:title[^>]*>([^<]*)<\/atom:title>/)?.[1] ?? xml;
  if (summary.includes('Fehler')) {
    throw new Error(title);
  }
  return title;
}

// ── Internal fetch helpers ────────────────────────────────────────────────────

async function fetchRolesTree(client: BwClient): Promise<RoleNode[]> {
  const { body } = await client.rawGet(
    '/sap/bw/modeling/comp/roles?level=10&requestchk=true&readleaves=false',
    { Accept: 'application/xml', 'X-sap-adt-sessiontype': 'stateless' }
  );
  const treeMatch = body.match(/<tree\b[^>]*>([\s\S]*)<\/tree>/);
  if (!treeMatch) return [];
  return parseNodes(treeMatch[1]);
}

interface QueryAssignment {
  roleName: string;
  roleNodeid: string;
  roleRole: string;
  roleTxt: string;
  attribKey: string;
  attribTxt: string;
  folder?: { nodeid: string; role: string; txt: string };
}

async function fetchQueryAssignments(client: BwClient, queryName: string): Promise<{ refName: string; queryTxt: string; assignments: QueryAssignment[] }> {
  const { body } = await client.rawGet(
    `/sap/bw/modeling/comp/roles?type=SAP_BW_QUERY&ancof=${encodeURIComponent(queryName)}`,
    { Accept: 'application/xml', 'X-sap-adt-sessiontype': 'stateless' }
  );

  const treeAttrStr = body.match(/<tree\b([^>]*?)(?:\/>|>)/)?.[1] ?? '';
  const treeAttrs = parseAttrs(treeAttrStr);
  const refName = treeAttrs['refName'] ?? queryName;
  const queryTxt = treeAttrs['txt'] ?? '';

  // Self-closing or empty tree means not published
  if (/<tree\b[^>]*\/>/.test(body)) {
    return { refName, queryTxt, assignments: [] };
  }

  const treeMatch = body.match(/<tree\b[^>]*>([\s\S]*)<\/tree>/);
  if (!treeMatch) return { refName, queryTxt, assignments: [] };

  const roleNodes = parseNodes(treeMatch[1]);
  const assignments: QueryAssignment[] = roleNodes.map(rn => {
    // The ancestor view returns a top-level FOLDER node when the query is assigned inside a
    // subfolder. The role name is embedded in the `role` attribute ("ROLENAME   ORIGINID").
    // When assigned at role level, a ROLE node is returned with `name` set directly.
    if (rn.type === 'FOLDER') {
      return {
        roleName: rn.role.split(/\s+/)[0],
        roleNodeid: '',
        roleRole: '',
        roleTxt: '',
        attribKey: rn.attribKey ?? '',
        attribTxt: rn.attribTxt ?? '',
        folder: { nodeid: rn.nodeid, role: rn.role, txt: rn.txt },
      };
    }
    const a: QueryAssignment = {
      roleName: rn.name || rn.role.split(/\s+/)[0],
      roleNodeid: rn.nodeid,
      roleRole: rn.role,
      roleTxt: rn.txt,
      attribKey: rn.attribKey ?? '',
      attribTxt: rn.attribTxt ?? '',
    };
    if (rn.children.length > 0) {
      const f = rn.children[0];
      a.folder = { nodeid: f.nodeid, role: f.role, txt: f.txt };
    }
    return a;
  });

  return { refName, queryTxt, assignments };
}

// ── Leaf parser ───────────────────────────────────────────────────────────────

interface LeafNode {
  nodeid: string;
  name: string;
  txt: string;
  objectType: string;
  objectSubType: string;
  infoprov: string;
  guid: string;
  responsible: string;
  timestamp: string;
}

interface RoleWithLeaves {
  roleName: string;
  roleTxt: string;
  leaves: LeafNode[];
}

function parseLeaves(xml: string): LeafNode[] {
  const leaves: LeafNode[] = [];
  const re = /<leaf\s([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    leaves.push({
      nodeid: attrs['nodeid'] ?? '',
      name: attrs['name'] ?? '',
      txt: attrs['txt'] ?? '',
      objectType: attrs['objectType'] ?? '',
      objectSubType: attrs['objectSubType'] ?? '',
      infoprov: attrs['infoprov'] ?? '',
      guid: attrs['guid'] ?? '',
      responsible: attrs['responsible'] ?? '',
      timestamp: attrs['timestamp'] ?? '',
    });
  }
  return leaves;
}

function parseRolesWithLeaves(xml: string): RoleWithLeaves[] {
  const result: RoleWithLeaves[] = [];

  function walk(content: string): void {
    let pos = 0;
    while (pos < content.length) {
      const nodeStart = content.indexOf('<node', pos);
      if (nodeStart === -1) break;

      const tagEnd = content.indexOf('>', nodeStart);
      if (tagEnd === -1) break;

      const tagInner = content.substring(nodeStart + 5, tagEnd);
      const isSelfClosing = tagInner.trimEnd().endsWith('/');
      const attrStr = isSelfClosing ? tagInner.trimEnd().slice(0, -1) : tagInner;
      const attrs = parseAttrs(attrStr);

      if (isSelfClosing) {
        pos = tagEnd + 1;
        continue;
      }

      let depth = 1;
      let searchPos = tagEnd + 1;
      let closingPos = -1;
      while (depth > 0 && searchPos < content.length) {
        const nextOpen = content.indexOf('<node', searchPos);
        const nextClose = content.indexOf('</node>', searchPos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          const innerTagEnd = content.indexOf('>', nextOpen);
          const innerTagInner = content.substring(nextOpen + 5, innerTagEnd);
          if (!innerTagInner.trimEnd().endsWith('/')) depth++;
          searchPos = innerTagEnd + 1;
        } else {
          depth--;
          if (depth === 0) closingPos = nextClose;
          searchPos = nextClose + 7;
        }
      }

      const childContent = closingPos !== -1 ? content.substring(tagEnd + 1, closingPos) : '';

      if (attrs['type'] === 'ROLE') {
        const leaves = parseLeaves(childContent);
        if (leaves.length > 0) {
          result.push({ roleName: attrs['name'] ?? '', roleTxt: attrs['txt'] ?? '', leaves });
        }
      } else {
        walk(childContent);
      }

      pos = closingPos !== -1 ? closingPos + 7 : tagEnd + 1;
    }
  }

  walk(xml);
  return result;
}

// ── Exported functions ────────────────────────────────────────────────────────

export async function bwGetRoles(
  client: BwClient,
  roleFilter?: string
): Promise<string> {
  const { body } = await client.rawGet(
    '/sap/bw/modeling/comp/roles?level=10&requestchk=true&readleaves=false',
    { Accept: 'application/xml', 'X-sap-adt-sessiontype': 'stateless' }
  );

  const treeMatch = body.match(/<tree\b[^>]*>([\s\S]*)<\/tree>/);
  if (!treeMatch) return 'No role tree found.';

  const topNodes = parseNodes(treeMatch[1]);

  function countRoles(nodes: RoleNode[]): number {
    let count = 0;
    for (const n of nodes) {
      if (n.type === 'ROLE') count++;
      count += countRoles(n.children);
    }
    return count;
  }

  function filterNodes(nodes: RoleNode[]): RoleNode[] {
    if (!roleFilter) return nodes;
    return nodes.flatMap(n => {
      if (n.type === 'ROLE') {
        return n.name.startsWith(roleFilter) ? [n] : [];
      }
      // FOLDER: keep as structural container if it has matching descendants
      const filteredChildren = filterNodes(n.children);
      return filteredChildren.length > 0 ? [{ ...n, children: filteredChildren }] : [];
    });
  }

  const totalRoles = countRoles(topNodes);
  const filteredNodes = filterNodes(topNodes);

  const lines: string[] = [
    'BW Query Role Tree',
    '==================',
    `Total roles: ${totalRoles}`,
    '',
  ];

  for (const node of filteredNodes) {
    renderTreeNode(node, '', lines);
  }

  return lines.join('\n');
}

export async function bwGetQueryRoles(
  client: BwClient,
  queryName: string
): Promise<string> {
  const { refName, queryTxt, assignments } = await fetchQueryAssignments(client, queryName.toUpperCase());

  if (assignments.length === 0) {
    return `Query ${refName} is not published in any role.`;
  }

  const lines: string[] = [
    `Query: ${refName}${queryTxt ? ` — ${queryTxt}` : ''}`,
    '',
    `Published in ${assignments.length} role(s):`,
  ];

  for (const a of assignments) {
    const roleDesc = a.roleTxt ? ` — ${a.roleTxt}` : '';
    lines.push(`  [ROLE] ${a.roleName}${roleDesc}`);
    if (a.folder) {
      lines.push(`    Folder: ${a.folder.txt}`);
    }
  }

  return lines.join('\n');
}

export async function bwSetQueryRoles(
  client: BwClient,
  queryName: string,
  action: 'add' | 'remove',
  targetName: string,
  targetType: 'role' | 'folder',
  parentRoleName?: string
): Promise<string> {
  const qName = queryName.toUpperCase();
  const putUrl = `/sap/bw/modeling/comp/roles?type=SAP_BW_QUERY&ancof=${encodeURIComponent(qName)}`;

  let putBody: string;

  if (action === 'add') {
    const tree = await fetchRolesTree(client);

    if (targetType === 'role') {
      function findRole(nodes: RoleNode[]): RoleNode | undefined {
        for (const n of nodes) {
          if (n.type === 'ROLE' && n.name === targetName) return n;
          const found = findRole(n.children);
          if (found) return found;
        }
        return undefined;
      }
      const roleNode = findRole(tree);
      if (!roleNode) throw new Error(`Role "${targetName}" not found in role tree.`);
      putBody = buildAddRoleBody(qName, roleNode);

    } else {
      if (!parentRoleName) throw new Error('parent_role_name is required when target_type is "folder".');

      function findParentRole(nodes: RoleNode[]): RoleNode | undefined {
        for (const n of nodes) {
          if (n.type === 'ROLE' && n.name === parentRoleName) return n;
          const found = findParentRole(n.children);
          if (found) return found;
        }
        return undefined;
      }
      const parentRole = findParentRole(tree);
      if (!parentRole) throw new Error(`Role "${parentRoleName}" not found in role tree.`);

      function findFolder(nodes: RoleNode[]): RoleNode | undefined {
        for (const n of nodes) {
          if (n.type === 'FOLDER' && n.txt === targetName) return n;
          const found = findFolder(n.children);
          if (found) return found;
        }
        return undefined;
      }
      const folderNode = findFolder(parentRole.children);
      if (!folderNode) throw new Error(`Folder "${targetName}" not found in role "${parentRoleName}".`);
      putBody = buildAddFolderBody(qName, folderNode);
    }

  } else {
    // action === 'remove'
    const { assignments } = await fetchQueryAssignments(client, qName);
    if (assignments.length === 0) throw new Error(`Query "${qName}" is not published in any role.`);

    if (targetType === 'role') {
      const a = assignments.find(x => x.roleName === targetName);
      if (!a) throw new Error(`Query "${qName}" is not published in role "${targetName}".`);
      putBody = buildDeleteBody(qName, {
        nodeid: a.roleNodeid,
        role: a.roleRole,
        name: a.roleName,
        type: 'ROLE',
        txt: a.roleTxt,
        attribKey: a.attribKey,
        attribTxt: a.attribTxt,
        children: [],
      });

    } else {
      if (!parentRoleName) throw new Error('parent_role_name is required when target_type is "folder".');
      const a = assignments.find(x => x.roleName === parentRoleName && x.folder?.txt === targetName);
      if (!a || !a.folder) throw new Error(`Query "${qName}" is not published in folder "${targetName}" of role "${parentRoleName}".`);
      putBody = buildDeleteBody(qName, {
        nodeid: a.folder.nodeid,
        role: a.folder.role,
        name: '',
        type: 'FOLDER',
        txt: a.folder.txt,
        attribKey: a.attribKey,
        attribTxt: a.attribTxt,
        children: [],
      });
    }
  }

  const csrfToken = await client.getCsrfToken();
  const { body: putResponse } = await client.rawPut(putUrl, putBody, {
    'Content-Type': 'application/xml',
    'X-sap-adt-sessiontype': 'stateless',
    'X-CSRF-Token': csrfToken,
  });

  return parsePutResponse(putResponse);
}

export async function bwGetRoleQueries(
  client: BwClient,
  roleName?: string
): Promise<string> {
  const { body } = await client.rawGet(
    '/sap/bw/modeling/comp/roles?level=10&requestchk=true&readleaves=true',
    { Accept: 'application/xml', 'X-sap-adt-sessiontype': 'stateless' }
  );

  const treeMatch = body.match(/<tree\b[^>]*>([\s\S]*)<\/tree>/);
  if (!treeMatch) return 'No role tree found.';

  const rolesWithLeaves = parseRolesWithLeaves(treeMatch[1]);

  const filtered = roleName
    ? rolesWithLeaves.filter(r => r.roleName === roleName)
    : rolesWithLeaves;

  if (filtered.length === 0) {
    return roleName
      ? `No published objects found in role "${roleName}".`
      : 'No published objects found in any role.';
  }

  const lines: string[] = [];
  let total = 0;

  for (const r of filtered) {
    lines.push(`[ROLE] ${r.roleName} — ${r.roleTxt}`);
    for (const leaf of r.leaves) {
      const label = leaf.txt && leaf.txt !== leaf.name ? `${leaf.name} — ${leaf.txt}` : leaf.name;
      lines.push(`  ${label} (${leaf.objectType}/${leaf.objectSubType}, InfoProv: ${leaf.infoprov})`);
      total++;
    }
    lines.push('');
  }

  lines.unshift(`Total published objects: ${total}`, '');
  return lines.join('\n');
}
