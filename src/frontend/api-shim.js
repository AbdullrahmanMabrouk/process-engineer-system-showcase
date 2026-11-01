/**
 * google.script.run shim for the static (Cloudflare Pages) build.
 * =============================================================
 * Reimplements exactly the surface index.html already uses:
 *
 *     google.script.run
 *       .withSuccessHandler(fn)
 *       .withFailureHandler(fn)
 *       .someBackendFunction(a, b)
 *
 * and routes it to the Worker gateway instead of Apps Script's iframe RPC.
 *
 * WHY A SHIM RATHER THAN REWRITING THE CALL SITES:
 * index.html has 54 of them. Rewriting each into a promise call is 54
 * chances to change behaviour subtly - especially around failure handlers,
 * which are easy to drop. Keeping the existing API means the call sites
 * stay byte-identical and the risky translation happens once, here.
 *
 * THE ONE SEMANTIC THAT MUST NOT DRIFT:
 * Under Apps Script, a server-side throw routes to withFailureHandler.
 * Through the gateway it arrives as a normal HTTP response carrying
 * {ok:false, code:'THREW'}. Several backend functions throw as their real
 * error path - getSpecSchemaForClient throws for a tab with no spec
 * schema, which the Phase 0 harness confirmed. So EVERY non-ok envelope is
 * routed to the failure handler below. Treating those as success would
 * turn every error path into a success path holding an error nobody reads.
 */
(function () {
  'use strict';

  // Set by config.js so the same shim works against a test gateway or the
  // production one without editing this file.
  var API_URL = (window.ERP_API_URL || '').replace(/\/+$/, '');

  // Same key index.html already uses - the shim reads the token itself so
  // no call site has to start passing one.
  var TOKEN_KEY = 'sessionToken';

  /**
   * Read-through cache for calls whose answer is stable.
   * ----------------------------------------------------
   * Every data call currently costs a round trip through Apps Script,
   * which measured at 3-18s against ~0.6s for a direct D1 query. A large
   * share of those calls ask for things that barely ever change - a PDS
   * schema is a constant object in Code.js, and a machine list is a config
   * sheet edited a few times a year.
   *
   * index.html already caches PDS and spec schemas, but only in memory for
   * the current page load, so every refresh pays for them again. Caching
   * here instead covers every call site at once, survives a refresh, and
   * needs no change to the 74 call sites.
   *
   * Cached IN THE BROWSER on purpose, not at the edge: these responses are
   * fetched with the user's own session and stored only for that user, so
   * there is no way to serve one person's data to another. An edge cache
   * keyed without the token would have exactly that risk.
   *
   * Values are seconds. Anything not listed is never cached - in
   * particular every record, draft, report and search, which must stay
   * live. The trade for the listed ones is that an admin edit can take up
   * to its TTL to appear; that is why nothing user-specific or
   * frequently-edited is on this list.
   */
  var CACHEABLE_SECONDS = {
    getPdsSchema: 900,
    getSpecSchemaForClient: 900,
    formGetDef: 900,
    getTargetModelForClient: 900,
    getTargetOptions: 900,
    getTargetOptionSource: 900,
    getDailyReportMachines: 300,
    getDailyReportDowntimeReasons: 300,
    getMaterialTypeAndSupplierOptions: 300,
    getPdsZoneColumns: 300,
    getUserNavForClient: 300
  };

  var CACHE_PREFIX = 'apiCache:';

  function cacheKey(fnName, args) {
    return CACHE_PREFIX + fnName + ':' + JSON.stringify(args);
  }

  function cacheRead(fnName, args) {
    var ttl = CACHEABLE_SECONDS[fnName];
    if (!ttl) return null;
    try {
      var raw = window.sessionStorage.getItem(cacheKey(fnName, args));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || (Date.now() - entry.t) > ttl * 1000) return null;
      return entry;
    } catch (e) {
      return null;
    }
  }

  function cacheWrite(fnName, args, value) {
    if (!CACHEABLE_SECONDS[fnName]) return;
    try {
      window.sessionStorage.setItem(cacheKey(fnName, args), JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
      // Quota exceeded or storage disabled - caching is an optimisation,
      // never a requirement, so a failure here is silent by design.
    }
  }

  /** Drops every cached response. Called on logout so a second user on a
   *  shared device cannot see the first one's cached config, and exposed
   *  globally so an admin screen can force a refresh after editing
   *  something cached (zone columns, machine lists). */
  function cacheClear() {
    try {
      var keys = [];
      for (var i = 0; i < window.sessionStorage.length; i++) {
        var k = window.sessionStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) { window.sessionStorage.removeItem(k); });
    } catch (e) { /* nothing to do */ }
  }
  window.apiCacheClear = cacheClear;

  /** Ops that describe the SHAPE of the app rather than data in it: which
   *  fields a form has, which tabs you can see. Cached like everything else
   *  during a session, but dropped on page load.
   *
   *  Reloading is what a person does when the app looks wrong, and these are
   *  exactly the responses where being 15 minutes stale looks like a bug
   *  rather than like old data: a form that has gained a field still shows
   *  the old one, a tab just granted still does not appear. Both have cost
   *  real time to diagnose. The option and machine lists keep their caches -
   *  those going stale looks like what it is.
   */
  var REVALIDATE_ON_LOAD = ['getPdsSchema', 'getUserNavForClient', 'formGetDef',
                            'getSpecSchemaForClient'];
  try {
    for (var ri = window.sessionStorage.length - 1; ri >= 0; ri--) {
      var rk = window.sessionStorage.key(ri);
      if (!rk || rk.indexOf(CACHE_PREFIX) !== 0) continue;
      var opName = rk.slice(CACHE_PREFIX.length).split(':')[0];
      if (REVALIDATE_ON_LOAD.indexOf(opName) > -1) window.sessionStorage.removeItem(rk);
    }
  } catch (e) { /* no storage - nothing was cached anyway */ }

  function currentToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null; // private mode / storage disabled
    }
  }

  function reportUnhandled(err) {
    // Mirrors Apps Script's behaviour of surfacing an unhandled server
    // error rather than failing silently. index.html installs a global
    // error banner; throwing asynchronously routes into it.
    console.error('[api] unhandled backend failure:', err);
    setTimeout(function () { throw err; }, 0);
  }

  function invoke(fnName, args, handlers) {
    if (!API_URL) {
      var cfgErr = new Error('ERP_API_URL is not configured - the frontend does not know where the gateway is.');
      if (handlers.failure) handlers.failure(cfgErr); else reportUnhandled(cfgErr);
      return;
    }

    // Cache hit. Delivered asynchronously on purpose: callers were written
    // against an async RPC, and firing the handler synchronously here would
    // run it before the code after the call site - a subtle ordering change
    // that would only show up in whichever screen happened to depend on it.
    var hit = cacheRead(fnName, args);
    if (hit) {
      if (handlers.success) {
        setTimeout(function () { handlers.success(hit.v, handlers.userObject); }, 0);
      }
      return;
    }

    // Logging out must not leave the next user on a shared device reading
    // cached config from this one.
    if (fnName === 'logoutSession') cacheClear();

    var payload = JSON.stringify({ token: currentToken(), fn: fnName, args: args });

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
      .then(function (resp) {
        // The gateway maps envelope codes onto real statuses, but the
        // envelope is still the authority - parse it either way rather
        // than branching on resp.ok.
        return resp.text().then(function (text) {
          try {
            return JSON.parse(text);
          } catch (e) {
            throw new Error('Gateway returned a non-JSON response (HTTP ' + resp.status + '): ' + text.slice(0, 200));
          }
        });
      })
      .then(function (envelope) {
        if (envelope && envelope.ok) {
          cacheWrite(fnName, args, envelope.result);
          if (handlers.success) handlers.success(envelope.result, handlers.userObject);
          return;
        }

        var err = new Error((envelope && envelope.error) || 'Backend call failed.');
        err.code = envelope && envelope.code;

        // An expired or missing session is not an application error - it
        // means "log in again". Give the app one place to handle that
        // rather than making all 54 call sites recognise the code.
        if (err.code === 'UNAUTHORIZED' && typeof window.onApiUnauthorized === 'function') {
          window.onApiUnauthorized(err);
          return;
        }

        if (handlers.failure) handlers.failure(err, handlers.userObject);
        else reportUnhandled(err);
      })
      .catch(function (err) {
        if (handlers.failure) handlers.failure(err, handlers.userObject);
        else reportUnhandled(err);
      });
  }

  function runner(handlers) {
    return new Proxy({}, {
      get: function (_target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) {
            return runner({ success: fn, failure: handlers.failure, userObject: handlers.userObject });
          };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) {
            return runner({ success: handlers.success, failure: fn, userObject: handlers.userObject });
          };
        }
        if (prop === 'withUserObject') {
          return function (obj) {
            return runner({ success: handlers.success, failure: handlers.failure, userObject: obj });
          };
        }
        // Anything else is a backend function name. Returns undefined like
        // the real API does - callers use handlers, never a return value.
        return function () {
          invoke(String(prop), Array.prototype.slice.call(arguments), handlers);
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};

  // A getter, because index.html starts a fresh chain on every call and
  // each must begin with empty handlers rather than inheriting the last.
  Object.defineProperty(window.google.script, 'run', {
    get: function () { return runner({}); },
    configurable: true
  });
})();
