# Changelog

## [0.7.0] — 2026-05-21

### Added

- `bw_get_process_chain` — reads a Process Chain (RSPC) definition via the BW/4HANA-specific endpoint (`/sap/bw/modeling/rspc/{name}/m`, Accept: `application/vnd.sap.bw4.modeling.processchain-v1_0_0+json`); returns header metadata (description, InfoArea, status, version), scheduling attributes (job priority, owner, server, streaming mode), monitoring settings (auto-monitored, error notification, keep-alive, auto-reset), all steps (nodes) with process type, variant, description, last execution status, DECISION branch labels with socket resolution, OR join annotations, and sub-chain references; edges with full conditional flow semantics (positive/negative/neutral, DECISION branch names resolved from socket descriptions); inline variant section; by default (`include_variant_details=true`) automatically fetches and embeds variant configuration for each step via internal calls to `/sap/bw4/v1/modeling/processtypes/{type}/variants/{name}/m` — deterministic, not prompt-driven; types with no variant schema (DTP_LOAD, CHAIN, OR, AND, EXOR, DTP_ADSO) are skipped; set `include_variant_details=false` for structural overview without variant detail; `format="raw"` returns full parsed JSON; use `bw_search` with `object_type=PRCH` to find chain names
- `bw_get_process_variant` — reads the detail configuration of a single Process Chain step variant from `/sap/bw4/v1/modeling/processtypes/{type}/variants/{name}/m`; generic across all 93 BW/4HANA process types; `oDetail` returned as indented JSON regardless of type — covers ABAP (program + selection variant), ADSOACT (aDSO + NOCONDENSE), ADSOREM (cleanup: days/requests), PLSWITCHL/PLSWITCHP (target aDSO), TRIGGER (full scheduling payload), DECISION (branch formula expressions), and any unknown type; `format="raw"` returns full parsed JSON; process_type and variant_name come from `bw_get_process_chain` output
- `bw_preview_datasource` — fetches a live data preview from a DataSource (RSDS) via the internal `rsdsint/dataprev` endpoint (`POST /sap/bw/modeling/rsdsint/dataprev/{source_system}/{datasource}?records={n}&external=true`); field names resolved automatically from a prior GET on the DataSource structure; renders a padded plain-text table with proper column alignment; `records` parameter configurable (default 20); handles field/column count mismatch with fallback to `COL_N` headers and warning

### Notes

- Process chain support uses the BW/4HANA-specific `/sap/bw4/` API namespace — the same API consumed internally by the BW/4HANA Cockpit (Fiori); `Accept: */*` is used to negotiate the correct media type automatically
- `bw_get_process_chain` with recursive sub-chain expansion: call the tool again on any CHAIN-type step's variant name to drill into the sub-chain

---

## [0.6.0] — 2026-05-10

### Added

- `bw_get_roles` _(Read only)_ — reads the complete BW role hierarchy as shown in the Eclipse BWMT "Publish to Role" dialog; returns ROLE and FOLDER nodes with technical names, descriptions, and nodeids; optional `role_filter` parameter limits output to roles whose name starts with the given prefix (e.g. `"BW:"`); endpoint: `GET /sap/bw/modeling/comp/roles?level=10&requestchk=true&readleaves=false`
- `bw_get_role_queries` _(Read only)_ — lists all BW Queries published in the role hierarchy, grouped by role and folder; only `SAP_BW_QUERY` objects are returned — PFCG menu entries of other types (e.g. AFO workbooks added as transactions) are not included; uses `readleaves=true` on the same endpoint to retrieve `<leaf>` elements
- `bw_get_query_roles` _(Read only)_ — returns all roles and folders where a specific BW Query is currently published; uses the `ancof` (ancestor-of) parameter: `GET /sap/bw/modeling/comp/roles?type=SAP_BW_QUERY&ancof=<QUERYNAME>`
- `bw_set_query_roles` — publishes or removes a BW Query from a role or folder; supports `action="add"` and `action="remove"`, `target_type="role"` or `target_type="folder"`; for role-level add operations the full role subtree (folders + nodeids) is fetched from `bw_get_roles` and sent as `state="unchanged"` children in the PUT body; uses `PUT /sap/bw/modeling/comp/roles?type=SAP_BW_QUERY&ancof=<QUERYNAME>`
- `BwClient.rawPut()` — new HTTP PUT helper on the shared BW client; sends a raw request body with caller-controlled headers using a fresh axios instance and the current session cookie; used by `bw_set_query_roles`

---

## [0.5.0] — 2026-05-03

### Added

- `bw_query_data` _(Read only)_ — executes a BEx Query or previews data from an InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint (`/sap/bw/modeling/comp/reporting`); parameters: `comp_id`, `is_provider` (adds `!` prefix for direct provider access), `state` (axis layout — ROWS/COLUMNS/FREE — plus per-characteristic filters supporting EQ/BT/GT/LT/GE/LE operators, include/exclude, external key, internal GUID key with `presentationMode="INT"`, and hierarchy-node filters via `nodeId=1`), `variables` (fills query variables; name and id must be copied verbatim from the GET response as they are session-specific and may contain trailing spaces), `from_row`/`to_row` (pagination), `drill_operations` (expand or collapse hierarchy and structure nodes by 1-based tuple index: `drill_state=3` expands, `drill_state=2` collapses), `format` (`text` default — formatted table with hierarchy indentation; `raw` — XML); all reporting calls use `X-sap-adt-sessiontype: stateless`; CSRF retry: on HTTP 403 the cached token is cleared and the request is retried once automatically
- `bw_get_filter_values` _(Read only)_ — looks up valid characteristic values before setting filters or variables; returns both `CHAVL_EXT` (use for state filters, `presentationMode="EXT"`) and `CHAVL_INT` (use for variable inputs); supports wildcard search (`*` for all, prefix match e.g. `2022*`); parameters: `characteristic_name`, `search_string`, `info_provider` (optional, scopes values to a specific provider), `max_rows` (default 201)

### Improved

- `bw_get_query` — added `format` parameter: `text` (new default) renders a compact human-readable summary covering settings, variables, filter, layout (rows/columns/free characteristics), CKFs, RKFs, exceptions, and cell definitions; `raw` returns the full parsed JSON (previous behaviour)
- `BwClient` — added `rawGet()` helper (shared session GET with caller-controlled headers, used by all reporting calls); CSRF token TTL of 4 minutes so that `ensureCsrf()` proactively re-fetches the token before SAP's ~5-minute session idle timeout expires (prevents "CSRF token has expired" failures in environments with slow tool-call approval); `clearCsrfToken()` public method exposed for use by retry logic

---

## [0.4.0] — 2026-04-26

### Added

- `bw_get_dataflow` _(Read only)_ — reads the complete structural data flow of any BW object (ADSO, RSDS, HCPR, TRFN, DTPA, IOBJ, TRCS, LSYS) using the same transient dataflow graph that Eclipse BWMT renders; supports direction (upwards / downwards / both), configurable depth levels, and format "text" | "raw"; text output uses tree rendering for ≤ 30 nodes and flat table for larger graphs
- `bw_list_source_systems` — lists all logical source systems (LSYS) registered in BW, optionally filtered by type (ODP_BW, ODP_SAP, ODP_CDS, ODP, FILE); returns name, description, type, status, and `children_path`
- `bw_list_datasources` — recursively traverses the full APCO hierarchy under a source system and lists all DataSources with name, description, status, and APCO path; format: `text` (default table) or `raw` (XML feed bodies)
- `bw_get_source_system` — reads full metadata of a single LSYS including type, description, connection details (ODP context/destination, HANA remote source/schema/SDI adapter)
- `bw_get_datasource` — reads complete DataSource structure: all fields with type, length, precision/scale, transfer flag, key flag, position, selection options, conversion exit, unit/currency reference, and active adapter config; format: `text` (default) or `raw` (XML)

### Improved

- `bw_xref` — new optional `source_system` parameter; required when `object_type=RSDS`; correct space-padded 40-character objectName (datasource padded to 30 + source system) is built automatically; explicit error thrown if omitted for RSDS
- `bw_get_transformation` — `raw` boolean replaced by `format: "text" | "raw"` parameter; `format="raw"` returns clean XML without wrapper header lines
- `bw_get_datasource`, `bw_list_datasources`, `bw_get_transformation` — unified `format: "text" | "raw"` parameter pattern across all three tools
- `bw_xref` tool description — documents that `object_type=DTPA` returns the process chain(s) a DTP belongs to, preferred over `bw_get_dtp` when only the process chain is needed
- `bw_get_dtp` tool description — documents that `bw_xref` with `object_type=DTPA` is the faster alternative when only process chain membership is needed

---

## [0.3.0] — 2026-04-24

### Added

- `bw_get_composite_provider` _(Read only)_ — reads a CompositeProvider (HCPR) structure: view node type (Union/Join), source providers with input mapping counts, all fields with dimension classification, join conditions, and temporal join details (extended from v0.2.0: field-level detail and join conditions fully parsed)
- `bw_get_ckf` _(Read only)_ — reads a global Calculated Key Figure with recursively resolved human-readable formula and full dependency graph of all referenced CKF/RKF sub-components
- `bw_get_rkf` _(Read only)_ — reads a global Restricted Key Figure: base measure resolved by name, all characteristic restriction groups with field and value details, and metadata
- `bw_get_structure` _(Read only)_ — reads a global Structure: all members with Formula/Selection breakdown, referenced components, characteristic filters, optional child members, and metadata
- `bw_list_contents` _(Read only)_ — navigates the full BW repository tree (InfoArea → type folder → object → sub-folder), mirroring the Eclipse BWMT Project Explorer; each entry includes `children_path` for seamless drill-down

---

## [0.2.0] — 2026-04-19

### Added

- `bw_get_query` — new read-only tool for BW Queries
  - Reads active version (`/A`) with automatic fallback to inactive (`/M`)
  - Parses all subComponents: Variables, Calculated Key Figures (CKFs), Restricted Key Figures (RKFs)
  - CKF formulas recursively resolved to human-readable strings: InfoObject names, cross-references between CKFs/RKFs, variable references, `IF` / `NOERR` / `NODIM` operators
  - RKF selection conditions fully parsed: key figure restrictions, characteristic restrictions, component references
  - Full layout parsing: columns, rows, free characteristics — both simple Dimensions and CustomDimensions (reusable structures)
  - CustomDimension members fully parsed including nested `childMembers` — inline RKFs with selection conditions and inline formulas with local member name resolution
  - Filter area: fixed values, variable references, mixed selections (variable + fixed value on same InfoObject)
  - Exceptions with alert levels, thresholds, cell coordinates, and evaluation flags
  - Grid cells and help cells fully parsed (cross-table layout queries)
  - Query-level settings: zero suppression, planning mode, result position, RFC/OData/easyQuery flags, sign presentation

---

## [0.1.0] — 2026-04-17

### Added

- Initial public release as pre-release (v0.1.0)
- aDSO: create, update (fields, settings, keys, field properties), delete — including write-interface (`pushMode`)
- InfoObject: create CHA + KYF, update attributes (DIS/NAV), delete
- InfoArea: create, move objects
- InfoSource (TRCS): create with/without template, update fields, delete
- Transformation: create (all source/target types), update (direct mapping, formula, field routines ABAP+AMDP, start/end routines), activate
- DTP: create, update (description + value filter), set filter routine
- Push API: `bw_push_data`, `bw_get_push_schema`
- General: search (`bw_search`), activate (`bw_activate`), where-used/xref (`bw_xref`), release locks (`bw_unlock`), delete (`bw_delete`)
