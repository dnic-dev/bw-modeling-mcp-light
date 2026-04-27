import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { createClientFromEnv } from './bw-client.js';
import { bwGetAdso, bwCreateAdso, FieldDef, bwUpdateAdso, bwUpdateAdsoAddPureField, bwUpdateAdsoSettings, AdsoSettings, bwUpdateAdsoManageKeys, bwUpdateAdsoFieldProperties, FieldProperties } from './tools/adso.js';
import { bwGetInfoObject, bwCreateInfoObject, bwUpdateInfoObject, AttributeDef } from './tools/infoobject.js';
import { bwGetTransformation, bwUpdateTransformation, bwCreateTransformation, bwSetTransformationRuntime, bwSetTransformationRoutine, bwDeleteTransformationRoutine } from './tools/transformation.js';
import { bwActivate } from './tools/activation.js';
import { bwGetDtps, bwGetDtp, bwCreateDtp, bwUpdateDtp, bwSetDtpFilterRoutine } from './tools/dtp.js';
import { bwSearch, bwXref } from './tools/search.js';
import { bwDelete } from './tools/delete.js';
import { bwCreateInfoArea, bwMoveObject, bwGetInfoarea } from './tools/infoarea.js';
import { bwCreateInfosource, bwUpdateInfosource, bwGetInfosource, InfosourceField } from './tools/infosource.js';
import { bwPushData, bwGetPushSchema } from './tools/push.js';
import { bwGetQuery } from './tools/query.js';
import { bwGetCompositeProvider } from './tools/composite_provider.js';
import { bwGetCkf, bwGetRkf, bwGetStructure } from './tools/cp_components.js';
import { bwListContents } from './tools/repository.js';
import { bwListSourceSystems, bwListDatasources, bwGetSourceSystem, bwGetDatasource } from './tools/datasource.js';
import { bwGetDataflow } from './tools/dataflow.js';

// Single shared client instance (CSRF token + session cookies are reused)
const client = createClientFromEnv();

const server = new Server(
  { name: 'bw-modeling-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'bw_search',
      description:
        'Search BW objects by name or description. Optionally filter by object type (ADSO, TRFN, DTPA, IOBJ, etc.). Supports wildcards in the search term.',
      inputSchema: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Search string. Wildcards supported (e.g. "NJ_*").',
          },
          object_type: {
            type: 'string',
            description:
              'Optional object type filter: ADSO, TRFN, DTPA, IOBJ, etc. Leave empty to search all types.',
          },
        },
        required: ['search_term'],
      },
    },
    {
      name: 'bw_xref',
      description:
        'Find where-used / dependencies for a BW object. Returns all objects that reference the given object. ' +
        'Use this to find the Transformation and DTPs that reference an aDSO, or to find which DTPs depend on a Transformation. ' +
        'Use object_type=DTPA to find the process chain(s) a DTP belongs to — this is preferred over bw_get_dtp when only the process chain is needed.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type: ADSO, TRFN, DTPA, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "ADSO_NAME" or "TRFN_UUID_KEY").',
          },
          source_system: {
            type: 'string',
            description: 'Required for object_type "RSDS". Logical source system name (e.g. "LSYS_NAME"). The correct padded objectName is built automatically.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_adso',
      description:
        'Read an aDSO (Advanced DataStore Object) structure — fields, settings, version. Returns the full XML of the inactive version.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO name (e.g. "ADSO_NAME").',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_create_adso',
      description:
        'Create a new aDSO shell. ' +
        'action "from_template" (default): copies fields/keys/settings from an existing aDSO — pass template_name. Without template_name creates an empty standard shell. ' +
        'action "empty": creates a minimal empty aDSO with the given adso_type preset (no fields). ' +
        'After creation the aDSO is inactive — add fields with bw_update_adso, then call bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'Name for the new aDSO (e.g. "ADSO_NAME").',
          },
          label: {
            type: 'string',
            description: 'Description / label for the new aDSO.',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea to create the aDSO in (e.g. "NEXTJUICE").',
          },
          action: {
            type: 'string',
            enum: ['from_template', 'empty'],
            description: '"from_template" (default) or "empty".',
          },
          template_name: {
            type: 'string',
            description: 'Existing aDSO to copy from (action "from_template" only).',
          },
          adso_type: {
            type: 'string',
            enum: ['standard', 'staging_inbound_only', 'staging_compress', 'staging_reporting', 'datamart', 'direct_update'],
            description: 'aDSO type preset for action "empty" (default "standard").',
          },
          package: {
            type: 'string',
            description: 'Development package (default "$TMP").',
          },
          write_interface: {
            type: 'boolean',
            description: 'Enable write interface (pushMode="true"). Default false.',
          },
        },
        required: ['adso_name', 'label', 'info_area'],
      },
    },
    {
      name: 'bw_update_adso',
      description:
        'Add/remove fields, change aDSO type/settings, manage key fields, or update individual field properties. ' +
        'action "add_field" (default): add one or more InfoObject-backed fields — infoobject_name required. ' +
        'action "remove_field": removes the field from the aDSO (and from the key if it was a key field). ' +
        'action "add_pure_field": add one or more pure (non-InfoObject) fields — pass fields array with name, label, data_type, optional length/precision/scale/aggregation_behavior/is_key. ' +
        'action "update_settings": change aDSO type preset and/or individual boolean flags — no infoobject_name needed. ' +
        'action "manage_keys": replace the complete key field list — pass key_fields array (empty = no key fields). ' +
        'action "update_field_properties": modify sidDeterminationMode, aggregationBehavior, fixedCurrency/Unit, or descriptions of a single field — pass field_name and properties. ' +
        'Returns a lock_handle that must be passed to bw_activate to complete the operation. ' +
        'Sequence: bw_update_adso → bw_activate (adso) → bw_activate (trfn) → bw_activate (each dtpa).',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO name (e.g. "ADSO_NAME").',
          },
          infoobject_name: {
            type: 'string',
            description: 'InfoObject name or comma-separated list to add or remove (e.g. "IOBJ_NAME" or "IOBJ_A,IOBJ_B"). Required for add_field and remove_field.',
          },
          action: {
            type: 'string',
            enum: ['add_field', 'remove_field', 'add_pure_field', 'update_settings', 'manage_keys', 'update_field_properties'],
            description: '"add_field" (default), "remove_field", "add_pure_field", "update_settings", "manage_keys", or "update_field_properties".',
          },
          fields: {
            type: 'array',
            description: 'Pure field definitions for action "add_pure_field".',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Field name (uppercase).' },
                label: { type: 'string', description: 'Field description.' },
                data_type: { type: 'string', description: 'Data type (user-facing names). Fixed length, do not pass length: INT1, INT2, INT4, INT8, FLTP, DATS, TIMS, LANG, CUKY, UNIT, DF16_RAW. No length: CURR, QUAN, STRING, RAWSTRING. User-defined length: CHAR, NUMC, RAW, SSTRING. User-defined length+precision: DEC. Precision only: DF16_DEC, DF34_DEC. Fixed length: D16N (16), D34N (34).' },
                length: { type: 'number', description: 'Length for character types (CHAR, NUMC).' },
                precision: { type: 'number', description: 'Precision (total digits) for DEC. For CURR/QUAN use scale instead.' },
                scale: { type: 'number', description: 'Decimal places for CURR, QUAN, DEC (maps to XML precision attribute for CURR/QUAN).' },
                aggregation_behavior: { type: 'string', enum: ['SUM', 'MIN', 'MAX', 'AVG', 'LAST', 'NONE'], description: 'Aggregation (default SUM for numeric types). Use NONE for no aggregation.' },
                is_key: { type: 'boolean', description: 'If true, also injects a <keyElement> entry.' },
              },
              required: ['name', 'label', 'data_type'],
            },
          },
          field_name: {
            type: 'string',
            description: 'Field name to modify (only for action "update_field_properties"), e.g. "FIELD_NAME" or "AMOUNT_P".',
          },
          properties: {
            type: 'object',
            description: 'Field properties to update (only for action "update_field_properties").',
            properties: {
              sid_determination_mode: {
                type: 'string',
                enum: ['N', 'R', 'S', 'M'],
                description: 'Master data check mode (InfoObject-backed fields only). N=none, R=reporting only, S=load/activate, M=load+SID.',
              },
              local_description: {
                description: 'Local description override (InfoObject-backed). String to override, null to clear (revert to InfoObject text).',
              },
              aggregation_behavior: {
                type: 'string',
                enum: ['SUM', 'MIN', 'MAX', 'AVG', 'LAST', 'NONE'],
                description: 'Aggregation behavior (pure fields only). Use NONE for no aggregation.',
              },
              fixed_currency: {
                description: 'Fixed currency code (pure CURR fields). String to set, null to switch to dynamic currency.',
              },
              fixed_unit: {
                description: 'Fixed unit of measure (pure QUAN fields). String to set, null to switch to dynamic unit.',
              },
              description: {
                type: 'string',
                description: 'Description label for pure fields (sets <localProperties><descriptions label="..."/>).',
              },
            },
          },
          key_fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of field names that should be key fields (only for action "manage_keys"). Empty array removes all key fields.',
          },
          settings: {
            type: 'object',
            description: 'Settings to apply (only for action "update_settings").',
            properties: {
              adso_type: {
                type: 'string',
                enum: ['standard', 'staging_inbound_only', 'staging_compress', 'staging_reporting', 'datamart', 'direct_update'],
                description: 'aDSO type preset. Sets activateData, cubeDeltaOnly, directUpdate, isReportingObject, noAqDeletion.',
              },
              write_changelog: { type: 'boolean', description: 'Write change log (Standard type sub-option).' },
              snap_shot_scenario: { type: 'boolean', description: 'Snapshot support (Standard type sub-option).' },
              unique_data_records: { type: 'boolean', description: 'Unique records (Standard type sub-option).' },
              planning_mode: { type: 'boolean', description: 'Planning enabled.' },
              write_interface: { type: 'boolean', description: 'Enable or disable write interface (pushMode).' },
              label: { type: 'string', description: 'aDSO description text.' },
            },
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_create_infoobject',
      description:
        'Create a new InfoObject — Characteristic (CHA) or Key Figure (KYF) — inactive. ' +
        'Sequence: lock → POST create → unlock. ' +
        'After creation call bw_activate with object_type "iobj" to activate.',
      inputSchema: {
        type: 'object',
        properties: {
          infoobject_type: {
            type: 'string',
            enum: ['CHA', 'KYF'],
            description: 'InfoObject type: CHA (Characteristic) or KYF (Key Figure). Default "CHA".',
          },
          name: {
            type: 'string',
            description: 'InfoObject name, max 9 characters (e.g. "IOBJ_NAME").',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea to assign the InfoObject to (e.g. "NEXTJUICE").',
          },
          description: {
            type: 'string',
            description: 'Short and long description text.',
          },
          // CHA-specific
          data_type: {
            type: 'string',
            enum: ['CHAR', 'NUMC', 'DATS', 'TIMS', 'SNUMC'],
            description: 'CHA only. ABAP data type. Default "CHAR".',
          },
          length: {
            type: 'number',
            description: 'CHA only. Field length. Default 10.',
          },
          conversion_routine: {
            type: 'string',
            description: 'CHA only. Conversion routine (e.g. "ALPHA"). Default "ALPHA" for CHAR/NUMC, "" for others.',
          },
          with_master_data: {
            type: 'boolean',
            description: 'CHA only. Generate master data tables. Default false.',
          },
          with_texts: {
            type: 'boolean',
            description: 'CHA only. Generate text tables. Default false.',
          },
          referenced_infoobject: {
            type: 'string',
            description: 'CHA only. Reference to an existing InfoObject (e.g. "IOBJ_NAME"). Omit withMasterData/withTexts — they are inherited. Default "".',
          },
          compound_infoobjects: {
            type: 'array',
            items: { type: 'string' },
            description: 'Technical names of the compound parent InfoObjects, in order. CHA only. Example: ["COMPND_IOBJ_NAME"].',
          },
          // KYF-specific
          object_specific_data_type: {
            type: 'string',
            enum: ['DEC', 'CURR', 'FLTP', 'QUAN', 'DATS', 'INT4', 'INT8', 'TIMS'],
            description: 'KYF only. Data type. Default "DEC". keyfigureType and semantics are derived automatically.',
          },
          aggregation_type: {
            type: 'string',
            enum: ['SUM', 'MAX', 'MIN'],
            description: 'KYF only. Aggregation type. Default "SUM".',
          },
          fixed_unit: {
            type: 'string',
            description: 'Fixed unit of measure for QUAN key figures (e.g. "KWH", "M3"). Required when object_specific_data_type is QUAN.',
          },
          fixed_currency: {
            type: 'string',
            description: 'Fixed currency for CURR key figures (e.g. "EUR"). Required when object_specific_data_type is CURR.',
          },
          // common
          package: {
            type: 'string',
            description: 'Development package. Default "$TMP".',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['name', 'info_area', 'description'],
      },
    },
    {
      name: 'bw_create_infoarea',
      description:
        'Create a new InfoArea. The InfoArea is immediately active after creation — no activation step needed.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoArea name, max 12 characters (e.g. "NEXTJUICE").',
          },
          parent_info_area: {
            type: 'string',
            description: 'Parent InfoArea name. Omit to create at root level.',
          },
          description: {
            type: 'string',
            description: 'Description text for the InfoArea.',
          },
          package: {
            type: 'string',
            description: 'Development package. Default "$TMP".',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_create_transformation',
      description:
        'Create a new Transformation between two BW objects (aDSO, DataSource, InfoSource, etc.). ' +
        'The Transformation name is server-generated (32-char UUID-like key). ' +
        'Created inactive — call bw_activate with object_type "trfn" afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          source_object_type: {
            type: 'string',
            description: 'Source object type. Valid values: HCPR (CompositeProvider), ADSO (aDSO), RSDS (DataSource — requires source_system), HAAP (HANA Analysis Process), IOBJ (InfoObject), TRCS (InfoSource), QVIW (Query).',
          },
          source_object_name: {
            type: 'string',
            description: 'Technical name of the source object.',
          },
          target_object_type: {
            type: 'string',
            description: 'Target object type. Valid values: ADSO (aDSO), IOBJ (InfoObject), TRCS (InfoSource), DEST (Open Hub Destination).',
          },
          target_object_name: {
            type: 'string',
            description: 'Technical name of the target object.',
          },
          package: {
            type: 'string',
            description: 'Development package. Default "$TMP".',
          },
          source_system: {
            type: 'string',
            description: 'Source system name. Required when source_object_type is RSDS (DataSource).',
          },
          copy_from_transformation: {
            type: 'string',
            description: 'Technical name of an existing Transformation to copy rules from.',
          },
        },
        required: ['source_object_type', 'source_object_name', 'target_object_type', 'target_object_name'],
      },
    },
    {
      name: 'bw_move_object',
      description:
        'Move a BW object (aDSO, InfoObject, InfoArea, …) to a different InfoArea. ' +
        'Single POST operation — no lock/unlock needed.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'BW object type URL segment (e.g. "adso", "iobj", "area").',
          },
          object_name: {
            type: 'string',
            description: 'Technical name of the object to move (e.g. "OBJECT_NAME").',
          },
          target_info_area: {
            type: 'string',
            description: 'Technical name of the target InfoArea (e.g. "MCPBW").',
          },
        },
        required: ['object_type', 'object_name', 'target_info_area'],
      },
    },
    {
      name: 'bw_get_infoobject',
      description:
        'Read an InfoObject definition (must already exist in the system). Returns the full XML including data type, length, conversion routine, and descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          infoobject_name: {
            type: 'string',
            description: 'InfoObject name (e.g. "IOBJ_NAME").',
          },
        },
        required: ['infoobject_name'],
      },
    },
    {
      name: 'bw_update_infoobject',
      description:
        'Update a Characteristic InfoObject: change description and/or replace the attribute list. ' +
        'Replaces all existing attributes with the supplied list (pass an empty array to remove all). ' +
        'Also supports Key Figure (KYF) updates: set fixed_unit or fixed_currency. ' +
        'Sequence: lock → GET → PUT → activate → unlock — all in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoObject name (e.g. "IOBJ_NAME").',
          },
          description: {
            type: 'string',
            description: 'New short and long description text. Omit to keep existing.',
          },
          transport: {
            type: 'string',
            description: 'Workbench transport order number (e.g. "DEVK900000"). Required when object is in a non-local package.',
          },
          fixed_unit: {
            type: 'string',
            description: 'KYF only. Fixed unit of measure (e.g. "KWH", "M3"). Sets fixedUnit on a QUAN key figure.',
          },
          fixed_currency: {
            type: 'string',
            description: 'KYF only. Fixed currency (e.g. "EUR"). Sets fixedCurrency on a CURR key figure.',
          },
          attributes: {
            type: 'array',
            description: 'New attribute list. Omit or pass [] to remove all attributes.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Technical name of the referenced InfoObject (e.g. "ATTR_IOBJ_NAME").' },
                type: { type: 'string', enum: ['DIS', 'NAV'], description: 'Attribute type: DIS (Display) or NAV (Navigation).' },
                time_dependent: { type: 'boolean', description: 'Time-dependent attribute (NAV only, default false).' },
                display_in_query: { type: 'boolean', description: 'Display in query (default true).' },
                use_text_of_original_characteristic: { type: 'boolean', description: 'Use text of original characteristic (default true).' },
              },
              required: ['name', 'type'],
            },
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_transformation',
      description:
        'Read a Transformation structure — source/target segments, mapping rules. ' +
        'Transformation names are UUID-like generated keys (e.g. "TRFN_UUID_KEY"). ' +
        'Use bw_xref on the aDSO to find the transformation name.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key, e.g. "TRFN_UUID_KEY").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['transformation_name'],
      },
    },
    {
      name: 'bw_update_transformation',
      description:
        'Map a source field to a target InfoObject in a Transformation, or convert an existing rule to a field routine (StepRoutine) or formula rule (StepFormula). ' +
        'rule_type="direct" (default): changes a StepNoUpdate/StepInitial rule to StepDirect. ' +
        'rule_type="routine": converts an existing StepDirect, StepInitial, or StepNoUpdate rule to StepRoutine (AMDP field routine). ' +
        'rule_type="formula": converts an existing rule to StepFormula — no ABAP class generated, BW evaluates the formula natively. ' +
        'rule_type="constant": sets a fixed constant value on the target field — no source field needed. ' +
        'For routine/formula on StepNoUpdate rules, source_field is required. ' +
        'For routine/formula on StepDirect/StepInitial rules, source_field is ignored (field is already mapped). ' +
        'source_field is always ignored for rule_type="constant". ' +
        'Returns a lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          source_field: {
            type: 'string',
            description:
              'Source field name in the source segment (e.g. "FIELD_NAME"). ' +
              'Required for rule_type="direct" if the existing rule has no source mapping. ' +
              'Also required for routine/formula when the target has no source mapping yet (StepNoUpdate). ' +
              'Required for rule_type="lookup".',
          },
          target_infoobject: {
            type: 'string',
            description: 'Target InfoObject name in the target segment (e.g. "IOBJ_NAME").',
          },
          rule_type: {
            type: 'string',
            enum: ['direct', 'routine', 'formula', 'constant', 'lookup', 'no_update'],
            description:
              'Rule type to assign. "direct" (default): maps source field directly (StepDirect). ' +
              '"routine": converts the rule to an AMDP field routine (StepRoutine) — the server generates the ABAP class automatically. ' +
              '"formula": converts the rule to a formula rule (StepFormula) — requires the formula parameter. ' +
              '"constant": sets a fixed constant value (StepConstant) — requires the constant_value parameter, source_field is ignored. ' +
              '"lookup": converts the rule to a StepRead (Lookup) rule — requires lookup_object and lookup_object_type. ' +
              '"no_update": reverts any existing mapping back to StepNoUpdate (no mapping, field stays empty). ' +
              'IMPORTANT: AMDP SQLSCRIPT methods only allow ASCII 7-bit characters — no German umlauts or special symbols in code or comments.',
          },
          formula: {
            type: 'string',
            description:
              'Formula expression for rule_type="formula" (required). ' +
              'Source fields are referenced by their technical field name: use /BIC/FIELDNAME for custom InfoObjects (e.g. "/BIC/FIELD_NAME + 10"), ' +
              'or the direct field name for standard InfoObjects. ' +
              'Operators: +, -, *, /. Functions: IF, ABS, CONCATENATE, DATE_YEAR, etc. ' +
              'Comparison operators < > <= >= <> are supported (will be XML-escaped automatically).',
          },
          constant_value: {
            type: 'string',
            description:
              'Constant value for rule_type="constant" (required). ' +
              'The value is written as-is into the target field during data loading. ' +
              'Example: "X" for a flag field, "USD" for a currency field.',
          },
          lookup_object: {
            type: 'string',
            description: 'Name of the InfoObject or aDSO to read from (Nachlese-Objekt). Required for rule_type="lookup".',
          },
          lookup_object_type: {
            type: 'string',
            enum: ['IOBJ', 'ADSO'],
            description: 'Type of the lookup object. "IOBJ" for InfoObject, "ADSO" for aDSO. Required for rule_type="lookup".',
          },
          additional_source_fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Additional source fields for rule_type="formula" when the formula references more than one source field. ' +
              'Combined with source_field, all listed fields are registered as inputs on the StepFormula rule. ' +
              'Example: ["QUANTITY_SOLD", "COST_PER_UNIT"].',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name', 'target_infoobject'],
      },
    },
    {
      name: 'bw_delete_transformation_routine',
      description:
        'Remove a Start, End, or Expert routine from a Transformation. ' +
        'Deletes the matching rule from group id="0". If no rules remain, removes the entire group. ' +
        'Returns lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          routine_type: {
            type: 'string',
            enum: ['start', 'end', 'expert'],
            description: 'Routine to remove: "start", "end", or "expert".',
          },
        },
        required: ['transformation_name', 'routine_type'],
      },
    },
    {
      name: 'bw_set_transformation_routine',
      description:
        'Add a Start, End, or Expert routine to a Transformation. ' +
        'Creates the global routine group (group id="0") and ABAP/AMDP method stub. ' +
        'Returns lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          routine_type: {
            type: 'string',
            enum: ['start', 'end', 'expert'],
            description: '"start" → GLOBAL_START, "end" → GLOBAL_END, "expert" → GLOBAL_EXPERT.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name', 'routine_type'],
      },
    },
    {
      name: 'bw_set_transformation_runtime',
      description:
        'Switch a Transformation between HANA and ABAP runtime. ' +
        'Only changes the HANARuntime attribute — no rule changes. ' +
        'If the runtime already matches the target value, returns early without a PUT. ' +
        'Returns a lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          runtime: {
            type: 'string',
            enum: ['hana', 'abap'],
            description: '"hana" sets HANARuntime="true", "abap" sets HANARuntime="false".',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name', 'runtime'],
      },
    },
    {
      name: 'bw_activate',
      description:
        'Activate one BW object (aDSO, Transformation, or DTP). ' +
        'Pass the lock_handle from bw_update_adso or bw_update_transformation. ' +
        'For DTP activation use lock_handle="" (no lock needed for DTPs). ' +
        'Unlock is sent automatically after activation (not for DTPs). ' +
        'The response lists any DTPs deactivated by impact analysis — these must be re-activated.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            enum: ['adso', 'trfn', 'dtpa', 'iobj', 'trcs'],
            description: 'Object type: adso, trfn, dtpa, iobj, or trcs.',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "OBJECT_NAME" or "DTP_...").',
          },
          lock_handle: {
            type: 'string',
            description:
              'Lock handle from bw_update_adso or bw_update_transformation. ' +
              'Use empty string "" for DTP activation.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number. Required on systems with transport obligation.',
          },
        },
        required: ['object_type', 'object_name', 'lock_handle'],
      },
    },
    {
      name: 'bw_delete',
      description:
        'Delete a BW object permanently (aDSO, InfoObject, Transformation, DTP, etc.). ' +
        'Sequence: lock (with /m) → DELETE → unlock. No activation needed — deletion is immediate. ' +
        'Dependency note: delete aDSOs before their InfoObjects, not the other way around.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'BW object type: adso, iobj, trfn, dtpa, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Technical object name (e.g. "OBJECT_NAME").',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_unlock',
      description:
        'Release a lock on a BW object without activating it. ' +
        'Use this to discard changes and free the lock, e.g. after an aborted create or update. ' +
        'DTPs do not need unlocking.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            enum: ['adso', 'trfn', 'trcs', 'iobj', 'area'],
            description: 'Object type: adso, trfn, trcs, iobj, or area (InfoArea).',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "OBJECT_NAME").',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_infosource',
      description: 'Read an InfoSource (TRCS) structure — fields, key fields, label, InfoArea, version status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_infoarea',
      description: 'Read an InfoArea definition — name, label, parent area, object status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoArea name (e.g. "NEXTJUICE").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_create_infosource',
      description:
        'Create a new InfoSource (TRCS) shell. ' +
        'Optionally copy fields from an existing aDSO, CompositeProvider, DataSource, or InfoObject via copy_from_* parameters. ' +
        'Created inactive — call bw_activate with object_type "trcs" afterwards. ' +
        'To add fields after creation use bw_update_infosource.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
          description: {
            type: 'string',
            description: 'Description / label for the InfoSource.',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea to create the InfoSource in (e.g. "MCPBW").',
          },
          package: {
            type: 'string',
            description: 'Development package (default "$TMP").',
          },
          copy_from_object_name: {
            type: 'string',
            description: 'Technical name of the source object to copy fields from. Required when copy_from_object_type is set.',
          },
          copy_from_object_type: {
            type: 'string',
            enum: ['ADSO', 'HCPR', 'RSDS', 'IOBJ'],
            description: 'Type of the source object: ADSO (aDSO), HCPR (CompositeProvider), RSDS (DataSource), IOBJ (InfoObject).',
          },
          copy_from_object_sub_type: {
            type: 'string',
            enum: ['ATTR', 'TEXT', 'HIER'],
            description: 'SubType for IOBJ only: ATTR (Attribute), TEXT (Text), HIER (Hierarchy).',
          },
          copy_from_source_system: {
            type: 'string',
            description: 'Source system name (required when copy_from_object_type is RSDS, e.g. "PC_FILE").',
          },
        },
        required: ['name', 'description', 'info_area'],
      },
    },
    {
      name: 'bw_update_infosource',
      description:
        'Update an InfoSource — change description and/or replace the complete field list. ' +
        'Provide fields as an array; the entire existing field list is replaced. ' +
        'Each field can reference an InfoObject (set infoobject_name) or be a local field (omit infoobject_name). ' +
        'Returns a lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
          description: {
            type: 'string',
            description: 'New description text (optional — omit to leave unchanged).',
          },
          fields: {
            type: 'array',
            description: 'Complete list of fields. Replaces all existing fields. Omit to leave fields unchanged.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Field name (uppercase).' },
                infoobject_name: { type: 'string', description: 'InfoObject name to bind this field to (omit for local fields).' },
                type: { type: 'string', description: 'Data type (e.g. CHAR, NUMC, DEC, CURR, DATS).' },
                length: { type: 'number', description: 'Field length.' },
                label: { type: 'string', description: 'Field label / description.' },
                is_key: { type: 'boolean', description: 'If true, also adds a keyElement entry.' },
                aggregation_behavior: {
                  type: 'string',
                  enum: ['NONE', 'SUM', 'MIN', 'MAX', 'AVG', 'LAST'],
                  description: 'Aggregation behavior (default "NONE").',
                },
              },
              required: ['name', 'type', 'length', 'label'],
            },
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_dtps',
      description:
        'List DTPs (Data Transfer Processes) that depend on a BW object. ' +
        'Uses the xref endpoint filtered to DTPA object type. ' +
        'Use object_type=TRFN and the transformation name to find DTPs after activating a transformation.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type of the referenced object: ADSO, TRFN, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Object name to find dependent DTPs for.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_dtp',
      description:
        'Read a DTP (Data Transfer Process) definition — source, target, transformation, extraction settings, and filter fields (selections and routines). ' +
        'Use bw_xref on an aDSO to find the DTP name first. ' +
        'To find only the process chain a DTP belongs to, use bw_xref with object_type=DTPA instead — it is faster and avoids loading the full DTP definition.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name (e.g. "DTP_...").',
          },
        },
        required: ['dtp_name'],
      },
    },
    {
      name: 'bw_create_dtp',
      description:
        'Create a new DTP (Data Transfer Process) for an existing Transformation and activate it. ' +
        'The DTP name is server-generated. ' +
        'Optionally set a filter on one source field (Equal operator). ' +
        'After creation the DTP is activated automatically. ' +
        'IMPORTANT: Before calling this tool, always check the full transformation chain. ' +
        'Single-step chain (e.g. ADSO->ADSO): use trfn_name only. ' +
        'Two-step chain (e.g. ADSO->TRCS->ADSO): use trfn_name for the first transformation and trfn_name_2 for the second; ' +
        'source_name/source_type = the start object, target_name/target_type = the end object. ' +
        'Omitting trfn_name_2 in a two-step chain causes a persistent HTTP 500 error. ' +
        'Use bw_get_transformation or bw_xref to determine the chain before creating the DTP.',
      inputSchema: {
        type: 'object',
        properties: {
          trfn_name: {
            type: 'string',
            description: 'Technical name of the existing Transformation (UUID-like key).',
          },
          trfn_name_2: {
            type: 'string',
            description: 'Optional second transformation in a multi-step chain. Include when the DTP spans two transformations (e.g. ADSO→TRCS→ADSO).',
          },
          source_name: {
            type: 'string',
            description: 'Source object name (e.g. "SOURCE_NAME").',
          },
          source_type: {
            type: 'string',
            description: 'Source object type (e.g. "ADSO", "TRCS", "RSDS").',
          },
          target_name: {
            type: 'string',
            description: 'Target object name (e.g. "TARGET_NAME").',
          },
          target_type: {
            type: 'string',
            description: 'Target object type (e.g. "ADSO").',
          },
          description: {
            type: 'string',
            description: 'Optional DTP description text (default: empty).',
          },
          package: {
            type: 'string',
            description: 'Development package (default "$TMP").',
          },
          filter_field: {
            type: 'string',
            description: 'Field name to filter on. Requires filter_dta_name and filter_value.',
          },
          filter_dta_name: {
            type: 'string',
            description: 'Internal dtaName for the filter field.',
          },
          filter_value: {
            type: 'string',
            description: 'Filter value for the Equal selection (e.g. "PL_001").',
          },
        },
        required: ['trfn_name', 'source_name', 'source_type', 'target_name', 'target_type'],
      },
    },
    {
      name: 'bw_set_dtp_filter_routine',
      description:
        'Set an ABAP filter routine on a DTP filter field. Use this only when custom ABAP code is needed for the filter logic, not for simple value filters.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name (e.g. "DTP_...").',
          },
          field_name: {
            type: 'string',
            description: 'Filter field name as it appears in the DTP XML fields element.',
          },
          routine_code: {
            type: 'string',
            description: 'ABAP routine code (plain text, without FORM/ENDFORM wrapper).',
          },
          global_code: {
            type: 'string',
            description: 'Optional global declarations for the routine.',
          },
        },
        required: ['dtp_name', 'field_name', 'routine_code'],
      },
    },
    {
      name: 'bw_update_dtp',
      description:
        'Update DTP properties: description and/or simple value filter (e.g. field = value). Use this for setting filter values on existing filter fields.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name to update (e.g. "DTP_...").',
          },
          description: {
            type: 'string',
            description: 'New description text for the DTP.',
          },
          filter_field: {
            type: 'string',
            description: 'Field name to filter on. Requires filter_value.',
          },
          filter_dta_name: {
            type: 'string',
            description: 'Internal dtaName for the filter field. Reserved for future use.',
          },
          filter_value: {
            type: 'string',
            description: 'Filter value(s) for the selection. Comma-separated for multiple values (e.g. "VAL1,VAL2").',
          },
          filter_excluding: {
            type: 'boolean',
            description: 'If true, the filter excludes the given values (excluding="true"). Default false (inclusive).',
          },
          filter_clear_fields: {
            type: 'string',
            description: 'Comma-separated list of field names whose filter selections should be removed entirely.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number. Required on systems with transport obligation.',
          },
          transport_lock_holder: {
            type: 'string',
            description: 'Transport lock holder. The transport request that currently owns the object lock. Required on some systems when updating an existing object.',
          },
        },
        required: ['dtp_name'],
      },
    },
    {
      name: 'bw_get_push_schema',
      description:
        'Fetch the JSON schema for an aDSO write interface. ' +
        'Returns field names, data types, and required fields. ' +
        'Use this before bw_push_data to know what fields to include in records.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO technical name (e.g. "ADSO_NAME").',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_push_data',
      description:
        'Push data records directly into an aDSO inbound table via the SAP BW/4HANA write interface. ' +
        'The aDSO must have write_interface enabled (pushMode="true"). ' +
        'Use bw_get_push_schema first to verify field names and types. ' +
        'Success = HTTP 204 (SAP returns empty body). ' +
        'DATS fields must be formatted as YYYYMMDD strings. INT4 fields as JSON integers.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO technical name (e.g. "ADSO_NAME").',
          },
          records: {
            type: 'array',
            description: 'Array of record objects. Field names must match aDSO field names exactly (uppercase).',
            items: { type: 'object' },
          },
          mode: {
            type: 'string',
            enum: ['one_step', 'messaging'],
            description: 'Push mode. "one_step" (default): implicit request per call. "messaging": uses ?request=MESSAGING param.',
          },
        },
        required: ['adso_name', 'records'],
      },
    },
    {
      name: 'bw_get_query',
      description:
        'Read a BW Query definition — variables, filter, layout (rows/columns/free characteristics), ' +
        'calculated and restricted measures, exceptions, and cell definitions. ' +
        'Tries the active version first; falls back to the inactive version if not found.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query (e.g. "QUERY_NAME").',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_get_composite_provider',
      description:
        'Read a CompositeProvider (HCPR) structure — general info, view node type (Union/Join), ' +
        'source providers (inputs) with mapping counts, fields with dimension classification, ' +
        'join condition, and temporal join details. Returns the inactive version.',
      inputSchema: {
        type: 'object',
        properties: {
          composite_provider_name: {
            type: 'string',
            description: 'Technical name of the CompositeProvider (e.g. "HCPR_NAME").',
          },
        },
        required: ['composite_provider_name'],
      },
    },
    {
      name: 'bw_list_contents',
      description:
        'Read the direct children of any node in the BW repository tree. ' +
        'The path parameter maps to the navigation hierarchy: ' +
        'use "/" or "" for all InfoAreas, ' +
        '"area/{name}" for InfoArea contents (object type folders), ' +
        '"area/{name}/{folder}" for objects within a folder (e.g. "area/MYAREA/adso"), ' +
        '"{type}/{name}" to expand an object (e.g. "hcpr/CP_NAME" → sub-folders), ' +
        '"{type}/{name}/{subfolder}" for objects within a sub-folder (e.g. "adso/ADSO_NAME/trfn"). ' +
        'Returns name, description, object_type, object_subtype, status, has_children, ' +
        'self_url, fiori_only, and children_path (pass directly to bw_list_contents to drill down).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Repository path to list. Use "/" or "" for all InfoAreas. ' +
              'Examples: "area/MYAREA", "area/MYAREA/hcpr", "hcpr/CP_NAME", "hcpr/CP_NAME/elem_ckf", "adso/ADSO_NAME/trfn".',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'bw_list_source_systems',
      description:
        'List logical source systems (LSYS) registered in the BW datasource structure. ' +
        'If source_system_type is provided, lists only source systems of that type (e.g. "ODP_SAP", "ODP_BW", "FILE"). ' +
        'If omitted, lists all source systems across all types. ' +
        'Returns each LSYS with name, description, source_system_type, status, self_url, and children_path ' +
        '(pass children_path directly to bw_list_datasources as the source_system argument).',
      inputSchema: {
        type: 'object',
        properties: {
          source_system_type: {
            type: 'string',
            description:
              'Optional source system type filter. Known values: ODP_BW, ODP_SAP, ODP_CDS, ODP, FILE. ' +
              'Omit to list all source systems.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_list_datasources',
      description:
        'List all DataSources (RSDS) available under a logical source system. ' +
        'Recursively traverses the full application component (APCO) hierarchy — may take time for large systems. ' +
        'Returns each DataSource with name, source_system, description, status, self_url, and apco_path ' +
        '(ordered list of application component titles from root to the DataSource).',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact plain-text table. "raw": raw XML feed bodies from BW.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_source_system',
      description:
        'Read the metadata of a single logical source system (LSYS) — type, description, connection details, and maintenance properties.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_datasource',
      description:
        'Read the full structure of a DataSource (RSDS) — metadata, all fields with types and properties, and adapter configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'Technical name of the DataSource (e.g. "DS_NAME").',
          },
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['datasource_name', 'source_system'],
      },
    },
    {
      name: 'bw_get_ckf',
      description:
        'Read a global Calculated Key Figure (CKF) defined at CompositeProvider level. ' +
        'Returns technical name, description, formula (recursively resolved), metadata, ' +
        'and the full dependency graph of referenced CKF/RKF sub-components.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the CKF (e.g. "CKF_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_rkf',
      description:
        'Read a global Restricted Key Figure (RKF) defined at CompositeProvider level. ' +
        'Returns technical name, description, base measure, characteristic filters, metadata, ' +
        'and the full dependency graph of referenced CKF/RKF sub-components.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the RKF (e.g. "RKF_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_structure',
      description:
        'Read a global Structure defined at CompositeProvider level. ' +
        'Returns the ordered member list with type (Selection/Formula), referenced component ' +
        'or IOBJ name, characteristic filters, and the full dependency graph.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the Structure (e.g. "STR_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_dataflow',
      description:
        'Trace the data flow graph for a BW object. ' +
        'Returns a tree (≤ 30 nodes) or flat table (> 30 nodes) showing all connected objects ' +
        '(ADSO, RSDS, TRFN, DTPA, TRCS, IOBJ, HCPR, LSYS, ELEM) with their type, name, description, and status. ' +
        'BW direction convention: "upwards" traverses towards BW target objects (ADSO, TRFN, TRCS, IOBJ); ' +
        '"downwards" traverses towards source systems (LSYS, RSDS). ' +
        'Use this to understand the full lineage of an object without navigating each connection manually. ' +
        'IMPORTANT: Always print the complete tool result verbatim as a fenced code block in your chat response — never omit or summarize it.',
      inputSchema: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'Technical name of the BW object (e.g. "ADSO_NAME", "DS_NAME").',
          },
          object_type: {
            type: 'string',
            description: 'BW object type: ADSO, RSDS, HCPR, TRFN, DTPA, IOBJ, TRCS, LSYS.',
          },
          source_system: {
            type: 'string',
            description: 'Required when object_type is RSDS. Logical source system name (e.g. "LSYS_NAME").',
          },
          direction: {
            type: 'string',
            enum: ['upwards', 'downwards', 'both'],
            description: 'Direction to traverse: "upwards" (towards BW target objects: ADSO, TRFN, TRCS, IOBJ), "downwards" (towards source systems: LSYS, RSDS), or "both". Default "both".',
          },
          levels: {
            type: 'number',
            description: 'Number of levels to expand in each direction. -1 = all levels (default).',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): tree or flat table. "raw": raw XML from BW.',
          },
        },
        required: ['object_name', 'object_type'],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let text: string;

    switch (name) {
      case 'bw_search':
        text = await bwSearch(
          client,
          args?.search_term as string,
          args?.object_type as string | undefined
        );
        break;

      case 'bw_xref':
        text = await bwXref(
          client,
          args?.object_type as string,
          args?.object_name as string,
          args?.source_system as string | undefined,
        );
        break;

      case 'bw_get_adso':
        text = await bwGetAdso(client, args?.adso_name as string);
        break;

      case 'bw_create_adso':
        text = await bwCreateAdso(
          client,
          args?.adso_name as string,
          args?.label as string,
          args?.info_area as string,
          (args?.action as 'from_template' | 'empty') ?? 'from_template',
          args?.template_name as string | undefined,
          (args?.adso_type as string) ?? 'standard',
          (args?.package as string) ?? '$TMP',
          (args?.write_interface as boolean) ?? false
        );
        break;

      case 'bw_update_adso':
        if (args?.action === 'update_settings') {
          const s = (args?.settings ?? {}) as Record<string, unknown>;
          const settings: AdsoSettings = {
            adsoType: s['adso_type'] as AdsoSettings['adsoType'],
            writeChangelog: s['write_changelog'] as boolean | undefined,
            snapShotScenario: s['snap_shot_scenario'] as boolean | undefined,
            uniqueDataRecords: s['unique_data_records'] as boolean | undefined,
            planningMode: s['planning_mode'] as boolean | undefined,
            writeInterface: s['write_interface'] as boolean | undefined,
            label: s['label'] as string | undefined,
          };
          // Remove undefined keys so applied output is clean
          (Object.keys(settings) as Array<keyof AdsoSettings>).forEach(
            (k) => settings[k] === undefined && delete settings[k]
          );
          settings.transport = args?.transport as string | undefined;
          text = await bwUpdateAdsoSettings(client, args?.adso_name as string, settings);
        } else if (args?.action === 'manage_keys') {
          text = await bwUpdateAdsoManageKeys(
            client,
            args?.adso_name as string,
            (args?.key_fields as string[]) ?? [],
            args?.transport as string | undefined
          );
        } else if (args?.action === 'add_pure_field') {
          const rawFields = (args?.fields as Array<Record<string, unknown>>) ?? [];
          const fieldDefs: FieldDef[] = rawFields.map((f) => ({
            name: f['name'] as string,
            label: f['label'] as string,
            dataType: f['data_type'] as string,
            length: f['length'] as number | undefined,
            precision: f['precision'] as number | undefined,
            scale: f['scale'] as number | undefined,
            aggregationBehavior: f['aggregation_behavior'] as string | undefined,
            isKey: f['is_key'] as boolean | undefined,
          }));
          text = await bwUpdateAdsoAddPureField(client, args?.adso_name as string, fieldDefs, args?.transport as string | undefined);
        } else if (args?.action === 'update_field_properties') {
          const p = (args?.properties ?? {}) as Record<string, unknown>;
          const fp: FieldProperties = {};
          if (p['sid_determination_mode'] !== undefined) fp.sidDeterminationMode = p['sid_determination_mode'] as FieldProperties['sidDeterminationMode'];
          if ('local_description' in p) fp.localDescription = p['local_description'] as string | null;
          if (p['aggregation_behavior'] !== undefined) fp.aggregationBehavior = p['aggregation_behavior'] as FieldProperties['aggregationBehavior'];
          if ('fixed_currency' in p) fp.fixedCurrency = p['fixed_currency'] as string | null;
          if ('fixed_unit' in p) fp.fixedUnit = p['fixed_unit'] as string | null;
          if (p['description'] !== undefined) fp.description = p['description'] as string;
          fp.transport = args?.transport as string | undefined;
          text = await bwUpdateAdsoFieldProperties(
            client,
            args?.adso_name as string,
            args?.field_name as string,
            fp
          );
        } else {
          text = await bwUpdateAdso(
            client,
            args?.adso_name as string,
            args?.infoobject_name as string,
            (args?.action as 'add_field' | 'remove_field') ?? 'add_field',
            args?.transport as string | undefined
          );
        }
        break;

      case 'bw_create_infoobject':
        text = await bwCreateInfoObject(client, {
          infoobject_type: args?.infoobject_type as 'CHA' | 'KYF' | undefined,
          name: args?.name as string,
          info_area: args?.info_area as string,
          description: args?.description as string,
          data_type: args?.data_type as string | undefined,
          length: args?.length as number | undefined,
          conversion_routine: args?.conversion_routine as string | undefined,
          with_master_data: args?.with_master_data as boolean | undefined,
          with_texts: args?.with_texts as boolean | undefined,
          referenced_infoobject: args?.referenced_infoobject as string | undefined,
          compound_infoobjects: args?.compound_infoobjects as string[] | undefined,
          object_specific_data_type: args?.object_specific_data_type as string | undefined,
          aggregation_type: args?.aggregation_type as string | undefined,
          fixed_unit: args?.fixed_unit as string | undefined,
          fixed_currency: args?.fixed_currency as string | undefined,
          package: args?.package as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_create_infoarea':
        text = await bwCreateInfoArea(client, {
          name: args?.name as string,
          parent_info_area: args?.parent_info_area as string | undefined,
          description: args?.description as string | undefined,
          package: args?.package as string | undefined,
        });
        break;

      case 'bw_create_transformation':
        text = await bwCreateTransformation(client, {
          source_object_type: args?.source_object_type as string,
          source_object_name: args?.source_object_name as string,
          target_object_type: args?.target_object_type as string,
          target_object_name: args?.target_object_name as string,
          package: args?.package as string | undefined,
          source_system: args?.source_system as string | undefined,
          copy_from_transformation: args?.copy_from_transformation as string | undefined,
        });
        break;

      case 'bw_move_object':
        text = await bwMoveObject(client, {
          objectType: args?.object_type as string,
          objectName: args?.object_name as string,
          targetInfoArea: args?.target_info_area as string,
        });
        break;

      case 'bw_get_infoobject':
        text = await bwGetInfoObject(client, args?.infoobject_name as string);
        break;

      case 'bw_update_infoobject': {
        const rawAttrs = (args?.attributes as Array<Record<string, unknown>> | undefined) ?? [];
        const attrDefs: AttributeDef[] = rawAttrs.map((a) => ({
          name: a['name'] as string,
          type: a['type'] as 'DIS' | 'NAV',
          timeDependent: a['time_dependent'] as boolean | undefined,
          displayInQuery: a['display_in_query'] as boolean | undefined,
          useTextOfOriginalCharacteristic: a['use_text_of_original_characteristic'] as boolean | undefined,
        }));
        text = await bwUpdateInfoObject(client, {
          name: args?.name as string,
          attributes: attrDefs,
          description: args?.description as string | undefined,
          fixed_unit: args?.fixed_unit as string | undefined,
          fixed_currency: args?.fixed_currency as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;
      }

      case 'bw_get_transformation':
        text = await bwGetTransformation(
          client,
          args?.transformation_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_update_transformation':
        text = await bwUpdateTransformation(
          client,
          args?.transformation_name as string,
          args?.source_field as string | undefined,
          args?.target_infoobject as string,
          (args?.rule_type as 'direct' | 'routine' | 'formula' | 'constant' | 'lookup' | 'no_update' | undefined) ?? 'direct',
          args?.formula as string | undefined,
          args?.constant_value as string | undefined,
          args?.lookup_object as string | undefined,
          args?.lookup_object_type as string | undefined,
          args?.transport as string | undefined,
          args?.additional_source_fields as string[] | undefined,
        );
        break;

      case 'bw_delete_transformation_routine':
        text = await bwDeleteTransformationRoutine(
          client,
          args?.transformation_name as string,
          args?.routine_type as 'start' | 'end' | 'expert'
        );
        break;

      case 'bw_set_transformation_routine':
        text = await bwSetTransformationRoutine(
          client,
          args?.transformation_name as string,
          args?.routine_type as 'start' | 'end' | 'expert',
          args?.transport as string | undefined
        );
        break;

      case 'bw_set_transformation_runtime':
        text = await bwSetTransformationRuntime(
          client,
          args?.transformation_name as string,
          args?.runtime as 'hana' | 'abap',
          args?.transport as string | undefined
        );
        break;

      case 'bw_activate':
        text = await bwActivate(
          client,
          args?.object_type as string,
          args?.object_name as string,
          args?.lock_handle as string,
          args?.transport as string | undefined
        );
        break;

      case 'bw_delete':
        text = await bwDelete(
          client,
          args?.object_type as string,
          args?.object_name as string
        );
        break;

      case 'bw_unlock':
        await client.unlock(
          args?.object_type as string,
          args?.object_name as string
        );
        text = JSON.stringify({ success: true, message: `Lock on ${(args?.object_type as string).toUpperCase()} '${args?.object_name}' released.` });
        break;

      case 'bw_get_infosource':
        text = await bwGetInfosource(client, args?.name as string);
        break;

      case 'bw_get_infoarea':
        text = await bwGetInfoarea(client, args?.name as string);
        break;

      case 'bw_create_infosource':
        text = await bwCreateInfosource(
          client,
          args?.name as string,
          args?.description as string,
          args?.info_area as string,
          (args?.package as string) ?? '$TMP',
          args?.copy_from_object_name as string | undefined,
          args?.copy_from_object_type as string | undefined,
          args?.copy_from_object_sub_type as string | undefined,
          args?.copy_from_source_system as string | undefined
        );
        break;

      case 'bw_update_infosource': {
        const rawFields = args?.fields as Array<Record<string, unknown>> | undefined;
        const fieldDefs: InfosourceField[] | undefined = rawFields?.map((f) => ({
          name: f['name'] as string,
          infoObjectName: f['infoobject_name'] as string | undefined,
          type: f['type'] as string,
          length: f['length'] as number,
          label: f['label'] as string,
          isKey: f['is_key'] as boolean | undefined,
          aggregationBehavior: f['aggregation_behavior'] as string | undefined,
        }));
        text = await bwUpdateInfosource(
          client,
          args?.name as string,
          args?.description as string | undefined,
          fieldDefs,
          args?.transport as string | undefined
        );
        break;
      }

      case 'bw_get_dtps':
        text = await bwGetDtps(
          client,
          args?.object_type as string,
          args?.object_name as string
        );
        break;

      case 'bw_get_dtp':
        text = await bwGetDtp(client, args?.dtp_name as string);
        break;

      case 'bw_create_dtp':
        text = await bwCreateDtp(client, {
          trfn_name: args?.trfn_name as string,
          trfn_name_2: args?.trfn_name_2 as string | undefined,
          source_name: args?.source_name as string,
          source_type: args?.source_type as string,
          target_name: args?.target_name as string,
          target_type: args?.target_type as string,
          description: args?.description as string | undefined,
          package: args?.package as string | undefined,
          filter_field: args?.filter_field as string | undefined,
          filter_dta_name: args?.filter_dta_name as string | undefined,
          filter_value: args?.filter_value as string | undefined,
        });
        break;

      case 'bw_set_dtp_filter_routine':
        text = await bwSetDtpFilterRoutine(client, {
          dtp_name: args?.dtp_name as string,
          field_name: args?.field_name as string,
          routine_code: args?.routine_code as string,
          global_code: args?.global_code as string | undefined,
        });
        break;

      case 'bw_update_dtp':
        text = await bwUpdateDtp(client, {
          dtp_name: args?.dtp_name as string,
          description: args?.description as string | undefined,
          filter_field: args?.filter_field as string | undefined,
          filter_dta_name: args?.filter_dta_name as string | undefined,
          filter_value: args?.filter_value as string | undefined,
          filter_excluding: args?.filter_excluding as boolean | undefined,
          filter_clear_fields: args?.filter_clear_fields as string | undefined,
          transport: args?.transport as string | undefined,
          transport_lock_holder: args?.transport_lock_holder as string | undefined,
        });
        break;

      case 'bw_get_push_schema':
        text = await bwGetPushSchema(args?.adso_name as string);
        break;

      case 'bw_push_data':
        text = await bwPushData(
          args?.adso_name as string,
          args?.records as object[],
          (args?.mode as string) ?? 'one_step'
        );
        break;

      case 'bw_get_query':
        text = await bwGetQuery(args?.query_name as string);
        break;

      case 'bw_list_contents':
        text = await bwListContents(client, args?.path as string);
        break;

      case 'bw_list_source_systems':
        text = await bwListSourceSystems(client, args?.source_system_type as string | undefined);
        break;

      case 'bw_list_datasources':
        text = await bwListDatasources(
          client,
          args?.source_system as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_get_source_system':
        text = await bwGetSourceSystem(client, args?.source_system as string);
        break;

      case 'bw_get_datasource':
        text = await bwGetDatasource(
          client,
          args?.datasource_name as string,
          args?.source_system as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_get_composite_provider':
        text = await bwGetCompositeProvider(client, args?.composite_provider_name as string);
        break;

      case 'bw_get_ckf':
        text = await bwGetCkf(client, args?.component_name as string);
        break;

      case 'bw_get_rkf':
        text = await bwGetRkf(client, args?.component_name as string);
        break;

      case 'bw_get_structure':
        text = await bwGetStructure(client, args?.component_name as string);
        break;

      case 'bw_get_dataflow':
        text = await bwGetDataflow(
          client,
          args?.object_name as string,
          args?.object_type as string,
          args?.source_system as string | undefined,
          (args?.direction as 'upwards' | 'downwards' | 'both') ?? 'both',
          (args?.levels as number) ?? -1,
          (args?.format as 'text' | 'raw') ?? 'text',
        );
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Return as error content so Claude can see the details
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await client.loadMediaTypes();
  } catch (err) {
    process.stderr.write(`[bw-modeling-mcp] Warning: discovery failed, using hardcoded media type fallbacks (${err})\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only (stdout is used for MCP protocol messages)
  process.stderr.write('bw-modeling-mcp server started\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
