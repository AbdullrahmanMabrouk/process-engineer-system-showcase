# Four ways the platform corrupted correct code

Google Apps Script serves an HTML page by handing `HtmlService` a string. What
the browser receives is not always what you wrote. Over the life of this
project, four separate transformations silently mangled valid code on its way
out, and each one took down the **entire application, including login**.

They share a signature that makes them unusually nasty:

- the local file is valid - `node --check` passes
- the deployment succeeds
- the symptom is not an error message, it is a page that never finishes loading

The client is a single inline `<script>` block. Corrupt it anywhere and every
function in it becomes undefined at once. The login handler is in that block.
So the failure always presents identically - "the app is stuck on login" -
regardless of which of the four caused it, and regardless of where.

This document is the accumulated result of debugging that four times.

---

## 1. Doc comments are stripped, without parsing

Something in the serving pipeline removes `/** ... */` blocks. It finds them by
scanning text, with no idea what a string literal is.

A single stray `*/` inside a doc comment therefore terminates the comment
early, and the remainder of the comment body becomes code.

**Caught by:** extracting the inline script and running `node --check` on it
before every push. This is worth doing even though it cannot catch the other
three, because it catches this one instantly.

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');
const s=h.match(/<script>([\s\S]*)<\/script>/)[1];require('vm').compileFunction(s);
console.log('OK')"
```

## 2. A literal protocol URL truncates the line

Writing `'https://example.com/x'` inside a JavaScript string is fatal. The
sanitiser rewrites URLs as it serves, and **truncates the line at the URL** -
leaving an unterminated string literal, which kills the whole script block.

```js
const u = 'https://example.com/x';   // served as:  const u = '
```

`node --check` on the local file cannot catch this. The local file is genuinely
valid. Only the served copy is broken.

Plain `//` is fine - base64 data URIs are unaffected. It is specifically
protocol URLs. The fix is to build them by concatenation:

```js
const SVG_NS = 'http' + '://www.w3.org/2000/svg';
```

**Caught by:** a pre-push grep asserting zero literal protocol URLs anywhere in
the script. Cruder than the rule strictly requires, and much harder to get
wrong.

## 3. Non-ASCII characters become invalid tokens

An em-dash, an ellipsis, a bullet, an arrow, a smart quote - anything
multi-byte - gets corrupted somewhere between `clasp push` and what
`HtmlService` serves, producing invalid tokens that break the script block.

Again the local file is fine; it decodes correctly. Only the served copy is
mangled. This one shipped twice.

The rule is now absolute: the client file is ASCII-only. `-` for dashes, `...`
for ellipses, `->` for arrows, `v` for a chevron with a CSS rotation for its
toggled state.

**Caught by:** a pre-push check that must print `0`.

```bash
node -e "const h=require('fs').readFileSync('index.html','utf8');
const m=h.match(/[^\x00-\x7F]/g);console.log(m?m.length:0)"
```

## 4. `/*` inside a string opens a comment that eats real code

This is the worst of the four, and the most instructive.

The same naive text scan from hazard 1 has no awareness of string or
template-literal context. So a `/*` *inside a string* opens a comment as far as
the sanitiser is concerned - and that fake comment is closed by whatever the
next real `*/` happens to be. Every line in between is silently deleted.

The trigger was this, in an HTML attribute:

```html
<input type="file" accept="image/*">
```

That wildcard MIME type opened a comment which ran forward until the next
JSDoc closer, deleting a function that computed variance pairs and the colour
legend used by every table-type form across every department. The forms still
rendered. The variance colouring was simply gone.

The fix is to never write the wildcard:

```html
<input type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp">
```

**Caught by:** a heuristic that flags any `/*` with real content before it on
the same line - i.e. any `/*` that is not the start of a standalone comment.

## The only real proof

All four checks above are heuristics on the local file. The local file is not
the artefact. The artefact is what the deployment actually serves.

So the verification that actually settles it is to fetch the deployed `/exec`
URL, pull `userHtml` out of the `goog.script.init("...")` payload, extract the
`<script>` block from *that*, and syntax-check it. Diffing the served script
against the local one is what finally found hazard 4 - after three wrong
guesses.

## The other half: making failure visible

Because a corrupted script block makes every function undefined simultaneously,
the default symptom is a page that hangs with no console output the user will
ever look at. So the very first thing in the script block is:

```js
window.addEventListener('error', function (e) { /* render a visible banner */ });
```

It is the only thing that turns a silent hang into a message naming the actual
error. It looks like debug clutter that should have been removed before
shipping. Removing it is how you go back to debugging blind.

---

## What I take from this

The general lesson is not about Apps Script. It is that **your build artefact
is what ships, not what you wrote**, and any transformation between the two is
part of your system whether you chose it or not.

Three of these four are invisible to every local check, because every local
check validates the wrong file. Once that was clear, the fix was not smarter
local linting - it was a way to read the served output, plus cheap conservative
rules that make the dangerous constructs impossible to write by accident.

All four rules, and the exact commands, live in the deployment's contributor
notes where the next person will actually hit them.
