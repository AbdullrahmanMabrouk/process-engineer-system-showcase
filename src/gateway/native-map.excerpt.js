/* ===================================================================
 * THE STRANGLER SEAM - excerpt
 * -------------------------------------------------------------------
 * EXCERPT NOTICE
 * Lifted verbatim from the Cloudflare Worker (src/index.js, ~35,500
 * lines). Two things are here: the NATIVE registry, which decides what
 * the edge answers for itself, and the forward handler, which is the
 * seam itself. Nothing is sanitised - there is no plant data in either.
 * It does not run standalone.
 * -------------------------------------------------------------------
 *
 * WHAT THIS IS FOR
 *
 * The application started life entirely inside Google Apps Script. That
 * was the right call to get it in front of engineers - no infrastructure,
 * no deployment story, a spreadsheet as the database - and the wrong one
 * to keep. Apps Script's cost is not the database, it is the iframe-plus-
 * RPC model: every call pays a fixed tax no amount of query tuning
 * removes.
 *
 * The number in the comment below is the whole argument:
 *
 *     forwarding costs 3-18s, answering here ~0.05s
 *
 * Two to three orders of magnitude, on calls an engineer makes dozens of
 * times a shift while standing at a machine.
 *
 * A rewrite was not an option - the thing was in daily production use by
 * four departments. So: a strangler fig. The Worker sits in front, the
 * frontend's call sites do not change at all (see api-shim.js, which
 * reimplements `google.script.run`'s chainable API over fetch), and each
 * endpoint moves to D1 when its data and its config are both ready.
 * Anything not yet listed forwards to Apps Script exactly as before.
 *
 * There was no flag day, and at no point was the app down for it.
 *
 * TWO DETAILS WORTH THE READ
 *
 * 1. `fallbackToAppsScript`. A native handler that discovers it cannot
 *    answer - a department whose data has not been migrated, a user the
 *    edge has not been told about - throws an error carrying this flag,
 *    and the request forwards as though it had never been listed. That
 *    turns a half-migrated endpoint from a liability into a normal state.
 *    The `login` handler uses it so that a user-sync running behind
 *    cannot lock anybody out.
 *
 * 2. `scope`. Authorisation is declared next to the route rather than
 *    checked inside each handler, and enforced once in the forward path
 *    so that a forwarded call is checked by the same rule as a native
 *    one. `auth: 'public'` on `login` and `resumeSession` is not an
 *    oversight - those calls *are* the authentication check, so they
 *    cannot require one.
 *
 * See docs/migration.md for the full write-up.
 * =================================================================== */

/**
 * Endpoints served here, from D1, without touching Apps Script.
 * =============================================================
 * This is the strangler seam. A function listed here is answered at the
 * edge; anything else is forwarded to Apps Script exactly as before, so
 * migration happens one endpoint at a time with no flag day.
 *
 * Measured difference: forwarding costs 3-18s, answering here ~0.05s.
 *
 * Adding one means its data AND its config must already be in D1 - that
 * is the real work, not the routing.
 */
const NATIVE = {
  getProductivityRuns: { auth: 'user', scope: { anyOf: ['productivity_runs'] }, handler: nativeGetProductivityRuns },
  // The filter dropdowns, and the whole screen in one call. These were the
  // last of the Production Runs path still forwarded to Apps Script, and the
  // options call sits ahead of everything else on that screen.
  getProductivityFilterOptions: { auth: 'user', scope: { anyOf: ['productivity_runs'] }, handler: nativeGetProductivityFilterOptions },
  // Stranding PDS coverage: the machine-by-size grid of what has a submitted
  // PDS and what does not. One grouped query.
  getStrandPdsCoverage: { auth: 'user', scope: { anyOf: ['pds_cov_str', 'pds_str'] }, handler: nativeGetStrandPdsCoverage },
  getProductivityRunsScreen: { auth: 'user', scope: { anyOf: ['productivity_runs'] }, handler: nativeGetProductivityRunsScreen },
  productivityMachineDepts: { auth: 'user', scope: { anyOf: ['productivity_runs'] }, handler: nativeProductivityMachineDepts },
  getPdsFilterAndResults: { auth: 'user', scope: { tab: 0 }, handler: nativeGetPdsFilterAndResults },
  // Opening a PDS form asks for all three of these. Serving them here is
  // what turns form-open from three Apps Script round trips into none.
  getPdsSchema: { auth: 'user', scope: { tab: 0 }, handler: nativeGetPdsSchema },
  // Public: it IS the authentication check, so it cannot require one.
  resumeSession: { auth: 'public', handler: nativeResumeSession },
  // Same reason. Sits on the boot path - the first thing anyone waits for.
  // Falls back to Apps Script for a user the edge has not been told about,
  // so a sync that is behind cannot lock somebody out.
  login: { auth: 'public', handler: nativeLogin },
  logoutSession: { auth: 'public', handler: nativeLogoutSession },
  // Public by necessity - the person asking has no account yet. Creates a
  // request only, never an account; throttled inside the handler.
  registerRequest: { auth: 'public', handler: nativeRegisterRequest },
  adminListUserRequests: { auth: 'admin', handler: nativeAdminListUserRequests },
  adminApproveUserRequest: { auth: 'admin', handler: nativeAdminApproveUserRequest },
  adminRejectUserRequest: { auth: 'admin', handler: nativeAdminRejectUserRequest },
  // Roles: a tag per account with preset pages. getRoles is public for the
  // request-access form and returns names only, never which pages.
  getRoles: { auth: 'public', handler: nativeGetRoles },
  adminGetRoles: { auth: 'admin', handler: nativeAdminGetRoles },
  adminSetRoleTabs: { auth: 'admin', handler: nativeAdminSetRoleTabs },
  adminSetUserRole: { auth: 'admin', handler: nativeAdminSetUserRole },
  adminResetUserToRole: { auth: 'admin', handler: nativeAdminResetUserToRole },
  adminCreateRole: { auth: 'admin', handler: nativeAdminCreateRole },

  // Admin panel reads. Two round trips before an admin could change
  // anything is why the panel felt dead on open.
  adminGetAllDeptsTabs: { auth: 'admin', handler: nativeAdminGetAllDeptsTabs },
  adminGetUserAccess: { auth: 'admin', handler: nativeAdminGetUserAccess },
  getUserNavForClient: { auth: 'user', scope: { open: 'your own nav; other users only for an admin, in the handler' }, handler: nativeGetUserNavForClient },

  // Admin writes. Every access change revokes the affected user's sessions,
  // because a session carries the nav it was issued with.
  adminSetUserAccess: { auth: 'admin', handler: nativeAdminSetUserAccess },
  adminSetUserAccessBulk: { auth: 'admin', handler: nativeAdminSetUserAccessBulk },
  adminCreateUser: { auth: 'admin', handler: nativeAdminCreateUser },
  adminSetUserAdmin: { auth: 'admin', handler: nativeAdminSetUserAdmin },
  targetPlanFromTds: { auth: 'user', scope: { open: 'calculator over reference tables, the TDS and the master plan; returns figures, not records' }, handler: nativeTargetPlanFromTds },
  // The same plan with every number traceable to its source, what-if
  // overrides, and a one-cell save (admin) with history and revert.
  targetPlanTrace: { auth: 'user', scope: { open: 'calculator over reference tables, the TDS and the master plan; returns figures, not records' }, handler: nativeTargetPlanTrace },
  // One TDS, every operation it needs, each through its own traced engine.
  targetPlanAll: { auth: 'user', scope: { open: 'calculator over reference tables, the TDS and the master plan; returns figures, not records' }, handler: nativeTargetPlanAll },
  // Screening > Taping Speed: the taping calculator, every number traced.
  tapingCalc: { auth: 'user', scope: { open: 'calculator over reference tables, the TDS and the master plan; returns figures, not records' }, handler: nativeTapingCalc },
  targetSaveSourceCell: { auth: 'admin', handler: nativeTargetSaveSourceCell },
  targetRevertSourceCell: { auth: 'admin', handler: nativeTargetRevertSourceCell },
  adminResetPassword: { auth: 'admin', handler: nativeAdminResetPassword },
  adminDeleteUser: { auth: 'admin', handler: nativeAdminDeleteUser },
  adminCreateTab: { auth: 'admin', handler: nativeAdminCreateTab },
  adminListProcesses: { auth: 'admin', handler: nativeAdminListProcesses },
  adminDeleteTab: { auth: 'admin', handler: nativeAdminDeleteTab },
  adminRestoreTab: { auth: 'admin', handler: nativeAdminRestoreTab },
  adminPurgeDeletedTabs: { auth: 'admin', handler: nativeAdminPurgeDeletedTabs },
  adminDeleteForm: { auth: 'admin', handler: nativeAdminDeleteForm },
  adminGetShiftRoster: { auth: 'admin', handler: nativeAdminGetShiftRoster },
  adminSetUserShift: { auth: 'admin', handler: nativeAdminSetUserShift },
  adminGetUserReportStats: { auth: 'admin', handler: nativeAdminGetUserReportStats },

  // Master Plan reads. The uploads still go through Apps Script, which owns
  // the xlsx conversion, so the plan is read here and written there.
  masterPlanGetRegistry: { auth: 'user', scope: { open: 'the master plan is plant-wide reference data' }, handler: nativeMasterPlanGetRegistry },
  masterPlanGetOrders: { auth: 'user', scope: { open: 'the master plan is plant-wide reference data' }, handler: nativeMasterPlanGetOrders },
  // On the Daily Report's hot path - once per work order typed.
  masterPlanLookupWorkOrder: { auth: 'user', scope: { open: 'the master plan is plant-wide reference data' }, handler: nativeMasterPlanLookupWorkOrder },
  // The month's plan as line work: families, processes, extrusion compounds,
  // and the TDS numbers we do not hold.
  masterPlanBreakdown: { auth: 'user', scope: { open: 'the master plan is plant-wide reference data' }, handler: nativeMasterPlanBreakdown },
  // The breakdown's estimated days: the plan priced at the system's own
  // line targets, a part at a time.
  masterPlanTargets: { auth: 'user', scope: { open: 'the master plan is plant-wide reference data' }, handler: nativeMasterPlanTargets },
  // Work Order Tracker. Reference reads over data the floor already
  // sees elsewhere, so 'user' rather than 'admin'.
  woTrackerLookup: { auth: 'user', scope: { anyOf: ['wo_tracker'] }, handler: nativeWoTrackerLookup },
  woTrackerPdsRecords: { auth: 'user', scope: { anyOf: ['wo_tracker'] }, handler: nativeWoTrackerPdsRecords },
  // The cable length checker's work-order resolve, and the two equipment
  // registers it reads. Both 'user': this is reference data anybody on the
  // floor may look at, and neither one writes anything.
  ehvResolveWorkOrder: { auth: 'user', scope: { open: 'EHV length checker (Tools menu) over the master plan' }, handler: nativeEhvResolveWorkOrder },
  ehvEquipment: { auth: 'user', scope: { open: 'equipment registers are reference data' }, handler: nativeEhvEquipment },
  // Schema changes ship with the Worker but do not APPLY themselves, so a
  // new table exists in the code and not in the database until something
  // runs the migrations. That gap surfaced as "no such table: open_forms"
  // in front of a user trying to load drafts. Exposed as an operation so
  // closing it needs the app and an admin session - not a second system.
  edgeApplyMigrations: { auth: 'admin', handler: nativeEdgeApplyMigrations },
  getTargetModelForClient: { auth: 'user', scope: { open: 'calculator over reference tables, the TDS and the master plan; returns figures, not records' }, handler: nativeGetTargetModelForClient },
  calcTargetTime: { auth: 'user', scope: { open: 'calculator over reference tables, the TDS and the master plan; returns figures, not records' }, handler: nativeCalcTargetTime },

  // ... 120 further entries omitted from this excerpt. The live registry
  // carries 149, each with the same shape: auth tier, page scope, handler.
  // Every one of them is an endpoint that used to cost 3-18 seconds.
};

async function handleAppsScriptForward(request, env, cors) {
  const body = await request.text();

  // Native first. Only what is not implemented here falls through to
  // Apps Script, so this list shrinking is the migration.
  let parsedBody = null;
  try { parsedBody = JSON.parse(body); } catch (e) { /* forwarded as-is below */ }

  if (parsedBody && parsedBody.fn && Object.prototype.hasOwnProperty.call(NATIVE, parsedBody.fn)) {
    const spec = NATIVE[parsedBody.fn];

    // 'public' operations authenticate nothing - resumeSession IS the
    // authentication check, so demanding a valid session first would make
    // it impossible to ever pass.
    let session = null;
    if (spec.auth !== 'public') {
      session = await validateSession(env, parsedBody.token);
      if (!session) {
        return json({ ok: false, code: 'UNAUTHORIZED', error: 'Missing or expired session token.' }, 401, cors);
      }
      if (spec.auth === 'admin' && !session.can_manage) {
        return json({ ok: false, code: 'FORBIDDEN', error: 'This operation requires an admin account.' }, 403, cors);
      }
    }

    let handled = true;
    // Counted per request so an expensive operation names itself in the
    // Network tab rather than being deduced from table sizes.
    const counter = { rows: 0, queries: 0, log: [] };
    // CLIENT_IP_ is for the public handlers' throttles only. Cloudflare sets
    // the header itself, so a caller cannot choose it.
    const countedEnv = Object.assign({}, env, {
      DB: countingDb_(env.DB, counter),
      CLIENT_IP_: request.headers.get('CF-Connecting-IP') || '',
    });
    const t0 = Date.now();

    // Tab scope (see scopeRefusal_). Refused here, before the handler, so a
    // refusal can never fall through to Apps Script either.
    if (spec.auth === 'user') {
      const refusal = await scopeRefusal_(countedEnv, parsedBody.fn, spec, parsedBody.args || [], session);
      if (refusal) return json({ ok: false, code: 'FORBIDDEN', error: refusal }, 403, cors);
    }

    try {
      let result;
      try { result = await spec.handler(countedEnv, parsedBody.args || [], session); }
      finally { if (MSPEC_WRITES_.has(parsedBody.fn)) await msCacheBump_(env); }
      const headers = {
        'X-Rows-Read': String(counter.rows),
        'X-Queries': String(counter.queries),
        'X-Ms': String(Date.now() - t0),
      };
      // Which statement cost what, for admins only - it is SQL text, not
      // data, but nobody else needs it. Base64 so SQL punctuation cannot
      // break the header; capped well under any proxy's header limit.
      if (session && session.can_manage) {
        try {
          const b = btoa(unescape(encodeURIComponent(JSON.stringify(counter.log))));
          if (b.length < 7000) headers['X-Query-Log'] = b;
        } catch (e) { /* diagnostics must never fail a request */ }
      }
      return json({ ok: true, result }, 200, Object.assign({}, cors, headers));
    } catch (e) {
      // A handler that cannot answer - stored data written before a column
      // existed, say - asks to be forwarded rather than failing. Anything
      // else is a real error.
      if (!(e && e.fallbackToAppsScript)) {
        return json({ ok: false, code: 'THREW', error: String(e && e.message ? e.message : e) }, 500, cors);
      }
      handled = false;
    }
    if (handled) return json({ ok: false, code: 'THREW', error: 'unreachable' }, 500, cors);
    // fall through to Apps Script below
  }

  if (!env.APPS_SCRIPT_URL) {
    return json({ ok: false, code: 'MISCONFIGURED', error: 'APPS_SCRIPT_URL is not set on this Worker.' }, 500, cors);
  }

  // Apps Script's /exec answers a POST with a 302 to
  // script.googleusercontent.com carrying the result, and that chain is
  // measurably unreliable: three identical calls produced an HTML error
  // page (HTTP 200), a second one (HTTP 404), then a correct JSON reply.
  // Left unhandled that surfaces as login randomly failing.
  //
  // So a non-JSON reply is retried rather than reported. Retrying a POST
  // is only safe because the mutations behind it are upserts keyed on a
  // caller-supplied id (recordId / row_hash), which makes a duplicate
  // delivery a no-op rather than a second row. Do NOT widen this to
  // operations without that property.
  let upstream = null;
  let text = '';
  let envelope = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 250 * attempt));
    try {
      upstream = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'follow',
      });
    } catch (e) {
      lastStatus = 0;
      continue;
    }
    lastStatus = upstream.status;
    text = await upstream.text();
    try {
      envelope = JSON.parse(text);
      break;
    } catch (e) {
      envelope = null;
    }
  }

  if (!envelope) {
    return json({
      ok: false, code: 'UPSTREAM_BAD_RESPONSE',
      error: 'Apps Script did not return JSON after 3 attempts (deployment may predate doPost, or require login).',
      upstreamStatus: lastStatus,
      head: String(text).slice(0, 300),
    }, 502, cors);
  }

  return json(envelope, statusForEnvelope(envelope), cors);
}