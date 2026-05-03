# bw-modeling-mcp

A Model Context Protocol (MCP) server that enables AI assistants like Claude to work directly inside SAP BW/4HANA systems — reading, creating and modifying BW modeling objects via the internal REST API used by Eclipse BWMT.

**This is not a simulation.** Every tool call connects to a live BW system — write operations produce real changes.

---

## 📖 Featured Blog Post

**Agentic AI meets SAP BW** — the full story behind this project: why I built it, what's inside, what happens when Claude walks through a complete BW data lineage on its own.

Read the blog (DE + EN): https://www.nextlytics.com/blog/agentic-ai-meets-sap-bw

![Agentic AI meets SAP BW](docs/blog-cover.png)

---

## 🆕 What's New — v0.5.0

Live data querying:

- `bw_query_data` — executes a BEx Query or previews data from any InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint; supports variable input, axis layout control (ROWS/COLUMNS/FREE), characteristic filters with include/exclude and range operators, hierarchy drill-down (expand/collapse nodes), pagination, and structure member selection; renders a formatted table with hierarchy indentation
- `bw_get_filter_values` — looks up valid characteristic values before setting filters or variables; supports wildcard search and optional InfoProvider scoping
- `bw_get_query` — now returns a compact human-readable summary by default; use `format="raw"` to get the previous full JSON output

---

## What's New — v0.4.0

DataSource and source system navigation:

- `bw_get_dataflow` — traces the complete structural data flow graph of any BW object in any direction (upwards / downwards / both); mirrors the Eclipse BWMT Transient Data Flow view
- `bw_list_source_systems` — lists all logical source systems (LSYS) registered in BW, filterable by type (ODP_SAP, ODP_CDS, ODP_BW, ODP, FILE, HANA_SDA, HANA_LOCAL)
- `bw_list_datasources` — recursively lists all DataSources under a source system with full APCO hierarchy path
- `bw_get_source_system` — reads full source system metadata: type, description, connection details (ODP context/destination, HANA remote source, schema)
- `bw_get_datasource` — reads complete DataSource structure: all fields with types, lengths, transfer flags, key flags, conversion exits, unit/currency references, and adapter configuration
- `bw_xref` — new `source_system` parameter for `object_type=RSDS`; the correct space-padded objectName is built automatically

---

## What's New — v0.3.0

CompositeProvider read support and BW repository navigation:

- `bw_get_composite_provider` — reads a CompositeProvider structure: view node type (Union/Join), source providers with mapping counts, all fields with dimension classification, join conditions, and temporal join details
- `bw_get_ckf` — reads a global Calculated Key Figure with recursively resolved human-readable formula and full dependency graph of referenced sub-components
- `bw_get_rkf` — reads a global Restricted Key Figure: base measure and all characteristic restriction groups
- `bw_get_structure` — reads a global Structure: all members with Formula/Selection breakdown, characteristic filters, and optional child members
- `bw_list_contents` — navigates the full BW repository tree (InfoAreas → type folders → objects → sub-folders), mirroring the Eclipse BWMT Project Explorer

> **Work in Progress** — bw-modeling-mcp already covers many typical BW development and analysis scenarios, but not everything yet. More is coming. The server has so far only been tested on our own demo systems — if you are running it against your own BW/4HANA system, feedback and bug reports are very welcome. Please use the [Issue templates](https://github.com/dnic-dev/bw-modeling-mcp/issues/new/choose) — you will be helping shape what gets built next.

---

## What it can do

### Search & Discovery
- Search BW objects by name or description (wildcards supported), filtered by type
- Where-used / dependency analysis (xref) for any BW object

### aDSO
- Read aDSO structure (fields, settings, version state)
- Create a new aDSO — from template or empty, field-based or InfoObject-based
- Add InfoObject-backed fields or pure (field-based) fields
- Remove fields
- Manage key fields
- Update field properties (aggregation, data type, length, etc.)
- Update aDSO settings (type preset, flags, description)
- Write-interface aDSO support (`pushMode`)

### InfoObject
- Read InfoObject definition
- Create Characteristic — all data types (CHAR, NUMC, DATS, TIMS, SNUMC), with or without master data and texts, with referenced InfoObject, with compounding parents
- Create Key Figure — all types (NUM, AMT, QTY, DAT, INT), all aggregations (SUM, MAX, MIN)
- Add and remove display and navigation attributes

### InfoArea
- Read InfoArea definition (name, label, parent area, status)
- Create a new InfoArea (immediately active, no activation step needed)
- Move any BW object to a different InfoArea

### InfoSource
- Read InfoSource structure (fields, key fields, label, InfoArea)
- Create InfoSource with full field definitions

### Transformation
- Read Transformation structure (all sources, all targets)
- Map source fields to target InfoObjects (StepDirect)
- Set formula rules (StepFormula)
- Set field routines — ABAP and AMDP (StepRoutine)
- Set start routines — ABAP and AMDP
- Set end routines — ABAP and AMDP
- Switch runtime between ABAP and AMDP

### DTP (Data Transfer Process)
- Read DTP structure and settings
- Create DTPs
- Update DTP settings and description
- Set value filters on fields
- Set routine filters (ABAP code)

### BW Query (Read)
- Read a BW Query — metadata, variables, filter, layout, measures, exceptions, and settings
- Variables: type, processing type (UserEntry, Authorization, CustomerExit), input behavior
- Filter: fixed values and variable references fully resolved, including mixed selections
- Layout: rows, columns, free characteristics with full member lists and nested members
- Calculated key figures: recursively resolved human-readable formulas
- Restricted key figures: selection conditions (key figure + characteristic restrictions)
- Inline local measures inside structures: both formulas and selections
- Exceptions with alert levels and thresholds, cell definitions for grid layout queries
- Active version with automatic fallback to inactive

### Live Data Querying
- Execute a BEx Query or preview data from any InfoProvider (aDSO, CompositeProvider) — returns a formatted result table
- Fill query variables, control axis layout (rows / columns / free), apply characteristic filters with include/exclude and range operators
- Drill into hierarchy nodes and structure members (expand / collapse by tuple index)
- Look up valid characteristic values before setting filters or variables — returns both internal and external key formats

### CompositeProvider (Read)
- Read CompositeProvider structure — view node type (Union/Join), source providers (inputs) with mapping count, all fields with dimension classification, join conditions, and temporal join details

### Global CP Components (Read)
- Read global Calculated Key Figure (CKF) — formula recursively resolved to a human-readable string, full dependency graph of all referenced sub-components
- Read global Restricted Key Figure (RKF) — base measure, all characteristic restriction groups with field and value details
- Read global Structure — all members with Formula/Selection breakdown, referenced components, characteristic filters, optional child members

### Repository Navigation
- Navigate the full BW repository tree — drill from InfoArea to type folder to object to sub-folder, mirroring the Eclipse BWMT Project Explorer; each entry returns a `children_path` for seamless drill-down

### Data Flow Navigation
- Traverse the complete structural data flow graph of any BW object — all connected sources and targets resolved recursively through Transformations, DTPs, InfoSources, aDSOs, DataSources, CompositeProviders, and InfoObjects; mirrors the Eclipse BWMT Transient Data Flow view

### DataSource Navigation
- List all source systems connected to the BW system (ODP_SAP, ODP_CDS, ODP_BW, ODP, FILE, HANA_SDA, HANA_LOCAL)
- Recursively list all DataSources in a source system with full APCO hierarchy path
- Read full source system metadata including connection details (ODP context/destination, HANA remote source and schema)
- Read complete DataSource structure: fields with types, lengths, transfer flags, adapter configuration

### Push API
- Get JSON push schema for a write-interface aDSO
- Push JSON record arrays directly into an aDSO

### General
- Search & Where-Used (xref)
- Activate BW objects (aDSO, InfoObject, Transformation, DTP)
- Release locks without activating (discard changes)
- Delete BW objects
- Transport request assignment

---

## Combining with an ADT MCP Server

For tasks involving ABAP or SQLScript (AMDP) logic inside Transformations, **bw-modeling-mcp works best alongside an ADT MCP server** such as [vibing-steampunk](https://github.com/oisee/vibing-steampunk).

The BW MCP server handles the BW modeling structure — creating the Transformation, setting up routines, activating objects. The ADT MCP server handles reading and writing the actual ABAP class source code that backs the routine. Together, they cover the full development cycle from BW object creation to ABAP logic implementation.

---

## System Compatibility

| System | Support |
|---|---|
| SAP BW/4HANA (all versions) | ✅ Full support |

---

## Requirements

- SAP BW/4HANA system with REST API access (`/sap/bw/modeling/`)
- Node.js 18 or later
- An MCP-compatible AI client (Claude Desktop, Claude Code, etc.)

---

## Installation

```bash
git clone https://github.com/dnic-dev/bw-modeling-mcp.git
cd bw-modeling-mcp
npm install
npm run build
```

---

## Configuration

The server is configured via environment variables:

| Variable | Description | Required |
|---|---|---|
| `BW_URL` | BW system URL (e.g. `https://myhost:50001`) | yes |
| `BW_USER` | SAP user name | yes |
| `BW_PASSWORD` | SAP password | yes |
| `BW_CLIENT` | SAP client (e.g. `001`) | yes |
| `BW_LANGUAGE` | Language for object texts (e.g. `EN`, `DE`). Default: `DE` | no |

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bw-modeling-mcp": {
      "command": "node",
      "args": ["/path/to/bw-modeling-mcp/dist/index.js"],
      "env": {
        "BW_URL": "https://your-bw-host:50001",
        "BW_USER": "YOUR_USER",
        "BW_PASSWORD": "YOUR_PASSWORD",
        "BW_CLIENT": "001",
        "BW_LANGUAGE": "EN"
      }
    }
  }
}
```

### Claude Code

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "bw-modeling-mcp": {
      "command": "node",
      "args": ["/path/to/bw-modeling-mcp/dist/index.js"],
      "env": {
        "BW_URL": "https://your-bw-host:50001",
        "BW_USER": "YOUR_USER",
        "BW_PASSWORD": "YOUR_PASSWORD",
        "BW_CLIENT": "001",
        "BW_LANGUAGE": "EN"
      }
    }
  }
}
```

---

## Tools Reference

### `bw_search`
Search BW objects by name or description. Supports wildcards (`*`). Optionally filter by object type (`ADSO`, `IOBJ`, `TRFN`, `DTPA`, etc.).

### `bw_xref`
Find all objects that reference a given BW object (where-used analysis). Use this to find Transformations and DTPs connected to an aDSO, or to find the process chain(s) a DTP belongs to (`object_type=DTPA`).

For DataSources (`object_type=RSDS`): pass `source_system` — the correctly space-padded objectName is built automatically.

### `bw_get_adso`
Read the full structure of an aDSO — fields, key fields, settings, version state.

### `bw_create_adso`
Create a new aDSO. Supports two modes: `from_template` (copies structure from an existing aDSO) or `empty`. Supports all aDSO type presets including write-interface (`pushMode`).

### `bw_update_adso`
Modify an existing aDSO. Actions:
- `add_field` — add an InfoObject-backed field
- `add_pure_field` — add a field-based (pure) field without an InfoObject
- `remove_field` — remove a field
- `manage_keys` — set or update key fields
- `update_field_properties` — change aggregation, data type, length, etc.
- `update_settings` — change aDSO type preset, flags, or description

### `bw_get_infoobject`
Read an InfoObject definition (Characteristic or Key Figure).

### `bw_create_infoobject`
Create a new InfoObject. Supports:
- **Characteristic (CHA):** all data types (CHAR, NUMC, DATS, TIMS, SNUMC), with or without master data and texts, with compound parent InfoObjects, with referenced InfoObject
- **Key Figure (KYF):** all types (NUM, AMT, QTY, DAT, INT), all aggregations (SUM, MAX, MIN)

Created as inactive — activate with `bw_activate`.

### `bw_update_infoobject`
Add or remove display (`DIS`) and navigation (`NAV`) attributes on an existing Characteristic.

### `bw_get_infoarea`
Read an InfoArea definition — name, label, parent area, object status.

### `bw_create_infoarea`
Create a new InfoArea. Immediately active after creation, no activation step needed.

### `bw_move_object`
Move any BW object (aDSO, InfoObject, InfoArea, etc.) to a different InfoArea.

### `bw_get_infosource`
Read an InfoSource (TRCS) structure — fields, key fields, label, InfoArea, version status.

### `bw_create_infosource`
Create a new InfoSource with full field definitions.

### `bw_update_infosource`
Update an existing InfoSource — fields and description.

### `bw_get_transformation`
Read a Transformation structure including all field mapping rules, routines, source, and target. Transformation names are UUID-like keys — use `bw_xref` on the target aDSO to find them.

### `bw_create_transformation`
Create a new Transformation. Supports all source types (aDSO, InfoSource, DataSource/RSDS) and all target types (aDSO). Can copy structure from an existing Transformation.

### `bw_update_transformation`
Modify field mappings in an existing Transformation:
- Map source field to target InfoObject (StepDirect)
- Set formula rule for a target field (StepFormula)

### `bw_set_transformation_routine`
Set a field routine, start routine, or end routine on a Transformation. Supports both ABAP and AMDP (SQLScript). The routine code is written in combination with an ADT MCP server.

### `bw_delete_transformation_routine`
Remove an existing routine from a Transformation field.

### `bw_set_transformation_runtime`
Switch the Transformation runtime between ABAP and AMDP.

### `bw_get_dtp`
Read the full definition of a single DTP — source, target, transformation reference, extraction settings (mode, package size), and all filter fields including value selections and routine code. DTP names are UUID-like keys — use `bw_xref` or `bw_get_dtps` to find them.

### `bw_get_dtps`
List all DTPs that depend on a given BW object or Transformation.

### `bw_create_dtp`
Create a new DTP on a Transformation. Source and target are derived from the Transformation automatically.

### `bw_update_dtp`
Update a DTP — description and value filters on fields.

### `bw_set_dtp_filter_routine`
Set an ABAP routine filter on a DTP field.

### `bw_get_push_schema`
Get the expected JSON schema for pushing data into a write-interface aDSO.

### `bw_push_data`
Push a JSON record array directly into a write-interface aDSO via the BW Push API (`/sap/bw4/v1/push/`).

### `bw_get_query` _(Read only)_
Read a BW Query definition — variables, filter logic (fixed values and variable references resolved), layout with full member lists, calculated key figures with recursively resolved formulas, restricted key figures with selection conditions, exceptions, and query settings. Output format: `text` (default, compact human-readable summary) or `raw` (full parsed JSON).

### `bw_query_data` _(Read only)_
Execute a BEx Query or preview data from an InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint. Returns a formatted result table with hierarchy indentation.

Parameters: `comp_id` (query or provider name), `is_provider` (set `true` for direct aDSO/HCPR access), `state` (axis placement — ROWS/COLUMNS/FREE — and per-characteristic filters supporting EQ/BT/GT/LT/GE/LE, include/exclude, external key, internal GUID key, and hierarchy-node filters), `variables` (fill query variables; name and id must be copied verbatim from the GET response), `from_row`/`to_row` (pagination), `drill_operations` (expand or collapse hierarchy and structure nodes by 1-based tuple index: `drill_state=3` expands, `drill_state=2` collapses), `format` (`text` default — formatted table; `raw` — XML).

Always call `bw_get_query` or `bw_get_adso` first to discover the axis layout and characteristic IDs, and call `bw_get_filter_values` before setting any filter or variable value.

### `bw_get_filter_values` _(Read only)_
Look up valid values for a characteristic — required before setting any filter or variable. Returns `CHAVL_EXT` (use for state filters) and `CHAVL_INT` (use for variable inputs); formats differ for date-type characteristics. Supports wildcard search (`*` for all values, prefix match e.g. `2022*`). Optionally scope results to a specific InfoProvider.

### `bw_get_composite_provider` _(Read only)_
Read a CompositeProvider (HCPR) — view node type (Union/Join), source providers with input mapping counts, all fields with dimension classification, join conditions, and temporal join details.

### `bw_get_ckf` _(Read only)_
Read a global Calculated Key Figure — formula recursively resolved to a human-readable string, metadata (package, InfoArea, author), and full dependency graph of all referenced sub-components.

### `bw_get_rkf` _(Read only)_
Read a global Restricted Key Figure — base measure, all characteristic restriction groups (field and value), and metadata.

### `bw_get_structure` _(Read only)_
Read a global Structure — all members with type (Formula/Selection), referenced components, characteristic filters, optional child members, and metadata.

### `bw_list_contents` _(Read only)_
Navigate the BW repository tree. Pass a path such as `""` (all InfoAreas), `"area/MYAREA"` (InfoArea contents), `"hcpr/CP_NAME"` (CP sub-folders), or `"adso/ADSO_NAME/trfn"` (Transformations on an aDSO). Each entry includes `children_path` to drill down further.

### `bw_list_source_systems` _(Read only)_
List all logical source systems (LSYS) registered in the BW DataSource structure. Optionally filter by type (`ODP_BW`, `ODP_SAP`, `ODP_CDS`, `ODP`, `FILE`). Each entry includes `children_path` — pass it directly to `bw_list_datasources` as `source_system`.

### `bw_list_datasources` _(Read only)_
List all DataSources available under a logical source system. Recursively traverses the full APCO hierarchy. Each DataSource entry includes name, description, status, and the full `apco_path` (ordered list of application component titles from root to the DataSource). Output format: `text` (default table) or `raw` (XML feed bodies).

### `bw_get_source_system` _(Read only)_
Read the metadata of a single logical source system — type, description, and connection details. For ODP systems: context, destination, validity flags. For HANA systems: remote source, database, schema, SDI adapter.

### `bw_get_datasource` _(Read only)_
Read the complete structure of a DataSource (RSDS): metadata (status, delta type, direct access, application component, package, timestamps), all fields with type, length, transfer flag, key flag, position, selection options, conversion exit, and unit/currency reference, plus active adapter configuration (ODP, HANA, File, CSV). Output format: `text` (default human-readable summary) or `raw` (XML from BW).

### `bw_get_dataflow` _(Read only)_
Read the complete structural data flow of a BW object — all connected sources and targets resolved recursively through Transformations, DTPs, InfoSources, aDSOs, DataSources, CompositeProviders, and InfoObjects. Mirrors the Eclipse BWMT Transient Data Flow view. Supports direction (`upwards` / `downwards` / `both`) and configurable depth. Note: routine-based lookups (ABAP/SQLScript) are not reflected — only structural BW dependencies.

### `bw_activate`
Activate one or more BW objects. Handles impact analysis and automatically deactivated DTPs. Supports: `adso`, `iobj`, `trfn`, `dtp`.

### `bw_unlock`
Release a lock on a BW object without activating (discard changes).

### `bw_delete`
Delete a BW object. Works for aDSO, InfoObject, InfoArea, and other types.

---

## Example Prompts

> **Fun starter** — this one was actually run by a colleague :-)
```
Create a write-interface aDSO to store all match results of the Bundesliga 2024/2025 season.
Include all relevant fields: matchday, home team, away team, home goals, away goals, match date.
Suggest a technical name that fits the existing objects in InfoArea MCPBW.
Then load the aDSO with real data from the completed 2024/2025 season using the Push API.
```

### Modify — working in the BW system

**Setting up a new BW area for a CRM integration:**
```
We are setting up a new BW area for our CRM integration project.
Create the InfoArea "ZCRM" with description "CRM Integration" below InfoArea "ZSALES".
Inside it, create a field-based aDSO to store sales order data loaded from the OpenCRX REST API.
The aDSO should contain the following fields: order_id (key, CHAR 20), customer_id (CHAR 10),
order_date (DATS), amount (DEC 15,2), currency (CUKY 5), status (CHAR 4).
Name the aDSO starting with "Z".
```

**Building a full data flow from field-based to InfoObject-based:**
```
Create a second aDSO in InfoArea "ZCRM" — this time InfoObject-based, same business content
as ZCRM_ORDERS. Create all required InfoObjects for this aDSO. Decide independently on type
(Characteristic/Key Figure), master data, and texts based on the field semantics.
Then create a Transformation from ZCRM_ORDERS to the new aDSO and map all fields 1:1.
Activate the Transformation. Finally, create a DTP on the Transformation and activate it.
```

**Adding derived logic with an AMDP routine and DTP filter:** — In Combination with an ADT MCP Server
```
Create a new InfoObject to flag high-value orders above $10,000.
Choose an appropriate technical name and description.
Add the InfoObject to aDSO ZCRM_ORDERS.
Create an AMDP field routine for this field in the Transformation and derive the logic
in SQLScript: set the flag if the calculated order total (quantity × unit price) exceeds 10,000.
Adjust the DTP filter: load only orders with status "CONFIRMED" (value filter)
and only orders from the current calendar year (routine filter).
```

---

### Read-Only — understanding existing models

**Full data lineage analysis:**
```
Analyze the complete data lineage of aDSO ZSLS_ORDSUM down to all connected DataSources
from source system OCRXCLNT100.
Include all intermediate objects: aDSOs, Transformations, InfoSources, and DataSources.
Also trace any objects referenced inside transformation routines (e.g. via AMDP or ABAP logic)
and follow their lineage as well.
Present the result as a structured table with columns:
Level (1 = closest to ZSLS_ORDSUM), Object Type, Technical Name, Description, Source System.
Use full object type names — no abbreviations.
```

---

## How it works

The server connects to the SAP BW Modeling REST API (`/sap/bw/modeling/`) — the same internal API used by Eclipse BWMT. All write operations follow the BW locking protocol:

1. **Lock** — acquires an exclusive lock and returns a `lockHandle`
2. **Read** — fetches the current complete XML of the object
3. **Modify** — applies changes to the XML
4. **PUT** — sends the full modified XML back (never partial updates)
5. **Activate** — promotes the inactive version to active
6. **Unlock** — releases the lock

Session cookies and CSRF tokens are managed automatically.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical architecture and complete API reference.

---

## Roadmap

- **BW on HANA support** — extend compatibility to SAP BW 7.5 on HANA. Support will be ⚠️ Partial — not all REST endpoints available in BW/4HANA exist in BW on HANA, so some tools may not be available or behave differently.
- **CompositeProvider** — Read: `bw_get_composite_provider` ✅, global components (`bw_get_ckf` / `bw_get_rkf` / `bw_get_structure`) ✅ — Create and modify: planned
- **BW Queries** — Read: `bw_get_query` ✅ — Create and modify: planned
- **Process Chains** — build and manage Process Chains
- **Open ODS View** — create Open ODS Views
- **Further BW/4HANA objects** — BW/4HANA Cockpit functions and additional modeling objects

---

## Contributing

Issues and feature requests are welcome — please use the [Issue templates](https://github.com/dnic-dev/bw-modeling-mcp/issues/new/choose).

If you have access to a BW/4HANA system and want to help expand coverage, I am happy to hear from you. The best way to contribute is to try it out and report what works, what doesn't, and what's missing.

---

## License

MIT
