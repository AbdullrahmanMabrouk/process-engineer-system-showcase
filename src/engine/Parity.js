/** Server functions the rebuilt client calls that only ever existed on the
 *  edge.
 *
 *  The client in index.html is now the same file the Cloudflare front door
 *  serves, so it calls everything that front door offered. Four of those had
 *  no Apps Script counterpart. Without them those screens throw
 *  "is not a function" at the operator with nothing to act on.
 *
 *  Two different answers here, on purpose:
 *
 *   - The field-option admin is implemented for real. It governs which
 *     values PDS dropdowns offer, so leaving it dead would change what the
 *     forms do, not merely which screens open.
 *
 *   - Productivity machine pairing and the TDS upload answer honestly that
 *     they are not here. They are Management screens with no bearing on PDS,
 *     the Daily Report or Trials, and a half-built version of either would
 *     be worse than a clear "not on this deployment".
 */

/** Where a hidden option is remembered. Sheet-backed to match how every
 *  other admin setting in this script is stored - the edge keeps the same
 *  thing in a hidden_options table. */
const HIDDEN_OPTIONS_SHEET_ = 'Config_HiddenOptions';

function getOrCreateHiddenOptionsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(HIDDEN_OPTIONS_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(HIDDEN_OPTIONS_SHEET_);
    sh.appendRow(['TabKey', 'FieldKey', 'ValueLc', 'Value', 'HiddenBy', 'HiddenAt']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function parityStr_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

/** Every value this field has been given, with how many records use it.
 *
 *  Mirrors nativeAdminGetFieldOptions on the edge, including the part that
 *  matters most: a value declared in the schema can never be hidden, and a
 *  value that records already use reports the count so nobody hides
 *  something ninety records depend on because the spelling looked odd.
 *
 *  Hiding never rewrites a record. It stops the value being OFFERED. */
function adminGetFieldOptions(tabKey, fieldKey) {
  tabKey = parityStr_(tabKey);
  fieldKey = parityStr_(fieldKey);
  if (!tabKey || !fieldKey) return { ok: false, error: 'tabKey and fieldKey are required' };

  try {
    const schema = PDS_SCHEMAS[tabKey];
    if (!schema) return { ok: false, error: 'No PDS schema for ' + tabKey };

    let declared = [];
    (schema.header || []).forEach(f => {
      if (f && f.key === fieldKey && Object.prototype.toString.call(f.options) === '[object Array]') {
        declared = f.options;
      }
    });

    const counts = {};
    const spelling = {};
    const rows = pdsSheetToObjects_(tabKey) || [];
    rows.forEach(r => {
      const v = parityStr_(r[fieldKey]);
      if (!v) return;
      const k = v.toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
      if (!(k in spelling)) spelling[k] = v;
    });

    const hidden = {};
    const hs = getOrCreateHiddenOptionsSheet_().getDataRange().getValues();
    for (let i = 1; i < hs.length; i++) {
      if (parityStr_(hs[i][0]) !== tabKey || parityStr_(hs[i][1]) !== fieldKey) continue;
      hidden[parityStr_(hs[i][2])] = { by: parityStr_(hs[i][4]), at: parityStr_(hs[i][5]) };
    }

    const out = [];
    const seen = {};
    declared.forEach(o => {
      const k = parityStr_(o).toLowerCase();
      seen[k] = true;
      out.push({
        value: o, usedBy: counts[k] || 0, source: 'schema',
        hidden: false, canHide: false
      });
    });
    Object.keys(counts).forEach(k => {
      if (seen[k]) return;
      const h = hidden[k];
      out.push({
        value: spelling[k], usedBy: counts[k], source: 'entered',
        hidden: !!h, canHide: true,
        hiddenBy: h ? h.by : '', hiddenAt: h ? h.at : ''
      });
    });
    // A value that is hidden and no longer used by anything still has to be
    // listed, or it could never be un-hidden.
    Object.keys(hidden).forEach(k => {
      if (seen[k] || counts[k]) return;
      out.push({
        value: k, usedBy: 0, source: 'entered', hidden: true, canHide: true,
        hiddenBy: hidden[k].by, hiddenAt: hidden[k].at
      });
    });

    out.sort((a, b) => (b.usedBy - a.usedBy)
      || String(a.value).toLowerCase().localeCompare(String(b.value).toLowerCase()));
    return { ok: true, options: out };
  } catch (e) {
    return { ok: false, error: (e && (e.message || String(e))) || 'Could not read the values.' };
  }
}

/** Hides or un-hides one entered value. */
function adminSetFieldOptionHidden(tabKey, fieldKey, value, hidden, byName) {
  tabKey = parityStr_(tabKey);
  fieldKey = parityStr_(fieldKey);
  const val = parityStr_(value);
  if (!tabKey || !fieldKey || !val) return { ok: false, error: 'tabKey, fieldKey and value are required' };

  try {
    // A schema value is part of the form's definition. Hiding one here would
    // put the sheet and the schema into disagreement about what the form
    // offers, so it is refused rather than half-applied.
    const schema = PDS_SCHEMAS[tabKey];
    let declared = [];
    ((schema && schema.header) || []).forEach(f => {
      if (f && f.key === fieldKey && Object.prototype.toString.call(f.options) === '[object Array]') {
        declared = f.options;
      }
    });
    const lc = val.toLowerCase();
    let isDeclared = false;
    declared.forEach(o => { if (parityStr_(o).toLowerCase() === lc) isDeclared = true; });
    if (isDeclared) {
      return { ok: false, error: 'That value is part of the form definition and cannot be hidden here.' };
    }

    const sh = getOrCreateHiddenOptionsSheet_();
    const values = sh.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < values.length; i++) {
      if (parityStr_(values[i][0]) === tabKey && parityStr_(values[i][1]) === fieldKey
          && parityStr_(values[i][2]) === lc) { row = i + 1; break; }
    }
    if (hidden) {
      const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
      if (row > 0) sh.getRange(row, 1, 1, 6).setValues([[tabKey, fieldKey, lc, val, parityStr_(byName), stamp]]);
      else sh.appendRow([tabKey, fieldKey, lc, val, parityStr_(byName), stamp]);
    } else if (row > 0) {
      sh.deleteRow(row);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && (e.message || String(e))) || 'Could not save that.' };
  }
}

/** Which machines ran which department's work.
 *
 *  Answered as "not known here" rather than guessed. The pairing is derived
 *  from run data on the edge, and the client is built to fall back to the
 *  full machine list when this comes back empty - so the Machine dropdown
 *  simply stays unfiltered, which is correct rather than merely harmless.
 *  Inventing a pairing from machine names would filter runs out of a report
 *  on the strength of a guess. */
function productivityMachineDepts() {
  return { ok: true, byDept: {} };
}

/** The TDS store lives only on the new system. Answering with zeroes lets
 *  the screen render its "nothing stored yet" state instead of an error. */
function tdsStats() {
  return {
    ok: true, rows: 0, tds: 0, files: 0, writesPerRow: 1,
    note: 'The TDS store is on the new system; this deployment cannot read it.'
  };
}

/** Refused outright rather than half-implemented: an import that wrote TDS
 *  rows into a sheet here would create a second, diverging copy of data the
 *  target calculations read from the edge. */
function tdsUploadRows(rows, files) {
  return {
    ok: false,
    error: 'The TDS import runs only on the new system. Nothing was uploaded.'
  };
}
