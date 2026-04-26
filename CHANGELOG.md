# Changelog

## [0.4.0] — 2026-04-26

### Added

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
