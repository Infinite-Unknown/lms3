/* Offline check: feed a real captured xAPI payload through the parser. */
const noop = () => {};
const el = { addEventListener: noop, appendChild: noop, querySelectorAll: () => [], querySelector: () => null, style: {}, attachShadow: () => ({ innerHTML: "", getElementById: () => ({ style: {} }) }) };
global.window = { addEventListener: noop, postMessage: noop, top: 1, self: 1 };
global.document = { addEventListener: noop, body: null, documentElement: el, createElement: () => el, querySelector: () => null, querySelectorAll: () => [] };
global.chrome = {
  storage: { local: { get: (k, cb) => cb({}), set: noop }, onChanged: { addListener: noop } },
  runtime: { onMessage: { addListener: noop } },
};
global.MutationObserver = class { observe() {} };
global.getComputedStyle = () => ({});

const { parseInteraction, harvest } = require("../src/content.js");

const payload = require("./sample-statement.json");
const found = harvest(payload);

let fail = 0;
const expect = (cond, label) => { console.log((cond ? "  PASS  " : "  FAIL  ") + label); if (!cond) fail++; };

console.log(`\nharvested ${found.length} question(s)\n`);
const q = found[0];
expect(!!q, "found an interaction");
expect(q.type === "statement", `type is "statement" (got "${q && q.type}")`);
expect(q.options.length === 4, `4 options (got ${q && q.options.length})`);

const want = [true, false, false, true];
q.options.forEach((o, i) => {
  expect(o.correct === want[i], `option ${i + 1} => ${want[i]} : "${o.text.slice(0, 48)}…"`);
});

console.log("\n--- extracted key ---");
for (const o of q.options) console.log(` ${o.correct ? "TRUE " : "FALSE"}  ${o.text.slice(0, 70)}…`);

/* synthetic coverage for the other pattern shapes */
const mk = (pattern, extra = {}) => ({ id: "x", definition: Object.assign({ name: { "en-US": "q" }, correctResponsesPattern: [pattern] }, extra) });
const mc = parseInteraction(mk("a[,]c", { interactionType: "choice", choices: [{ id: "a", description: { "en-US": "Alpha" } }, { id: "b", description: { "en-US": "Beta" } }, { id: "c", description: { "en-US": "Gamma" } }] }));
console.log("");
expect(mc.type === "choice", `multi-choice detected (got "${mc.type}")`);
expect(mc.options.map((o) => o.correct).join() === "true,false,true", "multi-choice marks a + c correct");

const fib = parseInteraction(mk("volatile[,]chain of custody", { interactionType: "fill-in" }));
expect(fib.type === "fill-in", `fill-in detected (got "${fib.type}")`);
expect(fib.options[1].text === "chain of custody", "fill-in keeps literal answers");

const mat = parseInteraction(mk("s1[.]t2[,]s2[.]t1", {
  interactionType: "matching",
  source: [{ id: "s1", description: { "en-US": "Hashing" } }, { id: "s2", description: { "en-US": "Imaging" } }],
  target: [{ id: "t1", description: { "en-US": "Bit-for-bit copy" } }, { id: "t2", description: { "en-US": "Integrity check" } }],
}));
expect(mat.type === "matching", `matching detected (got "${mat.type}")`);
expect(mat.options[0].match === "Integrity check", "matching resolves source -> target text");

/* Regression: Easygenerator numbers BOTH sides 0,1,2,3 so a shared id->text
   map lets the target clobber the source. Seen live as pattern "0[.]0[,]1[.]1". */
const collide = parseInteraction(mk("0[.]0[,]1[.]1", {
  interactionType: "matching",
  source: [
    { id: "0", description: { "en-US": "Objective of digital forensics" } },
    { id: "1", description: { "en-US": "Meaning of current state" } },
  ],
  target: [
    { id: "0", description: { "en-US": "To clarify the prior status of a digital artifact" } },
    { id: "1", description: { "en-US": "Conditions surrounding the artifact before examination" } },
  ],
}));
console.log("");
expect(collide.type === "matching", "colliding ids still parse as matching");
expect(collide.options[0].text === "Objective of digital forensics",
  `source 0 keeps its own text (got "${collide.options[0].text.slice(0, 40)}")`);
expect(collide.options[0].match === "To clarify the prior status of a digital artifact",
  "target 0 resolves separately");
expect(collide.options[0].text !== collide.options[0].match,
  "source and target are not the same string");
expect(collide.options[1].text === "Meaning of current state", "source 1 keeps its own text");

/* Dropdown fill-in-the-blank, captured live. The pattern is "value[.]blankId",
   which is the REVERSE of matching's "sourceId[.]targetId" - without checking
   interactionType first this parses as a matching question. */
const blank = parseInteraction(mk("theft.[.]41321dc61b5d4bb2bce633c64c3893de", {
  interactionType: "fill-in",
}));
console.log("");
expect(blank.type === "fill-in", `dropdown blank is fill-in, not matching (got "${blank.type}")`);
expect(blank.options.length === 1, "one blank");
expect(blank.options[0].text === "theft.", `answer is the value (got "${blank.options[0].text}")`);
expect(blank.options[0].blank === "41321dc61b5d4bb2bce633c64c3893de", "blank id kept separately");
expect(blank.options[0].correct === true, "blank answer marked correct");

const twoBlanks = parseInteraction(mk("alpha[.]b1[,]beta[.]b2", { interactionType: "fill-in" }));
expect(twoBlanks.options.map((o) => o.text).join() === "alpha,beta", "two blanks keep order");
expect(twoBlanks.options.map((o) => o.blank).join() === "b1,b2", "two blank ids kept");

const plainBlank = parseInteraction(mk("volatile[,]chain of custody", { interactionType: "fill-in" }));
expect(plainBlank.options.map((o) => o.text).join() === "volatile,chain of custody",
  "blanks with no id still parse");

/* Entries carry the parser version so a stale bank cannot feed bad data
   into the filler after a parsing fix. */
console.log("");
expect(typeof blank.pv === "number", "entries carry a parser version");
expect(blank.pv === collide.pv, "all entries stamp the same version");

console.log(fail ? `\n${fail} FAILED\n` : "\nall checks passed\n");
process.exit(fail ? 1 : 0);
