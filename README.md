# Process Engineer System

A production web application built for the process engineering department of a
cable-manufacturing plant. It replaced the paper and Excel workflow that four
teams used to record what actually happened on the production lines: process
data sheets, daily shift reports, quality logs, trial runs and target times.

It is in daily use by the plant's engineers.

<!-- TODO(you): if you want a date here, add the real one - e.g. "in daily use
     since March 2026". I left it out rather than guess. -->


**This repository is a curated, sanitised showcase.** It is not the deployment.
See [What is and is not here](#what-is-and-is-not-here).

---

## The problem

A cable is built in layers. A copper rod is drawn down to wire, the wires are
stranded into a conductor, the conductor is insulated, screened, armoured and
sheathed - each on a different line, by a different team, on a different shift.
Every one of those steps has a process data sheet: the settings the engineer
dialled in, and the measurements that came back.

Those sheets were paper. That meant:

- a setting that worked last month was findable only if you remembered which
  binder it was in
- nobody could answer "what did we actually run on this order" without walking
  to the line
- a measurement that drifted out of tolerance was visible only to whoever was
  holding the page
- shift handover was verbal

The application is the answer to those four things. Its core is not a form
builder - it is the observation that fourteen visually different documents are
one document with fourteen configurations.

## Scale

| | |
|---|---|
| Server (Google Apps Script, V8) | ~17,600 lines across 6 files |
| Client (single-page app) | ~17,000 lines of inline script, 748 functions |
| Form types, all schema-driven | 14 |
| Backing stores | Google Sheets, Google Drive, and a Cloudflare Worker + D1 for the query-heavy paths |
| Build step | none |

## Architecture

```
  Browser (single page, vanilla JS + Tailwind)
      |
      |  google.script.run  (RPC into the Apps Script runtime)
      v
  Apps Script server                          Cloudflare Worker + D1
    Code.js       forms, nav, auth, PDS         SQL for the read-heavy
    Forms.js      unified form registry         reporting paths, which
    Targets.js    target-time engine            Sheets could not serve
    Performance.js  shift coverage              at acceptable latency
    TdsLog.js     technical data sheets
    Parity.js     admin / config
      |
      v
  Google Sheets (records)  +  Google Drive (documents, photos)
```

There is no build step and no framework. That was a constraint, not a
preference: the deployment target is Google Apps Script, the plant machines run
locked-down browsers, and I had no admin rights on the workstation. The
interesting engineering is in what that constraint forced.

### Three pieces worth reading

**[The forms engine](docs/forms-engine.md)** - fourteen process data sheets, one
renderer. A department is a schema entry, not a code path. This is the spine of
the application and the decision I would defend hardest.
Code: [`src/server/schemas.excerpt.js`](src/server/schemas.excerpt.js),
[`src/client/pds-renderer.excerpt.js`](src/client/pds-renderer.excerpt.js),
[`src/server/Forms.js`](src/server/Forms.js).

**[The target-time engine](docs/target-times.md)** - "how long should one
kilometre take on this line?", answered from drum geometry, die schedules and
line speeds rather than from a guess. Models are declarative data with every
constant traceable to where it came from in the real world.
Code: [`src/server/Targets.js`](src/server/Targets.js).

**[Apps Script serving hazards](docs/apps-script-hazards.md)** - four ways the
platform silently corrupted correct code on its way to the browser, each of
which took down the entire application including login, and none of which a
local syntax check can catch. This is the most useful thing in the repository
if you want to know how I debug.

## What is and is not here

**Here:** four server modules in full (`Targets.js`, `Forms.js`, `TdsLog.js`,
`Parity.js`), representative excerpts from the two large files, and the
write-ups above.

**Not here:** the deployment. Specifically removed -

- all Google Drive, Sheets and Apps Script identifiers, replaced with
  `REPLACE_WITH_...` placeholders
- the plant's real line inventory, equipment vendors, works order numbers and
  machine serial numbers - replaced with a **fictional but structurally
  identical** set, so the code reads the way it really does
- the plant's production rates, drawing speeds, stranding RPM tables and
  reference workbooks
- employer branding and logo
- the commit history, which contains all of the above

Every number, machine code and supplier name you see in this repository is
invented. None of it describes a real facility.

**Also not here:** the two largest files in their entirety (`Code.js` at ~11,600
lines and `index.html` at ~17,500). They are excerpted rather than dumped,
because a wall of code is not a portfolio.

## A note on judgement

Two things in this codebase are deliberately *less* clever than they could be,
and both are load-bearing.

The application shows "not tracked yet" rather than a number, wherever it does
not genuinely have the data. A dashboard that invents a plausible figure is
worse than one that admits the gap, because an engineer will act on it. The
rule is written down in the repo's own contributor notes and it is enforced:
a computation returns `null` rather than a default when its inputs are missing,
and the total then reports as unavailable rather than as a confident wrong
answer.

The other is the global error banner installed at the top of the client script.
Apps Script serves the page as a string; a JavaScript error therefore presents
to the user as a page that simply never finishes loading. The banner is the
only thing that turns a silent hang into a visible message. It looks like
clutter. It is not.

## Licence

All rights reserved - see [LICENSE](LICENSE).

This repository is published for portfolio review only. The code is a sanitised
extract of a private production system developed as work product; no reuse
rights are granted. Read it, ask me about it - but it is not yours to fork.
