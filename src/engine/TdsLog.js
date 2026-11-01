/* ===================================================================
 * TDS LOG - the plant's per-TDS bill of materials
 * -------------------------------------------------------------------
 * One row per TDS, giving the cable's construction (phase and neutral cores,
 * CSA, wire counts) and, for each of the 13 process stages, the material
 * codes used and the kilograms of that material per kilometre of cable.
 *
 * WHY IT MATTERS HERE: it answers questions the target calculators would
 * otherwise have to ask a human or derive. Wire count comes straight from it;
 * so does the compound actually used on a layer, via the same
 * materialTypeForCode_ prefix map the PDS forms already use. Its conductor
 * kg/km reconciles with CSA x density to within about 1%, which is what makes
 * it trustworthy as a source rather than a hint.
 *
 * THE JOIN KEY IS THE TDS NUMBER, NOT THE SIZE. The `size` and `dscrpt`
 * columns are free text entered by many hands - "1X16", "1 X 35 MM2",
 * "3*150+70", "1 X 30 0 M", and blank on some rows - so matching on them
 * would silently mis-resolve. `cdh_no_a` is clean and is the same number the
 * master plan carries in its TDS column, so that is the only key used.
 *
 * STAGE x VARIANT LAYOUT: every stage has columns "<stage>_<variant>_code"
 * and "<stage>_<variant>_kgkm". Variants are c (core), n (neutral) and
 * p (phase). A fourth variant, r, exists on drw/ins/std; its meaning is not
 * settled yet, so it is parsed and carried through for display but no
 * calculation reads it. Do not guess at it - ask before wiring it up.
 *
 * A NOTE ON FILE LOAD ORDER: same constraint as Forms.js and Targets.js -
 * nothing here may reference Code.js definitions at top level.
 * =================================================================== */

/** The plant's TDS log, living in the same Drive folder as the PDS data.
 *  Read-only from the app's point of view - the plant maintains it directly. */
const TDS_LOG_FILE_ID_ = 'REPLACE_WITH_YOUR_TDS_LOG_SPREADSHEET_ID';

/** Process stages, in the order material is laid onto the cable rather than
 *  the alphabetical order the sheet's columns happen to use. Stage keys and
 *  department names line up with PRODUCTIVITY_OPERATION_SEED_ in Code.js so a
 *  stage means one thing across the whole app. */
const TDS_STAGES_ = [
  { key: 'drw', label: 'Drawing', dept: 'Drawing' },
  { key: 'std', label: 'Stranding', dept: 'Stranding' },
  { key: 'isc', label: 'Inner semi-con screen', dept: 'CV' },
  { key: 'ins', label: 'Insulation', dept: 'Extrusion' },
  { key: 'osc', label: 'Outer semi-con screen', dept: 'CV' },
  { key: 'msc', label: 'Metallic screen', dept: 'Screening' },
  { key: 'scw', label: 'Wire screen', dept: 'Screening' },
  { key: 'sct', label: 'Tape screen', dept: 'Screening' },
  { key: 'ppt', label: 'PPT', dept: 'Assembly' },
  { key: 'asm', label: 'Assembly', dept: 'Assembly' },
  { key: 'bed', label: 'Bedding', dept: 'Extrusion' },
  { key: 'arm', label: 'Armouring', dept: 'Armouring' },
  { key: 'she', label: 'Sheathing', dept: 'Extrusion' }
];

/** c/n/p are confirmed. r is deliberately absent: it appears on drw, ins and
 *  std but nobody has settled what it means, so it is displayed and never
 *  calculated with. */
const TDS_VARIANTS_ = [
  { key: 'c', label: 'Core' },
  { key: 'n', label: 'Neutral' },
  { key: 'p', label: 'Phase' }
];
const TDS_UNSETTLED_VARIANTS_ = ['r'];

/** Which TDS stage supplies the compound for an Extrusion process. The
 *  pds_extrusion form's own Process dropdown offers exactly these three. */
const TDS_PROCESS_STAGE_ = {
  Insulation: 'ins',
  Bedding: 'bed',
  Sheathing: 'she'
};

function tdsNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) || !isFinite(n) ? null : n;
}

function tdsStr_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/** The TDS number as written, uppercased and stripped of spaces. */
function tdsNormNo_(v) {
  return tdsStr_(v).toUpperCase().replace(/\s+/g, '');
}

/** The numeric part before any revision suffix, with leading zeros dropped -
 *  "0000839-00", "0000839", "839-00" and "839" all reduce to "839". The
 *  master plan's TDS column is typed by hand and does not consistently carry
 *  the padding or the revision, so an exact-string match alone would miss
 *  rows that are plainly the same TDS. Exact matches still win; this is only
 *  the fallback. */
function tdsBaseNo_(v) {
  const s = tdsNormNo_(v);
  if (!s) return '';
  const digits = s.split('-')[0].replace(/[^0-9]/g, '');
  return digits.replace(/^0+/, '') || (digits ? '0' : '');
}

let tdsLogCache_ = null;

/** Reads and parses the whole log once per execution. Not put in
 *  CacheService: the sheet is a few hundred rows of 80 columns, which is
 *  comfortably past the cache's per-key size limit, and a lookup only happens
 *  when someone enters a work order. */
function tdsLogRows_() {
  if (tdsLogCache_) return tdsLogCache_;

  let values;
  try {
    values = SpreadsheetApp.openById(TDS_LOG_FILE_ID_).getSheets()[0].getDataRange().getValues();
  } catch (e) {
    tdsLogCache_ = { error: 'Could not open the TDS log: ' + (e.message || e), byExact: {}, byBase: {}, count: 0 };
    return tdsLogCache_;
  }
  if (!values || values.length < 2) {
    tdsLogCache_ = { error: 'The TDS log is empty.', byExact: {}, byBase: {}, count: 0 };
    return tdsLogCache_;
  }

  const header = values[0].map(h => tdsStr_(h).toLowerCase());
  const col = {};
  header.forEach((h, i) => { if (h && !(h in col)) col[h] = i; });

  const byExact = {};
  const byBase = {};
  let count = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const no = tdsNormNo_(row[col.cdh_no_a]);
    if (!no) continue;
    const parsed = tdsParseRow_(row, col, no);
    byExact[no] = parsed;
    const base = tdsBaseNo_(no);
    // First row wins on a base collision (two revisions of one TDS); the
    // exact match is what resolves that properly, and the caller is told
    // which kind of match it got.
    if (base && !(base in byBase)) byBase[base] = parsed;
    count += 1;
  }

  tdsLogCache_ = { error: null, byExact: byExact, byBase: byBase, count: count };
  return tdsLogCache_;
}

function tdsParseRow_(row, col, no) {
  const cell = name => (name in col) ? row[col[name]] : '';

  const stages = {};
  TDS_STAGES_.forEach(s => {
    const variants = {};
    let total = 0;
    let any = false;
    TDS_VARIANTS_.forEach(v => {
      const kg = tdsNum_(cell(s.key + '_' + v.key + '_kgkm'));
      const code = tdsStr_(cell(s.key + '_' + v.key + '_code'));
      if (!kg && !code) return;
      variants[v.key] = { label: v.label, kgkm: kg, code: code };
      if (kg) { total += kg; any = true; }
    });
    const unsettled = {};
    TDS_UNSETTLED_VARIANTS_.forEach(v => {
      const kg = tdsNum_(cell(s.key + '_' + v + '_kgkm'));
      const code = tdsStr_(cell(s.key + '_' + v + '_code'));
      if (kg || code) unsettled[v] = { kgkm: kg, code: code };
    });
    if (!any && !Object.keys(variants).length && !Object.keys(unsettled).length) return;
    stages[s.key] = {
      key: s.key, label: s.label, dept: s.dept,
      variants: variants, unsettled: unsettled,
      // The sum of the SETTLED variants only. r is excluded on purpose - see
      // TDS_UNSETTLED_VARIANTS_.
      totalKgKm: total || null
    };
  });

  return {
    tdsNo: no,
    standard: tdsStr_(cell('standard')),
    volt: tdsStr_(cell('volt')),
    size: tdsStr_(cell('size')),
    desc: tdsStr_(cell('dscrpt')),
    phase: {
      cores: tdsNum_(cell('ph_n_cores')),
      csaMm2: tdsNum_(cell('ph_size')),
      wires: tdsNum_(cell('ph_n_wires'))
    },
    neutral: {
      cores: tdsNum_(cell('ne_n_cores')),
      csaMm2: tdsNum_(cell('ne_size')),
      wires: tdsNum_(cell('ne_n_wires'))
    },
    stages: stages
  };
}

/** Looks one TDS up. Returns { found, matchedOn, record } - matchedOn is
 *  'exact' or 'number' so a caller (and the engineer) can see whether the
 *  revision suffix actually agreed. */
function tdsLookup_(tdsNo) {
  const idx = tdsLogRows_();
  if (idx.error) return { found: false, error: idx.error };
  const want = tdsNormNo_(tdsNo);
  if (!want) return { found: false };
  if (idx.byExact[want]) return { found: true, matchedOn: 'exact', record: idx.byExact[want] };
  const base = tdsBaseNo_(want);
  if (base && idx.byBase[base]) return { found: true, matchedOn: 'number', record: idx.byBase[base] };
  return { found: false };
}

/** Client-callable: one TDS, for display. */
function tdsLookup(tdsNo) {
  return tdsLookup_(tdsNo);
}

/** The compound type a stage uses, via the same prefix map the PDS forms use
 *  (materialTypeForCode_ in Code.js). A stage's code cell is a slash-joined
 *  list - "/XL01/MP04/CX01" is the base compound plus its masterbatches - so
 *  the first token that resolves to a known type is the compound. Every
 *  variant of a stage has been the same compound family wherever both are
 *  filled, so the first variant carrying a code is used. */
function tdsStageMaterialType_(stage) {
  if (!stage) return null;
  const keys = Object.keys(stage.variants || {});
  for (let i = 0; i < keys.length; i++) {
    const code = stage.variants[keys[i]].code;
    if (!code) continue;
    const parts = String(code).split('/');
    for (let j = 0; j < parts.length; j++) {
      const t = materialTypeForCode_(parts[j]);
      if (t) return { type: t, code: parts[j], fullCode: code, variant: keys[i] };
    }
  }
  return null;
}

/** Client-callable: a compact readout of everything the log holds for a TDS,
 *  for the reference panel in work-order mode. Stage rows are only included
 *  when the TDS actually uses that stage. */
function tdsSummaryForClient(tdsNo) {
  const hit = tdsLookup_(tdsNo);
  if (!hit.found) return { found: false, error: hit.error || null };
  const r = hit.record;
  const stages = TDS_STAGES_.map(s => r.stages[s.key]).filter(s => s && s.totalKgKm !== null)
    .map(s => ({
      key: s.key, label: s.label, dept: s.dept, totalKgKm: s.totalKgKm,
      parts: Object.keys(s.variants).map(v => ({
        label: s.variants[v].label, kgkm: s.variants[v].kgkm, code: s.variants[v].code
      })).filter(p => p.kgkm),
      unsettled: Object.keys(s.unsettled).map(v => ({
        variant: v, kgkm: s.unsettled[v].kgkm, code: s.unsettled[v].code
      })).filter(p => p.kgkm)
    }));
  return {
    found: true, matchedOn: hit.matchedOn, tdsNo: r.tdsNo,
    standard: r.standard, volt: r.volt, size: r.size, desc: r.desc,
    phase: r.phase, neutral: r.neutral, stages: stages
  };
}

/** Run from the Apps Script editor to check the log parses and to see how
 *  much of it is usable. Reports coverage rather than a sample, because the
 *  question that matters is "how many TDSs can the calculators actually
 *  resolve", not "what does row 1 look like". */
function admin_diagnoseTdsLog() {
  const idx = tdsLogRows_();
  if (idx.error) return { ok: false, error: idx.error };

  const nos = Object.keys(idx.byExact);
  const out = {
    ok: true,
    rows: idx.count,
    distinctTdsNumbers: nos.length,
    withPhaseWires: 0,
    withPhaseCsa: 0,
    withNeutral: 0,
    blankSize: 0,
    stageUsage: {},
    unsettledRUsage: {}
  };

  nos.forEach(no => {
    const r = idx.byExact[no];
    if (r.phase.wires) out.withPhaseWires += 1;
    if (r.phase.csaMm2) out.withPhaseCsa += 1;
    if (r.neutral.cores) out.withNeutral += 1;
    if (!r.size) out.blankSize += 1;
    TDS_STAGES_.forEach(s => {
      const st = r.stages[s.key];
      if (st && st.totalKgKm) out.stageUsage[s.key] = (out.stageUsage[s.key] || 0) + 1;
      if (st && Object.keys(st.unsettled).length) {
        out.unsettledRUsage[s.key] = (out.unsettledRUsage[s.key] || 0) + 1;
      }
    });
  });

  // Does the log's own conductor weight agree with CSA x density? This is the
  // check that says whether its kg/km figures can be trusted as a source.
  const checks = [];
  nos.slice(0, 40).forEach(no => {
    const r = idx.byExact[no];
    const drw = r.stages.drw;
    if (!drw || !drw.totalKgKm || !r.phase.csaMm2) return;
    const density = /^cu/i.test(r.desc) ? 8.9 : 2.7;
    const expect = (r.phase.csaMm2 * (r.phase.cores || 1)
      + (r.neutral.csaMm2 || 0) * (r.neutral.cores || 0)) * density;
    if (!expect) return;
    checks.push({ tds: no, logged: drw.totalKgKm, expected: Math.round(expect),
      deltaPct: Math.round((drw.totalKgKm / expect - 1) * 1000) / 10 });
  });
  out.conductorWeightChecks = checks;
  return out;
}

