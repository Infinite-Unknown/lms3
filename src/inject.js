/* EG Answer Lab - MAIN world network sniffer.
 * Easygenerator validates answers client-side, so every xAPI "answered"
 * statement it emits carries definition.correctResponsesPattern.
 * We read those payloads in-page and hand them to the content script.
 */
(() => {
  "use strict";
  const TAG = "__EG_ANSWER_LAB__";
  const MARKERS = ["correctResponsesPattern", "isCorrect", "correctFeedback"];

  const send = (payload, origin) => {
    try {
      window.postMessage({ source: TAG, kind: "payload", origin, payload }, "*");
    } catch (_) {}
  };

  function looksRelevant(text) {
    if (typeof text !== "string" || text.length < 20) return false;
    for (const m of MARKERS) if (text.indexOf(m) !== -1) return true;
    return false;
  }

  function scan(text, origin) {
    try {
      if (!looksRelevant(text)) return;
      send(JSON.parse(text), origin);
    } catch (_) {
      // Not plain JSON (e.g. a data.js bundle). Pull embedded JSON blobs out.
      try {
        const re = /\{[\s\S]{40,}?"correctResponsesPattern"[\s\S]*?\}/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          try { send(JSON.parse(m[0]), origin + ":embedded"); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  /* ---- fetch ---- */
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        let body = init && init.body;
        if (body == null && input && typeof input === "object" && "body" in input) body = null;
        if (typeof body === "string") scan(body, "fetch-request");
      } catch (_) {}
      const p = nativeFetch.apply(this, arguments);
      try {
        return p.then((res) => {
          try {
            const ct = (res.headers && res.headers.get("content-type")) || "";
            if (/json|javascript|text/i.test(ct)) {
              res.clone().text().then((t) => scan(t, "fetch-response")).catch(() => {});
            }
          } catch (_) {}
          return res;
        });
      } catch (_) {
        return p;
      }
    };
  }

  /* ---- XMLHttpRequest ---- */
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__egUrl = url;
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { if (typeof body === "string") scan(body, "xhr-request"); } catch (_) {}
    try {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            scan(this.responseText, "xhr-response");
          } else if (this.responseType === "json" && this.response) {
            send(this.response, "xhr-response-json");
          }
        } catch (_) {}
      });
    } catch (_) {}
    return xhrSend.apply(this, arguments);
  };

  /* ---- sendBeacon ---- */
  const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (beacon) {
    navigator.sendBeacon = function (url, data) {
      try { if (typeof data === "string") scan(data, "beacon"); } catch (_) {}
      return beacon(url, data);
    };
  }

  /* ---- on-demand deep scan of the in-page course model ---- */
  function deepScan() {
    const seen = new WeakSet();
    const out = [];
    const walk = (node, depth) => {
      if (!node || depth > 8 || out.length > 400) return;
      if (typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
      if (node.correctResponsesPattern || (node.definition && node.definition.correctResponsesPattern)) {
        out.push(node);
      }
      for (const k in node) {
        let v;
        try { v = node[k]; } catch (_) { continue; }
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    };
    for (const k of Object.keys(window)) {
      if (/^(window|self|top|parent|frames|document|location)$/.test(k)) continue;
      let v;
      try { v = window[k]; } catch (_) { continue; }
      if (v && typeof v === "object") walk(v, 0);
    }
    if (out.length) send(out, "deep-scan");
    window.postMessage({ source: TAG, kind: "deep-scan-done", count: out.length }, "*");
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.source === TAG && d.kind === "deep-scan-request") deepScan();
  });
})();
