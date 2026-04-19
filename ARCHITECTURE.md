# Architecture — bw-modeling-mcp

Technical reference for the bw-modeling-mcp server: internal architecture, API discovery, and complete BW/4HANA Modeling REST API endpoint reference.

---

## Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| HTTP client | `axios` |
| XML parsing | `fast-xml-parser` |
| Runtime | Node.js 18+ |

---

## Authentication & Session Management

The BW Modeling REST API uses cookie-based sessions with CSRF token protection.

**CSRF Token Fetch:**
```
GET /sap/bw/modeling/discovery
Headers: X-CSRF-Token: Fetch
→ Response header: X-CSRF-Token: <token>
```

The token is fetched once at startup and reused for all subsequent write operations (PUT, POST). Session cookies are maintained across requests via `axios` cookie jar.

**Important:** Lock and write operations on the same object must use separate `BwClient` instances (separate `sap-contextid` session cookies). SAP's internal buffer caches object state per session — reusing the same session for both Lock and PUT causes null pointer crashes in the ABAP backend (`CL_RSTRAN_TRFN=>GET_PROGID`). This is not documented in the API — discovered via ABAP debugging.

---

## Lock → Read → Modify → PUT → Activate Pattern

All write operations on BW objects follow this protocol:

```
1. POST /sap/bw/modeling/{type}/{name}?action=lock
   → Response body: lockHandle (long hex string)

2. GET  /sap/bw/modeling/{type}/{name}/m
   → Full XML of the object (inactive version)

3. Modify XML in memory

4. PUT  /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}
   → Send full modified XML (never partial updates)

5. POST /sap/bw/modeling/activation
   → Promotes inactive version (m) to active (a)

6. POST /sap/bw/modeling/{type}/{name}?action=unlock  (if not activating)
```

**Object versions:**
- `m` = inactive/modified version (what you edit)
- `a` = active version (what is in production)

Always read `m`, write to `m`. Activation promotes `m` → `a`.

---

## Transport Request Handling

Transport request numbers (`corrNr`) are passed as URL query parameters on PUT operations — not as HTTP headers:

```
PUT /sap/bw/modeling/{type}/{name}/m?lockHandle={handle}&corrNr={transport}
```

---

## Media Type Discovery

Media types for each BW object type are loaded dynamically at server startup from the Discovery endpoint:

```
GET /sap/bw/modeling/discovery
```

This returns a self-describing service document with all available workspaces, object types, and their required media types. The server filters out `+json` variants where XML is required (e.g. for Lock endpoints).

---

## Push API

Write-interface aDSOs support direct data push via a separate API:

```
Base URL: /sap/bw4/v1/push/
CSRF:     GET /sap/bw4/v1/push/requests → X-CSRF-Token header
Body:     JSON array of records
Success:  HTTP 204 No Content
```

The Push API uses a separate `axios` client instance independent of the BW Modeling client.

---

## Source Structure

```
src/
├── index.ts              # MCP server entry point, tool definitions and dispatch
├── bw-client.ts          # HTTP client (CSRF, session, lock/unlock, GET/PUT/POST)
└── tools/
    ├── activation.ts     # bw_activate, bw_unlock
    ├── adso.ts           # bw_get_adso, bw_create_adso, bw_update_adso
    ├── delete.ts         # bw_delete
    ├── dtp.ts            # bw_get_dtp, bw_get_dtps, bw_create_dtp, bw_update_dtp, bw_set_dtp_filter_routine
    ├── infoarea.ts       # bw_get_infoarea, bw_create_infoarea, bw_move_object
    ├── infoobject.ts     # bw_get_infoobject, bw_create_infoobject, bw_update_infoobject
    ├── infosource.ts     # bw_get_infosource, bw_create_infosource, bw_update_infosource
    ├── push.ts           # bw_push_data, bw_get_push_schema
    ├── search.ts         # bw_search, bw_xref
    ├── transformation.ts # bw_get_transformation, bw_create_transformation,
    │                     # bw_update_transformation, bw_set_transformation_routine,
    │                     # bw_delete_transformation_routine, bw_set_transformation_runtime
    └── query.ts          # bw_get_query
```

---

## Complete BW/4HANA Modeling REST API Reference

Full endpoint list from BW/4HANA discovery — **47 workspaces, 130+ endpoints**.

### Core Modeling Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| aDSO | `/sap/bw/modeling/adso/{adsonm}` | `adso-v1_7_0+xml` |
| InfoObject | `/sap/bw/modeling/iobj/{infoobject}` | `infoobject-v2_2_0+json` |
| CompositeProvider | `/sap/bw/modeling/hcpr/{hcprnm}` | `hcpr-v1_15_0+xml` |
| Open ODS View | `/sap/bw/modeling/fbp/{fbpnm}` | `fbp-v1_0_0+xml` |
| InfoSource | `/sap/bw/modeling/trcs/{trcsnm}` | `trcs-v1_0_0+xml` |
| Transformation | `/sap/bw/modeling/trfn/{trfnnm}` | `trfn-v1_0_0+xml` |
| Transformation Formula Tokens | `/sap/bw/modeling/trfn/formula/tokens` | `trfn.formulatokens-v1_0_0+xml` |
| DataSource | `/sap/bw/modeling/rsds/{datasource}/{logsys}` | `rsds-v1_1_0+xml` |
| Aggregation Level | `/sap/bw/modeling/alvl/{alvlnm}` | `alvl-v1_0_0+xml` |
| Semantic Group | `/sap/bw/modeling/segr/{segrnm}` | `segr-v1_0_0+xml` |
| InfoArea | `/sap/bw/modeling/area/{objectname}` | `area-v1_1_0+json` |
| Source System | `/sap/bw/modeling/lsys/{sourcesystem}` | `lsys-v1_1_0+xml` |
| Open Hub Destination | `/sap/bw/modeling/dest/{destnm}` | `dest-v1_0_0+xml` |
| Document Store App | `/sap/bw/modeling/doca/{docanm}` | `doca-v1_0_0+xml` |
| HANA View as InfoProvider | `/sap/bw/modeling/hana/repository/{package}/{name}` | `hanv-v1_0_0+xml` |
| BW Hierarchy | `/sap/bw/modeling/hier/{hiernm}` | `hier-v1_0_0+xml` |
| Application Component | `/sap/bw/modeling/apco/{name}/{logsys}` | `apco-v1_0_0+xml` |
| Characteristic Relationship | `/sap/bw/modeling/plcr/{name}` | `plcr-v1_0_0+xml` |

### Process Chain & DTP Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| DTP | `/sap/bw/modeling/dtpa` | `dtp_load-v1_0_0+json` |
| Process Chain | `/sap/bw/modeling/rspc` | `chain-v1_0_0+json` |
| Process Variant | `/sap/bw/modeling/rspv` | `rspv-v1_0_0+json` |
| Process Type | `/sap/bw/modeling/rstp` | `type-v1_0_0+json` |
| Process Trigger | `/sap/bw/modeling/rspt` | `trigger-v1_0_0+json` |
| Process Interrupt | `/sap/bw/modeling/rspi` | `interrupt-v1_0_0+json` |
| Process Event | `/sap/bw/modeling/even` | `event-v1_0_0+json` |
| HANA Analysis Process | `/sap/bw/modeling/haap` | `hanaanalysisprocess-v1_0_0+json` |
| Dataflow | `/sap/bw/modeling/dmod` | `dmod-v1_0_0+xml` |
| Dataflow Copy | `/sap/bw/modeling/dmodcopy` | `dmodcopy-v1_0_0+xml` |

### Query Designer Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| BW Query | `/sap/bw/modeling/query/{compid}/{objvers}` | `query-v1_11_0+xml` |
| BW Variable | `/sap/bw/modeling/variable/{compid}/{objvers}` | `variable-v1_10_0+xml` |
| Restricted Key Figure | `/sap/bw/modeling/rkf/{compid}/{objvers}` | `rkf-v1_10_0+xml` |
| Calculated Key Figure | `/sap/bw/modeling/ckf/{compid}/{objvers}` | `ckf-v1_10_0+xml` |
| Filter Component | `/sap/bw/modeling/filter/{compid}/{objvers}` | `filter-v1_9_0+xml` |
| Structure Component | `/sap/bw/modeling/structure/{compid}/{objvers}` | `structure-v1_9_0+xml` |
| Reporting | `/sap/bw/modeling/reporting` | `bicsrequest-v1_1_0+xml` |

### Conversion & Planning Objects

| BW Object | Endpoint | Media Type |
|---|---|---|
| Currency Translation Type | `/sap/bw/modeling/ctrt/{objname}` | `ctrt-v1_0_0+xml` |
| Unit Conversion Type | `/sap/bw/modeling/uomt/{objname}` | `uomt-v1_0_0+xml` |
| Key Date Derivation Type | `/sap/bw/modeling/thjt/{objname}` | `thjt-v1_0_0+xml` |
| Data Slices | `/sap/bw/modeling/plds/{pldsnm}` | `plds-v1_0_0+xml` |
| Planning Functions | `/sap/bw/modeling/plse/{plsenm}` | `plse-v2_0_0+xml` |
| Planning Sequence | `/sap/bw/modeling/plsq/{plsqnm}` | `plsq-v1_0_0+xml` |
| Planning Function Type | `/sap/bw/modeling/plst/{plstnm}` | `plst-v1_0_0+xml` |

### Infrastructure Endpoints

| Purpose | Endpoint |
|---|---|
| **Activation** | `POST /sap/bw/modeling/activation` |
| **Check (pre-activation)** | `POST /sap/bw/modeling/checkruns` |
| Validation | `GET /sap/bw/modeling/validation?objectType=...&objectName=...` |
| Move objects | `POST /sap/bw/modeling/move_requests` |
| BW Transport | `/sap/bw/modeling/cto` |
| Jobs | `/sap/bw/modeling/jobs` |
| BW Content (install) | `/sap/bw/modeling/bwcontent/installation` |
| Component Refactor | `/sap/bw/modeling/comprefactor` |
| Data Privacy | `/sap/bw/modeling/dpp/fields` |
| BW Utils | `/sap/bw/modeling/utils` |
| Bucket services | `/sap/bw/modeling/bucket` |
| Query replication | `/sap/bw/modeling/compreplication` |

### Repository & Search Endpoints

| Purpose | Endpoint |
|---|---|
| **BW Search** | `GET /sap/bw/modeling/repo/is/bwsearch` |
| **Cross-reference / Where-used** | `GET /sap/bw/modeling/repo/is/xref` |
| InfoProvider tree | `GET /sap/bw/modeling/repo/infoproviderstructure/{type}/{name}` |
| DataSource tree | `GET /sap/bw/modeling/repo/datasourcestructure/{type}/{name}` |
| Node path resolver | `GET /sap/bw/modeling/repo/nodepath` |
| Application log | `GET /sap/bw/modeling/repo/is/applicationlog` |
| System capabilities | `GET /sap/bw/modeling/repo/is/systeminfo` |
| BW Content structure | `GET /sap/bw/modeling/repo/bwcontentstructure` |
| Virtual folders | `GET /sap/bw/modeling/repo/virtualfolders/contents` |
| Planning view | `GET /sap/bw/modeling/repo/is/planning_view` |

### Value Help Endpoints

| Purpose | Endpoint |
|---|---|
| InfoObjects | `/sap/bw/modeling/is/values/infoobject` |
| InfoProviders | `/sap/bw/modeling/is/values/infoprovider` |
| DataSources | `/sap/bw/modeling/is/values/datasources` |
| Source Systems | `/sap/bw/modeling/is/values/sourcesystem` |
| InfoAreas | `/sap/bw/modeling/is/values/infoareas` |
| Queries | `/sap/bw/modeling/is/values/queries` |
| DSO Names | `/sap/bw/modeling/is/values/dsonames` |
| Characteristics | `/sap/bw/modeling/is/values/characteristics` |
| Characteristic Hierarchies | `/sap/bw/modeling/is/values/characteristichiers` |
| InfoObject Hierarchies | `/sap/bw/modeling/is/values/infoObjectHierarchies` |
| Aggregation Levels | `/sap/bw/modeling/is/values/aggregationlevel` |
| Conversion Routines | `/sap/bw/modeling/is/values/conversionroutine` |
| HANA Remote Sources | `/sap/bw/modeling/is/values/hana_remotesources` |
| HANA Entities | `/sap/bw/modeling/is/values/hanaentity` |
| ODP | `/sap/bw/modeling/is/values/odp` |
| ODP Context | `/sap/bw/modeling/is/values/odpcontext` |
| Open ODS Views | `/sap/bw/modeling/is/values/fbp` |
| Planable InfoProviders | `/sap/bw/modeling/is/values/planableinfoprovider` |
