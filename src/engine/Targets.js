/* ===================================================================
 * TARGET TIME ENGINE - Drawing / Stranding / Extrusion
 * -------------------------------------------------------------------
 * "How long should one kilometre take on this line?" for every department
 * that has a published target model, in two modes:
 *
 *   MANUAL      - a calculator. EVERY number is typeable: the per-order
 *                 variables AND every constant, each pre-filled from its
 *                 reference table but editable in place.
 *   WORK ORDER  - the per-order variables are resolved from the master plan
 *                 plus the department's own PDS records, each carrying its
 *                 provenance, and stay editable.
 *
 * A model is DATA, not code paths. It declares four things:
 *
 *   context   - the selectors that pick which reference rows apply
 *   inputs    - the per-order variables (the orange cells in targets.xlsx)
 *   constants - every value read from a reference table, declared once with
 *               where it lives, so it can be listed, traced and overridden
 *               without any step function knowing about overrides
 *   steps     - the ordered chain, each an ordinary named function
 *
 * One generic server entrypoint (calcTargetTime) runs any model; one generic
 * client renderer draws any model. Adding a department is a registry entry -
 * never a new render/calc/resolve path. CLAUDE.md rule 3.
 *
 * Each declaration carries an `origin` saying where the value comes from in
 * real life - a reference table, the master plan, a PDS record, the shared
 * construction table, or the engineer's head. That is what makes
 * describeTargetData() able to print the whole data inventory from the code
 * rather than from a document that drifts out of date.
 *
 * A blank constant yields null for that step plus the constant's name in
 * `missing` - never silently defaulted, and the total reports as unavailable
 * rather than as a plausible wrong number (CLAUDE.md rule 4).
 *
 * A NOTE ON FILE LOAD ORDER: same constraint as Forms.js - Apps Script
 * evaluates project files in an order this code does not control, so nothing
 * here may reference PDS_MACHINE_OPTIONS_ / SPEC_SCHEMAS / getSpecData
 * (defined in Code.js) at top level. The registry is built lazily on first
 * use and cached; targetModels_() is the only entry point.
 * =================================================================== */

/** Where a value comes from in real life. Drives the data inventory and the
 *  "from ..." tag the engineer sees next to a resolved field. */
const TARGET_ORIGINS_ = {
  DATABASE: 'database',          // a reference table inside the app
  MASTER_PLAN: 'masterPlan',     // the uploaded monthly production plan
  TDS: 'tds',                    // the plant's TDS log, joined on the TDS number
  WIP: 'wip',                    // the daily WIP003 production export, joined on the work order
  PDS: 'pds',                    // a submitted PDS record for this department
  CONSTRUCTION: 'construction',  // the shared size + construction table
  MANUAL: 'manual'               // the engineer picks or types it
};

const TARGET_ORIGIN_LABELS_ = {
  database: 'Reference table',
  masterPlan: 'Master plan',
  tds: 'TDS log',
  wip: 'WIP003 run log',
  pds: 'PDS record',
  construction: 'Construction table',
  manual: 'Entered by hand'
};

/** Materials a conductor can be drawn or stranded from. Row labels here must
 *  match the row labels of the shared Specs_rpm_str_density table, which is
 *  the single source of conductor density for every department. */
const TARGET_CONDUCTOR_MATERIALS_ = ['Al', 'Cu', 'AA'];

/** The four cages a stranding line can carry, in the order the shop names
 *  them. Mirrors the rows of the rpm_str speed/wireDia tables. */
const TARGET_STRAND_CAGES_ = ['Cage 6', 'Cage 12', 'Cage 18', 'Cage 24'];

/** Which extruder on an extrusion line is laying down the layer being timed.
 *  Each maps to its own bleed-rate column on Specs_targets_ex_machine, and to
 *  the matching extruder block on the pds_extrusion form. */
const TARGET_EX_EXTRUDERS_ = [
  { value: 'Main', label: 'Main Extruder', bleedCol: 'Main Bleed Rate (kg/rpm/hr)', pdsBlock: 'main' },
  { value: 'Aux', label: 'Auxiliary Extruder', bleedCol: 'Aux Bleed Rate (kg/rpm/hr)', pdsBlock: 'aux' },
  { value: 'Ex3', label: 'Extruder 3', bleedCol: 'Ex3 Bleed Rate (kg/rpm/hr)', pdsBlock: 'ex3' },
  { value: 'Ex4', label: 'Extruder 4', bleedCol: 'Ex4 Bleed Rate (kg/rpm/hr)', pdsBlock: 'ex4' }
];

/* ===================================================================
 * EVALUATION CONTEXT
 * A step never reads a sheet or a param directly - it goes through the
 * context, so "what did this calculation consume, what was overridden, and
 * what was missing" is recorded in exactly one place and shown in the trace.
 * =================================================================== */

/** Coerces a sheet cell or form field to a finite number, or null. Blank,
 *  whitespace, text and NaN all collapse to null - the calculation then
 *  short-circuits rather than treating a blank as zero. */
/** Rounds for display inside a trace note. */
function tgtRound_(v, dp) {
  const n = Number(v);
  return isNaN(n) ? v : Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);
}

function targetNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) || !isFinite(n) ? null : n;
}

function targetCtx_(model, params) {
  const constDefs = {};
  (model.constants || []).forEach(c => constDefs[c.key] = c);

  return {
    model: model,
    params: params || {},
    constDefs: constDefs,
    specCache: {},
    missing: [],
    resolved: {},   // constant key -> { value, source, rowLabel }

    /** Reads one reference table once per calculation. */
    spec: function (tabKey, tableKey) {
      const k = tabKey + '|' + tableKey;
      if (!(k in this.specCache)) {
        try {
          this.specCache[k] = getSpecData(tabKey, tableKey);
        } catch (e) {
          this.specCache[k] = { cols: [], rows: [] };
        }
      }
      return this.specCache[k];
    },

    /** Whole row of a reference table by its row label, or null. */
    specRow: function (tabKey, tableKey, rowLabel) {
      if (rowLabel === null || rowLabel === undefined || rowLabel === '') return null;
      const data = this.spec(tabKey, tableKey);
      return data.rows.find(r => String(r.label) === String(rowLabel)) || null;
    },

    /** Reads a selector WITHOUT reporting it as missing - for resolving which
     *  reference row applies, where the selector's own step already reports. */
    choiceRaw: function (key) {
      const v = this.params[key];
      const s = (v === null || v === undefined) ? '' : String(v).trim();
      return s || null;
    },

    /** One declared constant, by key.
     *
     *  A manual override always wins - that is what makes manual mode a real
     *  calculator rather than a form over a database. Otherwise the value
     *  comes from the reference table row the model's `rowFrom` selector
     *  picks. A lookup whose row key was never chosen returns null WITHOUT
     *  reporting - the selector it depends on already reports itself, and
     *  adding "Max Speed for (no machine)" on top just buries the one thing
     *  the engineer actually has to do. */
    constant: function (key) {
      const d = this.constDefs[key];
      if (!d) throw new Error('Undeclared constant "' + key + '" in model ' + this.model.key);

      const override = targetNum_((this.params.constants || {})[key]);
      if (override !== null) {
        this.resolved[key] = { value: override, source: 'manual', rowLabel: null, note: '' };
        return override;
      }

      // A constant may compute itself from a whole table rather than sit in
      // one cell - Drawing's speed is read off a curve of speed against wire
      // diameter. It still goes through here so a manual override beats it and
      // the trace reports it the same as any other constant.
      if (d.resolve) {
        const r = d.resolve(this) || {};
        const v = targetNum_(r.value);
        if (v === null) {
          if (r.missing) this.missing.push(r.missing);
          this.resolved[key] = { value: null, source: null, rowLabel: null, note: r.note || '' };
          return null;
        }
        this.resolved[key] = {
          value: v, source: r.source || 'database',
          rowLabel: r.rowLabel || null, note: r.note || ''
        };
        return v;
      }

      const rowLabel = d.rowFrom ? this.choiceRaw(d.rowFrom) : d.row;
      if (!rowLabel) {
        this.resolved[key] = { value: null, source: null, rowLabel: null, note: '' };
        return null;
      }

      const row = this.specRow(d.tab, d.table, rowLabel);
      const n = row ? targetNum_(row.values[d.col]) : null;
      if (n === null) {
        this.missing.push(d.label + ' for ' + rowLabel + ' (' + d.where + ')');
        this.resolved[key] = { value: null, source: null, rowLabel: rowLabel, note: '' };
        return null;
      }
      this.resolved[key] = { value: n, source: 'database', rowLabel: rowLabel, note: '' };
      return n;
    },

    /** A per-order variable the engineer supplied (or that work-order mode
     *  resolved). `optional` inputs that are blank return null without being
     *  reported as missing - an override nobody set is not an error. */
    input: function (key, label, optional) {
      const n = targetNum_(this.params[key]);
      if (n === null && !optional) this.missing.push(label);
      return n;
    },

    /** A non-numeric selector (machine, material, drum size). */
    choice: function (key, label, optional) {
      const s = this.choiceRaw(key);
      if (!s && !optional) this.missing.push(label);
      return s;
    }
  };
}

/** Runs a model's ordered step chain. Each step gets the values computed so
 *  far (keyed by step key) and the context. A step returning null is recorded
 *  as unavailable and every later step that depends on it collapses to null
 *  the same way - no step ever substitutes a value for a missing one.
 *
 *  A step may also be overridden outright, which is how the Stranding chain
 *  lets an engineer type a target speed or a drum capacity straight in
 *  instead of deriving it from the cage grid. */
function targetRunSteps_(model, ctx) {
  const values = {};
  const overrides = ctx.params.steps || {};
  const steps = model.steps.map(def => {
    let value = null;
    let source = 'calculated';
    const ov = def.overridable ? targetNum_(overrides[def.key]) : null;
    if (ov !== null) {
      value = ov;
      source = 'manual';
    } else {
      try {
        value = targetNum_(def.fn(values, ctx));
      } catch (e) {
        value = null;
      }
      if (value === null) source = null;
    }
    values[def.key] = value;
    return {
      key: def.key,
      label: def.label,
      unit: def.unit || '',
      formula: def.formula || '',
      note: (def.noteFn ? (def.noteFn(values, ctx) || '') : (def.note || '')),
      overridable: !!def.overridable,
      source: source,
      value: value
    };
  });
  return { steps: steps, values: values };
}

/** How much length physically packs onto a drum, by counting loops - the
 *  plant's own method, and the same one calcStrandingTimePerKm already uses
 *  for a stranding bobbin:
 *
 *    turns across the barrel width  = a / d
 *    radial layers                  = (b - c) / (2d)
 *    mean circumference             = pi (b + c) / 2
 *    length = (a/d) x (b-c)/(2d) x pi(b+c)/2 = (pi/4) x a x (b^2 - c^2) / d^2
 *
 *  a/b/c are the barrel width, flange diameter and barrel diameter in mm (the
 *  same A/B/C the Drum Size diagram on the Stranding tab labels); d is the
 *  diameter of whatever is being wound on.
 *
 *  NOTE the pi/4, which is the whole point. Dividing the annular VOLUME by the
 *  wound cross-sectional AREA cancels it and so assumes a 100%-filled annulus,
 *  which round wire can never reach - square packing leaves about 21.5% of the
 *  annulus as gaps between turns. That route over-states capacity by 4/pi,
 *  about 27%. Null unless all four dimensions are known. */
function targetPackedLengthM_(a, b, c, itemDiaMm) {
  if (!a || !b || !c || !itemDiaMm) return null;
  // mm3 / mm2 -> mm, /1000 -> m
  return (Math.PI / 4) * (b * b - c * c) * a / (itemDiaMm * itemDiaMm) / 1000;
}

/** Length a drum or bobbin holds, as the smaller of what physically packs on
 *  and what its weight rating allows. Either constraint may be unknown; the
 *  result then rests on whichever one is known, and is null only if neither
 *  is. */
function targetDrumCapacityM_(a, b, c, maxWeightKg, itemDiaMm, densityKgM3) {
  const byPackingM = targetPackedLengthM_(a, b, c, itemDiaMm);

  let byWeightM = null;
  if (maxWeightKg && itemDiaMm && densityKgM3) {
    // Weight does not care how the turns pack - it is the real cross-section
    // of the wound product times its density.
    const crossSectionMm2 = (Math.PI / 4) * itemDiaMm * itemDiaMm;
    const kgPerM = crossSectionMm2 * densityKgM3 / 1e6;
    if (kgPerM > 0) byWeightM = maxWeightKg / kgPerM;
  }

  if (byPackingM === null && byWeightM === null) return { lengthM: null, byPackingM: null, byWeightM: null, limitedBy: null };
  if (byPackingM === null) return { lengthM: byWeightM, byPackingM: null, byWeightM: byWeightM, limitedBy: 'weight' };
  if (byWeightM === null) return { lengthM: byPackingM, byPackingM: byPackingM, byWeightM: null, limitedBy: 'packing' };
  return byWeightM < byPackingM
    ? { lengthM: byWeightM, byPackingM: byPackingM, byWeightM: byWeightM, limitedBy: 'weight' }
    : { lengthM: byPackingM, byPackingM: byPackingM, byWeightM: byWeightM, limitedBy: 'packing' };
}

/** Linear interpolation over a set of (x, y) points, for reading a value off a
 *  curve the plant tabulates only at the sizes it actually runs.
 *
 *  Returns null OUTSIDE the tabulated span rather than extrapolating. A drawing
 *  line's speed falls away steeply with wire size - across the tabulated
 *  span of one die schedule it can drop to a small fraction of its top-end
 *  value - so a straight line pushed past either end produces a confidently
 *  wrong number, and at the far end a negative one. The caller reports the range instead and the engineer
 *  can type a speed in, which manual mode already allows for any constant. */
function targetInterpolate_(points, x) {
  const pts = (points || [])
    .filter(p => p && p.x !== null && p.x !== undefined && p.y !== null && p.y !== undefined)
    .sort((a, b) => a.x - b.x);
  if (!pts.length || x === null || x === undefined) return null;
  if (x < pts[0].x || x > pts[pts.length - 1].x) return null;

  for (let i = 0; i < pts.length; i++) {
    if (pts[i].x === x) return { y: pts[i].y, exact: true, lo: pts[i], hi: pts[i] };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x > a.x && x < b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return { y: a.y + t * (b.y - a.y), exact: false, lo: a, hi: b };
    }
  }
  return null;
}

/** Drawing line speed for the finished wire diameter being drawn, read off the
 *  line's die schedule (Drawing > Speed by Wire Size) and interpolated between
 *  the sizes the plant tabulated.
 *
 *  Falls back to the line's single Max Speed on the Machine table when it has
 *  no speed-by-size rows yet, so the calculator works before the die schedules
 *  are entered - and says so in the trace, because the two are not the same
 *  basis and a silent switch between them would be indistinguishable from a
 *  wrong answer. */
/** The die-schedule rows that apply to the line and material being drawn.
 *
 *  Shared by the speed and the parallel-wire-count resolvers, so the two can
 *  never disagree about WHICH rows apply. The material fallback below is
 *  exactly the kind of rule that drifts once it is written out twice. */
function targetDrawingRows_(ctx) {
  const machine = ctx.choiceRaw('machine');
  if (!machine) return { machine: '', material: '', rows: [], gap: null };

  const forMachine = ctx.spec('targets_dr', 'speed').rows
    .filter(r => String(r.label) === String(machine));

  // A line can hold more than one schedule, keyed by material. Prefer rows for
  // the material being drawn; fall back to rows left blank, which mean "any
  // material". If the line has rows but none for this material, that is a real
  // gap and is reported rather than answered from another material's curve.
  const material = ctx.choiceRaw('material');
  const matches = r => String(r.values.Material || '').trim().toUpperCase() === String(material || '').toUpperCase();
  const blank = r => String(r.values.Material || '').trim() === '';
  const specific = material ? forMachine.filter(matches) : [];
  const generic = forMachine.filter(blank);
  const rows = specific.length ? specific : generic;

  return {
    machine: machine, material: material, rows: rows,
    gap: (forMachine.length && !rows.length)
      ? machine + ' has a die schedule but none for ' + material +
        ' (Drawing > Speed by Wire Size)'
      : null
  };
}

/** How many wires the line draws AT ONCE at this size.
 *
 *  Taken from the NEAREST tabulated diameter and never interpolated: a line
 *  draws 2 wires or 1, and 1.6 of them is not a thing. This genuinely changes
 *  inside a single curve - a line can draw 2 wires at the small end of its
 *  range and 1 at the large end - so it cannot be treated as a property of
 *  the machine. */
function targetDrawingParallelWires_(ctx) {
  const sel = targetDrawingRows_(ctx);
  if (!sel.machine) return { value: null };
  if (sel.gap) return { value: null, missing: sel.gap };

  const dia = targetNum_(ctx.params.wireDia);
  const pts = sel.rows.map(r => ({
    x: targetNum_(r.values['Wire Dia (mm)']),
    n: targetNum_(r.values['No. of Wires'])
  })).filter(p => p.x !== null && p.n !== null);

  // No column, or a schedule that predates it: the caller treats null as one
  // wire, which is what the running time assumed before this existed.
  if (!pts.length || dia === null) return { value: null };

  let best = null;
  pts.forEach(p => {
    const d = Math.abs(p.x - dia);
    if (!best || d < best.d) best = { d: d, p: p };
  });
  return {
    value: best.p.n, rowLabel: sel.machine,
    note: best.d === 0
      ? 'The line draws ' + best.p.n + ' wire(s) at once at ' + dia + ' mm.'
      : 'Nearest tabulated size is ' + best.p.x + ' mm, where the line draws ' +
        best.p.n + ' wire(s) at once. Not interpolated - a wire count is whole.'
  };
}

/** The bobbin change time for the spooler a drawing line actually ran.
 *
 *  A line can carry more than one kind and they differ by a whole minute: a
 *  single spooler takes about one, an automatic about forty seconds, and a
 *  basket spooler none at all. So this cannot be one number on the machine
 *  row. A line with exactly one spooler answers without being asked; a line
 *  with two refuses until told which, because guessing would move the target
 *  silently. */
function targetDrawingSpoolerChange_(ctx) {
  const machine = ctx.choiceRaw('machine');
  if (!machine) return { value: null };

  const rows = ctx.spec('targets_dr', 'spooler').rows
    .filter(r => String(r.label) === String(machine));

  if (!rows.length) {
    // Nothing on file for this line - fall back to the single change time the
    // Machine table has always carried, and say that is what happened.
    const row = ctx.specRow('targets_dr', 'machine', machine);
    const flat = row ? targetNum_(row.values['Bobbin Change Time (min)']) : null;
    if (flat === null) {
      return { value: null, missing: 'A change time for ' + machine +
        ' - either its spoolers (Drawing > Spooler Change Time) or its Bobbin Change Time (Drawing > Machine)' };
    }
    return { value: flat, rowLabel: machine,
      note: 'No spoolers listed for ' + machine + ', so this is the Machine table\'s single change time.' };
  }

  const typeOf = r => String(r.values['Spooler Type'] || '').trim();
  const want = ctx.choiceRaw('spoolerType');
  if (!want) {
    if (rows.length === 1) {
      return { value: targetNum_(rows[0].values['Change Time (min)']), rowLabel: machine,
        note: typeOf(rows[0]) + ' spooler - the only one ' + machine + ' has.' };
    }
    return { value: null, missing: 'Spooler - ' + machine + ' has a ' +
      rows.map(typeOf).join(' and a ') + ' spooler, and they do not change in the same time' };
  }

  const hit = rows.filter(r => typeOf(r).toUpperCase() === String(want).toUpperCase())[0];
  if (!hit) {
    return { value: null, missing: machine + ' has no ' + want + ' spooler (it has ' +
      rows.map(typeOf).join(', ') + ')' };
  }
  return { value: targetNum_(hit.values['Change Time (min)']), rowLabel: machine,
    note: typeOf(hit) + ' spooler on ' + machine + '.' };
}

/** The spooler kinds a drawing line can carry. */
const TARGET_DRAW_SPOOLERS_ = ['Automatic', 'Single', 'Basket'];

function targetDrawingSpeed_(ctx) {
  const sel = targetDrawingRows_(ctx);
  const machine = sel.machine;
  const material = sel.material;
  const rows = sel.rows;
  const dia = targetNum_(ctx.params.wireDia);
  if (!machine) return { value: null };
  if (sel.gap) return { value: null, missing: sel.gap };

  const pts = rows.map(r => ({
    x: targetNum_(r.values['Wire Dia (mm)']),
    y: targetNum_(r.values['Max Speed (m/s)'])
  })).filter(p => p.x !== null && p.y !== null);

  if (!pts.length) {
    const row = ctx.specRow('targets_dr', 'machine', machine);
    const flat = row ? targetNum_(row.values['Max Speed (m/s)']) : null;
    if (flat === null) {
      return { value: null, missing: 'Speed for ' + machine + ' - either its die schedule (Drawing > Speed by Wire Size) or its Max Speed (Drawing > Machine)' };
    }
    return { value: flat, rowLabel: machine, note: 'No die schedule for ' + machine + ' yet, so this is the line\'s single Max Speed, not a speed for this wire size.' };
  }

  // Two rows at the same wire size with different speeds make the answer
  // depend on row order, which is invisible from the screen. The plant hit
  // exactly this when one line's 1-wire and 2-wire schedules both listed the
  // same wire size, so say it plainly instead of quietly picking one.
  const seen = {};
  let clash = null;
  pts.forEach(p => {
    if (seen[p.x] !== undefined && seen[p.x] !== p.y) clash = { x: p.x, a: seen[p.x], b: p.y };
    seen[p.x] = p.y;
  });
  if (clash) {
    return {
      value: null,
      missing: machine + (material ? ' (' + material + ')' : '') + ' has two different speeds at ' +
        clash.x + ' mm - ' + clash.a + ' and ' + clash.b + ' m/s. Remove one (Drawing > Speed by Wire Size).'
    };
  }

  if (dia === null) return { value: null };

  const hit = targetInterpolate_(pts, dia);
  if (!hit) {
    const xs = pts.map(p => p.x).sort((a, b) => a - b);
    return {
      value: null,
      missing: dia + ' mm is outside ' + machine + '\'s die schedule (' + xs[0] + ' to ' +
        xs[xs.length - 1] + ' mm) - type a speed to override it'
    };
  }
  return {
    value: hit.y, rowLabel: machine,
    note: hit.exact
      ? 'Straight from the die schedule at ' + dia + ' mm.'
      : 'Interpolated between ' + hit.lo.x + ' mm (' + hit.lo.y + ' m/s) and ' +
        hit.hi.x + ' mm (' + hit.hi.y + ' m/s).'
  };
}

/* ===================================================================
 * WHAT THE SHOP FLOOR ACTUALLY RAN  (WIP003)
 * The daily WIP export already lands in the productivity module's fact_run
 * sheets, one row per payoff->takeup drum link, carrying the work order, the
 * machine and the operation code. That makes it the answer to "which line ran
 * this work order", which no other source in the app can give.
 * =================================================================== */

/** The most recent fact_run row for a work order in one department. Walks the
 *  month sheets newest first and stops at the first hit, rather than reading
 *  every month - the log runs to six figures of rows.
 *
 *  Returns null when the order has not run in that department yet, which is
 *  the normal case for a target being calculated before the job starts. */
/** `deptName` may be one department or a list of them. Screening and
 *  Armouring are one model but two labels in the operation map, so a single
 *  string would silently drop half its runs. */
function targetWipRun_(workOrder, deptName) {
  const wo = String(workOrder || '').trim().toLowerCase();
  if (!wo) return null;
  const wantDepts = deptName
    ? (Array.isArray(deptName) ? deptName : [deptName]).map(d => String(d))
    : [];

  let months;
  try {
    months = productivityExistingMonthKeys_();
  } catch (e) { return null; }
  if (!months || !months.length) return null;

  let opMap = {};
  try { opMap = productivityOperationMap_(); } catch (e) { opMap = {}; }

  const ss = getOrCreateProductivitySpreadsheet_();
  for (let m = months.length - 1; m >= 0; m--) {
    const sh = ss.getSheetByName(productivityMonthSheetName_(months[m]));
    if (!sh || sh.getLastRow() < 2) continue;
    const values = sh.getDataRange().getValues();
    const idx = {};
    values[0].forEach((h, i) => { idx[h] = i; });
    if (idx.WO === undefined) continue;

    let best = null;
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (String(row[idx.WO] || '').trim().toLowerCase() !== wo) continue;
      const oprCode = String(row[idx.OprCode] || '').trim().toUpperCase();
      const op = opMap[oprCode] || { name: '', dept: '' };
      if (wantDepts.length && wantDepts.indexOf(op.dept) === -1) continue;
      const dateCell = row[idx.Date];
      const date = dateCell instanceof Date
        ? Utilities.formatDate(dateCell, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(dateCell || '');
      // Latest date within the month wins; the months are already walked newest first.
      if (!best || date > best.date) {
        best = {
          date: date, month: months[m],
          machine: String(row[idx.Machine] || '').trim(),
          oprCode: oprCode, operationName: op.name || '', dept: op.dept || '',
          size: idx.Size === undefined ? '' : String(row[idx.Size] || '').trim(),
          metal: idx.Metal === undefined ? '' : String(row[idx.Metal] || '').trim()
        };
      }
    }
    if (best) return best;
  }
  return null;
}

/** WIP003 operation code -> the Extrusion model's Process selector. */
const TARGET_WIP_PROCESS_ = { INS: 'Insulation', BED: 'Bedding', SHE: 'Sheathing' };

/* ===================================================================
 * CONCENTRIC STRANDING GEOMETRY
 * =================================================================== */

/** A concentric conductor is one centre wire plus layers of 6, 12, 18 and 24 -
 *  which is why the cages are NAMED after those counts. So the wire count
 *  alone says which cages run: 7 = 1+6, 19 = +12, 37 = +18, 61 = +24.
 *
 *  Returns null for any count that is not one of those totals. Bunched and
 *  flexible conductors (the TDS log has 3-, 28- and 42-wire entries) are not
 *  built on cages at all, and quietly rounding them to the nearest concentric
 *  size would time the wrong machine setup. */
const TARGET_STRAND_LAYERS_ = [6, 12, 18, 24];

function targetCagesForWireCount_(wireCount) {
  const n = targetNum_(wireCount);
  if (n === null || n < 1 || n !== Math.floor(n)) return null;
  let remaining = n - 1;
  const cages = [];
  for (let i = 0; i < TARGET_STRAND_LAYERS_.length && remaining > 0; i++) {
    if (remaining < TARGET_STRAND_LAYERS_[i]) return null;
    remaining -= TARGET_STRAND_LAYERS_[i];
    cages.push('Cage ' + TARGET_STRAND_LAYERS_[i]);
  }
  return remaining === 0 ? cages : null;
}

/** The extruders a line carries, from Extrusion > Extruders. Returns only the
 *  ones marked as running by default; a line whose rows are all blank in that
 *  column returns all of them, since "which two are running" is a choice the
 *  engineer can still change on the form. */
function targetDefaultExtruders_(machine) {
  if (!machine) return [];
  let rows;
  try {
    rows = getSpecData('targets_ex', 'extruders').rows;
  } catch (e) { return []; }
  const mine = rows.filter(r => String(r.label).trim().toUpperCase() === String(machine).trim().toUpperCase());
  if (!mine.length) return [];
  const yes = v => /^(y|yes|true|1|x)$/i.test(String(v || '').trim());
  const flagged = mine.filter(r => yes(r.values['Runs By Default']));
  const use = flagged.length ? flagged : mine;
  const known = TARGET_EX_EXTRUDERS_.map(e => e.value);
  return use.map(r => String(r.values.Extruder || '').trim())
    .filter(e => known.indexOf(e) > -1)
    .filter((e, i, a) => a.indexOf(e) === i);
}

/* ===================================================================
 * BLEED RATE FROM THE BLEEDING LIBRARY
 * =================================================================== */

/** An extruder's output per RPM, measured rather than tabulated.
 *
 *  A bleeding test ramps the screw and records RPM against output at each
 *  step, which is exactly a bleed-rate measurement - the app has been
 *  collecting them all along under Bleeding, including a computed
 *  Output (kg/h/RPM) column. This averages output/RPM across the ramp steps
 *  of the most recent test for that machine + extruder + compound, which is
 *  the same straight-line-through-the-origin fit the target formula assumes.
 *
 *  Recomputes from the raw RPM and output columns rather than trusting the
 *  computed column, which is filled in the browser and may be blank on rows
 *  saved before it existed. */
function targetBleedRate_(machine, extruder, materialType) {
  if (!machine || !extruder) return null;
  let rows;
  try {
    rows = getPdsRecords('bleeding_extrusion', {});
  } catch (e) { return null; }

  const same = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
  const candidates = rows.filter(r => same(r.machine, machine) && same(r.extruder, extruder)
    && (!materialType || same(r.materialType, materialType)));
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const rowKeys = ['set'];
  for (let i = 1; i <= 8; i++) rowKeys.push('actual' + i);

  for (let c = 0; c < candidates.length; c++) {
    const rec = candidates[c];
    const ratios = [];
    rowKeys.forEach(k => {
      const rpm = targetNum_(rec['bleeding_' + k + '_rpm']);
      const out = targetNum_(rec['bleeding_' + k + '_outputKgH']);
      if (rpm && out) ratios.push(out / rpm);
    });
    if (!ratios.length) continue;
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return {
      value: mean, points: ratios.length,
      pdsCode: rec.pdsCode || rec.recordId || '', date: rec.date || '',
      materialType: rec.materialType || ''
    };
  }
  return null;
}

/* ===================================================================
 * SCREENING & ARMOURING GEOMETRY
 * -------------------------------------------------------------------
 * Laying a tape or a wire onto a cable is one calculation, whichever of the
 * three machine families is doing it: the head turns, and every revolution
 * drags the cable forward by one pitch. Line speed is rpm x pitch.
 *
 * For a WIRE CAGE the pitch is simply the lay length the TDS specifies.
 *
 * For a TAPE the pitch follows from the geometry. Wrap a tape of width W
 * helically round a cylinder of diameter D at a helix angle alpha to the
 * cable axis and the tape's own width spans the circumference as
 * W = pi D cos(alpha), while the cable advances pitch = W / sin(alpha) per
 * turn. The plant writes this two ways - its copper-tape sheet as
 * rpm (W-O) / (1000 sqrt(1 - ((W-O)/pi D)^2)) and its steel-tape sheet as
 * ACOS then SIN - which are the same equation, since sqrt(1-cos^2) IS sin.
 * =================================================================== */

/** The heads a screening or armouring line can carry, in the order they sit
 *  along the line. Which of them a given line actually has comes from the
 *  Screening > Heads table - this is only the vocabulary. */
const TARGET_SC_HEADS_ = ['Head 1', 'Head 2', 'Head 3', 'Wire Cage', 'Wire Cage 2'];

const TARGET_SC_ELEMENT_TYPES_ = ['Tape', 'Wire Cage'];

/** A head is only laying material when its process is Taping. Stripping and
 *  straight-through runs pass the cable through the same head without it
 *  turning, so that head places no limit on the line - which is exactly what
 *  the plant's sheets mean by zeroing the head and then taking MINIFS over
 *  the values above zero. */
const TARGET_SC_PROCESSES_ = ['Taping', 'Strip', 'Straight'];

const TARGET_SC_APPLICATIONS_ = ['Overlap', 'Gap'];

/** How far the cable advances per revolution of a taping head, in mm.
 *
 *  A tape laid with an OVERLAP advances by its width less what it laps back
 *  onto the previous turn; one laid with a deliberate GAP advances by its
 *  width plus that gap. That sign is the only difference between the plant's
 *  copper-tape sheet (W - overlap) and its steel-tape sheet (W + gap), and it
 *  is a property of the run, not of the machine - so it is an input, not a
 *  branch on the machine code.
 *
 *  N tapes applied at one head sit side by side around the circumference and
 *  so advance N times as far per turn. The plant's sheets only ever show one
 *  tape per head and therefore never had to say this; the TDS does specify
 *  two-tape heads ("2 X 30 X 0.2"), so the count is carried here and stated
 *  in the trace rather than silently assumed to be one. */
function targetScTapeAdvanceMm_(widthMm, pct, application, tapes) {
  const w = targetNum_(widthMm);
  if (w === null || w <= 0) return null;
  const p = targetNum_(pct);
  if (p === null) return null;
  const n = targetNum_(tapes);
  const count = (n === null || n < 1) ? 1 : n;
  const gapped = String(application || '').trim().toLowerCase() === 'gap';
  const adv = count * w * (gapped ? (1 + p / 100) : (1 - p / 100));
  return adv > 0 ? adv : null;
}

/** Line speed from one taping head, plus the helix it implies.
 *
 *  Returns `longitudinal: true` when the advance per turn reaches the
 *  circumference. At that point cos(alpha) is 1, the helix has flattened to a
 *  straight line along the cable, and there is no helical relation between
 *  rpm and speed at all - the tape is being applied longitudinally, which the
 *  plant does do and lists as a direction. Pushing the formula past that point
 *  divides by a sine of zero and then by the square root of a negative number,
 *  so it is reported rather than computed (CLAUDE.md rule 4). */
function targetScTapeSpeed_(rpm, advanceMm, diaMm) {
  const r = targetNum_(rpm), a = targetNum_(advanceMm), d = targetNum_(diaMm);
  if (r === null || a === null || d === null || d <= 0) return null;
  const cosA = a / (Math.PI * d);
  if (cosA >= 1) return { speed: null, longitudinal: true, alphaDeg: null, pitchMm: null };
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pitchMm = a / sinA;
  return {
    speed: r * pitchMm / 1000,
    longitudinal: false,
    alphaDeg: Math.acos(cosA) * 180 / Math.PI,
    pitchMm: pitchMm
  };
}

/** Rows of the Screening > Heads table for one line. */
function targetScHeadRows_(machine) {
  if (!machine) return [];
  let rows;
  try {
    rows = getSpecData('targets_sc', 'heads').rows;
  } catch (e) { return []; }
  return rows.filter(r => String(r.label).trim().toUpperCase() === String(machine).trim().toUpperCase());
}

/** The heads a line runs unless told otherwise - the same "flagged, else all
 *  of them" rule Extrusion uses for its extruders. */
function targetScDefaultHeads_(machine) {
  const mine = targetScHeadRows_(machine);
  if (!mine.length) return [];
  const yes = v => /^(y|yes|true|1|x)$/i.test(String(v || '').trim());
  const flagged = mine.filter(r => yes(r.values['Runs By Default']));
  const use = flagged.length ? flagged : mine;
  return use.map(r => String(r.values.Head || '').trim())
    .filter(h => TARGET_SC_HEADS_.indexOf(h) > -1)
    .filter((h, i, a) => a.indexOf(h) === i);
}

/** The element type the Heads table records for one head, or ''. */
function targetScHeadType_(machine, head) {
  const row = targetScHeadRows_(machine).find(r => String(r.values.Head || '').trim() === String(head).trim());
  return row ? String(row.values['Element Type'] || '').trim() : '';
}

/** Whether a tape material is metallic, from Screening > Tape Material. */
function targetScTapeClass_(tapeMaterial) {
  const name = String(tapeMaterial || '').trim();
  if (!name) return null;
  let rows;
  try {
    rows = getSpecData('targets_sc', 'tapeMaterial').rows;
  } catch (e) { return null; }
  const row = rows.find(r => String(r.label).trim().toUpperCase() === name.toUpperCase());
  const cls = row ? String(row.values.Class || '').trim() : '';
  return cls || null;
}

/** The rpm one head turns at, and where that number came from.
 *
 *  A submitted PDS for this run wins - that is what the head actually did.
 *  Otherwise the line's planned Max RPM from Screening > Heads, which is what
 *  the plant's own sheets use. Either way the figure is then capped by the
 *  class of tape on that head, because a metallic pad cannot be spun as fast
 *  as a plastic one whatever the head is rated for. */
function targetScHeadRpm_(machine, head, fields) {
  const f = fields || {};
  let value = targetNum_(f.rpm);
  let source = value === null ? null : 'entered';

  if (value === null) {
    const row = targetScHeadRows_(machine).find(r => String(r.values.Head || '').trim() === String(head).trim());
    const planned = row ? targetNum_(row.values['Max RPM']) : null;
    if (planned !== null) { value = planned; source = 'Screening > Heads'; }
  }
  if (value === null) return { value: null, source: null, capped: false, cap: null, cls: null };

  const cls = targetScTapeClass_(f.tapeMaterial);
  let cap = null;
  if (cls) {
    let capRows;
    try { capRows = getSpecData('targets_sc', 'rpmCap').rows; } catch (e) { capRows = []; }
    const capRow = capRows.find(r => String(r.label).trim().toUpperCase() === cls.toUpperCase());
    cap = capRow ? targetNum_(capRow.values['Max RPM']) : null;
  }
  if (cap !== null && cap < value) {
    return { value: cap, source: source, capped: true, cap: cap, cls: cls };
  }
  return { value: value, source: source, capped: false, cap: cap, cls: cls };
}

/* ===================================================================
 * THE MODELS
 * =================================================================== */

let targetModelsCache_ = null;

function targetModels_() {
  if (targetModelsCache_) return targetModelsCache_;

  const O = TARGET_ORIGINS_;

  /** The shared conductor-density constant, declared identically by every
   *  department so all three read the one Stranding table rather than each
   *  keeping its own copy. Returned in kg/m3; the sheet stores g/cm3. */
  const conductorDensityConst = {
    key: 'conductorDensity', label: 'Conductor density', unit: 'g/cm3',
    tab: 'rpm_str', table: 'density', rowFrom: 'material', col: 'Density (g/cm3)',
    where: 'Stranding > Material Density', origin: O.DATABASE,
    note: 'Shared by all three departments - one table, corrected in one place.'
  };
  const densityKgM3 = ctx => {
    const g = ctx.constant('conductorDensity');
    return g === null ? null : g * 1000;
  };

  targetModelsCache_ = {

    /* ================= DRAWING ================= */
    targets_dr: {
      key: 'targets_dr',
      title: 'Target Time - Drawing',
      deptName: 'Drawing',
      specTabKey: 'targets_dr',

      context: [
        { key: 'machine', label: 'Machine (Line)', type: 'select', optionsSource: 'drawingMachines',
          origin: O.WIP, originNote: 'The line this work order actually ran on, from WIP003.' },
        { key: 'material', label: 'Conductor Material', type: 'select', options: TARGET_CONDUCTOR_MATERIALS_,
          origin: O.MASTER_PLAN, originNote: 'Metal column of the work order.' },
        { key: 'bobbinSize', label: 'Bobbin Size', type: 'select', optionsSource: 'drawingBobbins', optional: true,
          origin: O.MANUAL,
          help: 'Leave blank and type Max per Bobbin directly if this bobbin is not in the table yet.' },
        { key: 'spoolerType', label: 'Spooler', type: 'select', options: TARGET_DRAW_SPOOLERS_,
          optional: true, origin: O.DATABASE,
          help: 'Which spooler this line ran. Filled in when the line has only one kind; ' +
            'a basket spooler changes in no time at all, a single one in about a minute.' }
      ],

      inputs: [
        { key: 'wireDia', label: 'Wire Diameter (mm)', type: 'number', unit: 'mm',
          origin: O.MANUAL,
          originNote: 'Typed. The TDS gives CSA and wire count, but deriving a diameter from them ' +
            'yields the nominal figure, which a compacted conductor does not match.' },
        { key: 'wireCount', label: 'No. of Wires', type: 'number', unit: 'wires',
          origin: O.TDS, originNote: 'ph_n_wires for the work order TDS.' },
        { key: 'maxPerBobbinKm', label: 'Max per Bobbin (km)', type: 'number', unit: 'km', optional: true,
          origin: O.MANUAL, help: 'Overrides the capacity derived from the bobbin dimensions.' }
      ],

      constants: [
        { key: 'maxSpeedMs', label: 'Line speed', unit: 'm/s',
          tab: 'targets_dr', table: 'speed', col: 'Max Speed (m/s)',
          where: 'Drawing > Speed by Wire Size', origin: O.DATABASE,
          note: 'Read off the line die schedule against the finished wire diameter.',
          resolve: targetDrawingSpeed_ },
        { key: 'parallelWires', label: 'Wires drawn at once', unit: 'wires',
          tab: 'targets_dr', table: 'speed', col: 'No. of Wires',
          where: 'Drawing > Speed by Wire Size', origin: O.DATABASE,
          note: 'How many wires this line draws simultaneously at this size. It changes ' +
            'with size on some lines, so it is read off the die schedule, not the machine.',
          resolve: targetDrawingParallelWires_ },
        { key: 'bobbinChangeMin', label: 'Bobbin change time', unit: 'min',
          tab: 'targets_dr', table: 'spooler', rowFrom: 'machine', col: 'Change Time (min)',
          where: 'Drawing > Spooler Change Time', origin: O.DATABASE,
          note: 'Depends on the spooler, not just the line - a basket spooler changes in zero time.',
          resolve: targetDrawingSpoolerChange_ },
        { key: 'coilChangeMin', label: 'Rod coil change time', unit: 'min',
          tab: 'targets_dr', table: 'machine', rowFrom: 'machine', col: 'Rod Coil Change Time (min)',
          where: 'Drawing > Machine', origin: O.DATABASE },
        { key: 'rodCoilKg', label: 'Rod coil weight', unit: 'kg',
          tab: 'targets_dr', table: 'rodCoil', rowFrom: 'material', col: 'Coil Weight (kg)',
          where: 'Drawing > Rod Coil', origin: O.DATABASE },
        { key: 'bobbinMaxWeightKg', label: 'Bobbin max weight', unit: 'kg',
          tab: 'targets_dr', table: 'bobbin', rowFrom: 'bobbinSize', col: 'Max Weight (kg)',
          where: 'Drawing > Bobbin', origin: O.DATABASE },
        conductorDensityConst
      ],

      steps: [
        {
          key: 'runningTimeMin', label: 'Running time', unit: 'min/km', overridable: true,
          formula: 'wires needed / wires drawn at once x 1000 / speed (m/s) / 60',
          fn: (v, ctx) => {
            ctx.choice('machine', 'Machine');
            const wires = ctx.input('wireCount', 'No. of Wires');
            const speed = ctx.constant('maxSpeedMs');
            // The line's OUTPUT is its speed times the number of wires it
            // draws at once, so drawing 2 at a time halves the time to make a
            // conductor's worth of wire. Null means a schedule with no No. of
            // Wires on file, and one wire is what the formula assumed before
            // the column existed - so an un-seeded line keeps its old answer
            // rather than silently returning nothing.
            const parallel = ctx.constant('parallelWires') || 1;
            return (wires && speed) ? (wires * 1000 / speed / 60 / parallel) : null;
          }
        },
        {
          key: 'bobbinCapacityKm', label: 'Max per bobbin', unit: 'km', overridable: true,
          formula: 'min(loops that pack on at the wire diameter, weight capacity) from A/B/C + max weight',
          fn: (v, ctx) => {
            const override = ctx.input('maxPerBobbinKm', 'Max per Bobbin (km)', true);
            if (override !== null) return override;
            const wireDia = ctx.input('wireDia', 'Wire Diameter (mm)');
            ctx.choice('material', 'Conductor Material');
            const bobbin = ctx.choice('bobbinSize', 'Bobbin Size', true);
            const maxWeight = ctx.constant('bobbinMaxWeightKg');
            if (!bobbin) {
              ctx.missing.push('Bobbin Size, or a Max per Bobbin (km) value');
              return null;
            }
            const row = ctx.specRow('targets_dr', 'bobbin', bobbin);
            const cap = targetDrumCapacityM_(
              row ? targetNum_(row.values.A) : null,
              row ? targetNum_(row.values.B) : null,
              row ? targetNum_(row.values.C) : null,
              maxWeight, wireDia, densityKgM3(ctx));
            if (cap.lengthM === null) {
              ctx.missing.push('A/B/C dimensions for bobbin "' + bobbin + '" (Drawing > Bobbin), or a Max per Bobbin (km) value');
              return null;
            }
            return cap.lengthM / 1000;
          }
        },
        {
          key: 'bobbinChangeMinPerKm', label: 'Bobbin change time', unit: 'min/km', overridable: true,
          formula: 'wires x bobbin change time / max per bobbin (km)',
          fn: (v, ctx) => {
            const wires = ctx.input('wireCount', 'No. of Wires');
            const changeMin = ctx.constant('bobbinChangeMin');
            return (wires && changeMin !== null && v.bobbinCapacityKm)
              ? (wires * changeMin / v.bobbinCapacityKm) : null;
          }
        },
        {
          key: 'coilLengthM', label: 'Length per rod coil', unit: 'm', overridable: true,
          formula: 'coil weight x 4 / (density x pi x (wire dia / 1000)^2)',
          fn: (v, ctx) => {
            const wireDia = ctx.input('wireDia', 'Wire Diameter (mm)');
            const coilKg = ctx.constant('rodCoilKg');
            const density = densityKgM3(ctx);
            const d = wireDia ? wireDia / 1000 : null;
            return (coilKg && density && d) ? (coilKg * 4 / (density * Math.PI * d * d)) : null;
          }
        },
        {
          key: 'coilChangeMinPerKm', label: 'Coil change time', unit: 'min/km', overridable: true,
          formula: 'coil change time / length per coil x 1000 x 60',
          fn: (v, ctx) => {
            const changeMin = ctx.constant('coilChangeMin');
            return (changeMin !== null && v.coilLengthM) ? (changeMin / v.coilLengthM * 60000) : null;
          }
        },
        {
          key: 'totalMinPerKm', label: 'Total target time', unit: 'min/km',
          formula: 'running time + bobbin change time + coil change time',
          fn: v => (v.runningTimeMin !== null && v.bobbinChangeMinPerKm !== null && v.coilChangeMinPerKm !== null)
            ? (v.runningTimeMin + v.bobbinChangeMinPerKm + v.coilChangeMinPerKm) : null
        }
      ]
    },

    /* ================= STRANDING =================
     * The hard parts - resolving the slowest of the line speed and every
     * cage's RPM x lay length, and the per-cage bobbin capacities - stay in
     * calcStrandingTimePerKm, called once and memoized. Only the three
     * one-line quotients that turn those into minutes live here, so each is
     * an ordinary overridable step like every other department's. */
    targets_str: {
      key: 'targets_str',
      title: 'Target Time - Stranding',
      deptName: 'Stranding',
      specTabKey: 'rpm_str',

      context: [
        { key: 'machine', label: 'Machine (Line)', type: 'select', optionsSource: 'strandingMachines',
          scopesSpecTables: true, origin: O.WIP,
          originNote: 'The line this work order actually ran on, from WIP003.' },
        { key: 'size', label: 'Cable Size', type: 'select', optionsSource: 'strandingSizes', allowOther: true,
          origin: O.MASTER_PLAN, originNote: 'Size column of the work order, falling back to the TDS log.' },
        { key: 'conductorType', label: 'Conductor Shape', type: 'select', options: ['Round', 'Sector'],
          origin: O.CONSTRUCTION, originNote: 'Conductor Shape column.' },
        { key: 'material', label: 'Conductor Material', type: 'select', options: ['Al', 'Cu'],
          origin: O.MASTER_PLAN, originNote: 'Metal column of the work order.' },
        { key: 'conductorPart', label: 'Conductor', type: 'select',
          options: [{ value: 'phase', label: 'Phase' }, { value: 'neutral', label: 'Neutral' }],
          origin: O.MANUAL,
          help: 'Picks which TDS wire count is used - ph_n_wires or ne_n_wires.' },
        { key: 'takeupSize', label: 'Take-Up Drum', type: 'select', optionsSource: 'strandingTakeups',
          origin: O.MANUAL }
      ],

      inputs: [
        { key: 'cages', label: 'Cages In Use', type: 'multiselect', options: TARGET_STRAND_CAGES_,
          origin: O.TDS,
          originNote: 'Derived from the wire count: a concentric conductor is 1 + 6 + 12 + 18 + 24, ' +
            'so 7 wires is one cage, 19 is two, 37 is three, 61 is four.' },
        {
          key: 'byCage', label: 'Per Cage', type: 'repeat', over: 'cages',
          fields: [
            { key: 'layLength', label: 'Lay Length (mm/rev)', type: 'number', optionsSource: 'strandingLayLengths',
              origin: O.PDS, originNote: 'Offered from submitted Stranding PDS records at this size and line.' },
            { key: 'bobbinSize', label: 'Bobbin Size', type: 'select', optionsSource: 'strandingDrums',
              origin: O.MANUAL }
          ]
        },
        { key: 'wireCount', label: 'No. of Wires', type: 'number', unit: 'wires',
          origin: O.TDS, originNote: 'ph_n_wires or ne_n_wires for the work order TDS, per the Conductor selector.' },
        { key: 'finishedOD', label: 'Finished Conductor OD (mm)', type: 'number', unit: 'mm',
          optionsSource: 'strandingOds',
          origin: O.PDS, originNote: 'Final Reading actual conductor dia, TDS as fallback.' }
      ],

      constants: [
        { key: 'changePerWireMin', label: 'Change duration per wire', unit: 'min',
          tab: 'rpm_str', table: 'runConst', row: 'Change Duration per Wire (min)', col: 'Value',
          where: 'Stranding > Run Constants', origin: O.DATABASE },
        { key: 'takeupChangeMin', label: 'Take-up drum change time', unit: 'min',
          tab: 'rpm_str', table: 'runConst', row: 'Takeup Drum Change Time (min)', col: 'Value',
          where: 'Stranding > Run Constants', origin: O.DATABASE },
        conductorDensityConst,
        // Declared so they appear in the data inventory and the constants
        // panel even though calcStrandingTimePerKm reads them itself. The
        // cage-level detail is per-cage, so it is not a single overridable
        // cell - the derived Target speed and Max per bobbin steps above it
        // are what an engineer overrides instead.
        { key: 'cageRpm', label: 'Cage RPM and line speed', unit: 'rpm / m/min',
          tab: 'rpm_str', table: 'speed_<line>', row: 'Cage 6..24, RMC, RMS', col: 'Al / Cu',
          where: 'Stranding > Speed Criteria (one grid per line)', origin: O.DATABASE,
          readOnly: true, note: 'Per cage and per line. Override the derived Target line speed instead.' },
        { key: 'cageWireDia', label: 'Cage wire diameter', unit: 'mm',
          tab: 'rpm_str', table: 'wireDia', row: 'Cage 6..24', col: 'Wire Diameter (mm)',
          where: 'Stranding > Wire Diameter', origin: O.DATABASE,
          readOnly: true, note: 'Per cage. Override the derived Max per bobbin instead.' },
        { key: 'drumDims', label: 'Bobbin A/B/C', unit: 'mm',
          tab: 'rpm_str', table: 'drum', row: 'per bobbin size', col: 'A / B / C',
          where: 'Stranding > Drum Size', origin: O.DATABASE,
          readOnly: true, note: 'Override the derived Max per bobbin instead.' },
        { key: 'takeupDims', label: 'Take-up A/B/C + max weight', unit: 'mm / kg',
          tab: 'rpm_str', table: 'takeup', rowFrom: 'takeupSize', col: 'A / B / C / Max Weight (kg)',
          where: 'Stranding > Takeup Drum', origin: O.DATABASE,
          readOnly: true, note: 'Override the derived Max per take-up drum instead.' }
      ],

      steps: [
        {
          key: 'targetSpeed', label: 'Target line speed', unit: 'm/min', overridable: true,
          formula: 'slowest of the line speed (RMC or RMS) and every cage RPM x lay length / 1000',
          fn: (v, ctx) => {
            const r = targetStrandCore_(ctx);
            return r ? r.targetSpeed : null;
          },
          noteFn: (v, ctx) => {
            const r = targetStrandCore_(ctx);
            return (r && r.speedRow) ? 'Line speed row used: ' + r.speedRow + '.' : '';
          }
        },
        {
          key: 'runningTimeMin', label: 'Running time', unit: 'min/km', overridable: true,
          formula: '1000 / target line speed',
          fn: v => v.targetSpeed ? (1000 / v.targetSpeed) : null
        },
        {
          key: 'bobbinCapacityKm', label: 'Max per bobbin', unit: 'km', overridable: true,
          formula: 'smallest cage bobbin capacity - loops that pack on at that cage wire diameter',
          fn: (v, ctx) => {
            const r = targetStrandCore_(ctx);
            return (r && r.bobbinLengthM !== null) ? r.bobbinLengthM / 1000 : null;
          }
        },
        {
          key: 'bobbinChangeMinPerKm', label: 'Bobbin change time', unit: 'min/km', overridable: true,
          formula: 'change duration per wire x wires / max per bobbin (km)',
          fn: (v, ctx) => {
            const wires = ctx.input('wireCount', 'No. of Wires');
            const perWire = ctx.constant('changePerWireMin');
            return (wires && perWire !== null && v.bobbinCapacityKm)
              ? (perWire * wires / v.bobbinCapacityKm) : null;
          }
        },
        {
          key: 'takeupCapacityKm', label: 'Max per take-up drum', unit: 'km', overridable: true,
          formula: 'annular volume / cable cross-section at the finished OD, capped by the drum weight rating',
          fn: (v, ctx) => {
            const r = targetStrandCore_(ctx);
            return (r && r.takeupLengthM !== null) ? r.takeupLengthM / 1000 : null;
          },
          noteFn: (v, ctx) => {
            const r = targetStrandCore_(ctx);
            if (!r || r.takeupLengthM === null || r.weightAtCapacityKg === null) return '';
            return r.weightLimited
              ? 'Weight-limited: a full drum would weigh ' + Math.round(r.weightAtCapacityKg) +
                ' kg against a ' + r.maxWeightKg + ' kg rating.'
              : 'Volume-limited: a full drum weighs ' + Math.round(r.weightAtCapacityKg) +
                ' kg, within its rating.';
          }
        },
        {
          key: 'takeupChangeMinPerKm', label: 'Take-up change time', unit: 'min/km', overridable: true,
          formula: 'take-up drum change time / max per drum (km)',
          fn: (v, ctx) => {
            const changeMin = ctx.constant('takeupChangeMin');
            return (changeMin !== null && v.takeupCapacityKm)
              ? (changeMin / v.takeupCapacityKm) : null;
          }
        },
        {
          key: 'totalMinPerKm', label: 'Total target time', unit: 'min/km',
          formula: 'running time + bobbin change time + take-up change time',
          fn: v => (v.runningTimeMin !== null && v.bobbinChangeMinPerKm !== null && v.takeupChangeMinPerKm !== null)
            ? (v.runningTimeMin + v.bobbinChangeMinPerKm + v.takeupChangeMinPerKm) : null
        }
      ]
    },

    /* ================= EXTRUSION ================= */
    targets_ex: {
      key: 'targets_ex',
      title: 'Target Time - Extrusion',
      deptName: 'Extrusion',
      specTabKey: 'targets_ex',

      context: [
        { key: 'machine', label: 'Machine (Line)', type: 'select', optionsSource: 'extrusionMachines',
          origin: O.WIP, originNote: 'The line this work order actually ran on, from WIP003.' },
        { key: 'process', label: 'Process', type: 'select', options: ['Insulation', 'Bedding', 'Sheathing'],
          origin: O.WIP, originNote: 'The operation code on the WIP003 run for this order (INS/BED/SHE). ' +
            'Also picks which TDS stage supplies the compound.' },
        { key: 'materialType', label: 'Compound', type: 'select', optionsSource: 'extrusionCompounds',
          origin: O.TDS, originNote: 'Material code on that stage, resolved through the same prefix map ' +
            'the PDS forms use (XL -> XLPE, VI/VS -> PVC, PS -> MDPE, SC -> SC).' },
        { key: 'material', label: 'Conductor Material', type: 'select', options: TARGET_CONDUCTOR_MATERIALS_,
          origin: O.MASTER_PLAN, originNote: 'Metal column of the work order.' },
        { key: 'takeupSize', label: 'Take-Up Drum', type: 'select', optionsSource: 'extrusionTakeups', optional: true,
          origin: O.MANUAL,
          help: 'Leave blank and type Max per Drum directly if this drum is not in the table yet.' }
      ],

      inputs: [
        { key: 'od', label: 'Outer Diameter (m)', type: 'number', unit: 'm',
          origin: O.PDS, originNote: 'Head Parameters final dia, actual with TDS fallback.' },
        { key: 'id', label: 'Inner Diameter (m)', type: 'number', unit: 'm',
          origin: O.PDS, originNote: 'Head Parameters inlet dia, actual with TDS fallback.' },
        { key: 'conductorArea', label: 'Conductor Area (mm2)', type: 'number', unit: 'mm2',
          origin: O.MASTER_PLAN,
          originNote: 'Phase CSA column of the work order. Falls back to the TDS log ph_size when the ' +
            'plan leaves it blank.' },
        // A line usually runs two extruders of different sizes at once and
        // their outputs ADD, so this is a set of extruders each with its own
        // RPM rather than one number. Which extruders a line has comes from
        // the Extrusion > Extruders table; the RPMs come from the matching
        // PDS block for each one.
        { key: 'extruders', label: 'Extruders In Use', type: 'multiselect',
          options: TARGET_EX_EXTRUDERS_.map(e => ({ value: e.value, label: e.label })),
          origin: O.DATABASE, originNote: 'The extruders this line carries (Extrusion > Extruders).' },
        {
          key: 'byExtruder', label: 'Per Extruder', type: 'repeat', over: 'extruders',
          fields: [
            { key: 'rpm', label: 'RPM', type: 'number',
              origin: O.PDS, originNote: 'That extruder block\'s RPM on the matching Extrusion PDS.' }
          ]
        },
        { key: 'maxPerDrumKm', label: 'Max per Drum (km)', type: 'number', unit: 'km', optional: true,
          origin: O.MANUAL, help: 'Overrides the capacity derived from the drum rating.' }
      ],

      constants: [
        { key: 'takeupChangeMin', label: 'Take-up change time', unit: 'min',
          tab: 'targets_ex', table: 'machine', rowFrom: 'machine', col: 'Takeup Change Time (min)',
          where: 'Extrusion > Machine', origin: O.DATABASE },
        { key: 'compoundDensity', label: 'Compound density', unit: 'g/cm3',
          tab: 'targets_ex', table: 'density', rowFrom: 'materialType', col: 'Density (g/cm3)',
          where: 'Extrusion > Compound Density', origin: O.DATABASE },
        { key: 'takeupMaxWeightKg', label: 'Take-up max weight', unit: 'kg',
          tab: 'targets_ex', table: 'takeup', rowFrom: 'takeupSize', col: 'Max Weight (kg)',
          where: 'Extrusion > Takeup Drum', origin: O.DATABASE },
        { key: 'takeupAllowance', label: 'Take-up weight allowance factor', unit: '',
          tab: 'targets_ex', table: 'runConst', row: 'Takeup Weight Allowance Factor', col: 'Value',
          where: 'Extrusion > Run Constants', origin: O.DATABASE,
          note: 'The 1.3 that covers varying layer densities.' },
        conductorDensityConst
      ],

      steps: [
        {
          key: 'compoundKgPerKm', label: 'Compound weight', unit: 'kg/km', overridable: true,
          formula: 'pi/4 x (OD^2 - ID^2) x 1000 x compound density',
          fn: (v, ctx) => {
            const od = ctx.input('od', 'Outer Diameter (m)');
            const id = ctx.input('id', 'Inner Diameter (m)');
            ctx.choice('materialType', 'Compound');
            const g = ctx.constant('compoundDensity');
            if (od === null || id === null || g === null) return null;
            return (Math.PI / 4) * (od * od - id * id) * 1000 * (g * 1000);
          }
        },
        {
          key: 'kgPerHr', label: 'Output rate', unit: 'kg/hr', overridable: true,
          formula: 'sum over the extruders in use of (bleed rate x RPM)',
          fn: (v, ctx) => {
            const machine = ctx.choice('machine', 'Machine');
            const materialType = ctx.choiceRaw('materialType');
            const list = ctx.params.extruders || [];
            if (!list.length) {
              ctx.missing.push('Extruders In Use');
              return null;
            }
            const byExtruder = ctx.params.byExtruder || {};
            let total = 0;
            const parts = [];
            let ok = true;
            list.forEach(ex => {
              const rpm = targetNum_((byExtruder[ex] || {}).rpm);
              if (rpm === null) { ctx.missing.push('RPM for the ' + ex + ' extruder'); ok = false; }
              const bleed = targetBleedRate_(machine, ex, materialType);
              if (!bleed) {
                ctx.missing.push('A bleeding test for ' + (machine || '(no machine)') + ' / ' + ex +
                  (materialType ? ' / ' + materialType : '') + ' (Bleeding library)');
                ok = false;
              }
              if (rpm === null || !bleed) return;
              total += bleed.value * rpm;
              parts.push(ex + ' ' + tgtRound_(bleed.value, 3) + ' kg/rpm/hr x ' + rpm +
                ' rpm = ' + tgtRound_(bleed.value * rpm, 1) + ' kg/hr');
            });
            if (!ok) return null;
            ctx.exOutputBreakdown = parts;
            return total;
          },
          noteFn: (v, ctx) => (ctx.exOutputBreakdown && ctx.exOutputBreakdown.length)
            ? ctx.exOutputBreakdown.join('  +  ') : ''
        },
        {
          key: 'lineSpeed', label: 'Line speed', unit: 'm/min', overridable: true,
          formula: 'kg/hr / kg/km x 1000 / 60',
          fn: v => (v.kgPerHr && v.compoundKgPerKm) ? (v.kgPerHr / v.compoundKgPerKm * 1000 / 60) : null
        },
        {
          key: 'runningTimeMin', label: 'Running time', unit: 'min/km', overridable: true,
          formula: '1000 / line speed',
          fn: v => v.lineSpeed ? (1000 / v.lineSpeed) : null
        },
        {
          key: 'conductorKgPerKm', label: 'Conductor weight', unit: 'kg/km', overridable: true,
          formula: 'conductor density x 1000 x conductor area / 1e6',
          fn: (v, ctx) => {
            const area = ctx.input('conductorArea', 'Conductor Area (mm2)');
            ctx.choice('material', 'Conductor Material');
            const density = densityKgM3(ctx);
            return (area !== null && density !== null) ? (density * 1000 * area / 1e6) : null;
          }
        },
        {
          key: 'takeupCapacityKm', label: 'Max on take-up', unit: 'km', overridable: true,
          formula: 'min(loops that pack on at the cable OD, max drum weight / (allowance factor x conductor kg/km))',
          fn: (v, ctx) => {
            const override = ctx.input('maxPerDrumKm', 'Max per Drum (km)', true);
            if (override !== null) return override;
            const drum = ctx.choice('takeupSize', 'Take-Up Drum', true);
            const allowance = ctx.constant('takeupAllowance');
            const maxWeight = ctx.constant('takeupMaxWeightKg');
            if (!drum) {
              ctx.missing.push('Take-Up Drum, or a Max per Drum (km) value');
              return null;
            }

            // conductorKgPerKm is already per kilometre, so this quotient is
            // in km - no further conversion.
            const byWeightKm = (maxWeight !== null && allowance !== null && v.conductorKgPerKm)
              ? maxWeight / (allowance * v.conductorKgPerKm) : null;

            // The OD input is in metres; the drum dimensions are in mm.
            const row = ctx.specRow('targets_ex', 'takeup', drum);
            const od = targetNum_(ctx.params.od);
            const byPackingM = row ? targetPackedLengthM_(
              targetNum_(row.values.A), targetNum_(row.values.B), targetNum_(row.values.C),
              od === null ? null : od * 1000) : null;
            const byPackingKm = byPackingM === null ? null : byPackingM / 1000;

            // The sheet caps this by weight alone. The packing limit only
            // binds once the plant fills in the drum's A/B/C, so a drum with
            // no dimensions on file still gives the sheet's answer.
            if (byWeightKm === null) return byPackingKm;
            if (byPackingKm === null) return byWeightKm;
            return Math.min(byWeightKm, byPackingKm);
          }
        },
        {
          key: 'takeupChangeMinPerKm', label: 'Drum change time', unit: 'min/km', overridable: true,
          formula: 'take-up change time / max on take-up (km)',
          fn: (v, ctx) => {
            const changeMin = ctx.constant('takeupChangeMin');
            return (changeMin !== null && v.takeupCapacityKm) ? (changeMin / v.takeupCapacityKm) : null;
          }
        },
        {
          key: 'totalMinPerKm', label: 'Total target time', unit: 'min/km',
          formula: 'running time + drum change time',
          fn: v => (v.runningTimeMin !== null && v.takeupChangeMinPerKm !== null)
            ? (v.runningTimeMin + v.takeupChangeMinPerKm) : null
        }
      ]
    },

    /* ================= SCREENING & ARMOURING ================= */
    /* One model for both, and for all three machine families. What a line is
     * made of - how many heads, which are taping heads and which are wire
     * cages - is read from the Heads table rather than written into the code,
     * so CT, CW, ST and the armouring drum twisters all run the same chain.
     *
     * The chain stops at running time on purpose. The plant's own sheet stops
     * at line speed; changeover time will come from the WIP003 run log rather
     * than from a drum-capacity calculation, so there is deliberately no
     * take-up table here and the total is the running time alone. */
    targets_sc: {
      key: 'targets_sc',
      title: 'Target Time - Screening & Armouring',
      deptName: 'Screening & Armouring',
      // The WIP003 operation map labels these runs under two separate
      // departments; one model covers both, so it matches on either.
      wipDepts: ['Screening', 'Armouring'],
      specTabKey: 'targets_sc',

      context: [
        { key: 'machine', label: 'Machine (Line)', type: 'select', optionsSource: 'screeningMachines',
          origin: O.WIP, originNote: 'The line this work order actually ran on, from WIP003.' },
        { key: 'stage', label: 'Stage', type: 'select', options: ['Metallic Screen', 'Armouring'],
          origin: O.WIP,
          originNote: 'Which department the WIP003 operation code belongs to. Falls back to the machine ' +
            'family (CT/CW screen, ST/DT armour) when the order has no run yet.' }
      ],

      inputs: [
        // Which heads are running is a set, not a number, and each carries its
        // own geometry - so this is the same multiselect + repeat pair
        // Extrusion uses for its extruders.
        { key: 'heads', label: 'Heads In Use', type: 'multiselect',
          options: TARGET_SC_HEADS_,
          origin: O.DATABASE, originNote: 'The heads this line carries (Screening > Heads).' },
        {
          key: 'byHead', label: 'Per Head', type: 'repeat', over: 'heads',
          fields: [
            { key: 'elementType', label: 'Element Type', type: 'select', options: TARGET_SC_ELEMENT_TYPES_,
              origin: O.DATABASE, originNote: 'Screening > Heads.' },
            { key: 'process', label: 'Process', type: 'select', options: TARGET_SC_PROCESSES_,
              origin: O.PDS, originNote: 'A head that is stripping or running straight is not laying ' +
                'material and places no limit on the line.' },
            { key: 'diaBefore', label: 'Cable Dia Before (mm)', type: 'number', unit: 'mm',
              origin: O.PDS, originNote: 'That tape block\'s Cable Dia (Before), actual with TDS fallback.' },
            { key: 'tapeWidth', label: 'Tape Width (mm)', type: 'number', unit: 'mm',
              origin: O.PDS, originNote: 'That tape block\'s Tape Width.' },
            { key: 'noOfTapes', label: 'No. of Tapes', type: 'number', optional: true,
              origin: O.PDS, help: 'Blank counts as one. Two tapes at one head advance twice as far per turn.' },
            { key: 'application', label: 'Applied With', type: 'select', options: TARGET_SC_APPLICATIONS_,
              origin: O.MANUAL,
              help: 'Overlap subtracts from the tape width, a gap adds to it. Copper taping overlaps; ' +
                'steel taping is usually gapped.' },
            { key: 'overlapGapPct', label: 'Overlap / Gap %', type: 'number', unit: '%',
              origin: O.PDS, originNote: 'That tape block\'s Overlap/Gap %.' },
            { key: 'tapeMaterial', label: 'Tape Material', type: 'select',
              optionsSource: 'screeningTapeMaterials', optional: true,
              origin: O.PDS, help: 'Only used to cap the head\'s rpm when the pad is metallic.' },
            { key: 'layLength', label: 'Lay Length (mm/rev)', type: 'number', unit: 'mm/rev', optional: true,
              origin: O.PDS, help: 'Wire cages only - it IS the pitch, so no helix is derived.' },
            { key: 'rpm', label: 'RPM', type: 'number', optional: true,
              origin: O.PDS, help: 'Blank falls back to the line\'s planned Max RPM in Screening > Heads.' }
          ]
        }
      ],

      constants: [
        { key: 'payoffMaxSpeed', label: 'Payoff max speed', unit: 'm/min',
          tab: 'targets_sc', table: 'machine', rowFrom: 'machine', col: 'Payoff Max Speed (m/min)',
          where: 'Screening > Machine', origin: O.DATABASE },
        { key: 'takeupMaxSpeed', label: 'Take-up max speed', unit: 'm/min',
          tab: 'targets_sc', table: 'machine', rowFrom: 'machine', col: 'Takeup Max Speed (m/min)',
          where: 'Screening > Machine', origin: O.DATABASE }
      ],

      steps: [
        {
          key: 'headSpeed', label: 'Slowest head', unit: 'm/min', overridable: true,
          formula: 'tape: rpm x (width -/+ overlap) / sin(alpha) / 1000, where cos(alpha) = ' +
            '(width -/+ overlap) / (pi x dia).  wire cage: rpm x lay length / 1000',
          fn: (v, ctx) => {
            const machine = ctx.choice('machine', 'Machine');
            const heads = ctx.params.heads || [];
            if (!heads.length) {
              ctx.missing.push('Heads In Use');
              return null;
            }
            const bag = ctx.params.byHead || {};
            const notes = [];
            const limits = [];
            let ok = true;

            heads.forEach(head => {
              const f = bag[head] || {};
              const process = String(f.process || '').trim();
              if (process && process.toLowerCase() !== 'taping') {
                notes.push(head + ': ' + process + ', not laying');
                return;
              }
              const type = String(f.elementType || '').trim().toLowerCase();
              if (!type) {
                ctx.missing.push('Element Type for ' + head);
                ok = false;
                return;
              }
              const rpmInfo = targetScHeadRpm_(machine, head, f);
              if (rpmInfo.value === null) {
                ctx.missing.push('RPM for ' + head + ', or a Max RPM for ' + (machine || '(no machine)') +
                  ' / ' + head + ' (Screening > Heads)');
                ok = false;
                return;
              }
              const rpmTag = rpmInfo.value + ' rpm' +
                (rpmInfo.capped ? ' (capped, ' + rpmInfo.cls + ')' : '') +
                (rpmInfo.source === 'entered' ? '' : ' [planned]');

              if (type === 'wire cage') {
                const lay = targetNum_(f.layLength);
                if (lay === null) {
                  ctx.missing.push('Lay Length for ' + head);
                  ok = false;
                  return;
                }
                const speed = rpmInfo.value * lay / 1000;
                limits.push({ name: head, speed: speed });
                notes.push(head + ': ' + rpmTag + ' x ' + lay + ' mm/rev = ' + tgtRound_(speed, 2) + ' m/min');
                return;
              }

              const width = targetNum_(f.tapeWidth);
              const dia = targetNum_(f.diaBefore);
              const pct = targetNum_(f.overlapGapPct);
              if (width === null) { ctx.missing.push('Tape Width for ' + head); ok = false; }
              if (dia === null) { ctx.missing.push('Cable Dia Before for ' + head); ok = false; }
              if (pct === null) { ctx.missing.push('Overlap / Gap % for ' + head); ok = false; }
              if (!String(f.application || '').trim()) {
                ctx.missing.push('Applied With (overlap or gap) for ' + head);
                ok = false;
              }
              if (width === null || dia === null || pct === null) return;

              const advance = targetScTapeAdvanceMm_(width, pct, f.application, f.noOfTapes);
              if (advance === null) {
                ctx.missing.push('A workable tape width and overlap for ' + head +
                  ' (the overlap leaves no advance per turn)');
                ok = false;
                return;
              }
              const r = targetScTapeSpeed_(rpmInfo.value, advance, dia);
              if (!r) { ok = false; return; }
              if (r.longitudinal) {
                // Not an error and not a limit - a tape wider than the
                // circumference is applied along the cable, not wrapped round
                // it, so this head's rpm says nothing about line speed.
                notes.push(head + ': ' + tgtRound_(advance, 1) + ' mm per turn exceeds the ' +
                  tgtRound_(Math.PI * dia, 1) + ' mm circumference - applied longitudinally, no helical limit');
                return;
              }
              limits.push({ name: head, speed: r.speed });
              notes.push(head + ': ' + rpmTag + ', pitch ' + tgtRound_(r.pitchMm, 1) + ' mm at ' +
                tgtRound_(r.alphaDeg, 1) + ' deg = ' + tgtRound_(r.speed, 2) + ' m/min');
            });

            ctx.scNotes = notes;
            ctx.scLimits = limits;
            if (!ok) return null;
            if (!limits.length) {
              ctx.missing.push('At least one head actually laying material');
              return null;
            }
            const slowest = limits.reduce((a, b) => (b.speed < a.speed ? b : a));
            ctx.scSlowestHead = slowest;
            return slowest.speed;
          },
          noteFn: (v, ctx) => (ctx.scNotes && ctx.scNotes.length) ? ctx.scNotes.join('   |   ') : ''
        },
        {
          key: 'lineSpeed', label: 'Line speed', unit: 'm/min', overridable: true,
          formula: 'the slowest of every head laying material, the payoff and the take-up',
          fn: (v, ctx) => {
            // No head speed means the heads could not be evaluated, not that
            // they place no limit. Falling through to the payoff and take-up
            // caps would hand back a confident line speed that ignores the
            // machine actually laying the material (CLAUDE.md rule 4).
            if (v.headSpeed === null) return null;
            const candidates = [
              { name: (ctx.scSlowestHead && ctx.scSlowestHead.name) || 'Heads', speed: v.headSpeed }
            ];
            // The payoff and take-up caps are read the same way as any other
            // constant, so a manual override beats the table - but a line
            // whose caps are not on file yet still gets an answer from its
            // heads alone, with the trace saying which limits were considered.
            const payoff = ctx.constant('payoffMaxSpeed');
            const takeup = ctx.constant('takeupMaxSpeed');
            if (payoff !== null) candidates.push({ name: 'Payoff', speed: payoff });
            if (takeup !== null) candidates.push({ name: 'Take-up', speed: takeup });
            if (!candidates.length) return null;
            const binding = candidates.reduce((a, b) => (b.speed < a.speed ? b : a));
            ctx.scBinding = binding;
            ctx.scConsidered = candidates;
            return binding.speed;
          },
          noteFn: (v, ctx) => {
            if (!ctx.scBinding) return '';
            const all = (ctx.scConsidered || [])
              .map(c => c.name + ' ' + tgtRound_(c.speed, 2)).join(', ');
            return 'Limited by ' + ctx.scBinding.name + '. Considered: ' + all + ' m/min.';
          }
        },
        {
          key: 'runningTimeMin', label: 'Running time', unit: 'min/km', overridable: true,
          formula: '1000 / line speed',
          fn: v => v.lineSpeed ? (1000 / v.lineSpeed) : null
        },
        {
          key: 'totalMinPerKm', label: 'Total target time', unit: 'min/km',
          formula: 'running time',
          note: 'Running time only. Changeover time is not added here - it is to come from the ' +
            'WIP003 run log rather than from a drum-capacity calculation.',
          fn: v => v.runningTimeMin
        }
      ]
    }
  };

  return targetModelsCache_;
}

/** The Stranding cage-level derivation, called at most once per calculation
 *  and cached on the context. Everything complicated about stranding - the
 *  slowest-of-line-and-cages speed, the per-cage bobbin capacities, the
 *  take-up weight-vs-volume decision - stays in calcStrandingTimePerKm; this
 *  only assembles its arguments and remembers the answer.
 *
 *  Returns null (rather than a half-filled result) when no line is chosen,
 *  since every one of its outputs is line-scoped. */
function targetStrandCore_(ctx) {
  if ('strandCore' in ctx) return ctx.strandCore;

  const p = ctx.params || {};
  const cages = p.cages || [];
  const byCage = p.byCage || {};
  const layLengthByCage = {};
  const bobbinSizeByCage = {};

  cages.forEach(cage => {
    const entry = byCage[cage] || {};
    const lay = targetNum_(entry.layLength);
    if (lay !== null) layLengthByCage[cage] = lay;
    if (entry.bobbinSize) bobbinSizeByCage[cage] = entry.bobbinSize;
  });

  const machine = ctx.choice('machine', 'Machine');
  const material = ctx.choice('material', 'Conductor Material');
  const takeupSize = ctx.choice('takeupSize', 'Take-Up Drum');
  const finishedOD = ctx.input('finishedOD', 'Finished Conductor OD (mm)');
  if (!cages.length) ctx.missing.push('Cages In Use');
  cages.forEach(cage => {
    if (layLengthByCage[cage] === undefined) ctx.missing.push('Lay Length for ' + cage);
    if (bobbinSizeByCage[cage] === undefined) ctx.missing.push('Bobbin Size for ' + cage);
  });

  if (!machine) {
    ctx.strandCore = null;
    return null;
  }

  let r = null;
  try {
    r = calcStrandingTimePerKm({
      material: material, machine: machine, conductorType: p.conductorType || 'Round',
      cages: cages, layLengthByCage: layLengthByCage, bobbinSizeByCage: bobbinSizeByCage,
      wireCount: targetNum_(p.wireCount), finishedOD: finishedOD, takeupSize: takeupSize,
      // Continuous lines split their loading speed on this.
      sizeCsa: targetNum_(p.size)
    });
  } catch (e) {
    r = null;
  }

  if (r) {
    if (r.targetSpeed === null) {
      ctx.missing.push('A cage RPM or line speed on the ' + machine + ' Speed Criteria grid');
    }
    if (r.bobbinLengthM === null) {
      ctx.missing.push('Bobbin A/B/C (Stranding > Drum Size) or cage wire diameters, or a Max per bobbin value');
    }
    if (r.takeupLengthM === null) {
      ctx.missing.push('Take-up dimensions for "' + (takeupSize || '') +
        '" (Stranding > Takeup Drum), or a Max per take-up drum value');
    }
  }

  ctx.strandCore = r;
  return r;
}

/* ===================================================================
 * CLIENT-CALLABLE API
 * =================================================================== */

/** Strips the functions off a model so it can cross the google.script.run
 *  bridge. The client needs the shape (what to render), never the maths. */
function getTargetModelForClient(modelKey) {
  const m = targetModels_()[modelKey];
  if (!m) throw new Error('No target model for ' + modelKey);
  return {
    key: m.key,
    title: m.title,
    deptName: m.deptName,
    specTabKey: m.specTabKey,
    context: m.context,
    inputs: m.inputs,
    constants: (m.constants || []).map(c => ({
      key: c.key, label: c.label, unit: c.unit || '', where: c.where,
      origin: c.origin, note: c.note || '', readOnly: !!c.readOnly
    })),
    steps: (m.steps || []).map(s => ({
      key: s.key, label: s.label, unit: s.unit || '',
      formula: s.formula || '', overridable: !!s.overridable
    }))
  };
}

/** Option lists a model's selectors declare via `optionsSource`. Same idea as
 *  PDS_OPTIONS_SOURCES_ in Code.js: a source is registered once here and any
 *  model may use it, so the client stays generic. Each returns a plain array
 *  of strings or {value,label} objects; a source with no data returns [] so
 *  the field renders empty rather than inventing entries. */
function targetOptionSource_(name, params) {
  const p = params || {};
  const labelsOf = (tabKey, tableKey) => {
    try {
      return getSpecData(tabKey, tableKey).rows.map(r => r.label).filter(l => l !== '' && l !== null && l !== undefined);
    } catch (e) { return []; }
  };
  switch (name) {
    case 'drawingMachines': return getDailyReportMachines('Drawing');
    case 'strandingMachines': return getStrandMachineOptions();
    case 'extrusionMachines': return PDS_MACHINE_OPTIONS_.pds_extrusion;
    // Screening and Armouring share one machine list because they share one
    // department - the drum twisters are added because DT02/DT03/DT04 armour
    // as well as lay up, and WIP003 will name them on an armouring run.
    case 'screeningMachines':
      return PDS_MACHINE_OPTIONS_.pds_screening_armouring.concat(
        PDS_MACHINE_OPTIONS_.pds_assembly.filter(m => /armor|armour/i.test(m.label)));
    case 'screeningTapeMaterials': return labelsOf('targets_sc', 'tapeMaterial');
    case 'drawingBobbins': return labelsOf('targets_dr', 'bobbin');
    case 'extrusionTakeups': return labelsOf('targets_ex', 'takeup');
    case 'extrusionCompounds': return labelsOf('targets_ex', 'density');
    case 'strandingDrums': return labelsOf('rpm_str', 'drum');
    case 'strandingTakeups': return labelsOf('rpm_str', 'takeup');
    case 'strandingSizes': return getStrandSizeOptions();
    case 'strandingLayLengths':
      return getStrandLayLengthOptions(p.size, p.machine, p.cage, p.material, p.conductorType);
    case 'strandingOds':
      return getStrandOdOptions(p.size, p.machine, p.conductorType);
    default: return [];
  }
}

/** Client-callable: every static option list a model needs, in one round trip.
 *  Sources that depend on the engineer's current selections (the stranding
 *  history lookups) are fetched separately as those selections change. */
function getTargetOptions(modelKey) {
  const m = targetModels_()[modelKey];
  if (!m) throw new Error('No target model for ' + modelKey);
  const out = {};
  const collect = field => {
    if (field.optionsSource && !(field.optionsSource in out)) {
      if (field.optionsSource === 'strandingLayLengths' || field.optionsSource === 'strandingOds') return;
      out[field.optionsSource] = targetOptionSource_(field.optionsSource, {});
    }
  };
  (m.context || []).forEach(collect);
  (m.inputs || []).forEach(f => {
    collect(f);
    (f.fields || []).forEach(collect);
  });
  return out;
}

/** Client-callable: one selection-dependent option list. */
function getTargetOptionSource(sourceName, params) {
  return targetOptionSource_(sourceName, params);
}

/** Client-callable: THE entrypoint. Runs any model against a set of context
 *  selections, per-order inputs, constant overrides and step overrides.
 *
 *  params: { <contextKey>: v, <inputKey>: v, byCage: {...},
 *            constants: { <constantKey>: v },   // manual mode overrides
 *            steps:     { <stepKey>: v },       // manual mode overrides
 *            quantityKm: v }
 *
 *  Returns { steps, constants, totalMinPerKm, quantityKm, totalHours, missing }.
 *  `constants` reports EVERY declared constant with the value actually used
 *  and where it came from, so the client can render a pre-filled, editable
 *  panel without a second round trip. `missing` is de-duplicated and names the
 *  sheet and row the plant needs to fill, so an unavailable total is always
 *  explained. */
function calcTargetTime(modelKey, params) {
  const model = targetModels_()[modelKey];
  if (!model) throw new Error('No target model for ' + modelKey);

  const ctx = targetCtx_(model, params);

  const run = targetRunSteps_(model, ctx);
  const steps = run.steps;

  const totalStep = steps.find(s => s.key === 'totalMinPerKm');
  const totalMinPerKm = totalStep ? totalStep.value : null;

  const quantityKm = targetNum_((params || {}).quantityKm);
  const totalHours = (totalMinPerKm !== null && quantityKm !== null)
    ? (totalMinPerKm * quantityKm / 60) : null;

  // Every declared constant, whether or not this run happened to reach it -
  // the manual-mode panel lists them all, so a step that short-circuited must
  // not make its constants vanish from the screen.
  const constants = (model.constants || []).map(c => {
    const r = ctx.resolved[c.key] || { value: null, source: null, rowLabel: null, note: '' };
    return {
      key: c.key, label: c.label, unit: c.unit || '', where: c.where,
      origin: c.origin, note: [c.note, r.note].filter(x => x).join(' '), readOnly: !!c.readOnly,
      rowLabel: r.rowLabel, value: r.value, source: r.source
    };
  });

  const seen = {};
  const missing = ctx.missing.filter(msg => {
    if (seen[msg]) return false;
    seen[msg] = true;
    return true;
  });

  return {
    modelKey: modelKey,
    steps: steps,
    constants: constants,
    totalMinPerKm: totalMinPerKm,
    quantityKm: quantityKm,
    totalHours: totalHours,
    missing: missing
  };
}

/* ===================================================================
 * DATA INVENTORY
 * =================================================================== */

/** Client-callable: every piece of data all models consume, grouped by where
 *  it comes from. Generated from the declarations themselves, so it cannot
 *  drift from what the calculators actually read.
 *
 *  Returns [{ dept, modelKey, items: [{ kind, key, label, unit, origin,
 *  originLabel, where, note }] }]. */
function describeTargetData() {
  const models = targetModels_();
  return Object.keys(models).map(modelKey => {
    const m = models[modelKey];
    const items = [];
    const push = (kind, f, extra) => items.push(Object.assign({
      kind: kind,
      key: f.key,
      label: f.label,
      unit: f.unit || '',
      origin: f.origin || TARGET_ORIGINS_.MANUAL,
      originLabel: TARGET_ORIGIN_LABELS_[f.origin || TARGET_ORIGINS_.MANUAL],
      where: f.where || '',
      note: f.originNote || f.note || '',
      optional: !!f.optional
    }, extra || {}));

    (m.context || []).forEach(f => push('Selector', f));
    (m.inputs || []).forEach(f => {
      if (f.type === 'repeat') {
        (f.fields || []).forEach(sub => push('Input (per cage)', sub));
        return;
      }
      push('Input', f);
    });
    (m.constants || []).forEach(c => push('Constant', c, {
      where: c.where, sheet: c.tab + ' > ' + c.table, column: c.col || c.colFrom || ''
    }));
    (m.steps || []).forEach(s => items.push({
      kind: 'Output', key: s.key, label: s.label, unit: s.unit || '',
      origin: 'calculated', originLabel: 'Calculated',
      where: '', note: s.formula || '', optional: false,
      overridable: !!s.overridable
    }));

    return { dept: m.deptName, modelKey: modelKey, title: m.title, items: items };
  });
}

/* ===================================================================
 * WORK-ORDER MODE
 * Resolves a model's per-order inputs from data the app already holds. Every
 * resolved value carries where it came from, and anything that cannot be
 * resolved is reported as unavailable rather than guessed (CLAUDE.md rule 4).
 * =================================================================== */

/** Normalises a size for comparison the way the rest of the app does. */
function targetNormSize_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, '').toUpperCase();
}

/** Looks a size + construction pair up in the shared Construction table.
 *  Returns null when the pair is not on file - the caller then reports the
 *  inputs as unavailable instead of substituting a neighbouring row. */
function targetLookupConstruction_(size, construction) {
  let data;
  try {
    data = getSpecData('targets_ref', 'construction');
  } catch (e) { return null; }
  const wantSize = targetNormSize_(size);
  const wantCon = String(construction || '').trim().toUpperCase();
  const matches = data.rows.filter(r => targetNormSize_(r.label) === wantSize);
  if (!matches.length) return null;
  const exact = wantCon
    ? matches.find(r => String(r.values.Construction || '').trim().toUpperCase() === wantCon)
    : null;
  const row = exact || (matches.length === 1 ? matches[0] : null);
  if (!row) return null;
  return {
    size: row.label,
    construction: row.values.Construction || '',
    conductorShape: row.values['Conductor Shape'] || '',
    wireCount: targetNum_(row.values['No of Wires']),
    wireDia: targetNum_(row.values['Wire Diameter (mm)']),
    conductorArea: targetNum_(row.values['Conductor Area (mm2)'])
  };
}

/** The most recent submitted PDS on one form for a size (and optionally one
 *  line). The department's own record of how the job was actually set up is
 *  the best source for the run variables, so every model that has a matching
 *  form resolves through here rather than growing its own copy. */
function targetFindDeptPds_(tabKey, size, machine) {
  let rows;
  try {
    rows = getPdsRecords(tabKey, {});
  } catch (e) { return null; }
  const wantSize = targetNormSize_(size);
  const candidates = rows.filter(r => targetNormSize_(r.size) === wantSize
    && (!machine || String(r.machine || '') === String(machine)));
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return candidates[0];
}

/** The most recent submitted Extrusion PDS for a size, used to source the
 *  layer's OD/ID and screw RPM. */
function targetFindExtrusionPds_(size, machine) {
  return targetFindDeptPds_('pds_extrusion', size, machine);
}

/** Which PDS block on the Screening & Armouring form records each head.
 *  The form's three tape blocks and two wire cages ARE the heads, in order. */
const TARGET_SC_HEAD_BLOCK_ = {
  'Head 1': 'tape1',
  'Head 2': 'tape2',
  'Head 3': 'tape3',
  'Wire Cage': 'wireCage',
  'Wire Cage 2': 'wireCage2'
};

/** One cell of an Actual/Tds block table, taking the actual reading first and
 *  the TDS value as the documented fallback - the same precedence the rest of
 *  the app uses, so "which number did it take" means one thing everywhere.
 *  Unlike targetSplitActualTds_ these are two separate cells, not one
 *  "actual / tds" string. */
function targetScPdsCell_(pds, blockKey, colKey) {
  if (!pds) return { value: null, basis: null };
  const actual = targetNum_(pds[blockKey + '_actual_' + colKey]);
  if (actual !== null) return { value: actual, basis: 'Actual' };
  const tds = targetNum_(pds[blockKey + '_tds_' + colKey]);
  if (tds !== null) return { value: tds, basis: 'TDS' };
  return { value: null, basis: null };
}

/** Same, for a cell holding text rather than a number. */
function targetScPdsText_(pds, blockKey, colKey) {
  if (!pds) return '';
  const actual = String(pds[blockKey + '_actual_' + colKey] || '').trim();
  if (actual) return actual;
  return String(pds[blockKey + '_tds_' + colKey] || '').trim();
}

/** Whether a tape on this line is laid overlapped or gapped.
 *
 *  The PDS records one "Overlap/Gap %" column without saying which it is, so
 *  the sign has to come from somewhere. The plant's own sheets settle it by
 *  family: the copper-tape and copper-wire sheets subtract an overlap, the
 *  steel-tape sheet adds a gap. That is a starting value the engineer can
 *  change on the form, not a fact - which is why it is returned with a
 *  provenance line saying where it came from. */
function targetScDefaultApplication_(machine) {
  const m = String(machine || '').trim().toUpperCase();
  if (/^CT|^CW/.test(m)) return 'Overlap';
  if (/^ST|^DT/.test(m)) return 'Gap';
  return null;
}

/** Actual reading first, TDS as the documented fallback - the same precedence
 *  getStrandOdOptions already uses, so "which number did it take" means one
 *  thing across the app. `raw` values look like "12.5 / 12.4" (actual / tds). */
function targetSplitActualTds_(raw) {
  const parts = String(raw === null || raw === undefined ? '' : raw).split('/');
  const actual = targetNum_(parts[0]);
  const tds = targetNum_(parts[1]);
  if (actual !== null) return { value: actual, basis: 'Actual' };
  if (tds !== null) return { value: tds, basis: 'TDS' };
  return { value: null, basis: null };
}

/** Client-callable: fills in as much of a model's context and inputs as the
 *  work order allows.
 *
 *  Returns { found, order, values: {key: value}, provenance: {key: text},
 *            unresolved: [labels] } - the client applies `values` to the form,
 *  shows `provenance` next to each field, and leaves `unresolved` blank for
 *  manual entry. Nothing here writes; it only reads existing records. */
function resolveTargetInputs(modelKey, workOrder, current) {
  const params_ = current || {};
  const model = targetModels_()[modelKey];
  if (!model) throw new Error('No target model for ' + modelKey);

  const plan = masterPlanLookupWorkOrder(workOrder);
  if (!plan || !plan.found) {
    return {
      found: false,
      error: (plan && plan.error) || 'Work order not found in any uploaded master plan.',
      values: {}, provenance: {}, unresolved: []
    };
  }

  const values = {};
  const provenance = {};
  const unresolved = [];
  // Things the engineer should read but that did not stop a field being
  // filled - the client shows these above the form. `unresolved` is for what
  // is missing; this is for what is present but worth a second look.
  const warnings = [];
  const planTag = 'Master plan ' + (plan.month || '') + ', W.O. ' + workOrder;

  if (plan.conductorMaterial) {
    values.material = plan.conductorMaterial;
    provenance.material = planTag;
  }
  const quantityKm = targetNum_(plan.plannedQtyKm);
  if (quantityKm !== null) {
    values.quantityKm = quantityKm;
    provenance.quantityKm = planTag;
  }

  const con = targetLookupConstruction_(plan.size, plan.construction);
  const conTag = con ? ('Construction table, size ' + con.size +
    (con.construction ? ' / ' + con.construction : '')) : '';

  // The TDS log is joined on the work order's TDS number, never on its size -
  // the log's size column is free text and would mis-resolve (see TdsLog.js).
  const tdsHit = tdsLookup_(plan.tds);
  const tds = tdsHit.found ? tdsHit.record : null;
  const tdsTag = tds ? ('TDS ' + tds.tdsNo +
    (tdsHit.matchedOn === 'number' ? ' (matched on number, revision not compared)' : '')) : '';

  // Which line actually ran this order, from the daily WIP003 export. This is
  // the only source in the app that knows; the master plan says what to make,
  // not what it ran on.
  const wip = targetWipRun_(workOrder, model.wipDepts || model.deptName);
  if (wip && wip.machine) {
    values.machine = wip.machine;
    provenance.machine = 'WIP003 ' + wip.date + ', ' + (wip.operationName || wip.oprCode);
  } else {
    unresolved.push('Machine (no WIP003 run for this order in ' + model.deptName + ' yet)');
  }

  if (modelKey === 'targets_dr' || modelKey === 'targets_str') {
    // Phase and neutral are separate runs with different wire counts, so the
    // Conductor selector decides which of the TDS's two counts applies.
    const part = String((params_ || {}).conductorPart || 'phase').toLowerCase();
    const side = (part === 'neutral') ? 'neutral' : 'phase';
    const wires = tds ? tds[side].wires : null;
    if (wires) {
      values.wireCount = wires;
      provenance.wireCount = tdsTag + ', ' + side + ' conductor';
    } else if (con && con.wireCount !== null) {
      values.wireCount = con.wireCount;
      provenance.wireCount = conTag;
    } else {
      unresolved.push('No. of Wires' + (tds && side === 'neutral' ? ' (this TDS has no neutral)' : ''));
    }
  }
  if (modelKey === 'targets_dr') {
    // Wire diameter stays typed. The TDS gives CSA and wire count, but
    // sqrt(4 x CSA/wires / pi) is the NOMINAL diameter, which a compacted
    // conductor does not match - about 2% out on the sizes checked. Rather
    // than resolve a number that looks authoritative and is quietly wrong,
    // it is left for the engineer (CLAUDE.md rule 4).
    unresolved.push('Wire Diameter (mm)');
  }
  if (modelKey === 'targets_str') {
    if (plan.size) {
      values.size = plan.size;
      provenance.size = planTag;
    } else if (tds && tds.size) {
      values.size = tds.size;
      provenance.size = tdsTag + ', size column';
    }

    // Cages follow from the wire count - the cage names ARE the wires per
    // layer - so nothing needs to pick them by hand.
    const cages = targetCagesForWireCount_(values.wireCount);
    if (cages && cages.length) {
      values.cages = cages;
      provenance.cages = (values.wireCount) + ' wires = 1 + ' +
        cages.map(c => c.replace('Cage ', '')).join(' + ');
    } else if (values.wireCount) {
      unresolved.push('Cages In Use (' + values.wireCount +
        ' wires is not a concentric 7/19/37/61 build, so the cages cannot be derived)');
    }
    if (con && con.conductorShape) {
      values.conductorType = con.conductorShape;
      provenance.conductorType = conTag;
    }
  }

  if (modelKey === 'targets_ex') {
    const planCsa = targetNum_(plan.phaseCsa);
    if (planCsa !== null) {
      values.conductorArea = planCsa;
      provenance.conductorArea = planTag + ' (Phase CSA)';
    } else if (tds && tds.phase.csaMm2) {
      values.conductorArea = tds.phase.csaMm2;
      provenance.conductorArea = tdsTag + ', ph_size (plan had no Phase CSA)';
    } else {
      unresolved.push('Conductor Area (mm2)');
    }

    // The operation code on the WIP003 run says which process ran.
    if (wip && TARGET_WIP_PROCESS_[wip.oprCode]) {
      values.process = TARGET_WIP_PROCESS_[wip.oprCode];
      provenance.process = 'WIP003 ' + wip.date + ', operation ' + wip.oprCode;
    }

    // Which extruders this line carries, and which of them run by default.
    const exList = targetDefaultExtruders_(values.machine);
    if (exList.length) {
      values.extruders = exList;
      provenance.extruders = 'Extrusion > Extruders for ' + values.machine;
    } else if (values.machine) {
      unresolved.push('Extruders In Use (no rows for ' + values.machine + ' in Extrusion > Extruders)');
    }

    const pds = targetFindExtrusionPds_(plan.size, values.machine);
    if (pds) {
      // Block table cells are stored as "<blockKey>_<rowKey>_<colKey>" and a
      // block's extraFields as "<blockKey>_x_<fieldKey>" - see
      // flattenPdsBlockInputs_ in index.html, which is what wrote these rows.
      const tag = 'PDS ' + (pds.pdsCode || pds.recordId || '') + (pds.date ? ', ' + pds.date : '');
      const outer = targetSplitActualTds_(pds.dieHead_finalDia_head1);
      const inner = targetSplitActualTds_(pds.dieHead_inletDia_head1);
      // The PDS records head diameters in mm; the model works in metres.
      if (outer.value !== null) {
        values.od = outer.value / 1000;
        provenance.od = tag + ' (' + outer.basis + ' final dia)';
      } else { unresolved.push('Outer Diameter (m)'); }
      if (inner.value !== null) {
        values.id = inner.value / 1000;
        provenance.id = tag + ' (' + inner.basis + ' inlet dia)';
      } else { unresolved.push('Inner Diameter (m)'); }

      values.byExtruder = values.byExtruder || {};
      exList.forEach(ex => {
        const def = TARGET_EX_EXTRUDERS_.find(e => e.value === ex);
        const rpm = def ? targetNum_(pds[def.pdsBlock + '_x_rpm']) : null;
        if (rpm !== null) {
          values.byExtruder[ex] = { rpm: rpm };
          provenance['byExtruder.' + ex] = tag;
        } else {
          unresolved.push('RPM for the ' + ex + ' extruder');
        }
      });
    } else {
      unresolved.push('Outer Diameter (m)');
      unresolved.push('Inner Diameter (m)');
      exList.forEach(ex => unresolved.push('RPM for the ' + ex + ' extruder'));
    }

    // The compound comes from whichever TDS stage matches the process being
    // run - Insulation reads ins, Bedding bed, Sheathing she - resolved
    // through the same prefix map the PDS forms use. The PDS's own Material
    // Type is the fallback, since the TDS is the design intent and the PDS
    // records one particular run of it.
    const stageKey = TDS_PROCESS_STAGE_[values.process];
    const stage = (tds && stageKey) ? tds.stages[stageKey] : null;
    const compound = tdsStageMaterialType_(stage);
    if (compound) {
      values.materialType = compound.type;
      provenance.materialType = tdsTag + ', ' + stageKey + ' material ' + compound.fullCode;
    } else if (pds && pds.materialType) {
      values.materialType = pds.materialType;
      provenance.materialType = 'PDS ' + (pds.pdsCode || '') + (pds.date ? ', ' + pds.date : '');
    } else if (!values.process) {
      unresolved.push('Process (needed before the TDS can name the compound)');
    } else {
      unresolved.push('Compound');
    }
  }

  if (modelKey === 'targets_sc') {
    // Which of the two stages ran. The operation map already splits these
    // runs into Screening and Armouring, so the WIP003 row says it outright;
    // the machine family is the fallback for an order with no run logged yet.
    if (wip && (wip.dept === 'Screening' || wip.dept === 'Armouring')) {
      values.stage = wip.dept === 'Armouring' ? 'Armouring' : 'Metallic Screen';
      provenance.stage = 'WIP003 ' + wip.date + ', operation ' + wip.oprCode + ' (' + wip.dept + ')';
    } else if (values.machine) {
      const m = String(values.machine).toUpperCase();
      if (/^CT|^CW/.test(m)) { values.stage = 'Metallic Screen'; provenance.stage = 'Machine family ' + m; }
      else if (/^ST|^DT/.test(m)) { values.stage = 'Armouring'; provenance.stage = 'Machine family ' + m; }
    }

    const lineHeads = targetScDefaultHeads_(values.machine);
    const pds = targetFindDeptPds_('pds_screening_armouring', plan.size, values.machine);
    const tag = pds ? ('PDS ' + (pds.pdsCode || pds.recordId || '') + (pds.date ? ', ' + pds.date : '')) : '';

    // A head counts as running when the run's own PDS has tape or wire data
    // against it - that is the record of what the line was actually set up to
    // do. With no PDS to go on, fall back to the heads the line carries and
    // let the engineer uncheck the ones that were idle.
    const withData = pds
      ? lineHeads.filter(h => {
          const b = TARGET_SC_HEAD_BLOCK_[h];
          if (!b) return false;
          return targetScPdsCell_(pds, b, 'tapeWidth').value !== null
            || targetScPdsCell_(pds, b, 'layLength').value !== null;
        })
      : [];
    const heads = withData.length ? withData : lineHeads;

    if (heads.length) {
      values.heads = heads;
      provenance.heads = withData.length
        ? tag + ' (the heads with data on that record)'
        : 'Screening > Heads for ' + values.machine;
    } else if (values.machine) {
      unresolved.push('Heads In Use (no rows for ' + values.machine + ' in Screening > Heads)');
    }

    const defaultApplication = targetScDefaultApplication_(values.machine);
    values.byHead = values.byHead || {};

    heads.forEach(head => {
      const block = TARGET_SC_HEAD_BLOCK_[head];
      const fields = {};
      const prov = (key, text) => { provenance['byHead.' + head + '.' + key] = text; };

      const type = targetScHeadType_(values.machine, head) ||
        (/cage/i.test(head) ? 'Wire Cage' : 'Tape');
      fields.elementType = type;
      prov('elementType', 'Screening > Heads');

      // Nothing in the app records a per-head process, so it is set from the
      // evidence that the head was working at all rather than defaulted.
      if (withData.length) {
        fields.process = 'Taping';
        prov('process', tag + ' (that block has data)');
      }

      if (block && pds) {
        const rpm = targetScPdsCell_(pds, block, 'rpm');
        if (rpm.value !== null) { fields.rpm = rpm.value; prov('rpm', tag + ' (' + rpm.basis + ')'); }

        const lay = targetScPdsCell_(pds, block, 'layLength');
        if (lay.value !== null) { fields.layLength = lay.value; prov('layLength', tag + ' (' + lay.basis + ')'); }

        if (/cage/i.test(type)) {
          if (lay.value === null) unresolved.push('Lay Length for ' + head);
        } else {
          const dia = targetScPdsCell_(pds, block, 'cableDiaBefore');
          if (dia.value !== null) { fields.diaBefore = dia.value; prov('diaBefore', tag + ' (' + dia.basis + ')'); }
          else unresolved.push('Cable Dia Before for ' + head);

          const width = targetScPdsCell_(pds, block, 'tapeWidth');
          if (width.value !== null) { fields.tapeWidth = width.value; prov('tapeWidth', tag + ' (' + width.basis + ')'); }
          else unresolved.push('Tape Width for ' + head);

          const pct = targetScPdsCell_(pds, block, 'overlapPct');
          if (pct.value !== null) { fields.overlapGapPct = pct.value; prov('overlapGapPct', tag + ' (' + pct.basis + ')'); }
          else unresolved.push('Overlap / Gap % for ' + head);

          const tapes = targetScPdsCell_(pds, block, 'noOfTapes');
          if (tapes.value !== null) { fields.noOfTapes = tapes.value; prov('noOfTapes', tag + ' (' + tapes.basis + ')'); }

          const mat = targetScPdsText_(pds, block, 'tapeMaterial');
          if (mat) { fields.tapeMaterial = mat; prov('tapeMaterial', tag); }

          if (defaultApplication) {
            fields.application = defaultApplication;
            prov('application', 'Machine family ' + String(values.machine).toUpperCase() +
              ' - the PDS records one Overlap/Gap % without saying which. Change it if this run was the other way.');
          } else {
            unresolved.push('Applied With (overlap or gap) for ' + head);
          }
        }
      } else {
        if (defaultApplication && !/cage/i.test(type)) {
          fields.application = defaultApplication;
          prov('application', 'Machine family ' + String(values.machine || '').toUpperCase());
        }
        unresolved.push((/cage/i.test(type) ? 'Lay Length' : 'Tape geometry') + ' for ' + head +
          ' (no Screening & Armouring PDS for this size yet)');
      }

      values.byHead[head] = fields;
    });

    if (!pds && heads.length) {
      warnings.push('No Screening & Armouring PDS was found for size ' + (plan.size || '') +
        ', so every head\'s geometry has to be typed. The line\'s planned Max RPM from ' +
        'Screening > Heads will be used for any head left without one.');
    }
  }

  return {
    found: true,
    order: {
      workOrder: workOrder, month: plan.month, size: plan.size, tds: plan.tds,
      kv: plan.kv, material: plan.conductorMaterial, desc: plan.desc,
      quantityKm: quantityKm
    },
    values: values,
    provenance: provenance,
    unresolved: unresolved,
    warnings: warnings,
    // The whole TDS bill of materials, for the reference panel. Read-only:
    // its per-stage kg/km are NOT fed into any calculation yet, because which
    // variant a single run covers is still an open question.
    tds: plan.tds ? tdsSummaryForClient(plan.tds) : { found: false }
  };
}

/* ===================================================================
 * SETUP
 * =================================================================== */

/** Run once from the Apps Script editor to register the Target Time tabs.
 *  Safe to re-run - skips whatever already exists.
 *
 *  Stranding is deliberately absent: its tab already exists as 'rpm_str' and
 *  now renders the same generic calculator (see TARGET_TAB_MODEL_ in
 *  index.html). Registering a second 'targets_str' tab would give Stranding
 *  two Target Time entries pointing at the same reference grids. */
function setupTargetTabs() {
  const wanted = [
    { deptId: 'D1', tabName: 'Target Time', tabKey: 'targets_dr', order: 15 },
    { deptId: 'D4', tabName: 'Target Time', tabKey: 'targets_ex', order: 15 },
    // Screening and Armouring share one department page, so one tab serves
    // both - the model tells them apart by the Stage selector.
    { deptId: 'D5', tabName: 'Target Time', tabKey: 'targets_sc', order: 15 }
  ];
  const existing = sheetToObjects_(SHEETS.TABS);
  const created = [];
  wanted.forEach(t => {
    if (!existing.some(e => e.TabKey === t.tabKey)) {
      adminCreateTab(t.deptId, t.tabName, t.tabKey, t.order);
      created.push(t.tabKey);
    }
  });
  return { ok: true, created: created };
}
