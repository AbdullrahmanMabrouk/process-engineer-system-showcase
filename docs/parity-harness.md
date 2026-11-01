# A test that passed while everything was broken

Code: [`src/tools/parity_sc.js`](../src/tools/parity_sc.js)

## The setup

The target-time formulas exist twice.

Once in `Targets.js`, which is the source of truth and where the plant's own
methods are written down. Once inside the Cloudflare Worker, because the edge
has to answer without a round trip and [that round trip is the whole point of
the migration](migration.md).

Duplication is normally just a smell. Here it is forced, and the forcing
reason is mundane: the formulas are synchronous closures that call
`getSpecData(a, b)` wherever they need a reference table, and D1 reads are
asynchronous. You cannot `await` inside a synchronous closure, so the port
prefetches everything into module-level slots and rewrites the call:

```js
getSpecData('targets_sc', 'heads')   ->   TARGET_SPECS_['targets_sc|heads']
```

That is the entire adaptation, applied mechanically. The copy is lifted
programmatically, never retyped.

## Why it needs a harness at all

Because of how this code fails.

A drifted formula does not crash. It does not throw, it does not return
`undefined`, it does not light up in an error log. It returns a number that
looks exactly like the right number, and a supervisor schedules a shift
against it. The gap between "wrong" and "found out" is a week.

So the harness feeds both engines the same reference tables and the same
cases, and diffs **every intermediate step**, not just the total. A total that
matches can hide two errors cancelling.

## The actual lesson

From the file's own header:

> Fails if coverage is zero: two earlier parity runs in this project reported
> "identical" while both engines were returning null for everything.

Twice, the harness printed a clean result. Twice, that result was meaningless,
because a setup problem - a stub that returned no rows, a context that never
got the specs injected - meant both engines produced `null` for every field.
`null === null`. Identical. Zero differences. Green.

The harness was not testing the formulas. It was testing that `null` equals
itself, and it was very good at it.

The fix is three lines and a refusal:

```
Fails if coverage is zero.
```

Count the comparisons that actually produced two real values. If that count
is zero, fail loudly, regardless of how few differences you found.

## Why this generalises

Any comparison-based check has this hole, and it is wider than it looks:

- a snapshot test where the snapshot is empty
- a contract test where both sides 404
- a migration diff where both queries return no rows
- a visual regression where both screenshots failed to render

In every case the comparison is well-formed, the assertion is satisfied, and
nothing was verified. The symptom is identical to success. Nobody investigates
a passing test.

So the rule I now apply to anything that works by diffing: **the test must
assert that it compared something.** Not that the comparison matched - that
it happened at all. A green light wired to nothing is worse than a red one,
because it stops you looking.

## What is in the file

The harness loads both engines into separate `vm` contexts, which means some
surgery on the Worker source - stripping ES imports it cannot run, converting
one `let` to `var` so the prefetched specs can be injected from outside the
script. Each of those rewrites is guarded:

```js
if (/^import /m.test(worker)) throw new Error('an import survived');
if (worker.indexOf('var TARGET_SPECS_') < 0) throw new Error('could not expose TARGET_SPECS_');
```

Same instinct as the coverage check. A text substitution that silently does
nothing is how you end up testing a different program than you think.

The machine codes and capability figures in the committed copy are synthetic.
The method is the real thing.
