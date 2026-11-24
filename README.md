## Install

Works in any Chromium browser (Chrome, Helium, Brave, Edge).

1. Clone or download this repo, then open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder (the one containing `manifest.json`)
4. Open an activity. On a question, a round blue ⚡ button sits bottom-right *inside the
   course frame*. **Alt+F** does the same thing.

## Use

One button. A round ⚡ button sits in the bottom-right of the course frame, on
questions only. Click it:

1. If the question is locked after a wrong answer, it presses **Try again** first.
2. It looks the question up in the key read from `content/data.js` when the page
   opened, fills the answers, checks they stuck, and submits.

Fallback, only for a question the file does not cover: tick a throwaway answer and
press **Submit**, which forces the xAPI statement carrying `correctResponsesPattern`;
read the key out of that traffic, press Try again, then fill. Every question in this
course is in the file, so this path does not run here — but it is kept, because it is
the second finding and it works on packages that do not ship answers.

A short status line appears beside the button and fades. There is no other UI.

**Nothing is stored and nothing is logged.** The answer key lives in memory and dies
with the page. The extension declares no `storage`
permission, writes no files, and prints nothing to the console.


# ツ (lms3)

**lms2 embedded exploit for revision.**

A Chrome extension that demonstrates a **client-side validation flaw** in Easygenerator
e-learning packages (as delivered through Moodle / APIIT LMS). One click fills in and
submits the correct answer to the question on screen.

Built for a cybersecurity class demo on **already-completed, non-graded** tutorial modules.

---

## How it works, in 30 seconds

```
 LMS page (lms2.apiit.edu.my)
 └─ iframe: Easygenerator player (elearning-package.easygenerator.com)
      │
      │  page opens ──► player downloads content/data.js
      │                 (every question + every correct answer, plain JSON)
      │
      │  extension, running inside that iframe, fetches the same file
      │  and keeps the answers in memory
      │
      │  you click ⚡ (or Alt+F)
      ▼
   1. find the question     its id is in the URL: #/sections/<id>/questions/<id>
   2. unlock it             press "Try again" if a wrong answer locked it
   3. fill it               click / tick / pick / type the correct answers
   4. check it              re-read the page; refuse to submit if anything is missing
   5. submit                then read the player's own verdict
```

Two things make this possible, and both are the vulnerability:

1. **The answers ship to the browser before you start** (`content/data.js`).
2. **Every submit sends them again** (xAPI `correctResponsesPattern`). The extension keeps
   this as a fallback: if a question is ever missing from the file, it submits a throwaway
   answer, reads the key out of the network traffic, presses Try again, then fills.

Everything stays in memory. Nothing is stored, logged, or sent anywhere.

| File | Job |
| --- | --- |
| `src/content.js` | Everything: loads the key, finds the question, fills, verifies, submits, draws ⚡ |
| `src/inject.js` | Watches network traffic for the xAPI key (fallback path only) |
| `manifest.json` | Chrome MV3 manifest; runs both scripts in every frame at `document_start` |
| `test/` | Offline tests — run them with Node, no browser needed |

The rest of this README is the detail: the finding, every trap hit while building it,
and the selectors the player exposes.

---

## The finding

Easygenerator grades quizzes **in the browser**, so the browser has to hold the answers.
They leak through two channels.

### 1. The whole answer key is downloaded before the learner starts

Opening a course downloads `content/data.js`: plain JSON with every question **and its
answers**. Nothing is answered yet, nothing is submitted, and DevTools → Network already
shows the key.

```
{ "type": "statement",      "answers": [ { "text": {…}, "isCorrect": true }, … ] }
{ "type": "textMatching",   "answers": [ { "key": {…}, "value": {…} }, … ] }      ← already paired
{ "type": "fillInTheBlank", "answerGroups": [ { "answers": [ { "text": {…}, "isCorrect": true }, … ] } ] }
```

Measured across this course: **14 packages, 38 questions, 5 question types, every one
with its answer** (7 True/False, 6 single select, 4 multiple select, 4 matching,
17 fill-in-the-blank). The file is served without authentication; anyone who has the
package path can fetch it.

### 2. Every submit re-sends the key

When you submit an answer, the package emits an xAPI (Tin Can) `answered` statement, and
that statement carries the full marking scheme in `object.definition.correctResponsesPattern`:

```
"correctResponsesPattern": [
  "b957d600…[.]true[,]3b7e13ea…[.]false[,]30771f3e…[.]false[,]215aece2…[.]true"
],
"choices": [ { "id": "b957d600…", "description": { "en-US": "In a forensic investigation…" } }, … ]
```

The two agree: for the same question, `data.js` marks the statements TRUE / FALSE /
FALSE / TRUE and the leaked pattern says `true / false / false / true`.

So the answer key is in the client's memory **before** the learner answers. The server
is never asked "is this right?" — it is only *told* the score (`result.score.scaled`).

**Impact**
1. **Answer disclosure** — every correct answer for the whole course is readable with
   DevTools alone, before attempting a single question.
2. **Score integrity** — the score is attacker-controlled data, not a server verdict.
3. **No rate limit matters** — retries are irrelevant when the key is local.

**Fix (what a defender should recommend)**
- Grade server-side; send only the learner's response up, and the verdict down.
- Do not ship `isCorrect` / matching pairs / blank answers in `content/data.js`; the player
  needs the questions, not the answers.
- Strip `correctResponsesPattern` from client-bound statements; emit it server-side on the LRS.
- Sign/verify score statements, or derive the score from recorded responses rather than trusting the posted value.

---

### Question types

| Type | `data.js` type | Status | How |
| --- | --- | --- | --- |
| True/False statement grid | `statement` | verified live | `statement-true-radio-button` / `statement-false-radio-button` by name |
| Single select | `singleSelectText` | verified live | `#list-item-<answer id>`, text match as fallback |
| Multiple select | `multipleSelect` | verified live | same; ticks correct, clears wrong |
| Matching | `textMatching` | verified live | opens each row's `+`, reads `[data-test="item-selected"]` |
| Fill-in-the-blank (dropdown) | `fillInTheBlank` (1 of 4 correct) | verified live | same dropdown as matching |
| Fill-in-the-blank (text box) | `fillInTheBlank` (1 of 1) | verified live | `input[name="<blank id>"]`, native value setter |
| Rank order / sequencing | — | not supported | not used in this course |

"Verified live" means: in Moodle **Preview mode**, reset with *Go to results → Start a
new attempt* so the question was blank, then one click — graded "That's correct!" by the
player, with the key coming from `data.js` and no probe submit. Preview mode records
nothing to the gradebook.

### Identifying the question

In priority order, because the cheap signal turned out to be actively misleading:

1. The question id in `location.hash` (`#/sections/<32 hex>/questions/<32 hex>`) —
   the same id `data.js` uses, so this is an exact lookup
2. The exact `[data-test="question-title"]` text
3. Answer text found on the page — last resort, and rejected when the entry has a
   single short answer

Reason for that order: the probe step types an answer onto the page, so a one-answer
entry from a *different* question scores a perfect text match. It answered question 2
with question 1's key until the URL check went in.

The URL check was itself dead for a while: it required 16+ hex characters, the sample
in this repo had 8, and nobody checked a real URL. Real ids are 32.

### Verification

A fill is only counted once the page proves it. Every tick is confirmed via
`aria-checked`, matching rows are re-read at the end, and the reported number is the
number the page actually shows — not the number of clicks made. If anything is
missing it reports a miss and does **not** submit, so a failed run never sends a wrong
answer.

### Cleanup is a change, and needs the same proof

Deleting dead code broke this twice: three helpers and the `Answered` object were
removed while still in use. `node --check` cannot see that — a call to a function
that no longer exists is valid JavaScript, and it fails at runtime inside a
cross-origin iframe where there is no console to read.

`test/static-check.js` exists for exactly that. It was also wrong twice before it
worked (it stripped `'` before `"`, so `"that's"` swallowed the file; and it only
read the first name in `const a = 1, b = 2`). Verify the safety net catches the
thing it is for — delete a function on purpose and watch it fail.

### One place decides "is this answered?"

`Answered.control(el)` reads `aria-checked` — authoritative for radios and
checkboxes. `Answered.area(el, want, all)` reads an element's *rendered* text —
authoritative for matching rows and dropdown blanks. Everything else calls these.

This matters because the bugs below were all one reader getting it wrong, and
six near-duplicate readers meant six places for the next one to hide.

### Traps, all found the hard way

**Parsing**

- **`[.]` means two different things.** Matching is `sourceId[.]targetId`; fill-in is
  `value[.]blankId`. Check `interactionType` before parsing.
- **Matching ids are not unique across sides.** Sources and targets are both numbered
  `0,1,2,3`, so one shared lookup table lets targets overwrite sources.
- **The key carries sentence punctuation.** A blank's answer is `"hacker/attacker."`
  while the rendered option is `hacker/attacker`. Compare with trailing punctuation
  trimmed.

**Identifying the question**

- **The probe poisons answer-text matching.** It types an answer onto the page, so a
  one-answer entry from a *different* question scores a perfect text match. Use the
  question GUID in `location.hash` first, then the exact title.

**Reading the DOM**

- **`textContent` lies.** Every matching row carries a hidden copy of the full option
  list, so `row.textContent.includes(answer)` is true for *every* row.
- **The open panel renders inside its trigger.** While a dropdown is open the button's
  text contains every option, including the one being looked for.
- **Review mode shows the correct answers in the rows.** After a wrong submit the
  player displays the answer key inline, which reads exactly like a filled-in row.
  Only fill while Submit is showing — "Try again disappeared" is not the same signal.
- **A matching row has two `drop-spot-button` elements**, measured on the live page:
  a 36px `+` toggle wrapped in `[data-test="dropdown-input-wrapper"]`, and a 230px
  answer cell marked `[data-test="item-selected"]`. Click the first, read the second.

**The state machine**

Almost every bug in this project was one root cause wearing a different mask:
**acting on a question that was not accepting input.**

- After a submit the question locks until **Try again**. A locked question has no
  Submit button, ignores every click, and displays the correct answers inline.
- The signal for "locked" is **Try again being visible** — not "Submit is missing".
  The player re-renders on every answer, so Submit vanishes for a moment each time;
  reading that as a lock aborts the fill mid-way.
- Unlock **first**, before anything else. The probe has to answer and submit too, so
  it needs an answerable question just as much as the fill does.
- A control can read as already-answered from a value that is about to change, while
  the reset is still clearing it. Re-read and repair afterwards; never trust one
  sample taken mid-re-render.
- **Enter submits the question.** A keyboard fallback that presses Enter on a control
  will submit and lock the page, which then breaks every row after it. Only send
  Enter at an open dropdown menu.

**Trust the right element**

- **The `+` toggle lies, and so does its wrapper.** The 36px toggle carries the text of
  *one* option — the **same** option in every row, filled or not. The code read
  `dropdown-input-wrapper`, believing it was the answer cell. It is the toggle's
  wrapper. The result was two bugs that looked unrelated:
  - the one row whose answer happened to be that option always read as *filled*, so it
    was skipped and the question was submitted with a blank row;
  - every other row always read as *empty*, so the repair loop re-opened its `+` forever.
- The truth is `[data-test="item-selected"]`: it shows *"Click on the plus sign (+) to
  set/create a match."* when empty and the chosen answer when filled.
- This looked exactly like a timing bug and was not one. Four rounds of fixes —
  substring matching, settling, closing panels, subtracting text — each plausible, none
  right, because none of them were based on the actual DOM.

**Clicking**

- **React detaches everything you are holding.** Collecting all option elements then
  clicking them in a loop silently fails from the second click on, because the first
  click re-renders the list. Re-query before every click.
- **Duplicate labels are separate chips.** When two rows need the same answer the
  dropdown offers it twice; clicking the same one *moves* it off the earlier row.
  Pick the Nth instance, counting rows that already hold that label.
- **A synthetic click does not always commit a Downshift selection.** Four methods are
  tried — click, inner-element click, raw mouse events, keyboard — checking after each.
- **A stuck panel wedges the page.** Escape, then a click on neutral ground.

**Diagnosing**

**Measure, do not guess.** The question runs in a cross-origin iframe, so DevTools in
the LMS tab, the accessibility tree, and browser automation all stop at its edge. What
does work: the content script runs *inside* that frame, so have it
`window.top.postMessage(...)` a snapshot of what it sees (per row: key text, every
`drop-spot-button` with its width and text, `item-selected`, the wrapper) and read it
from the top page. One snapshot found the matching bug that four rounds of guessing
did not. It was removed once fixed.

The player's `data-test` names can also be read straight out of
`static/js/8.*.chunk.js` (the question components live in that chunk, not `main`).

The `answered` statement also carries `result.response`: the learner's own answer in
the same grammar as `correctResponsesPattern`. Diffing the two is the fastest way to
tell a mapping bug from a clicking bug — `0[.][,]1[.][,]2[.]2` says rows 0 and 1 were
submitted empty while row 2 was correct.

Banked answers carry a parser version, so an entry from an old parser can be told
apart from a fresh one.

## Player selectors

The Easygenerator player ships stable `data-test` attributes. These were read out of
`static/js/main.*.chunk.js` in the published package, so the extension targets elements
directly instead of guessing by size and position:

| Element | Selector |
| --- | --- |
| Submit | `[data-test="question-submit-button"]` |
| Try again | `[data-test="question-try-again-button"]` |
| True/False row | `[data-test="statement-answer"]` |
| True / False radio | `[data-test="statement-true-radio-button"]`, `[data-test="statement-false-radio-button"]` |
| Choice option | `#list-item-<answer id>`; text in `[data-test="answer-option-text"]` |
| Matching row | `[data-test="text-matching-item"]` |
| Matching source | `[data-test="text-matching-key"]` |
| Matching `+` (click) | `[data-test="dropdown-input-wrapper"] [data-test="drop-spot-button"]` (36px) |
| Matching answer (read) | `[data-test="item-selected"]` (230px) |
| Typed blank | `input[name="<blank id>"]` |
| Dropdown panel | `[data-test="dropdown-content"]` |
| Dropdown option | `[data-test="dropdown-item"]` |
| Fill-in-the-blank | `[data-test="fill-in-the-blank-content"]` |

The dropdown is a Downshift combobox rendered into a Tippy portal, so it is appended to
`document.body` rather than to the row — the extension polls for it after clicking `+`.

Geometry-based detection is kept as a fallback for players that do not emit these attributes.

## How it is wired

```
src/content.js   Isolated world, runs in every frame. In the player frame it fetches
                 content/data.js on load and banks every question's answers. Also parses
                 the xAPI pattern grammar (fallback), finds the question, fills it, checks
                 it, submits. Draws the ⚡ button.
src/inject.js    MAIN world. Hooks fetch / XMLHttpRequest / sendBeacon (requests AND
                 responses) and postMessages anything containing correctResponsesPattern.
                 Only matters for the fallback path.
src/popup.html   Toolbar popup: a one-line pointer to the ⚡ button.
test/            Offline tests (see below).
```

Pattern grammar handled:

| `interactionType` | Pattern | Meaning |
| --- | --- | --- |
| `choice` | `id[.]true[,]id2[.]false` | true/false statement grid |
| `choice` | `id1[,]id2` | correct choice ids |
| `matching` | `srcId[.]tgtId[,]…` | matching pairs |
| `fill-in` | `value[.]blankId[,]…` | blank answers |
| `fill-in` | `word1[,]word2` | blank answers, no blank ids |

Note the two `[.]` forms are **reversed**: matching is `id[.]id`, fill-in is
`value[.]id`. `interactionType` has to be checked first or a dropdown blank parses
as a matching question.

Matching source and target ids are numbered independently (both `0,1,2,3`), so they
need separate lookup tables.

## Test

```bash
node test/parse-test.js && node test/data-test.js && node test/static-check.js
```

`parse-test` runs the xAPI parser against a real captured statement plus synthetic cases
for every pattern shape. `data-test` converts a synthetic `data.js` covering all five
question types (plus the ones that must be skipped) — the shapes are copied from the real
packages, the answers are made up, so no real key lives in this repo. `static-check` catches functions that are called but no longer
defined — the exact damage a cleanup pass does silently, which `node --check` cannot see.

## Scope

Reads only what the course already sent to the browser. It does not touch the LMS backend,
other users, or authentication. Intended for authorised demonstration on your own completed
tutorial attempts — get your lecturer's OK before running it on anything graded.
