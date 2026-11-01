/* ===================================================================
 * PDS SCHEMAS - excerpt
 * -------------------------------------------------------------------
 * EXCERPT NOTICE
 * This file is an excerpt from the production server file (Code.js,
 * ~11,700 lines). It carries three of the fourteen form schemas plus the
 * helpers they are built from, which is enough to show the shape of the
 * thing. It is not runnable on its own.
 *
 * MACHINE DATA IS SYNTHETIC. The real deployment's line inventory,
 * equipment vendors and serial numbers are the plant's, and are replaced
 * here with a fictional but structurally identical set. Everything else -
 * the schema mechanics, the field shapes, the comments - is the real code.
 * -------------------------------------------------------------------
 *
 * THE IDEA
 *
 * Fourteen departments each have their own multi-page process data sheet,
 * and every one of them is a different document: Stranding has a grid of
 * four repeating "cage" columns, CV has three extruders each with a
 * temperature-zone matrix, Extrusion has one, the QC log is a flat row.
 * The paper forms they replaced were genuinely different from each other.
 *
 * The naive build is fourteen forms. That is fourteen render paths,
 * fourteen submit paths, fourteen print stylesheets, fourteen draft
 * implementations, and a bug fixed in one of them fixed in only one of
 * them. I know this because the first two departments were built that way
 * before this refactor.
 *
 * Instead, every form is DATA. A schema declares its fields and its
 * layout; one generic renderer in the client draws any schema; one
 * generic submit path stores any schema; one print path prints any
 * schema. Adding a department is a schema entry. Adding a FIELD is a line.
 *
 * The rule that keeps it that way, from the repo's CLAUDE.md:
 *
 *   "If you're about to write department-specific UI code, stop and check
 *    whether the schema needs a new *generic* capability instead."
 *
 * Every capability below came from that check. `centerWireColumn` exists
 * because Stranding's grid needed a non-cage column in the middle;
 * `mergedCageFields` because two fields span all four cages instead of
 * repeating; `splitCageFields` because one cell holds width+thickness.
 * Each was a generic capability added to the renderer, and each was then
 * available to every other department for free.
 *
 * See docs/forms-engine.md for the full write-up.
 * =================================================================== */

/** Compound families a layer can be extruded from. */
const MATERIAL_TYPE_OPTIONS_ = ['PVC', 'LSHF', 'MDPE', 'SC', 'XLPE'];

/** Rows a table block repeats: what the engineer SET on the line, against
 *  what was ACTUALLY measured. The variance colouring compares the two. */
const SET_ACTUAL_ROWS_ = [{ key: 'set', label: 'Set' }, { key: 'actual', label: 'Actual' }];

/** Rows for a table compared against the technical data sheet instead of
 *  against a set point. */
const ACTUAL_TDS_ROWS_ = [{ key: 'actual', label: 'Actual' }, { key: 'tds', label: 'Tds' }];

/* -------------------------------------------------------------------
 * SYNTHETIC MACHINE INVENTORY
 *
 * Structurally identical to the real thing - per-department lists of
 * production lines, keyed by the form they belong to - but the codes,
 * counts and descriptions are invented. The real file additionally
 * carries equipment vendors, works order numbers and serial numbers per
 * machine, all of which are omitted here entirely.
 * ------------------------------------------------------------------- */
const PDS_MACHINE_OPTIONS_ = {
  pds_str: [
    { value: 'RS01', label: 'RS01 - 61 Wire Rigid Strander' },
    { value: 'RS02', label: 'RS02 - 61 Wire Rigid Strander' },
    { value: 'RS03', label: 'RS03 - 19 Wire Rigid Strander' },
    { value: 'CS01', label: 'CS01 - 37 Wire Central Strander' },
    { value: 'DTS01', label: 'DTS01 - Double Twist Strander (7 Wire)' }
  ],
  pds_cv: [
    { value: 'CCV01', label: 'CCV01 - Triple Extrusion MV Insulation Line' },
    { value: 'CCV02', label: 'CCV02 - Triple Extrusion MV/HV Insulation Line' }
  ],
  pds_extrusion: [
    { value: 'EX01', label: 'EX01 - Extrusion Line 120 (Insulation)' },
    { value: 'EX02', label: 'EX02 - Extrusion Line 150 (Bedding/Sheathing)' },
    { value: 'EX03', label: 'EX03 - Extrusion Line 180 (Insulation/Bedding/Sheathing)' }
  ],
  pds_assembly: [
    { value: 'DT01', label: 'DT01 - Drum Twister 3000mm (Laying Up)' },
    { value: 'DT02', label: 'DT02 - Drum Twister 3600mm (Laying Up & Armouring)' },
    { value: 'SZ01', label: 'SZ01 - SZ Assembly Line' }
  ],
  pds_screening_armouring: [
    { value: 'CT01', label: 'CT01 - Copper Tape Screening Line' },
    { value: 'CW01', label: 'CW01 - Copper Wire & Tape Screening Line' },
    { value: 'ST01', label: 'ST01 - Steel Tape Armouring Line' }
  ],
  trials_drawing: [
    { value: 'DR01', label: 'DR01 - Copper Rod Breakdown Machine' },
    { value: 'DR02', label: 'DR02 - Aluminium Rod Breakdown Machine' },
    { value: 'DR03', label: 'DR03' }
  ]
};

/* -------------------------------------------------------------------
 * COLUMN AND BLOCK HELPERS
 *
 * A temperature profile is N numbered zones, and writing out
 * { key:'z1', label:'Z1' } ten times per extruder across three extruders
 * across six departments is how a typo gets into one of them.
 * ------------------------------------------------------------------- */
function zCols_(n) {
  const cols = [];
  for (let i = 1; i <= n; i++) cols.push({ key: 'z' + i, label: 'Z' + i });
  return cols;
}

function hCols_(n) {
  const cols = [];
  for (let i = 1; i <= n; i++) cols.push({ key: 'h' + i, label: 'H' + i });
  return cols;
}

function tCols_(n) {
  const cols = [];
  for (let i = 1; i <= n; i++) cols.push({ key: 't' + i, label: 'T' + i });
  return cols;
}

/** varianceThreshold: how far Actual can differ from Set/Tds before the cell
 *  is flagged (live-form coloring, print, and the View status pill all read
 *  it) - omitted/0 means "any difference flags it" (the original behavior);
 *  temperature zone matrices and curing tubes pass 5 (+/-5 degree tolerance). */
function zoneMatrixBlock_(key, title, rowLabels, cols, extraFields, varianceThreshold) {
  const block = { type: 'table', key: key, title: title, rowLabels: rowLabels, cols: cols, extraFields: extraFields || [] };
  if (varianceThreshold) block.varianceThreshold = varianceThreshold;
  // Marks this as a real temperature-profile matrix, which buildTrialSchema_
  // uses to attach an HMI temperature-screen photo to exactly these tables.
  // This helper is ALSO used for tables that are not temperature profiles at
  // all - Assembly/Screening's Tape 1/2/3 (ACTUAL_TDS_ROWS_) and the
  // Bleeding ramp (set + actual1..8) - so key off the row shape rather than
  // the helper being called: only a plain Set/Actual pair is a zone matrix.
  const rowKeys = (rowLabels || []).map(r => r.key);
  block.zoneMatrix = rowKeys.length === 2 && rowKeys[0] === 'set' && rowKeys[1] === 'actual';
  // Which columns the in-app column editor may rename, and where a newly
  // added zone gets inserted. Separate from zoneMatrix (which means "is a
  // temperature profile", and only drives the Trials HMI photo) because the
  // two are not the same set: the Bleeding ramp is NOT a zone matrix but its
  // leading columns ARE editable zones - see bleedingBlock_, which overrides
  // zoneColsEnd so added zones land before the RPM/output metric columns
  // instead of at the far right of the table.
  if (block.zoneMatrix) {
    block.zoneColsEditable = true;
    block.zoneColsEnd = (cols || []).length;
  }
  return block;
}

/** includeBatch stays per-extruder (only ISC/OSC carry a batch number), but
 *  Material Type + Supplier are now on ALL THREE extruders per explicit
 *  request - INS previously had neither. Supplier narrows to the suppliers
 *  approved for that extruder's OWN Material Type (dependsOn is resolved
 *  within the same block, so ISC/INS/OSC each filter independently). */
function cvExtruderExtra_(materialLabel, includeBatch) {
  const fields = [
    { key: 'screwCooling', label: 'Screw Cooling' },
    { key: 'actRpm', label: 'Act. RPM' },
    { key: 'nccRpm', label: 'NCC RPM' },
    { key: 'motorLoadPct', label: 'Motor Load %' },
    { key: 'barrelPressure', label: 'Barrel Pressure (Bar)' },
    { key: 'meshSize', label: 'Mesh Size' },
    { key: 'material', label: materialLabel + ' Material', keyboard: 'text' },
    // Per-extruder, not header-level: CV runs three different compounds at
    // once (ISC / INS / OSC), and material, materialType and materialSupplier
    // are all already per-extruder here - a single header Material Code would
    // be ambiguous about which extruder it described. Extrusion PDS keeps its
    // existing header-level materialCode, which is correct there because that
    // form describes one material per record.
    { key: 'materialCode', label: materialLabel + ' Material Code', keyboard: 'text' },
    { key: 'materialType', label: materialLabel + ' Material Type', type: 'select', options: MATERIAL_TYPE_OPTIONS_, allowOther: true }
  ];
  if (includeBatch) {
    fields.push({ key: 'materialBatch', label: materialLabel + ' Batch Number', keyboard: 'text' });
  }
  fields.push({ key: 'materialSupplier', label: materialLabel + ' Supplier', type: 'select', dependsOn: 'materialType', optionsSource: 'materialSuppliers', allowOther: true });
  return fields;
}
/* -------------------------------------------------------------------
 * THE SCHEMAS
 *
 * Three of fourteen, chosen to span the range:
 *   pds_str     - the most structurally complex: a repeating cage grid
 *                 with merged, split and centred columns
 *   qc_log_str  - the simplest: header fields only, and it still gets
 *                 drafts, print, edit-in-place and history for free
 *   pds_cv      - block-based: three extruders, each a zone matrix
 * ------------------------------------------------------------------- */
const PDS_SCHEMAS = {
  pds_str: {
    header: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'machine', label: 'Machine', type: 'select', options: PDS_MACHINE_OPTIONS_.pds_str },
      { key: 'size', label: 'Size', type: 'text' },
      { key: 'phaseNeutral', label: 'Phase/Neutral', type: 'select', options: ['Phase', 'Neutral'] },
      { key: 'conductorType', label: 'Conductor Type', type: 'select', options: ['Round', 'Sector'] },
      { key: 'sectorAngle', label: 'Angle', type: 'select', options: ['60', '90', '100', '120'], showIf: { field: 'conductorType', equals: 'Sector' } },
      { key: 'conductorMaterial', label: 'Conductor Material', type: 'select', options: ['Al', 'Cu'] },
      { key: 'workOrder', label: 'Work Order', type: 'text', keyboard: 'text' },
      { key: 'pdsCode', label: 'PDS Code', type: 'text', keyboard: 'text' },
      { key: 'pdsName', label: 'PDS Name', type: 'text', keyboard: 'text' },
      { key: 'name', label: 'Name', type: 'text', keyboard: 'text' },
      { key: 'tds', label: 'TDS', type: 'text', keyboard: 'text' },
      { key: 'desc', label: 'Desc', type: 'text', keyboard: 'text' },
      { key: 'withTape', label: 'With Tape', type: 'checkbox' },
      { key: 'withPowder', label: 'With Powder', type: 'checkbox' },
      { key: 'powderCode', label: 'Powder Code', type: 'text', showIf: 'withPowder', keyboard: 'text' },
      { key: 'powderWeight', label: 'Powder Weight', type: 'text', showIf: 'withPowder' },
      { key: 'withGrease', label: 'With Grease', type: 'checkbox' },
      { key: 'greaseCode', label: 'Grease Code', type: 'text', showIf: 'withGrease', keyboard: 'text' },
      { key: 'greaseWeight', label: 'Grease Weight', type: 'text', showIf: 'withGrease' }
    ],
    cageGroups: ['CAGE 6', 'CAGE 12', 'CAGE 18', 'CAGE 24'],
    centerWireColumn: true,
    mergedCageFields: ['nextProcess', 'lineSpeed'],
    splitCageFields: {
      tapeDimension: { suffixes: ['width', 'thick'], labels: ['W', 'T'] },
      tensionPct: { suffixes: ['start', 'end'], labels: ['S', 'E'] }
    },
    tapeToggleKey: 'withTape',
    tapeCageFields: ['tapeMaterial', 'tapeDimension', 'overlapPct', 'tapeWeight'],
    rollerDirectionGroups: {
      groups: [
        { key: 'g1', label: 'After Cage 12' },
        { key: 'g2', label: 'After Cage 18' },
        { key: 'g3', label: 'After Cage 24' }
      ],
      pickersPerGroup: 4
    },
    cageFields: [
      { key: 'noOfWires', label: 'No. of Wires' },
      { key: 'wireDiameter', label: 'Wire Diameter (mm)' },
      { key: 'mcLayLength', label: 'M/C Lay-Length (mm)' },
      { key: 'actCondLayLength', label: 'ACT.COND Lay-Length (mm)' },
      { key: 'layDirection', label: 'Lay-Direction', type: 'select', options: ['Left', 'Right'] },
      { key: 'angle', label: 'Angle' },
      { key: 'prespiralLength', label: 'Prespiral Length (mm)' },
      { key: 'prespiralDirection', label: 'Prespiral Direction', type: 'select', options: ['Left', 'Right'] },
      { key: 'bobbinSize', label: 'Bobbin Size (mm)' },
      { key: 'bobbinLength', label: 'Bobbin Length (m)' },
      { key: 'dieDimension', label: 'Die Dimension (mm)' },
      { key: 'rollerDimension', label: 'Roller Dimension (mm)' },
      { key: 'noOfRollers', label: 'No. of Rollers' },
      { key: 'lineSpeed', label: 'Line Speed (m/min)' },
      { key: 'rpm', label: 'Rpm' },
      { key: 'tensionPct', label: 'Tension %' },
      { key: 'tapeMaterial', label: 'Tape Material', keyboard: 'text' },
      { key: 'tapeDimension', label: 'Tape Dimension (mm)' },
      { key: 'overlapPct', label: 'Overlap %' },
      { key: 'tapeWeight', label: 'Tape Weight (kg/km)' },
      { key: 'takeupDrumSize', label: 'Takeup Drum Size' },
      { key: 'takeupLength', label: 'Takeup Length' },
      { key: 'takeupTagNumber', label: 'Takeup Tag Number', keyboard: 'text' },
      { key: 'nextProcess', label: 'Next Process', keyboard: 'text' }
    ],
    finalReading: [
      { key: 'tdsConductorDiaSH', label: 'TDS Conductor Dia S/H' },
      { key: 'actualConductorDiaSH', label: 'Actual Conductor Dia S/H' },
      { key: 'tdsCondWeight', label: 'TDS Cond Weight' },
      { key: 'actualWeight', label: 'Actual Weight' },
      { key: 'tdsCondResistance', label: 'TDS Cond Resistance' },
      { key: 'actualResistance', label: 'Actual Resistance' }
    ]
  },

  /** Production & Quality Log Sheet (Stranding) - one submission = one day's log line,
   *  not one document per month. Header-only (no cage-grid, no blocks) so it gets every
   *  generic PDS feature - WO autofill, arrow-key nav, drafts, print, Load-to-edit,
   *  View Data history - for free. blocks:[] (not omitted) deliberately keeps it off the
   *  legacy cage-grid render path, which requires cageGroups/cageFields it doesn't have;
   *  see pdsFormTabDefs_ in index.html for how the resulting empty "blocks" tab is hidden. */
  qc_log_str: {
    header: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'machine', label: 'M/C', type: 'select', options: PDS_MACHINE_OPTIONS_.pds_str },
      { key: 'workOrder', label: 'W.O. #', type: 'text', keyboard: 'text' },
      { key: 'size', label: 'Size', type: 'text' },
      { key: 'conductorMaterial', label: 'Mat.', type: 'select', options: ['Al', 'Cu'] },
      { key: 'shape', label: 'Shape', type: 'select', options: ['Round', 'Sector'] },
      { key: 'resistance', label: 'Resistance', type: 'text' },
      { key: 'tdsDimensions', label: 'Dimensions - TDS', type: 'text', keyboard: 'text' },
      { key: 'actualDimensions', label: 'Dimensions - Actual', type: 'text', keyboard: 'text' },
      { key: 'tdsWeight', label: 'Weight - TDS', type: 'text' },
      { key: 'actualWeight', label: 'Weight - Actual', type: 'text' },
      { key: 'pdsNo', label: 'PDS No.', type: 'text', keyboard: 'text' },
      { key: 'name', label: 'Name', type: 'text', keyboard: 'text' },
      { key: 'pdsCode', label: 'PDS Code', type: 'text', keyboard: 'text' }
    ],
    blocks: []
  },

  pds_cv: {
    header: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'line', label: 'Line', type: 'select', options: PDS_MACHINE_OPTIONS_.pds_cv },
      { key: 'size', label: 'Size', type: 'text' },
      { key: 'kv', label: 'KV', type: 'text' },
      { key: 'conductorMaterial', label: 'Conductor Material', type: 'select', options: ['Al', 'Cu'] },
      { key: 'workOrder', label: 'Work Order', type: 'text', keyboard: 'text' },
      { key: 'tds', label: 'TDS', type: 'text', keyboard: 'text' },
      { key: 'name', label: 'Name', type: 'text', keyboard: 'text' },
      { key: 'lineSpeed', label: 'Line Speed (m/min)', type: 'text' },
      { key: 'nccLineSpeed', label: 'NCC Line Speed', type: 'text' },
      { key: 'withTape', label: 'With Tape', type: 'checkbox' },
      { key: 'strippable', label: 'Strippable', type: 'checkbox' },
      { key: 'pdsCode', label: 'PDS Code', type: 'text', keyboard: 'text' }
    ],
    blocks: [
      {
        type: 'fields', key: 'preheaterMotor', title: 'Pre Heater (KW) / Motor %',
        fields: [
          { key: 'preheaterKw', label: 'Preheater (KW)' },
          { key: 'conductorTemp', label: 'Conductor Temp.' },
          { key: 'cableTemp', label: 'Cable Temp.' },
          { key: 'upperCapstan', label: 'Upper Capstan' },
          { key: 'cat1Pct', label: 'CAT 1 %' },
          { key: 'cat2Pct', label: 'CAT 2 %' }
        ]
      },
      zoneMatrixBlock_('isc', 'ISC Extruder 1', SET_ACTUAL_ROWS_, zCols_(10).concat(hCols_(2)), cvExtruderExtra_('ISC', true), 5),
      zoneMatrixBlock_('ins', 'INS Extruder 2', SET_ACTUAL_ROWS_, INS_TEMP_COLS_, cvExtruderExtra_('INS'), 5),
      zoneMatrixBlock_('osc', 'OSC Extruder 3', SET_ACTUAL_ROWS_, zCols_(10).concat(hCols_(2)), cvExtruderExtra_('OSC', true), 5),
      zoneMatrixBlock_('curing', 'Curing Tube', SET_ACTUAL_ROWS_, tCols_(10).concat([
        { key: 'nz1', label: 'Null Zone 1' },
        { key: 'nz2', label: 'Null Zone 2' }
      ]), [
        { key: 'nitrogenPressure', label: 'Nitrogen Pressure (Bar)' },
        { key: 'waterTrapTemp', label: 'Water Trap Temp' }
      ], 5),
      // ... the remaining CV blocks (EHT, water trough, capstan, take-up
      // and final readings) are omitted from this excerpt.
    ]
  }

  // ... eleven further schemas omitted: pds_extrusion, pds_assembly,
  // pds_screening_armouring, head_inspection_cv, head_inspection_extrusion,
  // bleeding_cv, bleeding_extrusion, purchase_request, manufacturing_request,
  // machine_drum_limits, drum_register.
};
