/* EG Answer Lab - isolated world.
 * Receives xAPI payloads from inject.js, builds an answer bank,
 * and fills the on-screen question when the popup asks it to.
 * No on-page UI: everything is driven from the toolbar popup.
 */
(() => {
  "use strict";
  const TAG = "__EG_ANSWER_LAB__";
  const HOST_ID = "eg-answer-lab-host";
  // Bump whenever parseInteraction changes meaning. Entries banked by an older
  // parser are discarded on load instead of being filled from bad data.
  const PARSER_V = 5;

  let BANK = {};
  let busy = false;
  let lastFillLog = null;
  let captureSeq = 0;
  let lastCaptured = [];   // qids from the most recent capture
  let lastDropdown = null;
  const RESPONSES = {};   // qid -> the last result.response we sent

  /* Easygenerator ships stable data-test attributes. Read out of the player
     bundle (main.*.chunk.js) - far more reliable than geometry guessing. */
  const SEL = {
    submit: '[data-test="question-submit-button"],[data-test="question-block-submit-button"]',
    tryAgain: '[data-test="question-try-again-button"],[data-test="question-block-try-again-button"]',
    container: '[data-test="question-container"]',
    title: '[data-test="question-title"]',
    statementRow: '[data-test="statement-answer"]',
    stmtTrue: '[data-test="statement-true-radio-button"]',
    stmtFalse: '[data-test="statement-false-radio-button"]',
    optionText: '[data-test="answer-option-text"]',
    matchRow: '[data-test="text-matching-item"]',
    matchKey: '[data-test="text-matching-key"]',
    dropSpot: '[data-test="drop-spot-button"]',
    dropWrapper: '[data-test="dropdown-input-wrapper"]',
    itemSelected: '[data-test="item-selected"]',
    correctLabel: '[data-test="correct-answer-label"]',
    dropdown: '[data-test="dropdown-content"]',
    dropdownItem: '[data-test="dropdown-item"]',
    blanks: '[data-test="fill-in-the-blank-content"]',
  };
  const qa = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (_) { return []; }
  };
  const q1 = (sel, root) => qa(sel, root)[0] || null;

  /* ------------------------------------------------------------------ utils */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const norm = (s) =>
    (s || "")
      .replace(/[‘’“”]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const lang = (o) => {
    if (!o) return "";
    if (typeof o === "string") return o;
    return o["en-US"] || o["en"] || Object.values(o)[0] || "";
  };

  const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");

  const where = () => (window.top === window.self ? "top" : "frame");

  let panel = null;   // set up later by mountPanel()

  // Status goes to the on-page chip and nowhere else: nothing is written to
  // storage and nothing is logged, so no answer key ever leaves the page.
  function report(state, msg) {
    try { if (panel) panel.status(state, msg); } catch (_) {}
  }

  /* --------------------------------------------------------------- parsing */
  // xAPI / Easygenerator correctResponsesPattern grammar:
  //   "id[.]true[,]id2[.]false"   -> statement grid (true/false per row)
  //   "id1[,]id2"                 -> single / multiple choice (choice ids)
  //   "src[.]tgt[,]src2[.]tgt2"   -> matching pairs
  //   "word1[,]word2"             -> fill-in-the-blank literals
  function parseInteraction(obj) {
    const d = obj && obj.definition;
    if (!d || !Array.isArray(d.correctResponsesPattern) || !d.correctResponsesPattern.length) return null;

    const pattern = d.correctResponsesPattern[0];
    const itype = d.interactionType || "";
    const title = stripHtml(lang(d.name)).trim();
    const qid = obj.id || title;
    if (!qid) return null;

    const choices = (d.choices || []).map((c) => ({
      id: c.id,
      text: stripHtml(lang(c.description)).trim(),
    }));

    // Source and target ids are NOT globally unique - Easygenerator numbers both
    // sides 0,1,2,3 (pattern "0[.]0[,]1[.]1"). One shared lookup table makes the
    // target overwrite the source, so keep a table per side.
    const srcText = {}, tgtText = {};
    for (const c of choices) { srcText[c.id] = c.text; tgtText[c.id] = c.text; }
    for (const x of d.source || []) srcText[x.id] = stripHtml(lang(x.description)).trim();
    for (const x of d.target || []) tgtText[x.id] = stripHtml(lang(x.description)).trim();
    const idText = tgtText;   // non-matching types only ever use one side

    const tokens = String(pattern).split("[,]").filter(Boolean);
    const boolRe = /^(.*)\[\.\](true|false)$/i;

    let type = "choice";
    const flag = {};
    const pair = {};
    let literals = [];

    if (/fill-in/i.test(itype)) {
      // "theft.[.]41321dc6..."  = answer [.] blank id   (reverse of matching)
      // plain "theft." when the player does not id the blank
      type = "fill-in";
      literals = tokens.map((t) => {
        const i = t.lastIndexOf("[.]");
        return i >= 0 ? { value: t.slice(0, i), blank: t.slice(i + 3) } : { value: t, blank: null };
      });
    } else if (tokens.length && tokens.every((t) => boolRe.test(t))) {
      type = "statement";
      for (const t of tokens) {
        const m = t.match(boolRe);
        flag[m[1]] = m[2].toLowerCase() === "true";
      }
    } else if (tokens.some((t) => t.includes("[.]"))) {
      type = "matching";
      for (const t of tokens) {
        const i = t.indexOf("[.]");
        pair[t.slice(0, i)] = t.slice(i + 3);
      }
    } else if (choices.length && tokens.some((t) => choices.some((c) => c.id === t))) {
      type = /sequencing|rank|order/i.test(itype) ? "sequencing" : "choice";
      for (const t of tokens) flag[t] = true;
      literals = tokens.slice();
    } else {
      type = "fill-in";
      literals = tokens.map((t) => ({ value: t, blank: null }));
    }

    let options;
    if (type === "matching") {
      options = Object.keys(pair).map((sid) => ({
        id: sid,
        text: srcText[sid] || sid,
        match: tgtText[pair[sid]] || pair[sid],
        correct: null,
      }));
    } else if (type === "sequencing") {
      options = literals.map((id, i) => ({ id, text: idText[id] || id, order: i + 1, correct: null }));
    } else if (type === "fill-in") {
      options = literals.map((l, i) => ({
        id: (l && l.blank) || "blank" + (i + 1),
        text: l && typeof l === "object" ? l.value : l,
        blank: (l && l.blank) || null,
        correct: true,
      }));
    } else {
      options = choices.map((c) => ({ id: c.id, text: c.text, correct: !!flag[c.id] }));
    }

    const raw = {};
    if (type === "matching" || type === "fill-in") {
      if (d.source) raw.source = d.source.map((x) => ({ id: x.id, text: stripHtml(lang(x.description)).trim().slice(0, 40) }));
      if (d.target) raw.target = d.target.map((x) => ({ id: x.id, text: stripHtml(lang(x.description)).trim().slice(0, 40) }));
      if (d.choices) raw.choices = d.choices.map((x) => ({ id: x.id, text: stripHtml(lang(x.description)).trim().slice(0, 40) }));
    }
    return { qid, title, type, itype, pattern, options, raw, pv: PARSER_V, seen: Date.now() };
  }

  // The answered statement also reports result.response - the learner's own
  // answer in the same grammar as correctResponsesPattern. Diffing the two
  // shows exactly which ids our clicks actually selected.
  function harvestResponses(payload) {
    const out = {};
    const seen = new Set();
    const walk = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 10) return;
      if (Array.isArray(n)) { n.forEach((v) => walk(v, depth + 1)); return; }
      if (n.object && n.object.id && n.result && typeof n.result.response === "string") {
        out[n.object.id] = n.result.response;
      }
      for (const k in n) {
        let v; try { v = n[k]; } catch (_) { continue; }
        if (v && typeof v === "object" && !seen.has(v)) { seen.add(v); walk(v, depth + 1); }
      }
    };
    walk(payload, 0);
    return out;
  }

  function harvest(payload) {
    const byId = new Map();
    const seen = new Set();
    const walk = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 10) return;
      if (Array.isArray(n)) { n.forEach((v) => walk(v, depth + 1)); return; }
      if (n.definition && n.definition.correctResponsesPattern) {
        const e = parseInteraction(n);
        if (e && !byId.has(e.qid)) byId.set(e.qid, e);
      }
      for (const k in n) {
        let v; try { v = n[k]; } catch (_) { continue; }
        if (v && typeof v === "object" && !seen.has(v)) { seen.add(v); walk(v, depth + 1); }
      }
    };
    walk(payload, 0);
    return Array.from(byId.values());
  }

  /* --------------------------------------------------------- course data */
  // The player downloads content/data.js the moment the course opens. It is
  // plain JSON, and it carries every question WITH its answers - before the
  // learner has answered anything. Reading it means no throwaway submit, no
  // Try again, and no waiting on the network: the key is already here.
  //
  // Measured across all 38 questions in the course:
  //   statement         answers[].isCorrect   true = the statement is TRUE
  //   singleSelectText  answers[].isCorrect
  //   multipleSelect    answers[].isCorrect
  //   textMatching      answers[] = { key, value }, already correctly paired
  //   fillInTheBlank    answerGroups[] = one per blank; one isCorrect each
  //                     (1 of 4 = dropdown blank, 1 of 1 = typed blank)
  // The statement mapping was checked against a captured xAPI key for the same
  // question: the two agree option for option.
  const decodeEntities = (s) => String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'");
  const plain = (v) => decodeEntities(stripHtml(lang(v))).replace(/\s+/g, " ").trim();

  function entryFromQuestion(q, sectionId) {
    if (!q || !q.id || q.isSurvey) return null;
    const base = {
      qid: String(q.id), sectionId: sectionId || null, title: plain(q.title),
      itype: q.type, pattern: null, raw: {}, pv: PARSER_V, seen: 0, src: "data",
    };
    const flagged = () => (q.answers || []).map((a) => ({ id: a.id, text: plain(a.text), correct: !!a.isCorrect }));

    if (q.type === "statement") return Object.assign(base, { type: "statement", options: flagged() });
    if (q.type === "singleSelectText" || q.type === "multipleSelect") {
      return Object.assign(base, { type: "choice", options: flagged() });
    }
    if (q.type === "textMatching") {
      return Object.assign(base, {
        type: "matching",
        options: (q.answers || []).map((a) => ({ id: a.id, text: plain(a.key), match: plain(a.value), correct: null })),
      });
    }
    if (q.type === "fillInTheBlank") {
      const options = [];
      for (const g of q.answerGroups || []) {
        const list = g.answers || [];
        const right = list.find((a) => a.isCorrect) || list[0];
        if (!right) continue;
        // typed answers are compared exactly by the player (matchCase), so
        // keep the text as authored - only markup and spacing are cleaned
        options.push({ id: g.id, text: plain(right.text), blank: g.id, correct: true });
      }
      return options.length ? Object.assign(base, { type: "fill-in", options }) : null;
    }
    return null;          // informationContent, or a type we cannot fill
  }

  function entriesFromCourse(data) {
    const out = [];
    for (const s of (data && data.sections) || []) {
      for (const q of s.questions || []) {
        const e = entryFromQuestion(q, s.id);
        if (e && e.options.length) out.push(e);
      }
    }
    return out;
  }

  // One fetch per frame, started as early as possible. Only the player's own
  // frame can reach the file (same origin); every other frame resolves to 0.
  let courseLoad = null;
  function loadCourseData() {
    if (courseLoad) return courseLoad;
    const host = (typeof location !== "undefined" && location.hostname) || "";
    if (!/(^|\.)easygenerator\.com$/i.test(host) || typeof fetch !== "function") {
      return (courseLoad = Promise.resolve(0));
    }
    let url;
    try { url = new URL("content/data.js", location.href).href; } catch (_) { return (courseLoad = Promise.resolve(0)); }
    courseLoad = fetch(url, { credentials: "same-origin", cache: "force-cache" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        const start = t.indexOf("{");
        if (start < 0) return 0;
        const found = entriesFromCourse(JSON.parse(t.slice(start)));
        for (const e of found) BANK[e.qid] = e;
        return found.length;
      })
      .catch(() => 0);
    return courseLoad;
  }

  /* ------------------------------------------------------------- storage */
  // The bank is in memory only. It holds what the current page's traffic
  // revealed while solving, and dies with the page.
  function save() { /* intentionally not persisted */ }

  /* -------------------------------------------------------------- DOM find */
  function allElements() {
    const out = [];
    const walk = (root) => {
      let list;
      try { list = root.querySelectorAll("*"); } catch (_) { return; }
      for (const el of list) {
        if (el.id === HOST_ID) continue;          // never touch our own panel
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    let cs; try { cs = getComputedStyle(el); } catch (_) { return false; }
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function pointer(el) {
    try { return getComputedStyle(el).cursor === "pointer"; } catch (_) { return false; }
  }

  function findTextNode(text, pool) {
    const want = norm(text);
    if (!want) return null;
    const hits = [];
    for (const el of pool) {
      const t = norm(el.textContent);
      if (!t) continue;
      const exact = t === want;
      const prefix = want.length > 30 && t.startsWith(want.slice(0, 50)) && t.length <= want.length + 30;
      if (exact || prefix) hits.push(el);
    }
    if (!hits.length) return null;
    const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    return deepest.find(visible) || deepest[0] || hits[0];
  }

  const CTRL_SEL =
    'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],' +
    '[class*="radio" i],[class*="checkbox" i],[class*="choice-mark" i]';

  function dedupeControls(list) {
    const out = [];
    for (const el of list) {
      const idx = out.findIndex((o) => o.contains(el) || el.contains(o));
      if (idx !== -1) { if (el.tagName === "INPUT") out[idx] = el; continue; }
      out.push(el);
    }
    return out.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  }

  function controlsIn(el) {
    let list = Array.from(el.querySelectorAll(CTRL_SEL)).filter(visible);
    if (list.length) return dedupeControls(list);
    list = Array.from(el.querySelectorAll("*")).filter((n) => {
      if (!visible(n)) return false;
      if (n.children.length > 1) return false;
      if (norm(n.textContent).length > 2) return false;
      const r = n.getBoundingClientRect();
      return r.width >= 10 && r.width <= 48 && r.height >= 10 && r.height <= 48 &&
             Math.abs(r.width - r.height) <= 10;
    });
    return dedupeControls(list);
  }

  function rowFor(textEl, need) {
    let el = textEl;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      const c = controlsIn(el);
      if (c.length >= need) return { row: el, controls: c };
      el = el.parentElement;
    }
    return null;
  }

  function clickableAncestor(el) {
    let n = el;
    for (let i = 0; i < 6 && n && n !== document.body; i++) {
      const tag = n.tagName;
      const role = n.getAttribute && n.getAttribute("role");
      if (tag === "BUTTON" || tag === "A" || tag === "LI" || role === "button" || role === "option") return n;
      if (pointer(n)) return n;
      n = n.parentElement;
    }
    return el;
  }

  function activate(el) {
    try { el.scrollIntoView({ block: "center" }); } catch (_) {}
    if (el.tagName === "INPUT") {
      if (!el.checked) {
        el.click();
        if (!el.checked) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set;
          setter.call(el, true);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      return true;
    }
    for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
    // native click last: fires the real activation path for buttons and links
    try { el.click(); }
    catch (_) { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
    return true;
  }

  // text of an element's own text nodes only, so <div>True<span/></div> still reads "true"
  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return norm(t);
  }

  // Locate the True / False column centres from the header chips above the rows.
  function trueFalseColumns(pool, rowTops) {
    const firstRow = rowTops && rowTops.length ? Math.min.apply(null, rowTops) : Infinity;
    const buckets = { true: [], false: [] };
    for (const el of pool) {
      const t = ownText(el);
      if (t !== "true" && t !== "false") continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 180) continue;                       // a wrapper, not a chip
      buckets[t].push({ cx: r.left + r.width / 2, top: r.top });
    }
    const pick = (list) => {
      if (!list.length) return null;
      const above = list.filter((c) => c.top < firstRow - 4);
      const use = above.length ? above : list;
      use.sort((a, b) => a.top - b.top);
      return use[0].cx;
    };
    const tx = pick(buckets["true"]);
    const fx = pick(buckets["false"]);
    if (tx === null || fx === null || Math.abs(tx - fx) < 8) return null;
    return { tx, fx };
  }

  /* --------------------------------------------- matching: find the + button */
  /* --------------------------------------------- DOM diffing & page buttons */
  function findButton(re, scope) {
    const root = scope || document;
    let pool;
    try { pool = Array.from(root.querySelectorAll("button,[role=\"button\"],a,input,div,span,p")); }
    catch (_) { return null; }
    const hits = [];
    for (const el of pool) {
      const t = norm(el.tagName === "INPUT" ? el.value : el.textContent);
      if (!t || t.length > 24 || !re.test(t)) continue;   // cheap test first
      if (!visible(el)) continue;
      hits.push(el);
    }
    if (!hits.length) return null;
    const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    const clickable = deepest.filter(
      (el) => el.tagName === "BUTTON" || el.tagName === "INPUT" ||
              (el.getAttribute && el.getAttribute("role") === "button") || pointer(el)
    );
    const pick = clickable[0] || deepest[0];
    return pick ? clickableAncestor(pick) : null;
  }

  // the block of page that holds the question, derived from the Submit button
  function questionScope() {
    const btn = findButton(/^submit$/i) || findButton(/^(try again|next)$/i);
    let n = btn || document.body;
    for (let i = 0; i < 6 && n && n !== document.body; i++) {
      const r = n.getBoundingClientRect();
      if (r.height > 220) return n;
      n = n.parentElement;
    }
    return document.body;
  }

  // Circular "+" buttons stacked in a COLUMN -> a matching question.
  // The column test matters: without it a lone hamburger or back-arrow icon
  // looks identical to a + button and gets clicked.
  function plusButtons(scope) {
    const out = [];
    let pool;
    try { pool = Array.from(scope.querySelectorAll("*")); } catch (_) { return out; }
    for (const el of pool) {
      if (el.id === HOST_ID) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 18 || r.width > 60 || Math.abs(r.width - r.height) > 10) continue;
      const t = norm(el.textContent);
      if (t.length > 1) continue;
      if (!visible(el)) continue;
      if (!pointer(el) && el.tagName !== "BUTTON" &&
          !(el.getAttribute && el.getAttribute("role") === "button")) continue;
      out.push(el);
    }
    const dedup = out.filter((el) => !out.some((o) => o !== el && el.contains(o)));

    // keep only the largest group sharing an x position - that is the column
    const groups = new Map();
    for (const el of dedup) {
      const r = el.getBoundingClientRect();
      const key = Math.round((r.left + r.width / 2) / 10);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }
    let best = [];
    for (const g of groups.values()) if (g.length > best.length) best = g;
    if (best.length < 2) return [];
    return best.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function setValue(el, val) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ------------------------------- seed ANY answer so we can force a submit */
  async function seedAnswer() {
    // statement grid: tick the first control of every row
    const liveStRows = () => qa(SEL.statementRow).filter(visible);
    const stCount = liveStRows().length;
    if (stCount) {
      for (let i = 0; i < stCount; i++) {
        const row = liveStRows()[i];
        if (!row) continue;
        let c = qa('[role="radio"]', row).filter(visible);
        if (c.length < 2) c = controlsIn(row);
        if (c[0]) { activate(c[0]); await sleep(60); }
      }
      return "statement x" + stCount;
    }

    // text matching: open each dropdown and take whatever is first
    const liveMRows = () => qa(SEL.matchRow).filter(visible);
    const mCount = liveMRows().length;
    if (mCount) {
      for (let i = 0; i < mCount; i++) {
        const getBtn = () => answerSlot(liveMRows()[i]);
        const btn = getBtn();
        if (!btn) continue;
        activate(btn);
        const dd = await waitForDropdown(2200);
        if (dd) {
          const first = qa(SEL.dropdownItem, dd).filter(visible)[0];
          if (first) await pickFromDropdown(getBtn, norm(first.innerText || first.textContent), 0);
          else { activate(btn); await waitForDropdownClosed(700); }
        }
        await sleep(120);
      }
      return "matching x" + mCount;
    }

    // single / multiple choice
    const opts = qa(SEL.optionText).filter(visible);
    if (opts.length) { activate(clickableAncestor(opts[0])); return "choice"; }

    // fill in the blanks - dropdown style first, then plain text boxes
    const blankScope = q1(SEL.blanks);
    if (blankScope) {
      const liveB = () => qa(SEL.dropSpot, q1(SEL.blanks) || document).filter(visible);
      const bCount = liveB().length;
      if (bCount) {
        for (let i = 0; i < bCount; i++) {
          const getBtn = () => liveB()[i];
          const btn = getBtn();
          if (!btn) continue;
          activate(btn);
          const dd = await waitForDropdown(2200);
          if (dd) {
            const first = qa(SEL.dropdownItem, dd).filter(visible)[0];
            if (first) await pickFromDropdown(getBtn, norm(first.innerText || first.textContent), 0);
            else { activate(btn); await waitForDropdownClosed(700); }
          }
          await sleep(120);
        }
        return "blank-dropdowns x" + bCount;
      }
      const ins = qa('input[type="text"],input:not([type]),textarea', blankScope).filter(visible);
      ins.forEach((el) => setValue(el, "a"));
      if (ins.length) return "blanks x" + ins.length;
    }

    // any other Downshift dropdown that is not part of a matching row
    const looseSpots = qa(SEL.dropSpot).filter(visible).filter((el) => !el.closest(SEL.matchRow));
    if (looseSpots.length) {
      for (const btn of looseSpots) {
        activate(btn);
        const dd = await waitForDropdown(2200);
        if (dd) {
          const first = qa(SEL.dropdownItem, dd).filter(visible)[0];
          if (first) await pickFromDropdown(() => btn, norm(first.innerText || first.textContent), 0);
          else { activate(btn); await waitForDropdownClosed(700); }
        }
        await sleep(120);
      }
      return "dropdowns x" + looseSpots.length;
    }

    /* ---- fallbacks for players without data-test attributes ---- */
    const scope = questionScope();

    const radios = qa('input[type="radio"]', scope).filter(visible);
    if (radios.length) {
      const groups = new Map();
      for (const r of radios) {
        const key = r.name || Math.round(r.getBoundingClientRect().top / 10);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      for (const g of groups.values()) activate(g[0]);
      return "radio x" + groups.size;
    }

    const boxes = qa('input[type="checkbox"]', scope).filter(visible);
    if (boxes.length) { activate(boxes[0]); return "checkbox"; }

    const texts = qa('input[type="text"],input:not([type]),textarea', scope).filter(visible);
    if (texts.length) { texts.forEach((t) => setValue(t, "a")); return "text x" + texts.length; }

    const ctrls = controlsIn(scope);
    if (ctrls.length) {
      const rows = new Map();
      for (const c of ctrls) {
        const r = c.getBoundingClientRect();
        const key = Math.round((r.top + r.height / 2) / 14);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(c);
      }
      for (const g of rows.values()) {
        activate(g.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]);
      }
      return "custom x" + rows.size;
    }
    return null;
  }

  // does this DOM node's text contain the option text we are looking for?
  // The key often carries the sentence's punctuation ("hacker/attacker.")
  // while the rendered option does not, so compare trimmed forms too.
  const trimPunct = (x) => norm(x).replace(/[.,;:!?\u2026]+$/g, "").trim();

  function matchesText(haystack, want) {
    const t = norm(haystack);
    const w = norm(want);
    if (!t || !w) return false;
    if (t === w || t.includes(w.slice(0, Math.min(70, w.length)))) return true;
    const tp = trimPunct(t), wp = trimPunct(w);
    if (!tp || !wp) return false;
    return tp === wp || tp.includes(wp.slice(0, Math.min(70, wp.length)));
  }

  function textHas(el, want) {
    if (!el) return false;
    return matchesText(el.textContent, want);
  }

  async function waitForDropdown(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const dd = qa(SEL.dropdown).filter(visible)[0];
      if (dd && qa(SEL.dropdownItem, dd).length) return dd;
      await sleep(110);
    }
    return null;
  }

  /* --------------------------------------------------------- answered? ---
     ONE place that decides whether something is answered, and which element
     is authoritative for each kind of control. Every caller uses these.

     control(el)         -> true | false | null   (null = cannot tell)
         aria-checked on el or its nearest ancestor that carries it.
         Authoritative for radios and checkboxes.

     area(el, want, all) -> boolean
         True when el's RENDERED text shows `want` and nothing else from
         `all`. Authoritative for matching rows and dropdown blanks, whose
         toggle buttons keep a stale class and text after a reset.          */
  // What the player prints in a match slot that holds nothing.
  const EMPTY_SLOT = /click on the plus sign|set\s*\/\s*create a match/i;

  const Answered = {
    control(el) {
      if (!el) return null;
      const v = ariaOf(el, "aria-checked");
      return v === null ? null : v === "true";
    },
    area(el, want, all, read) {
      if (!el) return false;
      const t = (read || spotText)(el);
      // The player spells out an empty slot. Believing it beats inferring
      // emptiness from text that may have leaked in from somewhere else.
      if (EMPTY_SLOT.test(t)) return false;
      if (!t || !matchesText(t, want)) return false;
      if (!all || !all.length) return true;
      // several different answers in one area means the option list leaked in
      const distinct = new Set(all.filter((x) => matchesText(t, x)).map((x) => norm(x)));
      return distinct.size === 1;
    },
  };

  const anyDropdownOpen = () => qa(SEL.dropdown).filter(visible).length > 0;

  async function waitForDropdownClosed(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (!qa(SEL.dropdown).filter(visible)[0]) return true;
      await sleep(110);
    }
    return false;
  }

  // A panel left open blocks the rest of the page, which is what forces a
  // full reload. Escape, then a click on neutral ground.
  async function forceCloseDropdown() {
    if (!anyDropdownOpen()) return true;
    for (const el of [document.activeElement, document.body, document.documentElement]) {
      if (!el) continue;
      pressKey(el, "Escape", 27);
      if (await waitForDropdownClosed(500)) return true;
    }
    try {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    return await waitForDropdownClosed(800);
  }

  // Reading a row while its list is open is meaningless: the open list is
  // rendered in the row, so spotText() strips it out and the row reads EMPTY
  // even when it holds the right answer. That is what made it reopen the same
  // "+" over and over. Close first, then look.
  async function quietDropdowns(ms) {
    if (!anyDropdownOpen()) return true;
    if (await waitForDropdownClosed(ms || 900)) return true;
    return await forceCloseDropdown();
  }

  /* The matching dropdown is a Downshift combobox inside a Tippy portal.
     A plain click does not always commit the selection, so try several ways
     and VERIFY each one against the button's own state before moving on.
     An unpicked button's className contains "empty"; once picked it shows the answer. */
  function pressKey(el, k, code) {
    const mk = (type) =>
      new KeyboardEvent(type, { key: k, code: k, keyCode: code, which: code, bubbles: true, cancelable: true });
    try { el.dispatchEvent(mk("keydown")); el.dispatchEvent(mk("keyup")); } catch (_) {}
  }

  function rawClick(el) {
    for (const t of ["mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEvent(t, {
          bubbles: true, cancelable: true, view: window, button: 0, buttons: t === "mousedown" ? 1 : 0,
        }));
      } catch (_) {}
    }
  }

  const PICK_STRATEGIES = [
    { name: "click", run: (item) => item.click() },
    { name: "inner-click", run: (item) => (item.firstElementChild || item).click() },
    { name: "raw-events", run: (item) => rawClick(item) },
    {
      // Enter on the toggle button submits the whole QUESTION when the menu is
      // not open - that is what was locking the page mid-fill. Only ever send
      // keys at an open panel, never at the button.
      name: "keyboard",
      run: (item, index, btn) => {
        const dd = qa(SEL.dropdown).filter(visible)[0];
        if (!dd) return;                       // no open menu: do not touch Enter
        const target = item || dd;
        for (let i = 0; i <= index; i++) pressKey(target, "ArrowDown", 40);
        pressKey(target, "Enter", 13);
      },
    },
  ];

  // The open dropdown panel can live INSIDE the trigger's subtree, so the
  // button's textContent then contains every option - including the one we
  // want. Strip the panel, and refuse to judge while any panel is open.
  // textContent includes hidden nodes. Every matching row carries a hidden copy
  // of the whole option list, so textContent made every row look answered.
  // innerText only reports what is actually rendered.
  function spotText(el) {
    let t = "";
    try { t = el.innerText || ""; } catch (_) {}
    if (!t) { try { t = el.textContent || ""; } catch (_) {} }
    t = norm(t);
    if (!t) return t;
    // Subtract anything that is not the chosen answer: an open panel rendered
    // inside the trigger, and the "correct answer" hint the player shows after
    // a wrong submit (which otherwise reads as if the row were filled in).
    // Strip panels whether or not they read as visible: Tippy keeps its popper
    // mounted with opacity 0, which innerText still reports. That leaks the
    // whole option list into the slot and makes every row look answered.
    const noise = [];
    for (const dd of qa(SEL.dropdown)) {
      if (el === dd || (el.contains && el.contains(dd))) noise.push(dd);
    }
    for (const dd of qa(SEL.dropdown, el)) noise.push(dd);
    for (const it of qa(SEL.dropdownItem, el)) noise.push(it);
    for (const lab of qa(SEL.correctLabel, el)) noise.push(lab);
    for (const n of noise) {
      const nt = norm(n.innerText || n.textContent || "");
      if (nt) t = norm(t.split(nt).join(" "));
    }
    return t;
  }


  // The rightmost drop spot in a row is the answer slot (a row has two).
  function answerSlot(row) {
    if (!row) return null;
    const wrap = q1(SEL.dropWrapper, row);
    const list = (wrap ? qa(SEL.dropSpot, wrap) : qa(SEL.dropSpot, row)).filter(visible);
    if (!list.length) return null;
    return list.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).pop();
  }

  // getSlot() is re-evaluated every time: React replaces these nodes.
  // occurrence picks the Nth chip with the wanted label, so two rows needing
  // the same label take different chips instead of stealing one from another.
  async function pickFromDropdown(getSlot, wantText, occurrence, verify) {
    const want = occurrence || 0;
    const chosen = () => {
      if (anyDropdownOpen()) return false;
      if (verify) return !!verify();              // caller knows the real signal
      return Answered.area(getSlot(), wantText);
    };
    if (await stable(chosen)) return { ok: true, via: "already set" };

    let sawItems = null;
    let noPanel = 0;
    for (let a = 0; a < PICK_STRATEGIES.length; a++) {
      // a locked question swallows every click, so each strategy would sit out
      // its full timeout for nothing
      if (!(await ensureAnswerable())) return { ok: false, err: "page locked, could not reset", saw: sawItems };
      // An already-open panel may belong to a DIFFERENT row. Picking out of it
      // puts the answer in the wrong place and leaves this row empty.
      await quietDropdowns(900);
      const slot = getSlot();
      if (!slot) return { ok: false, err: "no answer slot" };
      activate(slot);
      const dd = await waitForDropdown(2200);
      if (!dd) { if (++noPanel >= 2) return { ok: false, err: "list never opened", saw: sawItems }; continue; }

      const items = qa(SEL.dropdownItem, dd).filter(visible);
      sawItems = items.map((i) => norm(i.innerText || i.textContent).slice(0, 34));
      lastDropdown = { want: norm(wantText).slice(0, 34), occurrence: want, offered: sawItems };

      // Prefer a chip whose whole label IS the answer. textHas() is a substring
      // test, so "Mobile" would also match "Mobile device forensics" and the
      // row would take the wrong chip - leaving the row that needed it empty.
      const want_n = norm(wantText);
      const label = (i) => norm(i.innerText || i.textContent || "");
      let matches = items.filter((i) => label(i) === want_n);
      if (!matches.length) matches = items.filter((i) => trimPunct(label(i)) === trimPunct(want_n));
      if (!matches.length) matches = items.filter((i) => textHas(i, wantText));
      if (!matches.length) {
        const s = getSlot();
        if (s) activate(s);
        await waitForDropdownClosed(800);
        return { ok: false, err: "target not in dropdown", saw: sawItems };
      }

      const item = matches[Math.min(want, matches.length - 1)];
      try { PICK_STRATEGIES[a].run(item, items.indexOf(item), getSlot()); } catch (_) {}
      await waitForDropdownClosed(1600);
      for (let t = 0; t < 14; t++) {
        await sleep(100);
        if (chosen()) return { ok: true, via: PICK_STRATEGIES[a].name + (want ? "#" + want : "") };
      }
      if (anyDropdownOpen()) {
        const s = getSlot();
        if (s) activate(s);
        if (!(await waitForDropdownClosed(900))) await forceCloseDropdown();
      }
    }
    return { ok: false, err: "click never committed", saw: sawItems };
  }

  /* ---------------------------------------------------------- statement grid */
  async function fillStatement(entry) {
    let ok = 0, miss = 0;
    const log = [];
    const rows = qa(SEL.statementRow).filter(visible);

    if (rows.length) {
      // JSX order inside a statement row is [True control, False control].
      // Re-query per row: clicking one re-renders the list and detaches refs.
      const controlFor = (opt) => {
        const row = qa(SEL.statementRow).filter(visible).find((r) => textHas(r, opt.text));
        if (!row) return null;
        // The player names each side. Taking it by name beats assuming the
        // first control in the row is True - that assumption is what made a
        // whole grid pick False when a header chip changed the JSX order.
        const named = q1(opt.correct ? SEL.stmtTrue : SEL.stmtFalse, row);
        if (named && visible(named)) return named;
        let ctrls = qa('[role="radio"]', row).filter(visible);
        if (ctrls.length < 2) ctrls = controlsIn(row);
        if (ctrls.length < 2) return null;
        return ctrls[opt.correct ? 0 : 1];
      };

      for (const opt of entry.options) {
        if (typeof opt.correct !== "boolean") continue;
        let done = false, note = null;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          if (!(await ensureAnswerable())) { note = "page locked, could not reset"; break; }
          const target = controlFor(opt);
          if (!target) { note = "row/controls not found"; break; }
          const state = await stable(() => Answered.control(controlFor(opt)));
          if (state === true) { done = true; note = attempt ? "attempt" + attempt : "already"; break; }

          if (attempt === 0) activate(target); else rawClick(target);
          if (state === null || state === undefined) { done = true; note = "unverified"; break; }

          for (let t = 0; t < 8 && !done; t++) {
            await sleep(80);
            if (Answered.control(controlFor(opt)) === true) { done = true; note = "attempt" + attempt; }
          }
        }
        if (done) ok++; else miss++;
        log.push({ text: opt.text.slice(0, 26), want: opt.correct, ok: done, via: note });
      }

      // A row can read as already-answered while Try again is still clearing
      // it, so confirm every row against the DOM and repair what is wrong.
      const isSet = (opt) => Answered.control(controlFor(opt)) !== false;

      for (let pass = 2; pass <= 3; pass++) {
        await sleep(350);
        const bad = entry.options.filter((o) => typeof o.correct === "boolean" && !isSet(o));
        if (!bad.length) break;
        log.push({ pass, repairing: bad.length });
        for (const opt of bad) {
          if (!(await ensureAnswerable())) break;
          const t = controlFor(opt);
          if (t) { activate(t); await sleep(250); }
        }
      }

      await settle(1500, 300);
      let verified = 0;
      const unfilled = [];
      for (const opt of entry.options) {
        if (typeof opt.correct !== "boolean") continue;
        if (isSet(opt)) verified++; else unfilled.push(opt.text.slice(0, 26));
      }
      log.push({ verified, unfilled });
      lastFillLog = log;
      return { ok: verified, miss: unfilled.length, log, unfilled };
    }

    // fallback: no data-test rows (older player) -> geometry
    const pool = allElements();
    const resolved = entry.options.map((opt) => {
      const te = findTextNode(opt.text, pool);
      return { opt, te, r: te ? rowFor(te, 2) : null };
    });
    const tops = resolved.filter((x) => x.te).map((x) => x.te.getBoundingClientRect().top);
    const cols = trueFalseColumns(pool, tops);
    for (const { opt, r } of resolved) {
      if (typeof opt.correct !== "boolean") continue;
      if (!r || !r.controls.length) { miss++; continue; }
      let pick = null;
      if (cols) {
        const want = opt.correct ? cols.tx : cols.fx;
        pick = r.controls.reduce((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return Math.abs(ra.left + ra.width / 2 - want) <= Math.abs(rb.left + rb.width / 2 - want) ? a : b;
        });
      }
      if (!pick) pick = opt.correct ? r.controls[0] : r.controls[r.controls.length - 1];
      if (pick) { activate(pick); ok++; } else miss++;
    }
    return { ok, miss };
  }

  /* ------------------------------------------------------- single / multiple */
  // Clicking an option makes React re-render the list, which detaches every
  // element reference captured beforehand. Re-query before every click, and
  // confirm the toggle landed via aria-checked rather than assuming it did.
  function ariaOf(label, attr) {
    let n = label;
    for (let i = 0; i < 8 && n && n !== document.body; i++) {
      if (n.hasAttribute && n.hasAttribute(attr)) return n.getAttribute(attr);
      n = n.parentElement;
    }
    return null;
  }

  const optionChecked = (label) => Answered.control(label);

  // The answer key carries each option's element id, and the player puts it on
  // the row as "list-item-<id>". Anchoring there is exact; text matching is a
  // guess that two similar options can both satisfy.
  function optionBox(id) {
    if (!id) return null;
    let box = null;
    try { box = document.getElementById("list-item-" + id) || document.getElementById(id); } catch (_) {}
    return box && visible(box) ? box : null;
  }

  const findOptionLabel = (wantText, id) => {
    const box = optionBox(id);
    if (box) {
      return qa(SEL.optionText, box).filter(visible)[0]
        || qa('[role="radio"],[role="checkbox"]', box).filter(visible)[0]
        || box;
    }
    return qa(SEL.optionText).filter(visible).find((l) => textHas(l, wantText)) || null;
  };

  // The clickable control is the node carrying role=radio / aria-checked.
  // clickableAncestor() walks up by cursor:pointer and can overshoot it.
  function optionControl(label) {
    let n = label;
    for (let i = 0; i < 8 && n && n !== document.body; i++) {
      const role = n.getAttribute && n.getAttribute("role");
      if (role === "radio" || role === "checkbox") return n;
      if (n.hasAttribute && n.hasAttribute("aria-checked")) return n;
      n = n.parentElement;
    }
    return clickableAncestor(label);
  }

  async function setOption(wantText, want, id) {
    let clicked = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await ensureAnswerable())) return { ok: false, err: "page locked, could not reset", clicked };

      const lab = findOptionLabel(wantText, id);
      if (!lab) return { ok: false, err: "option not on page", clicked };

      const state = await stable(() => {
        const l = findOptionLabel(wantText, id);
        return l ? optionChecked(l) : null;
      });
      if (state === want) return { ok: true, via: attempt === 0 ? "already" : "attempt" + attempt };

      const ctl = optionControl(lab);
      clicked = describe(ctl);
      if (attempt === 0) ctl.click();
      else if (attempt === 1) lab.click();
      else if (attempt === 2) rawClick(ctl);
      else if (attempt === 3) activate(ctl);
      else {
        // Space toggles; Enter is deliberately NOT sent - on a focused control
        // inside the question it submits the whole thing and locks the page.
        try { ctl.focus(); } catch (_) {}
        pressKey(ctl, " ", 32);
      }

      // no aria-checked anywhere: cannot verify, so trust the first click
      if (state === null) return { ok: true, via: "unverified" };

      for (let t = 0; t < 8; t++) {
        await sleep(90);
        const again = findOptionLabel(wantText, id);
        if (again && optionChecked(again) === want) return { ok: true, via: "attempt" + attempt };
      }
    }
    return { ok: false, err: "would not toggle", clicked };
  }

  async function fillChoice(entry) {
    let ok = 0, miss = 0;
    const log = [];

    const probe = findOptionLabel((entry.options[0] || {}).text || "", (entry.options[0] || {}).id);
    const role = probe ? ariaOf(probe, "role") : null;
    const multi = role === "checkbox" || entry.options.filter((o) => o.correct).length > 1;
    log.push({ role, multi });

    // tick the correct ones first: on a radio group this clears the rest for us
    for (const opt of entry.options) {
      if (!opt.correct) continue;
      const res = await setOption(opt.text, true, opt.id);
      if (res.ok) ok++; else miss++;
      log.push({
        text: opt.text.slice(0, 26), want: true, ok: res.ok,
        via: res.via, err: res.err, clicked: res.clicked,
      });
    }

    // then clear leftovers - but only on checkboxes. Clicking a wrong radio
    // would select it instead of clearing it.
    if (multi) {
      for (const opt of entry.options) {
        if (opt.correct) continue;
        const lab = findOptionLabel(opt.text, opt.id);
        if (!lab || optionChecked(lab) !== true) continue;
        const res = await setOption(opt.text, false, opt.id);
        log.push({ text: opt.text.slice(0, 26), want: false, ok: res.ok, via: res.via, err: res.err });
        if (!res.ok) miss++;
      }
    }

    // Verify against the DOM and repair. setOption can report "already" from a
    // stale aria-checked while a reset is still clearing the option.
    for (let pass = 2; pass <= 3; pass++) {
      await sleep(300);
      const bad = entry.options.filter((o) => {
        if (!o.correct && !multi) return false;        // a radio cannot be unset
        const lab = findOptionLabel(o.text, o.id);
        if (!lab) return false;
        const st = optionChecked(lab);
        return st !== null && st !== !!o.correct;
      });
      if (!bad.length) break;
      log.push({ pass, repairing: bad.length });
      for (const o of bad) {
        if (!(await ensureAnswerable())) break;
        await setOption(o.text, !!o.correct, o.id);
      }
    }

    await sleep(250);
    let verified = 0;
    const wrong = [];
    for (const o of entry.options) {
      if (!o.correct) continue;
      const lab = findOptionLabel(o.text, o.id);
      const st = lab ? optionChecked(lab) : null;
      if (st === null || st === true) verified++;
      else wrong.push(o.text.slice(0, 26));
    }
    log.push({ verified, wrong });
    lastFillLog = log;
    return { ok: verified, miss: wrong.length, log };
  }

  /* ----------------------------------------------------------- text matching */
  async function fillMatching(entry) {
    const log = [];
    if (await stillLocked()) {
      log.push({ err: "question is in review mode, not accepting input" });
      lastFillLog = log;
      return { ok: 0, miss: entry.options.length, log };
    }
    const liveRows = () => qa(SEL.matchRow).filter(visible);
    const keyText = (r) => {
      const k = q1(SEL.matchKey, r) || r;
      return norm(k.innerText || k.textContent || "");
    };

    // Give every key its OWN row. Looking each key up independently by
    // substring lets two keys land on the same row whenever one key contains
    // the other ("Firewall" inside "Firewall rules"), and the key that loses
    // that race is the row that silently never gets filled. Assign strictest
    // first so an exact key can never be beaten to its row by a looser one.
    function rowAssignment(rows) {
      const texts = rows.map(keyText);
      const taken = new Set();
      const out = new Map();
      const round = (test) => {
        for (const opt of entry.options) {
          if (out.has(opt)) continue;
          const want = norm(opt.text || "");
          if (!want) continue;
          for (let i = 0; i < rows.length; i++) {
            if (taken.has(i)) continue;
            if (test(texts[i], want)) { taken.add(i); out.set(opt, rows[i]); break; }
          }
        }
      };
      round((a, b) => a === b);
      round((a, b) => trimPunct(a) === trimPunct(b));
      round((a, b) => a.startsWith(b) || b.startsWith(a));
      round((a, b) => a.includes(b) || b.includes(a));
      return out;
    }

    // React swaps these nodes on every pick, so a stored row goes stale and
    // reports whatever it held before. Keep the map only while the exact same
    // row elements are still on the page.
    let rowCache = null;
    const rowMap = () => {
      const rows = liveRows();
      if (rowCache && rowCache.rows.length === rows.length &&
          rowCache.rows.every((r, i) => r === rows[i])) return rowCache.map;
      rowCache = { rows, map: rowAssignment(rows) };
      return rowCache.map;
    };
    const rowOf = (opt) => rowMap().get(opt) || null;
    const slotOf = (opt) => answerSlot(rowOf(opt));

    // A filled slot shows exactly ONE answer. If its text matches several of
    // the targets, the option list has leaked into it and it tells us nothing,
    // so treat that as empty rather than believing it.
    const allTargets = entry.options.map((o) => o.match).filter(Boolean);
    // The 36x36 "+" toggle keeps className "dropdown-button" and the previous
    // answer text after a reset, so it lies about whether the row is answered.
    // The truth is the slot area beside it: placeholder, or the chosen answer.
    // THE ANSWER CELL. Measured on the live page, a row holds two drop spots:
    //   36px  - the "+" toggle, wrapped in "dropdown-input-wrapper"
    //   230px - the answer cell, marked "item-selected"
    // The 36px toggle carries a copy of ONE option's text, and it is the SAME
    // text in every row. Reading it reported one row as answered when it was
    // blank, and every other row as blank forever - the submitted-with-a-gap
    // bug and the "+" spam were both this one element. Read "item-selected".
    const slotArea = (opt) => {
      const row = rowOf(opt);
      if (!row) return null;
      const sel = q1(SEL.itemSelected, row);
      if (sel && visible(sel)) return sel;
      const wide = qa(SEL.dropSpot, row).filter(visible).filter((b) => {
        try { return b.getBoundingClientRect().width > 60; } catch (_) { return false; }
      });
      return wide.length ? wide[wide.length - 1] : null;
    };

    const filled = (opt) => Answered.area(slotArea(opt), opt.match, allTargets);

    // Labels repeat but each chip can only sit in one row, so two rows wanting
    // the same label must take DIFFERENT chips. Pick the Nth one, where N is how
    // many other rows already hold that label.
    const occurrenceFor = (opt) => {
      let n = 0;
      for (const o of entry.options) {
        if (o === opt) continue;
        if (norm(o.match || "") !== norm(opt.match || "")) continue;
        if (filled(o)) n++;
      }
      return n;
    };

    log.push({ rowsFound: liveRows().length, options: entry.options.length });

    async function attempt(opt, pass) {
      if (!opt.match) { log.push({ pass, src: opt.text.slice(0, 26), err: "no target in key" }); return; }
      await quietDropdowns(900);
      // stable read: a single sample here is how empty rows got skipped
      if (await stable(() => filled(opt))) {
        log.push({ pass, src: opt.text.slice(0, 26), via: "already set" });
        return;
      }
      if (!rowOf(opt)) { log.push({ pass, src: opt.text.slice(0, 26), err: "row not found" }); return; }
      if (!slotOf(opt)) { log.push({ pass, src: opt.text.slice(0, 26), err: "no answer slot" }); return; }

      if (!(await ensureAnswerable())) { log.push({ pass, src: opt.text.slice(0, 26), err: "page locked, could not reset" }); return; }
      lastDropdown = null;
      const occ = occurrenceFor(opt);
      const res = await pickFromDropdown(() => slotOf(opt), opt.match, occ, () => filled(opt));
      if (anyDropdownOpen()) {
        const s = slotOf(opt);
        if (s) activate(s);
        if (!(await waitForDropdownClosed(900))) await forceCloseDropdown();
      }
      await sleep(250);

      log.push({
        pass,
        src: opt.text.slice(0, 26),
        want: String(opt.match).slice(0, 28),
        occ,
        via: res.ok ? res.via : undefined,
        err: res.ok ? undefined : res.err,
        offered: lastDropdown && lastDropdown.offered,
        stuck: filled(opt),
      });
    }

    await quietDropdowns(900);
    for (let i = 0; i < entry.options.length; i++) {
      report("working", `Matching row ${i + 1} of ${entry.options.length}\u2026`);
      await attempt(entry.options[i], 1);
    }

    // A chip can only sit in one row, so filling row 4 can pull the chip back
    // off row 3. Let the page settle FIRST, then look again - checking
    // straight after a pick reads the row before React has taken it away.
    let worst = Infinity;
    for (let pass = 2; pass <= 5; pass++) {
      await quietDropdowns(1200);
      await settle(1600, 320);
      const left = entry.options.filter((o) => !filled(o));
      if (!left.length) break;
      // Give up once a whole pass stops helping. Re-opening the same dropdown
      // for a row that will not take the chip just spins.
      if (left.length >= worst) { log.push({ pass, stalled: left.length }); break; }
      worst = left.length;
      log.push({ pass, repairing: left.length });
      report("working", `Repairing ${left.length} row(s)\u2026`);
      for (const opt of left) await attempt(opt, pass);
    }

    await quietDropdowns(1200);
    await settle(1500, 300);
    let verified = 0;
    const unfilled = [];
    for (const opt of entry.options) {
      if (filled(opt)) verified++;
      else unfilled.push(opt.text.slice(0, 26));
    }
    log.push({ verified, unfilled });
    lastFillLog = log;
    return { ok: verified, miss: entry.options.length - verified, log, unfilled };
  }

  /* --------------------------------------------------------- fill the blanks */
  // A blank is either a text box or a <select> that the player turns into the
  // same Downshift dropdown the matching question uses.
  async function fillBlanks(entry) {
    // Re-query on every access. Pressing Try again, or any pick, re-renders
    // these nodes; a reference captured up front is detached and silently
    // ignores clicks, so the panel never opens.
    const liveSpots = () => qa(SEL.dropSpot, q1(SEL.blanks) || document).filter(visible);
    const spots = liveSpots();

    if (spots.length) {
      let ok = 0, miss = 0;
      const log = [{ blankDropdowns: spots.length }];
      const used = new Set();
      for (const opt of entry.options) {
        let done = false;
        let lastErr = null, lastSaw = null;
        if (!(await ensureAnswerable())) { miss++; log.push({ value: opt.text, err: "page locked, could not reset" }); continue; }
        for (let i = 0; i < spots.length; i++) {
          if (used.has(i)) continue;
          const res = await pickFromDropdown(() => liveSpots()[i], opt.text, 0);
          if (res.ok) {
            used.add(i);
            ok++;
            done = true;
            log.push({ value: opt.text, spot: i, via: res.via });
            break;
          }
          lastErr = res.err;
          lastSaw = res.saw;
        }
        if (!done) {
          miss++;
          log.push({ value: opt.text, err: lastErr || "no blank offered it", saw: lastSaw });
        }
      }
      lastFillLog = log;
      return { ok, miss, log };
    }

    // Text blanks. React owns the value, so setting it is not the same as it
    // being committed - poll the element until it really holds the answer.
    const scope = q1(SEL.blanks) || document;
    const boxes = () => qa('input[type="text"],input:not([type]),textarea', scope).filter(visible);
    // The key gives each answer the id of the blank it belongs to, and the
    // player sets that id as the input's name. Position is only a fallback:
    // it breaks the moment a blank is hidden or the order differs.
    const boxAt = (opt, i) => {
      const id = opt && opt.blank;
      if (id) {
        let named = null;
        try { named = q1('input[name="' + CSS.escape(id) + '"]', scope); } catch (_) {}
        if (named && visible(named)) return named;
      }
      return boxes()[i];
    };
    let ok = 0, miss = 0;
    const log = [{ textBlanks: boxes().length }];

    for (let i = 0; i < entry.options.length; i++) {
      const opt = entry.options[i];
      let landed = false;

      for (let attempt = 0; attempt < 3 && !landed; attempt++) {
        const el = boxAt(opt, i);
        if (!el) break;
        if (el.disabled || el.readOnly) { await sleep(300); continue; }

        try { el.focus(); } catch (_) {}
        setValue(el, opt.text);

        for (let t = 0; t < 12; t++) {
          await sleep(80);
          const now = boxAt(opt, i);
          if (now && now.value === opt.text) { landed = true; break; }
        }

        if (landed) {
          // nudge anything listening for keyup / blur rather than input
          const el2 = boxAt(opt, i);
          if (el2) {
            pressKey(el2, "End", 35);
            try { el2.dispatchEvent(new Event("blur", { bubbles: true })); } catch (_) {}
          }
          await sleep(150);
          const after = boxAt(opt, i);
          landed = !!after && after.value === opt.text;   // blur handlers can wipe it
        }
      }

      if (landed) ok++; else miss++;
      log.push({ value: opt.text.slice(0, 30), ok: landed });
    }

    lastFillLog = log;
    return { ok, miss, log };
  }

  async function fill(entry) {
    if (await stillLocked()) {
      const log = [{ err: "question is in review mode (Try again is showing), input is ignored" }];
      lastFillLog = log;
      return { ok: 0, miss: entry.options.length, log, locked: true };
    }
    if (entry.type === "statement") return fillStatement(entry);
    if (entry.type === "choice") return fillChoice(entry);
    if (entry.type === "matching") return fillMatching(entry);
    if (entry.type === "fill-in") return fillBlanks(entry);
    return { ok: 0, miss: entry.options.length, manual: true };
  }

  /* --------------------------------------------------------------- matching */
  // Identifying the on-screen question.
  //
  // Two traps live here. A dropdown blank hides its answers until opened, so
  // option-text scoring alone can never find it - hence the title match. But a
  // title match must WIN outright: after a probe the page literally contains the
  // seeded answer, so a one-option entry from a different question scores 1.0 on
  // text and would otherwise beat the correct entry.
  function optionScore(e, page) {
    const opts = (e.options || []).filter((o) => o.text && o.text.length > 3);
    if (!opts.length) return 0;
    let hit = 0;
    for (const o of opts) {
      const probe = norm(o.text).slice(0, 60);
      if (probe && page.includes(probe)) hit++;
    }
    return hit / opts.length;
  }

  /* The entry (or entries) the last capture produced. After a probe this is
     the question we just answered, which beats any page-text guess: a
     statement grid renders no title and a dropdown blank hides its options,
     so both are invisible to text matching. */
  function probedEntry() {
    const got = lastCaptured.map((q) => BANK[q]).filter(Boolean);
    if (!got.length) return null;
    if (got.length === 1) return got[0];

    // more than one statement in the same batch: prefer the one whose id is in
    // the URL, then the one whose answers are actually on screen, then newest
    const idInUrl = (location.hash || "").match(/questions\/([0-9a-f]{6,})/i);
    if (idInUrl) {
      const id = idInUrl[1].toLowerCase();
      const hit = got.find((e) => String(e.qid || "").toLowerCase().includes(id));
      if (hit) return hit;
    }
    const page = norm(document.body ? document.body.innerText : "");
    got.sort((a, b) => (optionScore(b, page) - optionScore(a, page)) || (b.seen - a.seen));
    return got[0];
  }

  function currentEntry() {
    const page = norm(document.body ? document.body.innerText : "");
    if (!page || page.length < 20) return null;

    const entries = Object.values(BANK);
    if (!entries.length) return null;

    // 0. The URL hash carries the question's own GUID. When it is there it is
    //    AUTHORITATIVE: an exact hit, or nothing. Falling through to title or
    //    answer-text matching here is how a fill-in key from another question
    //    ends up being applied to a multiple-choice question.
    const idInUrl = (location.hash || "").match(/questions\/([0-9a-f]{6,})/i);
    if (idInUrl) {
      const id = idInUrl[1].toLowerCase();
      return entries.find((e) => String(e.qid || "").toLowerCase().includes(id)) || null;
    }

    const titleEl = q1(SEL.title);
    const pageTitle = titleEl ? norm(titleEl.textContent) : "";

    // 1. exact title match
    let titled = pageTitle ? entries.filter((e) => norm(e.title || "") === pageTitle) : [];
    // 2. otherwise a substantial substring match
    if (!titled.length && pageTitle) {
      titled = entries.filter((e) => {
        const t = norm(e.title || "");
        return t.length > 8 && (pageTitle.includes(t) || t.includes(pageTitle));
      });
    }
    if (titled.length === 1) return titled[0];
    if (titled.length > 1) {
      // same title on more than one question: break the tie on answer text,
      // then on whichever was captured most recently
      titled.sort((a, b) => (optionScore(b, page) - optionScore(a, page)) || (b.seen - a.seen));
      return titled[0];
    }

    // 3. no title to go on - fall back to answer text
    let best = null, bestScore = 0;
    for (const e of entries) {
      const score = optionScore(e, page);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (!best || bestScore < 0.6) return null;

    // a single short answer appearing somewhere on the page is weak evidence:
    // it is exactly what a leftover probe answer looks like
    const opts = (best.options || []).filter((o) => o.text && o.text.length > 3);
    if (opts.length < 2 && norm(opts[0] ? opts[0].text : "").length < 25) return null;
    return best;
  }

  async function doFill() {
    if (busy) return;
    const e = currentEntry();
    if (!e) return;                       // another frame may have it
    busy = true;
    report("working", `Filling ${e.type}…`);
    try {
      if (!(await resetIfLocked())) {
        report("fail", "Question stayed locked after Try again \u2014 nothing was filled.");
        return;
      }
      const r = await withTimeout(fill(e), 75000);
      if (r.manual) {
        report("manual", `${e.type}: can't auto-click — key logged to console`, { entry: e });
        console.table(e.options);
      } else if (r.ok) {
        report("done", `Filled ${r.ok}${r.miss ? ` · ${r.miss} missed` : ""} (${e.type})`);
      } else {
        report("fail", `Found the question but clicked nothing (${e.type}).`);
      }
    } catch (err) {
      report("fail", "Error: " + (err && err.message));
    } finally {
      busy = false;
    }
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timed out after " + Math.round(ms / 1000) + "s")), ms)),
    ]);
  }

  // After a submit the question is locked until "Try again" is pressed:
  // clicks on the controls are ignored while the feedback banner is up.
  // After a submit the question is locked until "Try again" is pressed: clicks
  // and typing are ignored while the feedback banner is up. Returns false if it
  // is still locked, because filling into a locked question looks like it worked
  // (the text appears) while the player never registers it.
  async function resetIfLocked() {
    if (answering()) return true;

    // Don't gate the press on our own visibility check - if the question is
    // not accepting input, press Try again whether or not it reads as visible,
    // and press it again if the first one did not take.
    for (let round = 0; round < 3; round++) {
      const again = tryAgainButton();
      if (again) {
        report("working", "Question is locked \u2014 pressing Try again\u2026");
        pressButton(again);
      }
      for (let t = 0; t < 12; t++) {
        await sleep(200);
        if (answering()) {
          // The reset clears the controls a moment AFTER Submit comes back.
          // Reading before that settles is what made empty rows look answered.
          await settle(2000, 350);
          return true;
        }
      }
      if (!again) break;        // nothing to press and still not ready
    }
    return answering();
  }

  // After submitting, read the player's own verdict so the panel can say
  // whether the answer was actually accepted - not just that it was sent.
  async function submitVerdict(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(200);
      let page = "";
      try { page = norm(document.body.innerText || ""); } catch (_) {}
      if (page.includes("that's incorrect") || page.includes("incorrect!")) return "incorrect";
      if (page.includes("that's correct") || page.includes("correct!")) return "correct";
      if (qa('[data-test="fail-icon"],[data-test="failed-icon"]').filter(visible).length) return "incorrect";
    }
    return null;
  }

  // The real markup of the current question. Guessing at structure from
  // screenshots is what has made this slow; this gives the actual HTML.
  /* ------------------------------------------------- reading state safely --
     Every bug in this project came from the same mistake: reading the DOM one
     time, during or just after a state change, and believing the answer.
     These two primitives are the fix. Use them for any decision that SKIPS
     work ("it is already answered"), because a wrong skip is silent.          */

  // Resolve once the page has stopped mutating for `quietMs`, or at `maxMs`.
  function settle(maxMs, quietMs) {
    const cap = maxMs || 2000;
    const quiet = quietMs || 300;
    return new Promise((resolve) => {
      let done = false, idle = null, hard = null, obs = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(idle); clearTimeout(hard);
        try { if (obs) obs.disconnect(); } catch (_) {}
        resolve();
      };
      const bump = () => { clearTimeout(idle); idle = setTimeout(finish, quiet); };
      try {
        obs = new MutationObserver(bump);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      } catch (_) { resolve(); return; }
      hard = setTimeout(finish, cap);
      bump();
    });
  }

  // Sample until two consecutive reads agree, so a value caught mid-change
  // is never acted on.
  async function stable(read, gap, tries) {
    const g = gap || 250;
    const n = tries || 4;
    let prev;
    try { prev = read(); } catch (_) { return undefined; }
    for (let i = 0; i < n; i++) {
      await sleep(g);
      let now;
      try { now = read(); } catch (_) { return prev; }
      if (now === prev) return now;
      prev = now;
    }
    return prev;
  }

  async function waitUntil(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(220);
    }
    return false;
  }

  /* One click: if we have no key, burn a throwaway attempt to capture it,
     reset the question, fill the real answers, submit. */
  async function autoSolve(submitAtEnd) {
    if (busy) return;
    busy = true;
    try {
      if (!currentEntry() && !hasQuestion()) { busy = false; return; }   // not this frame

      // Unlock FIRST. The probe needs to answer and submit, and a locked
      // question has no Submit button and ignores every click.
      if (!(await ensureAnswerable())) {
        report("fail", "Question is locked and Try again would not reset it.");
        return;
      }

      // Normally finished long ago; this only waits on a click in the first
      // instant after the page opens.
      try { await withTimeout(loadCourseData(), 5000); } catch (_) {}

      let e = currentEntry();

      if (!e) {
        report("working", "No key yet \u2014 probing with a throwaway answer\u2026");
        const seeded = await seedAnswer();
        if (!seeded) { report("fail", "Could not find any answer controls to click."); return; }
        await sleep(400);

        const submit = submitButton();
        if (!submit) { report("fail", `Seeded (${seeded}) but no Submit button found.`); return; }
        const seq0 = captureSeq;
        pressButton(submit);
        report("working", "Probe submitted, waiting for the answer key\u2026");

        // count ANY capture, not just a new question id: re-answering a question
        // we already banked emits the same id and would look like a failure
        const grew = await waitUntil(() => captureSeq > seq0, 9000);
        if (!grew) {
          report("fail", "Probe submitted but no answer key appeared in the traffic.");
          return;
        }

        report("working", "Key captured, resetting the question\u2026");
        if (!(await resetIfLocked())) {
          report("fail", "Captured the key, but Try again would not reset the question.");
          return;
        }
        // The probe answered THIS question and submitted it, so the statement
        // that came back belongs to THIS question. That is stronger evidence
        // than any page-text match, and it is the only evidence available for
        // a question that renders no title and hides its answers.
        e = probedEntry() || currentEntry();
        if (!e) {
          report("fail", "Key captured but it could not be matched to this question.");
          return;
        }
      }

      if (!(await resetIfLocked())) {
        report("fail", "Question stayed locked after Try again \u2014 nothing was filled.");
        return;
      }
      report("working", `Filling ${e.type}\u2026`);
      const r = await withTimeout(fill(e), 75000);
      if (r.manual) {
        report("manual", `${e.type}: cannot auto-click \u2014 key logged to console`);
        console.table(e.options);
        return;
      }
      if (!r.ok) {
        report("fail", r.locked
          ? "The question is still in review mode \u2014 press Try again, then Solve."
          : `Matched the question but clicked nothing (${e.type}).`);
        return;
      }

      let tail = "";
      if (submitAtEnd && !r.miss) {
        // give React time to commit the last change before submitting; typed
        // text in particular can still be in flight
        await sleep(900);

        // last check: a controlled input can revert after the fill returns
        if (e.type === "fill-in") {
          const bScope = q1(SEL.blanks) || document;
          const boxes = qa('input[type="text"],input:not([type]),textarea', bScope).filter(visible);
          const vals = boxes.map((b) => norm(b.value));
          const reverted = boxes.length && e.options.some((o) => !vals.includes(norm(o.text)));
          if (reverted) {
            report("fail", "Typed answer did not stick \u2014 not submitting.");
            return;
          }
        }

        const sub = submitButton();
        if (sub) {
          pressButton(sub);
          const verdict = await submitVerdict(7000);
          if (verdict === "incorrect") {
            report("fail", `Filled ${r.ok} and submitted, but the player marked it INCORRECT. ` +
              "The answer key may map differently.");
            return;
          }
          tail = verdict === "correct" ? ", submitted \u2014 correct" : ", submitted";
        } else {
          tail = ", no Submit button found";
        }
      }
      if (r.miss) {
        const which = (r.unfilled || []).slice(0, 2).join("; ");
        report("fail", `Partly solved \u2014 ${r.ok} filled, ${r.miss} missed` +
          (which ? `: ${which}` : "") + ". Not submitted.");
      } else {
        report("done", `Solved \u2014 ${r.ok} filled${tail}`);
      }
    } catch (err) {
      report("fail", "Error: " + (err && err.message));
    } finally {
      busy = false;
    }
  }

  /* A dry run: work out exactly what a fill WOULD click, without clicking.
     This is the report to paste back when something picks the wrong control. */
  function describe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let cls = "";
    try {
      cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
    } catch (_) {}
    return {
      tag: el.tagName,
      type: el.type || null,
      cls: String(cls).slice(0, 70),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      checked: el.checked === undefined ? null : el.checked,
      txt: norm(el.textContent).slice(0, 18) || null,
    };
  }

  /* ------------------------------------------------------------------- wire */
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== TAG || d.kind !== "payload") return;
    Object.assign(RESPONSES, harvestResponses(d.payload));
    const found = harvest(d.payload);
    for (const entry of found) BANK[entry.qid] = entry;
    if (found.length) {
      lastCaptured = found.map((e) => e.qid);
      captureSeq++;                      // counts re-captures too, not just new ids
    }
  });

  // Start reading the course file now, so the key is banked long before the
  // first click. Harmless in frames that are not the player.
  loadCourseData();

  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "f" || e.key === "F")) { e.preventDefault(); autoSolve(true); }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.cmd === "solve") { autoSolve(true); reply({ frame: where() }); }
    return true;
  });

  /* --------------------------------------------------------------- panel UI */
  // A question frame needs BOTH a Submit/Try again button AND answer controls.
  // The outer Moodle page has neither, so only one panel is ever drawn.
  function questionButton() {
    try {
      const byAttr = qa(SEL.submit).concat(qa(SEL.tryAgain)).filter(visible)[0];
      if (byAttr) return byAttr;
      return findButton(/^submit$/i) || findButton(/^try again$/i);
    } catch (_) { return null; }
  }

  // The question only accepts input while Submit is showing. In review mode
  // (Try again showing) the rows display the CORRECT answers, which reads
  // exactly like a filled-in row.
  function answering() {
    const sub = submitButton();
    const again = tryAgainButton();
    return !!(sub && visible(sub)) && !(again && visible(again));
  }

  // "Locked" means the feedback banner is up - Try again is showing. That is a
  // real state change. The Submit button briefly disappearing is NOT: the player
  // re-renders the question on every answer, so a single sample of
  // answering()===false mid-fill is a transient, not a lock.
  function isLocked() {
    const again = tryAgainButton();
    return !!(again && visible(again));
  }

  async function stillLocked() {
    if (!isLocked()) return false;
    await sleep(400);
    return isLocked();
  }

  // If the question did lock part-way through, press Try again and carry on
  // rather than abandoning the rows that are still empty.
  async function ensureAnswerable() {
    if (!(await stillLocked())) return true;
    return await resetIfLocked();
  }

  // data-test sits on a styled wrapper, which may not be the node carrying the
  // click handler. Prefer a real <button> inside it.
  function realButton(el) {
    if (!el) return null;
    if (el.tagName === "BUTTON" || el.tagName === "INPUT") return el;
    let inner = null;
    try { inner = el.querySelector('button,[role="button"],input[type="submit"]'); } catch (_) {}
    if (inner && visible(inner)) return inner;
    return el;
  }

  function pressButton(el) {
    const b = realButton(el);
    if (!b) return false;
    activate(b);
    if (b !== el) activate(el);     // belt and braces: the wrapper may own it
    return true;
  }

  function submitButton() {
    return qa(SEL.submit).filter(visible)[0] || findButton(/^submit$/i);
  }
  function tryAgainButton() {
    return qa(SEL.tryAgain).filter(visible)[0] || findButton(/^try again$/i);
  }

  function hasQuestion() {
    try {
      if (!questionButton()) return false;
      if (qa(SEL.statementRow).length || qa(SEL.matchRow).length ||
          qa(SEL.optionText).length || qa(SEL.blanks).length ||
          qa(SEL.dropSpot).filter(visible).length) return true;
      if (document.querySelector('input[type="radio"],input[type="checkbox"],textarea')) return true;
      return plusButtons(document.body).length >= 2;
    } catch (_) {
      return false;
    }
  }

  let hidden = false;
  let openTimer = null;

  function mountPanel() {
    if (panel || !document.body || hidden) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = [
      "<style>",
      "*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
      ".wrap{display:flex;align-items:center;gap:9px}",
      ".chip{display:none;max-width:230px;background:#11151c;color:#e8eef7;border:1px solid #2a3340;",
      "border-radius:9px;padding:7px 10px;font-size:11px;line-height:1.4;",
      "box-shadow:0 8px 24px rgba(0,0,0,.4)}",
      ".chip.on{display:block}",
      ".chip.ok{color:#35d07f}.chip.bad{color:#ff7a7a}.chip.warn{color:#f0b429}",
      ".btn{width:46px;height:46px;border-radius:50%;border:none;cursor:pointer;",
      "background:#2b6cf6;color:#fff;display:flex;align-items:center;justify-content:center;",
      "box-shadow:0 6px 18px rgba(43,108,246,.45);padding:0}",
      ".btn:hover{background:#1f5ae0}",
      ".btn:active{transform:translateY(1px)}",
      ".btn.busy{background:#55637a;box-shadow:none;cursor:default}",
      ".btn.busy svg{animation:spin 1s linear infinite}",
      "@keyframes spin{to{transform:rotate(360deg)}}",
      "</style>",
      '<div class="wrap">',
      '  <div class="chip" id="chip"></div>',
      '  <button class="btn" id="btn" title="Solve this question" aria-label="Solve this question">',
      '    <svg id="ico" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">',
      '      <path d="M13 2L4.5 13.5H11L10 22L19 10H12.5L13 2Z" fill="currentColor"/>',
      "    </svg>",
      "  </button>",
      "</div>",
    ].join("");
    document.body.appendChild(host);

    const $ = (id) => sr.getElementById(id);
    $("btn").onclick = () => autoSolve(true);

    panel = {
      host,
      status(state, msg) {
        const chip = $("chip"), btn = $("btn");
        if (!chip || !btn) return;
        btn.className = "btn" + (state === "working" ? " busy" : "");
        chip.textContent = msg;
        chip.className = "chip on " +
          ({ done: "ok", fail: "bad", manual: "warn", capture: "" }[state] || "");
        clearTimeout(openTimer);
        if (state !== "working") {
          openTimer = setTimeout(() => {
            try { chip.className = "chip"; } catch (_) {}
          }, 7000);
        }
      },
    };
  }

  function unmountPanel() {
    try { if (panel && panel.host) panel.host.remove(); } catch (_) {}
    panel = null;
  }

  function panelTick() {
    try {
      if (hidden) return;
      const q = hasQuestion();
      if (q && !panel) mountPanel();
      else if (!q && panel && !busy) { unmountPanel(); return; }
    } catch (_) {}
  }

  function startPanel() {
    panelTick();
    setInterval(panelTick, 1200);
  }
  if (document.body) startPanel();
  else document.addEventListener("DOMContentLoaded", startPanel);


  /* exported for the offline parser test (no-op in the browser) */
  try {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = { parseInteraction, harvest, norm, entriesFromCourse };
    }
  } catch (_) {}
})();
