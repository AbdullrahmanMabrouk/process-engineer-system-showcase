/* ===================================================================
 * FORMS ENGINE - unified registry, storage and session layer
 * -------------------------------------------------------------------
 * One place that answers, for EVERY form in the app (13 PDS/QC/Trials/
 * Bleeding types plus Daily Report):
 *
 *   - where does it store rows            (storage)
 *   - what fields does it render          (schema)
 *   - what is its id column / id prefix   (idColumn / idPrefix)
 *   - what does its chip caption say      (labelFields)
 *   - which field plays which SEMANTIC role for cross-form matching
 *     and search                          (roles)
 *   - how does it auto-match a record in another form  (match)
 *
 * Adding a department or a whole new form type is a registry entry plus
 * a schema - never a new render/save/draft/search code path. This is the
 * generalization of CLAUDE.md rule 3 from "PDS forms are schema-driven"
 * to "every form is schema-driven".
 *
 * WHY roles EXIST: before this, cross-form matching hardcoded field names
 * ('machine', 'desc', ...) and every department that named a field
 * differently got its own patch table bolted onto Daily Report -
 * DAILY_REPORT_PDS_TABKEY_ / _DESC_KEY_ / _MACHINE_KEY_ / _MATERIAL_KEY_ /
 * _MATERIALTYPE_KEY_ were five parallel maps that all existed for that one
 * reason, and a missing entry silently produced "no PDS found" for a record
 * that did exist (that was a real, reported CV bug - pds_cv calls its
 * machine field 'line'). Declaring the role once per form, next to the
 * schema, makes those tables unnecessary and makes the next differently
 * named field a one-line declaration instead of a sixth lookup table.
 *
 * A NOTE ON FILE LOAD ORDER: Apps Script evaluates project files in an
 * order this code does not control, so nothing here may reference
 * PDS_SCHEMAS / PDS_LIBRARIES / PDS_FILTER_FIELDS (defined in Code.js) at
 * top level. The registry is therefore built lazily on first use and
 * cached - formRegistry_() is the only entry point.
 * =================================================================== */

/** Semantic roles a form field can play. Used by matching, search and the
 *  chip caption so none of them has to know a department's field names.
 *  A form declares only the roles it genuinely has - an absent role means
 *  "this form does not track that concept" and every consumer treats it as
 *  not-comparable rather than inventing a value (CLAUDE.md rule 4). */
const FORM_ROLES_ = {
  MACHINE: 'machine',
  SIZE: 'size',
  WORK_ORDER: 'workOrder',
  CODE: 'code',
  DESC: 'desc',
  MATERIAL: 'material',
  MATERIAL_TYPE: 'materialType',
  PROCESS: 'process',
  DATE: 'date',
  NAME: 'name',
  KV: 'kv'
};

/** Per-form metadata that is NOT already expressed by PDS_SCHEMAS /
 *  PDS_LIBRARIES / PDS_FILTER_FIELDS. Kept as a small separate table
 *  (rather than edited into each schema literal) so the schemas stay pure
 *  field definitions and this stays a readable one-screen summary of how
 *  every form relates to every other one.
 *
 *  roles  - semantic role -> this form's actual field key.
 *  label  - fields whose values build the chip caption, in order; the
 *           first non-empty few are joined. Never invents a caption -
 *           a record with none of them filled falls back to 'Untitled'.
 *  title  - human name, used in the global drafts list and search results
 *           where a bare tabKey would be meaningless.
 *  dept   - owning department name, matching Config_Departments. */
const FORM_META_ = {
  pds_str: {
    title: 'PDS - Stranding', dept: 'Stranding',
    label: ['pdsCode', 'machine', 'size'],
    roles: {
      machine: 'machine', size: 'size', workOrder: 'workOrder', code: 'pdsCode',
      desc: 'desc', material: 'conductorMaterial', date: 'date', name: 'name'
    }
  },
  qc_log_str: {
    title: 'Production & Quality Log - Stranding', dept: 'Stranding',
    label: ['workOrder', 'machine', 'size'],
    roles: {
      machine: 'machine', size: 'size', workOrder: 'workOrder',
      material: 'conductorMaterial', date: 'date', name: 'name'
    }
  },
  pds_cv: {
    title: 'PDS - CV', dept: 'CV',
    label: ['pdsCode', 'line', 'size'],
    // 'line', not 'machine' - the exact mismatch that made CV's PDS lookup
    // silently fail before roles existed.
    roles: {
      machine: 'line', size: 'size', workOrder: 'workOrder', code: 'pdsCode',
      material: 'conductorMaterial', date: 'date', name: 'name', kv: 'kv'
    }
  },
  pds_extrusion: {
    title: 'PDS - Extrusion', dept: 'Extrusion',
    label: ['pdsCode', 'machine', 'size'],
    roles: {
      machine: 'machine', size: 'size', workOrder: 'workOrder', code: 'pdsCode',
      desc: 'desc', materialType: 'materialType', process: 'process',
      date: 'date', name: 'name'
    }
  },
  pds_assembly: {
    title: 'PDS - Assembly', dept: 'Assembly',
    label: ['pdsCode', 'machine', 'size'],
    // No conductor-material field in this schema at all - the material role
    // is omitted rather than pointed at a loosely related field. process and
    // kv DO exist here and are declared: without process, Assembly's
    // Machine+Size+Process match criteria could never be satisfied, which
    // admin_selfCheck caught.
    roles: {
      machine: 'machine', size: 'size', workOrder: 'workOrder', code: 'pdsCode',
      desc: 'description', process: 'process', kv: 'kv',
      date: 'date', name: 'name'
    }
  },
  pds_screening_armouring: {
    title: 'PDS - Screening & Armouring', dept: 'Screening',
    label: ['pdsCode', 'machine', 'size'],
    roles: {
      machine: 'machine', size: 'size', workOrder: 'workOrder', code: 'pdsCode',
      desc: 'description', material: 'material', process: 'process',
      date: 'date', name: 'name'
    }
  },
  head_inspection_cv: {
    title: 'Head Inspection - CV', dept: 'CV',
    label: ['machine', 'headSize', 'date'],
    roles: { machine: 'machine', date: 'date', name: 'name' }
  },
  head_inspection_extrusion: {
    title: 'Head Inspection - Extrusion', dept: 'Extrusion',
    label: ['machine', 'headSize', 'date'],
    roles: { machine: 'machine', date: 'date', name: 'name' }
  },
  bleeding_cv: {
    title: 'Bleeding Test - CV', dept: 'CV',
    label: ['machine', 'material', 'date'],
    roles: {
      machine: 'machine', material: 'material', date: 'date', name: 'name'
    }
  },
  bleeding_extrusion: {
    title: 'Bleeding Test - Extrusion', dept: 'Extrusion',
    label: ['machine', 'material', 'date'],
    roles: {
      machine: 'machine', material: 'material', date: 'date', name: 'name'
    }
  },
  trials_str: {
    title: 'Trials & Samples - Stranding', dept: 'Stranding',
    label: ['trialName', 'machine', 'size'],
    roles: { machine: 'machine', size: 'size', date: 'date', name: 'name' }
  },
  trials_cv: {
    title: 'Trials & Samples - CV', dept: 'CV',
    label: ['trialName', 'line', 'size'],
    roles: { machine: 'line', size: 'size', date: 'date', name: 'name' }
  },
  trials_extrusion: {
    title: 'Trials & Samples - Extrusion', dept: 'Extrusion',
    label: ['trialName', 'machine', 'size'],
    roles: { machine: 'machine', size: 'size', date: 'date', name: 'name' }
  },
  trials_assembly: {
    title: 'Trials & Samples - Assembly', dept: 'Assembly',
    label: ['trialName', 'machine', 'size'],
    roles: { machine: 'machine', size: 'size', date: 'date', name: 'name' }
  },
  trials_screening_armouring: {
    title: 'Trials & Samples - Screening & Armouring', dept: 'Screening',
    label: ['trialName', 'machine', 'size'],
    roles: { machine: 'machine', size: 'size', date: 'date', name: 'name' }
  }
};

/** Daily Report is not a PDS library entry, so its storage/id/roles are
 *  declared in full here. It is registered as a peer of every PDS form,
 *  which is what lets one chip strip, one drafts list, one search and one
 *  save path serve it without a single dailyReport-specific branch. */
const FORM_DAILY_REPORT_ = {
  title: 'Daily Report', dept: null, // every department has one
  idColumn: 'reportId', idPrefix: 'dr',
  perDept: true,
  label: ['date', 'machine', 'shift'],
  roles: {
    machine: 'machine', size: 'size', workOrder: 'workOrder', desc: 'desc',
    process: 'process', date: 'date', kv: 'kv'
  },
  /** Ordered auto-match strategies for resolving this report's PDS. Each
   *  strategy is a list of ROLES that must all be equal between this form's
   *  values and a candidate record in the target form; they are tried in
   *  order and the FIRST strategy that yields any candidates wins - so an
   *  exact Work-Order match beats a looser Machine+Size match, and a role
   *  the target form does not declare simply makes that strategy
   *  inapplicable rather than silently matching on fewer fields.
   *
   *  Never auto-picks between multiple candidates and never invents one:
   *  the caller shows a picker for 2+ and a manual search for 0
   *  (formResolveLink_ returns them all, ranked, and says which strategy
   *  produced them so the UI can say WHY these were offered). */
  match: {
    pds: {
      targetByDept: {
        Stranding: 'pds_str', CV: 'pds_cv', Extrusion: 'pds_extrusion',
        Assembly: 'pds_assembly', Screening: 'pds_screening_armouring',
        Armouring: 'pds_screening_armouring'
        // Drawing has no PDS schema anywhere in this app - omitted on
        // purpose so the lookup reports "unavailable" instead of searching
        // a form that does not exist.
      },
      /** The exact grounds each department matches a PDS on, set by the
       *  plant. Deliberately EXACT with no looser fallback: a department
       *  that says "machine + size + process" means those three, and
       *  quietly widening to machine+size when nothing matched is how the
       *  wrong PDS gets attached to a shift's production. No match means
       *  the operator is offered Create PDS instead.
       *
       *  Departments not listed use _default. Every role named here must be
       *  declared by BOTH the report and the target PDS schema, or the
       *  strategy is skipped as inapplicable (admin_selfCheck verifies
       *  this). */
      strategiesByDept: {
        Stranding: [['machine', 'size']],
        CV: [['machine', 'size', 'kv']],
        Extrusion: [['machine', 'size', 'process']],
        _default: [['machine', 'size', 'process']]
      }
    }
  }
};

/** Lazily built, then cached for the life of the execution. */
let FORM_REGISTRY_CACHE_ = null;

/** The single lookup every consumer goes through: formKey -> full form
 *  definition. Composes the existing PDS_SCHEMAS / PDS_LIBRARIES /
 *  PDS_FILTER_FIELDS tables with FORM_META_ rather than restating any of
 *  them, so the field definitions keep exactly one home. */
function formRegistry_() {
  if (FORM_REGISTRY_CACHE_) return FORM_REGISTRY_CACHE_;
  const reg = {};

  Object.keys(FORM_META_).forEach(formKey => {
    const meta = FORM_META_[formKey];
    const lib = PDS_LIBRARIES[formKey];
    if (!lib) return; // a meta entry with no storage is not a usable form
    reg[formKey] = {
      formKey: formKey,
      title: meta.title,
      dept: meta.dept,
      perDept: false,
      idColumn: 'recordId',
      idPrefix: formKey,
      storage: { fileName: lib.fileName, sheetName: lib.sheetName },
      schema: PDS_SCHEMAS[formKey] || null,
      filters: PDS_FILTER_FIELDS[formKey] || [],
      label: meta.label || [],
      roles: meta.roles || {},
      match: meta.match || null,
      multiPage: !!(PDS_SCHEMAS[formKey] && PDS_SCHEMAS[formKey].multiPage)
    };
  });

  reg.daily_report = {
    formKey: 'daily_report',
    title: FORM_DAILY_REPORT_.title,
    dept: FORM_DAILY_REPORT_.dept,
    perDept: true,
    idColumn: FORM_DAILY_REPORT_.idColumn,
    idPrefix: FORM_DAILY_REPORT_.idPrefix,
    storage: { fileName: DAILY_REPORT_FILE_, sheetName: DAILY_REPORT_SHEET_ },
    schema: null, // converted to a FORM_SCHEMAS entry in a later step
    filters: [],
    label: FORM_DAILY_REPORT_.label,
    roles: FORM_DAILY_REPORT_.roles,
    match: FORM_DAILY_REPORT_.match,
    multiPage: true
  };

  FORM_REGISTRY_CACHE_ = reg;
  return reg;
}

/** Throws on an unknown formKey rather than returning undefined - every
 *  caller here treats a bad key as a programming error, and a silent
 *  undefined would surface much later as an unrelated null dereference. */
function getFormDef_(formKey) {
  const def = formRegistry_()[formKey];
  if (!def) throw new Error('Unknown formKey: ' + formKey);
  return def;
}

/** Client-callable: the registry facts the client needs, without shipping
 *  the whole schema (which it fetches separately and caches). Keeps chip
 *  captions, link targets and role lookups defined in exactly one place
 *  rather than mirrored in a second client-side table that would drift. */
function formGetDef(formKey) {
  const d = formRegistry_()[formKey];
  if (!d) return null;
  return {
    formKey: d.formKey, title: d.title, dept: d.dept, perDept: d.perDept,
    idColumn: d.idColumn, idPrefix: d.idPrefix, label: d.label,
    short: formShortName_(d.formKey),
    roles: d.roles, match: d.match, multiPage: d.multiPage
  };
}

/** The sheet a form's rows live in, created on demand. Reuses the existing
 *  per-department PDS spreadsheet plumbing, so a new form gets its file and
 *  header row for free. */
function getFormSheet_(formKey) {
  const def = getFormDef_(formKey);
  const ss = getOrCreatePdsSpreadsheet_(def.storage.fileName);
  let sh = ss.getSheetByName(def.storage.sheetName);
  if (!sh) sh = ss.insertSheet(def.storage.sheetName);
  return sh;
}

/** Resolves a role to this form's field key, or null when the form does
 *  not track that concept. The one function that makes every consumer
 *  department-agnostic. */
function formRoleKey_(formKey, role) {
  const roles = getFormDef_(formKey).roles || {};
  return roles[role] || null;
}

/** Reads a role's VALUE out of a record of that form. Returns '' for a
 *  role the form does not declare - callers distinguish "no such concept"
 *  from "empty value" via formRoleKey_ when they need to. */
function formRoleValue_(formKey, record, role) {
  const key = formRoleKey_(formKey, role);
  if (!key || !record) return '';
  const v = record[key];
  return v === null || v === undefined ? '' : v;
}

/** Chip caption / drafts-list caption for a record, built from the form's
 *  declared label fields. Falls back to the form title plus a short id
 *  rather than an empty chip - an unlabelled chip is unclickable in
 *  practice because the user cannot tell which form it is. */
/** Short form name used in every chip and drafts-list caption. Derived from
 *  the formKey by rule rather than declared per form, so a new department
 *  gets a correct name automatically. */
function formShortName_(formKey) {
  if (formKey === 'daily_report') return 'DailyReport';
  if (formKey.indexOf('qc_log') === 0) return 'QCLog';
  if (formKey.indexOf('bleeding') === 0) return 'Bleeding';
  if (formKey.indexOf('trials') === 0) return 'Trials';
  if (formKey.indexOf('pds') === 0) return 'PDS';
  return formKey;
}

/** Caption for a record: Form-Line-Date, e.g. PDS-EX05-12/08.
 *
 *  Built from ROLES, not field names, so it works unchanged for CV (whose
 *  machine field is called 'line') and for any future form. The PDS code
 *  used to lead the caption, which made chips long and near-identical -
 *  every Extrusion code starts "PDSSheathing1*500Phase..." - and told the
 *  operator nothing they could distinguish at a glance. Machine and day do.
 *
 *  Missing pieces are dropped rather than rendered blank, so a form with no
 *  machine still gets a usable name instead of "PDS--12/08". */
function formLabelFor_(formKey, record) {
  const def = getFormDef_(formKey);
  const parts = [formShortName_(formKey)];

  const machine = formRoleValue_(formKey, record, 'machine');
  if (machine !== '' && machine !== null && machine !== undefined) {
    parts.push(String(machine).trim());
  }

  const rawDate = formRoleValue_(formKey, record, 'date');
  const iso = rawDate ? pdsDateStr_(rawDate) : '';
  if (iso) {
    const bits = iso.split('-'); // yyyy-MM-dd
    if (bits.length === 3) parts.push(bits[2] + '/' + bits[1]); // DD/MM
  }

  const label = parts.filter(p => p !== '').join('-');
  // Never return a bare form name with nothing to tell records apart.
  if (parts.length > 1) return label;
  const id = record && record[def.idColumn];
  return label + (id ? '-' + String(id).slice(-4) : '');
}

/* ===================================================================
 * OPEN FORMS - the cross-device "what am I working on" set
 * -------------------------------------------------------------------
 * The chip strip used to be a per-device localStorage key, so the drafts
 * themselves synced across devices but the set of forms you had OPEN did
 * not: opening the app on a phone showed an empty strip even with work in
 * progress on the desktop. This sheet is that set, keyed by UserID (the
 * stable user key from the Users sheet, not the display name that
 * enteredBy carries), so the strip is identical everywhere you sign in.
 *
 * Closing a chip removes the row here but NEVER touches the record -
 * the draft stays in its own sheet and stays listed in the global drafts
 * view, which is where you go to reopen something you dismissed.
 * =================================================================== */

const OPEN_FORMS_FILE_ = 'Forms_Session_Data';
const OPEN_FORMS_SHEET_ = 'open_forms';
const OPEN_FORMS_HEADERS_ = [
  'userId', 'formKey', 'recordId', 'label', 'deptName', 'openedAt', 'lastTouched'
];

/** Self-creating, exactly like the Sessions sheet - no manual setup step
 *  for the plant to perform before this feature works. */
function getOrCreateOpenFormsSheet_() {
  const ss = getOrCreatePdsSpreadsheet_(OPEN_FORMS_FILE_);
  let sh = ss.getSheetByName(OPEN_FORMS_SHEET_);
  if (!sh) sh = ss.insertSheet(OPEN_FORMS_SHEET_);
  if (sh.getLastRow() === 0) sh.appendRow(OPEN_FORMS_HEADERS_);
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return sh;
}

function openFormsRows_() {
  const sh = getOrCreateOpenFormsSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { sh: sh, headers: values[0] || OPEN_FORMS_HEADERS_, rows: [] };
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = {};
    headers.forEach((h, c) => { obj[h] = values[i][c]; });
    obj.__rowNum = i + 1;
    rows.push(obj);
  }
  return { sh: sh, headers: headers, rows: rows };
}

/** Client-callable: this user's open form chips, most recently touched
 *  first, so the strip's order matches what they were last doing. */
function formOpenList(userId) {
  if (!userId) return [];
  const { rows } = openFormsRows_();
  return rows
    .filter(r => String(r.userId) === String(userId))
    .sort((a, b) => (b.lastTouched || 0) - (a.lastTouched || 0))
    .map(r => ({
      formKey: r.formKey, recordId: r.recordId, label: r.label,
      deptName: r.deptName,
      lastTouched: r.lastTouched instanceof Date ? r.lastTouched.toISOString() : r.lastTouched
    }));
}

/** Client-callable: add or refresh a chip. Idempotent on
 *  (userId, recordId) - autosave calls this on every label change, so it
 *  must update in place rather than accumulate duplicate chips. */
function formOpenTouch(userId, formKey, recordId, label, deptName) {
  if (!userId || !recordId) return { ok: false, error: 'Missing userId or recordId' };
  // Fail fast on the global script lock, for the same reason the record save
  // does: this runs for every user whenever a chip caption changes, and a
  // 30-second wait here blocked every other request in the project until the
  // simultaneous-execution ceiling was hit.
  //
  // Skipping a chip-strip update is harmless - the caption refreshes on the
  // next save, and the record itself is written by a different call. Never
  // worth stalling the app for.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { ok: false, busy: true };
  try {
    const { sh, headers, rows } = openFormsRows_();
    const now = new Date();
    const existing = rows.find(r =>
      String(r.userId) === String(userId) && String(r.recordId) === String(recordId));
    if (existing) {
      const obj = Object.assign({}, existing, {
        label: label || existing.label, lastTouched: now,
        deptName: deptName || existing.deptName
      });
      delete obj.__rowNum;
      const row = headers.map(h => (h in obj ? obj[h] : ''));
      sh.getRange(existing.__rowNum, 1, 1, row.length).setValues([row]);
      return { ok: true, rowNum: existing.__rowNum };
    }
    const obj = {
      userId: userId, formKey: formKey, recordId: recordId,
      label: label || '', deptName: deptName || '', openedAt: now, lastTouched: now
    };
    sh.appendRow(headers.map(h => (h in obj ? obj[h] : '')));
    return { ok: true, rowNum: sh.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

/** Client-callable: dismiss a chip. Deletes ONLY the open-forms row -
 *  the record itself is untouched and still appears in formListAllDrafts,
 *  which is the guarantee that makes closing a chip a safe, non-destructive
 *  action the user can take freely. */
function formOpenClose(userId, recordId) {
  if (!userId || !recordId) return { ok: false, error: 'Missing userId or recordId' };
  // Same fail-fast rule as formOpenTouch. If the lock is busy the chip stays
  // in the sheet and disappears on the next successful sync; the record is
  // untouched either way, since closing never deletes anything.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { ok: false, busy: true };
  try {
    const { sh, rows } = openFormsRows_();
    const hit = rows.find(r =>
      String(r.userId) === String(userId) && String(r.recordId) === String(recordId));
    if (!hit) return { ok: true, alreadyClosed: true };
    sh.deleteRow(hit.__rowNum);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Called after a successful Submit: a finished record is no longer
 *  "in progress", so it leaves the strip automatically. Same non-
 *  destructive contract as formOpenClose - the submitted record remains
 *  fully available through search and View Data. */
function formOpenCloseSubmitted(userId, recordId) {
  return formOpenClose(userId, recordId);
}

/* ===================================================================
 * READING - one reader for every form
 * -------------------------------------------------------------------
 * pdsSheetToObjects_ (PDS-only, and unconditionally hides Drafts) and
 * Daily Report's own inline getDataRange loops are replaced by this pair,
 * so drafts, search, matching and View Data all read rows the same way
 * and a fix to blank-row/Date handling lands once.
 * =================================================================== */

/** Like pdsSheetIfExists_ but registry-driven and non-creating: returns
 *  null for a form whose spreadsheet has never been made yet. Sweeps over
 *  every form (drafts list, search) rely on this so an untouched
 *  department costs a null instead of creating an empty file as a side
 *  effect of someone running a search. */
function formSheetIfExists_(formKey) {
  const def = getFormDef_(formKey);
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'pdsFileId_' + def.storage.fileName;
  let ss = null;
  const cachedId = props.getProperty(cacheKey);
  if (cachedId) {
    try { ss = SpreadsheetApp.openById(cachedId); } catch (e) { props.deleteProperty(cacheKey); }
  }
  if (!ss) {
    const folder = DriveApp.getFolderById(PDS_FOLDER_ID);
    const files = folder.getFilesByName(def.storage.fileName);
    if (files.hasNext()) {
      const file = files.next();
      props.setProperty(cacheKey, file.getId());
      ss = SpreadsheetApp.open(file);
    }
  }
  return ss ? (ss.getSheetByName(def.storage.sheetName) || null) : null;
}

/** Every row of a form as an object, with __rowNum and __formKey attached.
 *  opts.status filters on the Status column: 'Draft', 'Submitted', or
 *  omitted for everything.
 *
 *  A blank Status means the row predates the Draft/Submitted model. Those
 *  rows are treated as Submitted - which is what they always implicitly
 *  were - so 'Submitted' includes them and 'Draft' never does. That keeps
 *  every legacy row visible and searchable without a migration having to
 *  run first (the backfill only adds ids, it does not change what is
 *  visible). */
function formReadAll_(formKey, opts) {
  opts = opts || {};
  const sh = formSheetIfExists_(formKey);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row.some(c => c !== '')) continue;
    const obj = {};
    headers.forEach((h, c) => { obj[h] = row[c]; });
    const status = String(obj.Status || '');
    if (opts.status === 'Draft' && status !== 'Draft') continue;
    if (opts.status === 'Submitted' && status === 'Draft') continue;
    obj.__rowNum = i + 1;
    obj.__formKey = formKey;
    out.push(obj);
  }
  return out;
}

/** Every formKey in the registry, for the cross-form sweeps below. */
function formAllKeys_() { return Object.keys(formRegistry_()); }

/* ===================================================================
 * GLOBAL DRAFTS - every unfinished record you own, across all forms
 * -------------------------------------------------------------------
 * The counterpart to the chip strip: the strip shows what you chose to
 * keep open, this shows EVERYTHING unfinished, including chips you closed
 * and drafts started on another device. Reopening from here is what makes
 * closing a chip safe.
 * =================================================================== */

/** Client-callable. enteredBy (the display name stored on every row) is
 *  what identifies ownership on the records themselves; userId identifies
 *  the chip strip. Both are passed so the result can mark which drafts are
 *  currently on this user's strip and which are not.
 *
 *  Sweeps every form's sheet. That is one read per distinct spreadsheet
 *  and is why this is an on-demand view rather than something loaded on
 *  every page - it is not cheap enough to sit in the app shell, and the
 *  chip strip (a single small sheet) is what serves that purpose. */
function formListAllDrafts(userId, enteredBy) {
  // This reads every form's spreadsheet, which is genuinely expensive, so the
  // result is cached briefly per user. Drafts change on the order of minutes,
  // not seconds, and the client shows its own cached copy immediately and
  // refreshes underneath - so a short server cache removes the repeated
  // full sweep without anyone seeing stale data for long. Cleared on delete.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'drafts_' + String(userId || 'anon') + '_' + String(enteredBy || 'all');
  try {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* fall through to a real read */ }

  const result = formListAllDraftsUncached_(userId, enteredBy);
  try {
    // 45s: long enough to absorb a burst of opens, short enough that a draft
    // saved on another device shows up promptly.
    cache.put(cacheKey, JSON.stringify(result), 45);
  } catch (e) { /* a result too large to cache is still returned */ }
  return result;
}

function formListAllDraftsUncached_(userId, enteredBy) {
  const openIds = {};
  if (userId) formOpenList(userId).forEach(o => { openIds[String(o.recordId)] = true; });

  // Only sweep forms this user can actually reach. Each form is a separate
  // spreadsheet read, and most people can see two or three departments out
  // of fourteen forms - reading the rest costs seconds and can never produce
  // a draft they own. Falls back to everything if the nav cannot be read,
  // so a lookup failure shows too much rather than silently hiding drafts.
  // Scope the sweep to the departments this user can reach. Reading all 14
  // form spreadsheets took long enough to hang the screen entirely.
  //
  // The earlier version of this scoping DID hide drafts, but that was not
  // the scoping's fault - the list was also filtering by owner, and an admin
  // checking on someone else's draft owns none of them. Owner filtering is
  // now explicit (admins pass no owner), so narrowing by department is safe
  // and is the difference between a usable screen and a stalled one.
  // daily_report is always included: every department has one, and it is
  // where most drafts live.
  let keys = formAllKeys_();
  if (userId) {
    try {
      const allowed = { daily_report: true };
      getUserNav_(userId).forEach(d => d.tabs.forEach(t => { allowed[t.tabKey] = true; }));
      const scoped = keys.filter(k => allowed[k]);
      if (scoped.length) keys = scoped;
    } catch (e) { /* unreadable nav: keep the full sweep rather than hide work */ }
  }

  const out = [];
  keys.forEach(formKey => {
    const def = formRegistry_()[formKey];
    let rows;
    try {
      rows = formReadAll_(formKey, { status: 'Draft' });
    } catch (e) {
      // One unreadable department must not blank the whole drafts view -
      // report it as an entry so the user sees that something is wrong
      // rather than silently missing drafts they know they have.
      out.push({ formKey: formKey, title: def.title, error: String(e.message || e) });
      return;
    }
    const wantOwner = String(enteredBy || '').trim().toLowerCase();
    rows.forEach(r => {
      // Owner match is trimmed and case-insensitive. An exact comparison
      // hid drafts whose stored name differed only by spacing or case from
      // the signed-in name - the draft was plainly in the sheet but never
      // listed, which is exactly the "my drafts are missing" report.
      const rowOwner = String(r.enteredBy || '').trim().toLowerCase();
      if (wantOwner && rowOwner && rowOwner !== wantOwner) return;
      const id = r[def.idColumn];
      if (!id) return; // a Draft with no id cannot be reopened; never fabricate one
      out.push({
        formKey: formKey,
        title: def.title,
        recordId: id,
        // Who owns it. Shown in the list so an empty-looking view is
        // explainable ("these are all someone else's") rather than
        // indistinguishable from a broken query.
        enteredBy: String(r.enteredBy || ''),
        label: formLabelFor_(formKey, r),
        deptName: def.perDept ? (r.deptName || '') : def.dept,
        lastModified: r.LastModified instanceof Date ? r.LastModified.toISOString() : (r.LastModified || ''),
        rowNum: r.__rowNum,
        onStrip: !!openIds[String(id)]
      });
    });
  });

  out.sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')));
  return out;
}

/* ===================================================================
 * SEARCH - one cross-form query
 * -------------------------------------------------------------------
 * Serves both the View Data screens and the link/auto-match picker, so
 * "find me the record I mean" behaves identically wherever it is asked.
 * Matching is role-based, which is what lets one query hit forms that
 * name their fields differently.
 * =================================================================== */

function formNorm_(v) { return String(v === null || v === undefined ? '' : v).trim().toLowerCase(); }

/** Cable sizes get written with whichever multiplication mark came to hand -
 *  "3x240+120", "3*240+120", "3 X 240 + 120" - and they all mean the same
 *  size. Compared as raw strings they do not match, which is how a work
 *  order whose PDS was already on file reported "No PDS found for these
 *  details yet" and offered to create a second one.
 *
 *  Whitespace goes too: a size is one compact token, so a space inside it
 *  is never meaningful.
 *
 *  NOT folded in here: the single-core "1x185" == "185" equivalence that
 *  dailyReportNormSize_ applies. That one changes WHICH records match
 *  rather than merely how they are spelled, so it stays where it is. */
function formNormSize_(v) {
  return formNorm_(v).replace(/\s+/g, '').replace(/[*\u00d7]/g, 'x');
}

/** Role-aware normalisation for MATCHING. Every place that compares a role
 *  value goes through this, so size equivalence cannot be right in one
 *  matcher and wrong in another. */
function formNormRole_(role, v) {
  return role === 'size' ? formNormSize_(v) : formNorm_(v);
}

/** query: {
 *    formKeys: [..]        restrict to these forms (default: all)
 *    dept: 'CV'            restrict to one department
 *    roles: {machine:'..'} role -> required value (exact, case-insensitive)
 *    text: 'free text'     substring match against the form's label fields
 *    dateFrom/dateTo       'yyyy-MM-dd' against the form's date role
 *    status: 'Submitted'   defaults to Submitted (finished records only)
 *    limit: 50
 *  }
 *  A role the target form does not declare makes that form ineligible for
 *  a roles-constrained search rather than matching it on fewer conditions
 *  - loosening a query silently is how the old matcher returned confidently
 *  wrong PDS records. */
function formSearch(query) {
  query = query || {};
  const keys = (query.formKeys && query.formKeys.length) ? query.formKeys : formAllKeys_();
  const wantRoles = query.roles || {};
  const roleNames = Object.keys(wantRoles).filter(r => formNorm_(wantRoles[r]) !== '');
  const text = formNorm_(query.text);
  const limit = query.limit || 50;
  const status = query.status === undefined ? 'Submitted' : query.status;

  const results = [];
  keys.forEach(formKey => {
    const def = formRegistry_()[formKey];
    if (!def) return;
    if (query.dept && !def.perDept && def.dept !== query.dept) return;

    // Ineligible if the form cannot express every constrained role.
    for (let i = 0; i < roleNames.length; i++) {
      if (!formRoleKey_(formKey, roleNames[i])) return;
    }

    let rows;
    try { rows = formReadAll_(formKey, { status: status }); } catch (e) { return; }

    rows.forEach(r => {
      if (query.dept && def.perDept && String(r.deptName || '') !== query.dept) return;
      for (let i = 0; i < roleNames.length; i++) {
        const role = roleNames[i];
        if (formNormRole_(role, formRoleValue_(formKey, r, role)) !== formNormRole_(role, wantRoles[role])) return;
      }
      if (query.dateFrom || query.dateTo) {
        const dKey = formRoleKey_(formKey, 'date');
        if (!dKey) return;
        const d = pdsDateStr_(r[dKey]);
        if (!d) return;
        if (query.dateFrom && d < query.dateFrom) return;
        if (query.dateTo && d > query.dateTo) return;
      }
      const label = formLabelFor_(formKey, r);
      if (text && formNorm_(label).indexOf(text) === -1) return;

      results.push({
        formKey: formKey,
        title: def.title,
        recordId: r[def.idColumn] || '',
        rowNum: r.__rowNum,
        label: label,
        // The bare identifying code, separate from the composite label. A
        // caller filling a "PDS No." field wants the code alone; the label
        // is for showing a human which record it is.
        code: String(formRoleValue_(formKey, r, 'code') || ''),
        deptName: def.perDept ? (r.deptName || '') : def.dept,
        enteredBy: r.enteredBy || '',
        lastModified: r.LastModified instanceof Date ? r.LastModified.toISOString() : (r.LastModified || '')
      });
    });
  });

  results.sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')));
  return { total: results.length, results: results.slice(0, limit) };
}

/* ===================================================================
 * LINK RESOLUTION - schema-declared auto-match, never a guess
 * -------------------------------------------------------------------
 * Replaces dailyReportFindPds's hardcoded machine/size/code logic and the
 * five per-department key tables that grew around it. The criteria come
 * from the source form's own match declaration, so tuning which fields a
 * department matches on is a schema edit.
 * =================================================================== */

/** sourceFormKey  - the form doing the looking (e.g. 'daily_report')
 *  linkName       - which declared link ('pds')
 *  values         - the source form's current values, keyed by ROLE
 *  deptName       - the source record's department, picking the target form
 *
 *  Returns { available, targetFormKey, strategy, candidates:[...] }.
 *  - available:false means this department genuinely has no target form
 *    (Drawing has no PDS anywhere in the app) - the UI says so instead of
 *    showing an empty search.
 *  - exactly one candidate: the caller auto-fills it.
 *  - two or more: the caller shows a picker. This function deliberately
 *    does NOT break the tie; picking the newest is how a wrong PDS gets
 *    silently attached to a shift's production.
 *  - zero: the caller offers manual search. */
function formResolveLink(sourceFormKey, linkName, values, deptName) {
  const def = getFormDef_(sourceFormKey);
  const link = def.match && def.match[linkName];
  if (!link) return { available: false, reason: 'No ' + linkName + ' link declared for ' + sourceFormKey };

  const targetFormKey = link.targetByDept ? link.targetByDept[deptName] : link.target;
  if (!targetFormKey) {
    return {
      available: false,
      reason: 'No ' + linkName + ' form exists for ' + (deptName || 'this department')
    };
  }

  values = values || {};
  // Per-department criteria when declared, otherwise the link's own list.
  const strategies = link.strategiesByDept
    ? (link.strategiesByDept[deptName] || link.strategiesByDept._default || [])
    : (link.strategies || []);

  const tried = [];
  for (let i = 0; i < strategies.length; i++) {
    const roles = strategies[i];

    // Every role in the strategy must be expressible by the TARGET form
    // and actually filled in on the SOURCE - otherwise this strategy would
    // silently degrade into a broader match than it claims to be.
    const usable = roles.every(role =>
      formRoleKey_(targetFormKey, role) && formNorm_(values[role]) !== '');
    if (!usable) { tried.push({ roles: roles, skipped: true }); continue; }

    const roleQuery = {};
    roles.forEach(role => { roleQuery[role] = values[role]; });
    const found = formSearch({
      formKeys: [targetFormKey], roles: roleQuery, status: 'Submitted', limit: 25
    });
    tried.push({ roles: roles, count: found.total });
    if (found.total > 0) {
      return {
        available: true, targetFormKey: targetFormKey,
        strategy: roles, tried: tried, candidates: found.results
      };
    }
  }

  return {
    available: true, targetFormKey: targetFormKey,
    strategy: null, tried: tried, candidates: []
  };
}

/** Client-callable wrapper. Kept separate from formResolveLink so the
 *  internal function stays usable from other server code without the
 *  client's argument shape leaking into it. */
function formFindLinkCandidates(sourceFormKey, linkName, values, deptName) {
  try {
    return formResolveLink(sourceFormKey, linkName, values, deptName);
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

/* ===================================================================
 * BACKFILL - give pre-existing rows an identity
 * -------------------------------------------------------------------
 * Every row written before the Draft/Submitted id model has a blank
 * recordId/reportId, Status and Version. Such a row is visible and
 * searchable (blank Status reads as Submitted) but cannot be OPENED,
 * EDITED or LINKED TO, because every one of those paths addresses a
 * record by its id. This pass gives each one an id, marks it Submitted
 * and stamps Version 1, which is the whole of what "keep old rows
 * readable" requires.
 *
 * Deliberately conservative:
 *   - only ever fills BLANK cells; an existing id/Status/Version is
 *     never rewritten, so re-running is safe and cannot disturb rows the
 *     new system already owns
 *   - no other column is touched, so no data can be reinterpreted or lost
 *   - dryRun (the default) reports exactly what would change and writes
 *     nothing
 *
 * Run from the Apps Script editor, same convention as every other
 * maintenance entry point here. Start with admin_backfillFormIds() to see
 * the report, then admin_backfillFormIds(false) to apply.
 * =================================================================== */

/** Ids minted for legacy rows are marked 'lg' so a row that predates the
 *  new system stays identifiable forever - useful when a future question
 *  is "was this entered through the old form or the new one". */
function formLegacyId_(formKey, rowNum) {
  return getFormDef_(formKey).idPrefix + '_lg' + rowNum + '_' + Utilities.getUuid().slice(0, 6);
}

/** Client-callable: permanently delete one of this user's own unfinished
 *  drafts, for ANY form type. One function rather than a per-family
 *  variant, since the registry already knows each form's sheet and id
 *  column.
 *
 *  Three guards, all re-checked HERE rather than trusted from the client:
 *  the row must exist, it must still be a Draft (a submitted record is a
 *  real record and is never deleted by this path), and it must belong to
 *  the person asking. The client's own confirm dialog is a courtesy; this
 *  is the actual rule.
 *
 *  Also clears the draft off every device's chip strip, so deleting on one
 *  device does not leave a chip elsewhere pointing at a row that no longer
 *  exists. */
function formDeleteDraft(formKey, recordId, enteredBy, userId) {
  if (!recordId) return { ok: false, error: 'Missing recordId' };
  let def;
  try { def = getFormDef_(formKey); } catch (e) { return { ok: false, error: String(e.message || e) }; }

  const sh = formSheetIfExists_(formKey);
  if (!sh) return { ok: false, error: 'No data file for ' + def.title + ' yet.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return { ok: false, error: 'Draft not found (it may already be deleted).' };
    const headers = values[0];
    const idIdx = headers.indexOf(def.idColumn);
    const statusIdx = headers.indexOf('Status');
    const enteredByIdx = headers.indexOf('enteredBy');
    if (idIdx === -1) return { ok: false, error: 'This sheet has no ' + def.idColumn + ' column.' };

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idIdx]) !== String(recordId)) continue;
      if (statusIdx > -1 && String(values[i][statusIdx]) !== 'Draft') {
        return { ok: false, error: 'Only unfinished drafts can be deleted here - this one has been submitted.' };
      }
      if (enteredByIdx > -1 && String(values[i][enteredByIdx]) !== String(enteredBy)) {
        return { ok: false, error: 'You can only delete your own drafts.' };
      }
      sh.deleteRow(i + 1);
      if (userId) { try { formOpenClose(userId, recordId); } catch (e) {} }
      // The cached drafts list would otherwise keep showing this for up to
      // its TTL, so a delete would look like it failed.
      try { CacheService.getScriptCache().removeAll([
        'drafts_' + String(userId || 'anon') + '_' + String(enteredBy || 'all'),
        'drafts_' + String(userId || 'anon') + '_all'
      ]); } catch (e) {}
      return { ok: true };
    }
    return { ok: false, error: 'Draft not found (it may already be deleted).' };
  } finally {
    lock.releaseLock();
  }
}

/** Corrects Shift III reports that were dated to the evening they started
 *  instead of the morning they end.
 *
 *  Shift III runs 23:00-07:30. Reports written after midnight already carry
 *  the right date, so ONLY the pre-midnight ones move forward a day. The
 *  test is deliberately narrow - shift III, created at 23:00 or later, and
 *  the stored date still equal to the creation date - so a report whose date
 *  was already corrected by hand is left alone and re-running is harmless.
 *
 *  Dry run by default. admin_fixShiftIIIDatesApply() actually writes (the
 *  editor's Run button cannot pass arguments). */
function admin_fixShiftIIIDatesApply() {
  return admin_fixShiftIIIDates(false);
}

function admin_fixShiftIIIDates(apply) {
  const dryRun = (apply !== false);
  const sh = formSheetIfExists_('daily_report');
  if (!sh) return { ok: false, error: 'No Daily Report sheet' };
  const tz = Session.getScriptTimeZone();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, changed: 0 };

  const headers = values[0];
  const iShift = headers.indexOf('shift');
  const iDate = headers.indexOf('date');
  const iTs = headers.indexOf('Timestamp');
  const iId = headers.indexOf('reportId');
  if (iShift === -1 || iDate === -1 || iTs === -1) {
    return { ok: false, error: 'Missing shift/date/Timestamp column' };
  }

  const changes = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[iShift] || '').trim().toUpperCase() !== 'III') continue;
    const ts = row[iTs];
    if (!(ts instanceof Date)) continue;
    if (ts.getHours() < 23) continue; // written after midnight: already right

    const stored = pdsDateStr_(row[iDate]);
    const created = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
    if (!stored || stored !== created) continue; // already corrected by hand

    const next = new Date(ts.getTime());
    next.setDate(next.getDate() + 1);
    const corrected = Utilities.formatDate(next, tz, 'yyyy-MM-dd');
    changes.push({
      rowNum: i + 1,
      reportId: iId > -1 ? String(row[iId] || '') : '',
      from: stored, to: corrected
    });
    if (!dryRun) {
      // Written as a plain string, matching how the form stores dates - a
      // Date object here would be reformatted by the column and reintroduce
      // the timezone drift this is fixing.
      sh.getRange(i + 1, iDate + 1).setValue(corrected);
    }
  }

  const result = { ok: true, dryRun: dryRun, changed: changes.length, changes: changes.slice(0, 40) };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Repairs Version columns that Sheets has reinterpreted as dates.
 *
 *  A row whose Version cell reads as a date can never match the version the
 *  client holds, so it refuses every save. This rewrites the whole column as
 *  plain integers and pins its number format so it cannot happen again.
 *  A damaged cell is reset to 1 - the true count is unrecoverable and
 *  irrelevant; what matters is that it is a comparable number again.
 *
 *  Run with no arguments to repair every form. Read-then-write, and it only
 *  touches the Version column. */
function admin_repairVersionColumns(onlyFormKey) {
  const report = { forms: [], totalRepaired: 0 };
  const keys = onlyFormKey ? [onlyFormKey] : formAllKeys_();
  keys.forEach(formKey => {
    const sh = formSheetIfExists_(formKey);
    if (!sh) { report.forms.push({ formKey: formKey, skipped: 'no sheet' }); return; }
    const values = sh.getDataRange().getValues();
    if (values.length < 2) { report.forms.push({ formKey: formKey, rows: 0 }); return; }
    const headers = values[0];
    const verIdx = headers.indexOf('Version');
    if (verIdx === -1) { report.forms.push({ formKey: formKey, skipped: 'no Version column' }); return; }

    const col = [];
    let repaired = 0;
    for (let i = 1; i < values.length; i++) {
      const raw = values[i][verIdx];
      const isBlankRow = !values[i].some(c => c !== '');
      if (isBlankRow) { col.push(['']); continue; }
      const n = versionNumberOrNull_(raw);
      if (n === null) { col.push([1]); repaired++; }
      else col.push([n]);
    }
    if (col.length) {
      const range = sh.getRange(2, verIdx + 1, col.length, 1);
      range.setNumberFormat('0');
      range.setValues(col);
    }
    report.forms.push({ formKey: formKey, rows: col.length, repaired: repaired });
    report.totalRepaired += repaired;
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Ground truth for "did my save actually land?".
 *
 *  Run from the Apps Script editor. Reports the most recently touched rows
 *  of a form's sheet with the four columns that answer the question:
 *  recordId (which record), Status, LastModified (stamped on EVERY save, so
 *  blank means no save has ever hit this row) and Version (increments per
 *  save, so 1 means backfill-only).
 *
 *  Exists because the UI's own "Saved" feedback cannot be trusted as
 *  evidence - a previous data-loss incident here was only pinned down by
 *  reading the sheet directly rather than believing the client. */
function admin_diagnoseSaves(formKey, howMany) {
  formKey = formKey || 'pds_extrusion';
  howMany = howMany || 8;
  const sh = formSheetIfExists_(formKey);
  if (!sh) return { ok: false, error: 'No sheet for ' + formKey };
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, rows: [], note: 'sheet is empty' };
  const headers = values[0];
  const idx = h => headers.indexOf(h);
  const def = getFormDef_(formKey);
  const iId = idx(def.idColumn), iStatus = idx('Status'),
    iLM = idx('LastModified'), iVer = idx('Version'), iCode = idx('pdsCode');

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i].some(c => c !== '')) continue;
    rows.push({
      rowNum: i + 1,
      recordId: iId > -1 ? String(values[i][iId] || '') : '(no id column)',
      code: iCode > -1 ? String(values[i][iCode] || '') : '',
      status: iStatus > -1 ? String(values[i][iStatus] || '') : '',
      lastModified: iLM > -1 && values[i][iLM] ? String(values[i][iLM]) : '(never saved)',
      version: iVer > -1 ? String(values[i][iVer] || '') : ''
    });
  }
  // Newest-touched first, then the physically last rows - a duplicate
  // created by a bad save would appear at the bottom of the sheet.
  const everSaved = rows.filter(r => r.lastModified !== '(never saved)');
  const result = {
    ok: true,
    formKey: formKey,
    totalRows: rows.length,
    rowsEverSaved: everSaved.length,
    mostRecentlySaved: everSaved.slice(-howMany),
    lastRowsInSheet: rows.slice(-howMany)
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* ===================================================================
 * SELF-CHECK - catch registry drift before a user does
 * -------------------------------------------------------------------
 * The forms engine spreads one form's definition across several tables
 * (FORM_META_, PDS_LIBRARIES, PDS_SCHEMAS, PDS_FILTER_FIELDS, and the
 * client's FORMS_ENGINE_TABKEYS_/FORM_RPC_). Any one of them can be
 * edited without the others, and the result is usually silent: a role
 * pointing at a field that no longer exists does not throw, it just
 * quietly stops matching - exactly the class of failure that produced
 * the "no PDS found" bug for CV.
 *
 * Run admin_selfCheck() from the editor after ANY schema or registry
 * edit. It reads only - it never writes - so it is safe to run at any
 * time, and returns a list of problems with an empty list meaning
 * everything lines up.
 * =================================================================== */
function admin_selfCheck() {
  const problems = [];
  const note = (formKey, msg) => problems.push(formKey + ': ' + msg);

  Object.keys(FORM_META_).forEach(formKey => {
    const meta = FORM_META_[formKey];
    if (!PDS_LIBRARIES[formKey]) note(formKey, 'has FORM_META_ but no PDS_LIBRARIES storage entry');
    const schema = PDS_SCHEMAS[formKey];
    if (!schema) { note(formKey, 'has FORM_META_ but no PDS_SCHEMAS entry'); return; }

    const headerKeys = {};
    (schema.header || []).forEach(f => { headerKeys[f.key] = true; });

    // A role must point at a field the schema actually has, or every
    // cross-form match and search using that role silently does nothing.
    Object.keys(meta.roles || {}).forEach(role => {
      const key = meta.roles[role];
      if (!headerKeys[key]) {
        note(formKey, 'role "' + role + '" points at "' + key + '", which is not a header field');
      }
    });

    // Label fields build the chip caption; a stale one degrades captions
    // to "Untitled" without any error.
    (meta.label || []).forEach(key => {
      if (!headerKeys[key]) note(formKey, 'label field "' + key + '" is not a header field');
    });

    (PDS_FILTER_FIELDS[formKey] || []).forEach(key => {
      // enteredBy is a stored column rather than a schema field - expected.
      if (key === 'enteredBy') return;
      if (!headerKeys[key]) note(formKey, 'filter field "' + key + '" is not a header field');
    });
  });

  // Link targets must exist as real forms, or the picker offers a search
  // against nothing.
  Object.keys(formRegistry_()).forEach(formKey => {
    const def = formRegistry_()[formKey];
    if (!def.match) return;
    Object.keys(def.match).forEach(linkName => {
      const link = def.match[linkName];
      const targets = link.targetByDept ? Object.keys(link.targetByDept).map(d => link.targetByDept[d]) : [link.target];
      targets.forEach(t => {
        if (t && !formRegistry_()[t]) note(formKey, 'link "' + linkName + '" targets unknown form "' + t + '"');
      });
      // Validate every strategy list, however it is declared.
      let allStrategies = (link.strategies || []).slice();
      if (link.strategiesByDept) {
        Object.keys(link.strategiesByDept).forEach(d => {
          allStrategies = allStrategies.concat(link.strategiesByDept[d]);
        });
      }
      const known = ['machine', 'size', 'workOrder', 'code', 'desc', 'material',
        'materialType', 'process', 'date', 'name', 'kv'];
      allStrategies.forEach(roles => {
        roles.forEach(role => {
          if (known.indexOf(role) === -1) {
            note(formKey, 'link "' + linkName + '" uses unknown role "' + role + '"');
          }
        });
      });
      // Every department's criteria must be expressible by ITS target form,
      // or that department can never match anything.
      if (link.strategiesByDept && link.targetByDept) {
        Object.keys(link.targetByDept).forEach(dept => {
          const target = link.targetByDept[dept];
          const list = link.strategiesByDept[dept] || link.strategiesByDept._default || [];
          list.forEach(roles => roles.forEach(role => {
            if (target && formRegistry_()[target] && !formRoleKey_(target, role)) {
              note(formKey, dept + ' matches on "' + role + '", which ' + target + ' does not declare');
            }
          }));
        });
      }
    });
  });

  const result = { ok: problems.length === 0, problems: problems, formsChecked: Object.keys(FORM_META_).length };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** APPLY mode, as a zero-argument function.
 *
 *  The Apps Script editor's Run button cannot pass arguments, so
 *  admin_backfillFormIds() run from the dropdown is ALWAYS a dry run - it
 *  reports what it would fill and writes nothing. That made the apply path
 *  unreachable from the only interface available here, which is a design
 *  fault in the function rather than a limitation to work around. Run THIS
 *  one to actually write.
 *
 *  Safe to run repeatedly: the pass only ever fills blank cells and skips
 *  Drafts entirely, so a second run reports 0 filled rather than changing
 *  anything a second time. */
function admin_backfillFormIdsApply() {
  return admin_backfillFormIds(false);
}

function admin_backfillFormIds(apply, onlyFormKey) {
  const dryRun = (apply !== false); // default is a dry run
  const report = { dryRun: dryRun, forms: [], totalFilled: 0, totalRows: 0 };

  const keys = onlyFormKey ? [onlyFormKey] : formAllKeys_();
  keys.forEach(formKey => {
    const def = getFormDef_(formKey);
    const sh = formSheetIfExists_(formKey);
    if (!sh) { report.forms.push({ formKey: formKey, skipped: 'no spreadsheet yet' }); return; }

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const values = sh.getDataRange().getValues();
      if (values.length < 2) { report.forms.push({ formKey: formKey, rows: 0, filled: 0 }); return; }

      let headers = values[0].slice();
      // The three columns the new model needs. Appending a header is the
      // same auto-extend genericUpsertRow_ already performs, so this adds
      // nothing the ordinary save path would not have added anyway.
      ['Status', 'Version', def.idColumn].forEach(h => {
        if (headers.indexOf(h) === -1) headers.push(h);
      });
      const idIdx = headers.indexOf(def.idColumn);
      const statusIdx = headers.indexOf('Status');
      const verIdx = headers.indexOf('Version');

      let filled = 0, scanned = 0;
      const samples = [];
      const width = headers.length;
      const out = [];
      for (let i = 1; i < values.length; i++) {
        const row = values[i].slice();
        while (row.length < width) row.push('');
        if (!row.some(c => c !== '')) { out.push(row); continue; }
        scanned++;

        // A Draft is live work owned by the new system already - leave it
        // entirely alone, including its id.
        if (String(row[statusIdx] || '') === 'Draft') { out.push(row); continue; }

        let touched = false;
        if (String(row[idIdx] || '') === '') {
          row[idIdx] = formLegacyId_(formKey, i + 1);
          touched = true;
        }
        if (String(row[statusIdx] || '') === '') { row[statusIdx] = 'Submitted'; touched = true; }
        if (String(row[verIdx] || '') === '') { row[verIdx] = 1; touched = true; }
        if (touched) {
          filled++;
          if (samples.length < 3) samples.push({ rowNum: i + 1, recordId: row[idIdx] });
        }
        out.push(row);
      }

      if (!dryRun && filled > 0) {
        sh.getRange(1, 1, 1, width).setValues([headers]);
        if (out.length) sh.getRange(2, 1, out.length, width).setValues(out);
      }
      report.forms.push({ formKey: formKey, rows: scanned, filled: filled, samples: samples });
      report.totalFilled += filled;
      report.totalRows += scanned;
    } finally {
      lock.releaseLock();
    }
  });

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}


/** =====================================================================
 *  IN-PROGRESS STRIP -> EDGE
 *  =====================================================================
 *  Copies the open_forms sheet into D1 once, so nobody's in-progress
 *  chips disappear the moment the strip starts reading from there.
 *
 *  Run ONCE. After this the edge owns the strip: formOpenTouch and
 *  formOpenClose write there directly, and re-running would resurrect
 *  chips somebody has since closed.
 *
 *  Merges rather than replaces, so a chip opened since the cutover
 *  survives being seeded over.
 */
function admin_seedOpenFormsToEdge() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('CRDB_PROXY_URL');
  const token = props.getProperty('CRDB_PROXY_TOKEN');
  if (!url || !token) return { ok: false, error: 'Proxy properties missing.' };

  const before = crdbProxyFetch_(url, token, 'openFormsCount', []);
  const existing = (before.ok && before.rows && before.rows[0]) ? Number(before.rows[0].n) : 0;

  const { rows } = openFormsRows_();
  const iso = function (v) {
    if (!v) return '';
    if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
    return String(v);
  };
  const payload = rows.map(function (r) {
    return {
      u: String(r.userId || ''), r: String(r.recordId || ''),
      f: String(r.formKey || ''), l: String(r.label || ''),
      d: String(r.deptName || ''),
      o: iso(r.openedAt), t: iso(r.lastTouched)
    };
  }).filter(function (x) { return x.u && x.r; });

  let wrote = 0;
  for (var i = 0; i < payload.length; i += 300) {
    var chunk = payload.slice(i, i + 300);
    var resp = crdbProxyFetch_(url, token, 'openFormsBulk', [JSON.stringify(chunk)]);
    if (resp.ok) wrote += chunk.length;
    else return { ok: false, error: 'Chunk ' + i + ': ' + resp.error, seeded: wrote };
  }

  const after = crdbProxyFetch_(url, token, 'openFormsCount', []);
  const result = {
    ok: true,
    sheetRows: rows.length,
    seeded: wrote,
    edgeCountBefore: existing,
    edgeCountAfter: (after.ok && after.rows && after.rows[0]) ? Number(after.rows[0].n) : null,
    note: 'Run once. After this the edge owns the strip - re-running would resurrect chips that have since been closed.'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
