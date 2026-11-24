/* Offline check: turn a course's content/data.js into answer-bank entries.
 * The course below is synthetic, but every field name and shape is copied
 * from the real packages (5 question types, 38 questions, all inspected). */
const noop = () => {};
const el = { addEventListener: noop, appendChild: noop, querySelectorAll: () => [], querySelector: () => null, style: {}, attachShadow: () => ({ innerHTML: "", getElementById: () => ({ style: {} }) }) };
global.window = { addEventListener: noop, postMessage: noop, top: 1, self: 1 };
global.document = { addEventListener: noop, body: null, documentElement: el, createElement: () => el, querySelector: () => null, querySelectorAll: () => [] };
global.chrome = { runtime: { onMessage: { addListener: noop } } };
global.MutationObserver = class { observe() {} };
global.getComputedStyle = () => ({});

const { entriesFromCourse } = require("../src/content.js");

const en = (s) => ({ en: s });
const id = (n) => String(n).padStart(32, "0");

const course = {
  sections: [
    {
      id: id("s1"),
      questions: [
        { id: id("info"), type: "informationContent", title: en("Read this") },
        {
          id: id("st"), type: "statement", title: en("True or false?"), isSurvey: false,
          answers: [
            { id: id("a1"), text: en("The sky is blue."), isCorrect: true },
            { id: id("a2"), text: en("Fire is cold."), isCorrect: false },
          ],
        },
        {
          id: id("ss"), type: "singleSelectText", title: en("Pick one"), isSurvey: false,
          answers: [
            { id: id("b1"), text: en("Wrong"), isCorrect: false },
            { id: id("b2"), text: en("Right"), isCorrect: true },
          ],
        },
        {
          id: id("ms"), type: "multipleSelect", title: en("Pick all"), isSurvey: false,
          answers: [
            { id: id("c1"), text: en("Yes one"), isCorrect: true },
            { id: id("c2"), text: en("No"), isCorrect: false },
            { id: id("c3"), text: en("Yes two"), isCorrect: true },
          ],
        },
      ],
    },
    {
      id: id("s2"),
      questions: [
        {
          id: id("tm"), type: "textMatching", title: en("Match them"),
          answers: [
            { id: id("d1"), key: en("Black hat behavior"), value: en("Exploit weaknesses for harmful gain") },
            { id: id("d2"), key: en("White hat purpose"), value: en("Identify and fix vulnerabilities") },
          ],
        },
        {
          id: id("fb"), type: "fillInTheBlank", title: en("Fill it"),
          answerGroups: [
            // a dropdown blank: one correct of four
            { id: id("g1"), answers: [
              { id: "x", text: en("theft"), isCorrect: false, matchCase: true },
              { id: "y", text: en("Mobile device forensics."), isCorrect: true, matchCase: true },
              { id: "z", text: en("fraud"), isCorrect: false, matchCase: true },
              { id: "w", text: en("spam"), isCorrect: false, matchCase: true },
            ] },
            // a typed blank: one accepted answer
            { id: id("g2"), answers: [{ id: "v", text: en("Chain of Custody"), isCorrect: true, matchCase: true }] },
          ],
        },
        { id: id("sv"), type: "singleSelectText", title: en("Survey"), isSurvey: true,
          answers: [{ id: "s", text: en("Any"), isCorrect: false }] },
        { id: id("hs"), type: "hotspot", title: en("Click the spot") },
        { id: id("en"), type: "statement", title: en("Entities &amp; <b>markup</b>"),
          answers: [{ id: "e", text: en("Tom&#39;s <i>car</i>&nbsp;is red."), isCorrect: true }] },
      ],
    },
  ],
};

let fail = 0;
const expect = (cond, label) => { console.log((cond ? "  PASS  " : "  FAIL  ") + label); if (!cond) fail++; };
const by = {};
const out = entriesFromCourse(course);
for (const e of out) by[e.itype + ":" + e.qid.replace(/^0+/, "")] = e;

console.log(`\nconverted ${out.length} question(s)\n`);
expect(out.length === 6, `6 answerable questions (info, survey and hotspot skipped) - got ${out.length}`);
expect(out.every((e) => e.qid.length === 32), "every entry keyed by the 32-char question id");
expect(out.every((e) => e.src === "data"), "every entry marked as coming from data.js");

const st = by["statement:st"];
expect(st && st.type === "statement", "statement -> statement");
expect(st && st.options.map((o) => o.correct).join() === "true,false", "statement isCorrect = TRUE");

const ss = by["singleSelectText:ss"];
expect(ss && ss.type === "choice", "singleSelectText -> choice");
expect(ss && ss.options.filter((o) => o.correct).map((o) => o.text).join() === "Right", "single select marks the one right answer");

const ms = by["multipleSelect:ms"];
expect(ms && ms.type === "choice", "multipleSelect -> choice");
expect(ms && ms.options.map((o) => o.correct).join() === "true,false,true", "multiple select marks both right answers");
expect(ms && ms.options[0].id === id("c1"), "choice options keep their element id (for #list-item-<id>)");

const tm = by["textMatching:tm"];
expect(tm && tm.type === "matching", "textMatching -> matching");
expect(tm && tm.options[0].text === "Black hat behavior", "matching key is the row label");
expect(tm && tm.options[0].match === "Exploit weaknesses for harmful gain", "matching value is the answer");
expect(tm && tm.sectionId === id("s2"), "entry remembers its section");

const fb = by["fillInTheBlank:fb"];
expect(fb && fb.type === "fill-in", "fillInTheBlank -> fill-in");
expect(fb && fb.options.length === 2, "one option per blank");
expect(fb && fb.options[0].text === "Mobile device forensics.", "dropdown blank takes the isCorrect answer, punctuation kept");
expect(fb && fb.options[0].blank === id("g1"), "blank id is the answer group id (= input name)");
expect(fb && fb.options[1].text === "Chain of Custody", "typed blank keeps its exact case");

const ent = by["statement:en"];
expect(ent && ent.title === "Entities & markup", "titles lose markup and entities");
expect(ent && ent.options[0].text === "Tom's car is red.", "answer text loses markup, entities, nbsp");

expect(entriesFromCourse(null).length === 0, "no data -> no entries, no crash");
expect(entriesFromCourse({ sections: [{ questions: [{ id: "q", type: "textMatching", answers: [] }] }] }).length === 0,
  "a question with no answers is skipped");

console.log(fail ? `\n${fail} check(s) FAILED\n` : "\nall checks passed\n");
process.exit(fail ? 1 : 0);
