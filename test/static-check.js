/* Catches functions that are called but no longer defined - the exact damage
   a cleanup pass does silently, and which `node --check` cannot see.
   Comments and string literals are stripped first so prose and CSS do not
   look like calls. */
const fs = require("fs");
let src = fs.readFileSync(__dirname + "/../src/content.js", "utf8");

const code = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")      // block comments
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")  // line comments
  // one pass, left to right, so whichever quote opens first wins - stripping
  // single-quoted before double-quoted mis-reads "that's" and eats the rest
  .replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');

const declared = new Set();
for (const m of code.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of code.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declared.add(m[1]);
for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
  for (const part of m[1].split(",")) {
    const n = part.trim().split(/[\s=]/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
  }
}
for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
// extra declarators:  const a = 1, b = 2;
for (const m of code.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);

const builtin = new Set(("Promise Set Map Date Math JSON Object Array String Number Boolean Error RegExp " +
  "console window document location navigator chrome fetch setTimeout clearTimeout setInterval clearInterval " +
  "MutationObserver MouseEvent PointerEvent KeyboardEvent Event Blob URL CSS HTMLInputElement " +
  "HTMLTextAreaElement getComputedStyle module require exports if for while return typeof new catch try " +
  "switch function const let var await async of in this null true false undefined do else break continue " +
  "case default throw delete void instanceof class extends super yield import export from as Infinity NaN " +
  "parseInt parseFloat isNaN Symbol WeakSet WeakMap").split(" "));

const missing = new Set();
// plain calls:  foo(...)
for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
  const n = m[1];
  if (!declared.has(n) && !builtin.has(n)) missing.add(n);
}
// method calls on an object:  Foo.bar(...)  - the object must exist too
for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\s*\(/g)) {
  const n = m[1];
  if (!declared.has(n) && !builtin.has(n)) missing.add(n);
}

if (missing.size) {
  console.log("  FAIL  called but never defined: " + [...missing].join(", "));
  process.exit(1);
}
console.log("  PASS  every called function is defined");
