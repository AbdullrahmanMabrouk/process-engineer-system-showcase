# The forms engine

Fourteen process data sheets. One renderer.

## What the forms actually look like

A process data sheet is not a tidy list of fields. The paper originals were
designed by the people who ran the lines, and they look like it:

- **Stranding** is a grid. Four cages lay wire onto the conductor, so most
  fields repeat four times across the page - but not all of them. Line speed is
  one value for the whole machine, so it spans all four columns. Tape dimension
  is one cell holding two numbers, width and thickness. And there is a centre
  wire, which is one wire, sitting in a column in the *middle* of the four
  repeating ones.
- **CV** (the insulation line) has three extruders, each with a ten-zone
  temperature profile recorded as a matrix: what was set, against what was
  measured.
- **Roller direction** is recorded by circling one of four arrows, because that
  is how the paper form did it and the engineers wanted it kept.
- **The QC log** is a flat row. One submission is one day's line in a
  ledger, not a document.

These are genuinely different documents. The first two departments were built
as two separate forms, which is the obvious thing to do.

## Why that stops working at two

Two hand-built forms means two render paths, two submit paths, two print
stylesheets, two draft implementations, two sets of keyboard navigation. A bug
fixed in one is fixed in one. At fourteen it is not a maintenance burden, it is
a different program that happens to be fourteen copies of itself.

So the forms became data.

## The shape

A schema declares what a form has. The renderer asks, and draws:

```js
pds_str: {
  header: [
    { key: 'date',          label: 'Date',     type: 'date' },
    { key: 'machine',       label: 'Machine',  type: 'select', options: PDS_MACHINE_OPTIONS_.pds_str },
    { key: 'conductorType', label: 'Conductor Type', type: 'select', options: ['Round', 'Sector'] },
    { key: 'sectorAngle',   label: 'Angle',    type: 'select', options: ['60','90','100','120'],
      showIf: { field: 'conductorType', equals: 'Sector' } },
    ...
  ],
  cageGroups:       ['CAGE 6', 'CAGE 12', 'CAGE 18', 'CAGE 24'],
  centerWireColumn: true,
  mergedCageFields: ['nextProcess', 'lineSpeed'],
  splitCageFields: {
    tapeDimension: { suffixes: ['width', 'thick'], labels: ['W', 'T'] },
    tensionPct:    { suffixes: ['start', 'end'],   labels: ['S', 'E'] }
  },
  cageFields:   [ ... ],
  finalReading: [ ... ]
}
```

And the entry point, in full:

```js
function renderPdsForm(tabKey, schema, chipMode) {
  ...
  html += `<div id="pdsTabPane_header">${renderPdsHeaderFieldsHtml_(schema, tabKey)}</div>`;

  let blocksHtml = '';
  if (schema.multiPage)    blocksHtml = pageContent.blocksHtml;
  else if (schema.blocks)  schema.blocks.forEach(b => blocksHtml += renderPdsBlockFormHtml_(b));
  else                     blocksHtml += renderPdsCageGridHtml_(schema);
  ...
}
```

There is no `if (tabKey === 'pds_str')` in that function. There is none
anywhere in the renderer. That is the whole discipline, and it is written into
the repository's contributor notes as a rule:

> PDS forms are schema-driven, not hand-coded per department. If you're about
> to write department-specific UI code, stop and check whether the schema needs
> a new *generic* capability instead.

## The capabilities, and where each came from

Every one of these exists because a department needed a layout the renderer
could not express. In each case the fix was to teach the renderer a general
trick, which then became available to all fourteen forms for free.

| Capability | The department that forced it | What it does |
|---|---|---|
| `centerWireColumn` | Stranding | A column inside a repeating group that does not repeat |
| `mergedCageFields` | Stranding | One field spanning the whole repeating group |
| `splitCageFields` | Stranding | One logical field stored as two sub-values in one cell |
| `showIf` | Stranding | A field that appears only when another is set |
| `circleLeft` | Assembly | Circular pickers, drawn rather than typed |
| `zoneMatrix` | CV | A set/actual matrix over N temperature zones |
| `varianceThreshold` | CV | How far actual may drift from set before the cell flags |
| `dependsOn` / `optionsSource` | Bleeding | A dropdown filtered by another dropdown, from a live source |

The payoff is concrete. `qc_log_str`, the simplest schema in the file, is
header fields and `blocks: []`. For those twenty lines it gets work-order
autofill, arrow-key navigation, drafts, printing, load-to-edit and full record
history - because those are properties of the engine, not of the form.

## The second generalisation: roles

The schema solved rendering. It did not solve *matching*, and that produced a
real bug.

The Daily Report needs to find the process data sheet that corresponds to a
shift's production. To do that it has to ask a record "which machine were you
on?" - but Stranding calls that field `machine` and CV calls it `line`. The
first implementation handled this with a lookup table mapping department to
field name. Then it needed the description field, so a second table. Then
material, material type, tab key: five parallel tables, all existing for the
same reason.

They failed the way lookup tables fail. A missing entry did not error - it
returned undefined, matching found nothing, and the engineer was told "no PDS
found" for a record that existed. That was reported from the CV line, and the
cause was that `pds_cv` names its machine field `line`.

The fix was to declare the *semantic role* once, next to the schema:

```js
roles: {
  machine:  'line',      // pds_cv calls it 'line'
  desc:     'name',
  material: 'material'
}
```

Five tables became one declaration per form, and the next differently named
field became a one-line change instead of a sixth table. `Forms.js` in this
repository is that registry: for every form, where it stores rows, what its ID
column is, what its chip caption says, and which field plays which role.

## What I would change

The cage grid still has a legacy render path separate from the block path, kept
because Stranding predates blocks and migrating it is a data migration, not a
code change. `qc_log_str` carries `blocks: []` rather than omitting it purely
to stay off that path - a comment in the schema says so. That is the kind of
wart that accumulates when you generalise an existing system rather than
rewriting it, and I think taking the wart was the right call, but it is a wart.
