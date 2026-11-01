/* ===================================================================
 * TARGET-ENGINE PARITY HARNESS - excerpt
 * -------------------------------------------------------------------
 * EXCERPT NOTICE
 * Verbatim from the live gateway repo apart from the test fixtures:
 * machine codes and equipment capability figures are replaced with the
 * synthetic set used elsewhere in this showcase. The method is the real
 * thing. It will not run here - it wants both engines' source files.
 * -------------------------------------------------------------------
 *
 * WHY THIS EXISTS
 *
 * The target-time formulas exist twice: once in the Apps Script source
 * (Targets.js, shipped in full under src/engine/) and once inside the
 * Worker, because the edge has to answer without a round trip. They are
 * lifted programmatically, never retyped.
 *
 * Duplication is normally the bug. Here the duplication is forced - the
 * formulas are synchronous closures and D1 reads are not - so the bug to
 * guard against is DRIFT. And drift in this particular code does not
 * crash. It produces a plausible wrong figure, which a supervisor then
 * schedules a shift against. Nobody finds out from a stack trace.
 *
 * So: feed both engines the same tables and the same inputs, and diff
 * every intermediate step, not just the total.
 *
 * THE LINE THAT MATTERS
 *
 *     Fails if coverage is zero: two earlier parity runs in this project
 *     reported "identical" while both engines were returning null for
 *     everything.
 *
 * That is the lesson, and it was learned the expensive way. A comparison
 * harness that cannot distinguish "both correct" from "both broken" is
 * not a test, it is a green light wired to nothing. Any diff-based check
 * needs an assertion that it actually compared something.
 *
 * See docs/parity-harness.md for the full write-up.
 * =================================================================== */

/* Runs the SAME screening/armouring cases through BOTH engines - the Apps
 * Script Targets.js and the Worker's ported copy - and diffs every step.
 *
 * Fails if coverage is zero: two earlier parity runs in this project reported
 * "identical" while both engines were returning null for everything.
 */
const fs = require('fs');
const path = require('path');

// Both repos are expected as siblings of erp-crdb-proxy: the Apps Script
// source (process-engineer-system, cloned as "ERP System" on the original
// machine) and this one. ERP_GAS_DIR overrides the Apps Script location.
function gasDir_() {
  if (process.env.ERP_GAS_DIR) return process.env.ERP_GAS_DIR;
  const up = path.resolve(__dirname, '..', '..', '..');
  const hit = ['ERP System', 'process-engineer-system']
    .map(n => path.join(up, n)).find(d => fs.existsSync(path.join(d, 'Targets.js')));
  if (!hit) throw new Error('Apps Script source not found next to erp-crdb-proxy - set ERP_GAS_DIR');
  return hit;
}
const WORKER_SRC_ = path.resolve(__dirname, '..', '..', 'src', 'index.js');
const vm = require('vm');

const GAS = path.join(gasDir_(), 'Targets.js');
const WORKER = WORKER_SRC_;

const SPECS = {
  'targets_sc|machine': { cols: ['Payoff Max Speed (m/min)', 'Takeup Max Speed (m/min)'], rows: [
    { label: 'CT01', values: { 'Payoff Max Speed (m/min)': 65, 'Takeup Max Speed (m/min)': 65 } },
    { label: 'CW01', values: { 'Payoff Max Speed (m/min)': 45, 'Takeup Max Speed (m/min)': 45 } },
    { label: 'ST01', values: { 'Payoff Max Speed (m/min)': 55, 'Takeup Max Speed (m/min)': 55 } }
  ] },
  'targets_sc|heads': { cols: ['Head', 'Element Type', 'Max RPM', 'Runs By Default'], rows: [
    { label: 'CT01', values: { Head: 'Head 1', 'Element Type': 'Tape', 'Max RPM': 1200, 'Runs By Default': 'Y' } },
    { label: 'CT01', values: { Head: 'Head 2', 'Element Type': 'Tape', 'Max RPM': 48, 'Runs By Default': 'Y' } },
    { label: 'CW01', values: { Head: 'Head 1', 'Element Type': 'Tape', 'Max RPM': 520, 'Runs By Default': 'Y' } },
    { label: 'CW01', values: { Head: 'Wire Cage', 'Element Type': 'Wire Cage', 'Max RPM': 90, 'Runs By Default': 'Y' } },
    { label: 'ST01', values: { Head: 'Head 1', 'Element Type': 'Tape', 'Max RPM': 300, 'Runs By Default': 'Y' } }
  ] },
  'targets_sc|tapeMaterial': { cols: ['Class', 'Thickness (mm)'], rows: [
    { label: 'Copper pads', values: { Class: 'Metallic', 'Thickness (mm)': 0.12 } },
    { label: 'Steel Pads', values: { Class: 'Metallic', 'Thickness (mm)': 0.08 } },
    { label: 'Water resistance', values: { Class: 'Non-metallic', 'Thickness (mm)': 0.15 } }
  ] },
  'targets_sc|rpmCap': { cols: ['Max RPM'], rows: [
    { label: 'Metallic', values: { 'Max RPM': 450 } },
    { label: 'Non-metallic', values: { 'Max RPM': 520 } }
  ] }
};

// ---- engine A: Apps Script Targets.js ------------------------------------
const gasBox = {
  console: console,
  getSpecData: (t, k) => SPECS[t + '|' + k] || { cols: [], rows: [] },
  getPdsRecords: () => []
};
vm.createContext(gasBox);
// The real machine directory, not a stub - the option sources are part of what
// is being compared, and an empty stub would manufacture a difference.
const codeJs = fs.readFileSync(path.join(gasDir_(), 'Code.js'), 'utf8');
const mo = codeJs.indexOf('const PDS_MACHINE_OPTIONS_ = {');
const moEnd = codeJs.indexOf('\n};', mo);
if (mo < 0 || moEnd < 0) throw new Error('could not lift PDS_MACHINE_OPTIONS_ from Code.js');
vm.runInContext('var ' + codeJs.slice(mo + 'const '.length, moEnd + 3), gasBox, { filename: 'machine-options' });
vm.runInContext(fs.readFileSync(GAS, 'utf8'), gasBox, { filename: 'Targets.js' });

// ---- engine B: the Worker's ported copy ----------------------------------
let worker = fs.readFileSync(WORKER, 'utf8');
worker = worker.replace('export default {', 'const __worker_default = {');
// ES imports (cloudflare:sockets, for SMTP) cannot run in a vm script and
// nothing the target engine calls uses them.
worker = worker.replace(/^import .*$/gm, '');
if (/^import /m.test(worker)) throw new Error('an import survived');
// vm `let` bindings are not reachable from outside the script; `var` lands on
// the context object, which is how the harness injects the prefetched specs.
worker = worker.replace('let TARGET_SPECS_ = {};', 'var TARGET_SPECS_ = {};');
if (worker.indexOf('var TARGET_SPECS_') < 0) throw new Error('could not expose TARGET_SPECS_');

const wBox = { console: console, crypto: global.crypto, fetch: () => { throw new Error('no network in parity'); },
  URL: URL, TextEncoder: TextEncoder, TextDecoder: TextDecoder, atob: global.atob, btoa: global.btoa };
vm.createContext(wBox);
vm.runInContext(worker, wBox, { filename: 'worker-index.js' });
wBox.TARGET_SPECS_ = SPECS;

// ---- the cases ------------------------------------------------------------
const CASES = [
  { name: 'CT01 two taping heads', p: {
    machine: 'CT01', stage: 'Metallic Screen', heads: ['Head 1', 'Head 2'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 92, tapeWidth: 60, overlapGapPct: 30, application: 'Overlap' },
      'Head 2': { elementType: 'Tape', process: 'Taping', diaBefore: 92, tapeWidth: 60, overlapGapPct: 30, application: 'Overlap' } } } },
  { name: 'CW01 tape + wire cage', p: {
    machine: 'CW01', stage: 'Metallic Screen', heads: ['Head 1', 'Wire Cage'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 36, tapeWidth: 50, overlapGapPct: 20, application: 'Overlap', tapeMaterial: 'Water resistance' },
      'Wire Cage': { elementType: 'Wire Cage', process: 'Taping', layLength: 420 } } } },
  { name: 'ST01 gapped steel tape', p: {
    machine: 'ST01', stage: 'Armouring', heads: ['Head 1'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 26, tapeWidth: 30, overlapGapPct: 50, application: 'Gap', tapeMaterial: 'Steel Pads' } } } },
  { name: 'CT01 head 2 stripping', p: {
    machine: 'CT01', stage: 'Metallic Screen', heads: ['Head 1', 'Head 2'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 92, tapeWidth: 60, overlapGapPct: 30, application: 'Overlap' },
      'Head 2': { elementType: 'Tape', process: 'Strip' } } } },
  { name: 'CW01 metallic rpm cap', p: {
    machine: 'CW01', stage: 'Metallic Screen', heads: ['Head 1'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 36, tapeWidth: 50, overlapGapPct: 20, application: 'Overlap', tapeMaterial: 'Copper pads' } } } },
  { name: 'two tapes at one head', p: {
    machine: 'ST01', stage: 'Armouring', heads: ['Head 1'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 80, tapeWidth: 30, noOfTapes: 2, overlapGapPct: 50, application: 'Gap' } } } },
  { name: 'missing geometry reports rather than computes', p: {
    machine: 'ST01', stage: 'Armouring', heads: ['Head 1'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 26 } } } },
  { name: 'longitudinal head places no limit', p: {
    machine: 'ST01', stage: 'Armouring', heads: ['Head 1'], byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 10, tapeWidth: 60, overlapGapPct: 0, application: 'Gap' } } } },
  { name: 'manual override of the line speed', p: {
    machine: 'ST01', stage: 'Armouring', heads: ['Head 1'], quantityKm: 12, byHead: {
      'Head 1': { elementType: 'Tape', process: 'Taping', diaBefore: 26, tapeWidth: 30, overlapGapPct: 50, application: 'Gap' } },
    steps: { lineSpeed: 9 } } }
];

let comparisons = 0, real = 0, diffs = 0;
function cmp(caseName, field, a, b) {
  comparisons++;
  const bothNum = typeof a === 'number' && typeof b === 'number';
  if (a !== null && a !== undefined && a !== '') real++;
  const same = bothNum ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b);
  if (!same) {
    diffs++;
    console.log('  DIFF  ' + caseName + ' / ' + field + '\n        GAS   : ' + JSON.stringify(a) +
      '\n        Worker: ' + JSON.stringify(b));
  }
}

CASES.forEach(c => {
  const a = gasBox.calcTargetTime('targets_sc', c.p);
  const b = wBox.calcTargetTime('targets_sc', c.p);
  cmp(c.name, 'totalMinPerKm', a.totalMinPerKm, b.totalMinPerKm);
  cmp(c.name, 'totalHours', a.totalHours, b.totalHours);
  cmp(c.name, 'missing', a.missing, b.missing);
  a.steps.forEach((s, i) => {
    cmp(c.name, 'step.' + s.key + '.value', s.value, b.steps[i].value);
    cmp(c.name, 'step.' + s.key + '.source', s.source, b.steps[i].source);
    cmp(c.name, 'step.' + s.key + '.note', s.note, b.steps[i].note);
  });
  a.constants.forEach((k, i) => {
    cmp(c.name, 'const.' + k.key + '.value', k.value, b.constants[i].value);
    cmp(c.name, 'const.' + k.key + '.source', k.source, b.constants[i].source);
  });
  const line = a.steps.find(s => s.key === 'lineSpeed');
  console.log('  ' + c.name + ': line speed ' +
    (line.value === null ? 'unavailable' : line.value.toFixed(3) + ' m/min') +
    ', total ' + (a.totalMinPerKm === null ? '-' : a.totalMinPerKm.toFixed(2) + ' min/km') +
    (a.missing.length ? '   [missing: ' + a.missing.length + ']' : ''));
});

// the option sources and the client-facing model description must match too
cmp('options', 'screeningMachines',
  gasBox.getTargetOptionSource('screeningMachines', {}), wBox.getTargetOptionSource('screeningMachines', {}));
cmp('options', 'screeningTapeMaterials',
  gasBox.getTargetOptionSource('screeningTapeMaterials', {}), wBox.getTargetOptionSource('screeningTapeMaterials', {}));
// Keys only the Worker's client description has, by design - not formula
// drift. tdsPlan: the Target-from-TDS feature, which has no Apps Script side.
// List a key here only after checking it is Worker-only; anything else that
// differs must still fail.
const WORKER_ONLY_MODEL_KEYS_ = ['tdsPlan'];
const wModel = Object.assign({}, wBox.getTargetModelForClient('targets_sc'));
WORKER_ONLY_MODEL_KEYS_.forEach(k => { delete wModel[k]; });
cmp('model', 'getTargetModelForClient', gasBox.getTargetModelForClient('targets_sc'), wModel);

console.log('');
console.log(comparisons + ' comparisons, ' + real + ' with a real value, ' + diffs + ' differences');
if (!real) { console.log('FAIL: zero coverage - both engines returned nothing'); process.exitCode = 1; }
else if (diffs) { console.log('FAIL'); process.exitCode = 1; }
else console.log('IDENTICAL');
