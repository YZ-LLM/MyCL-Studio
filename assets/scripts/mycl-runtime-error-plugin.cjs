// MyCL Runtime Error Reporter — Vite plugin (dev-only)
//
// Bu dosya MyCL Studio tarafından kullanıcı projesine `.mycl/`
// klasörüne kopyalanır. Kullanıcı projesinin `vite.config.*` dosyasına
// import + plugins[] satırı eklenir. Vite dev modunda `transformIndexHtml`
// hook'u ile `<script>` enjekte eder; browser'da window.onerror,
// unhandledrejection ve fetch wrapper hook'larını çalıştırır. Yakalanan
// hatalar `http://localhost:9273/__mycl/runtime-error`'a POST atılır.
//
// Production build (`vite build`) etkilenmez — plugin sadece `serve`
// command'inde aktif.
//
// MIT — MyCL Studio v14 (auto-generated, DO NOT EDIT manually).

"use strict";

// v15.2 Core: port placeholder. vite-runtime-injector kopyalama sırasında
// {{MYCL_RUNTIME_PORT}}'u runtime-http-server.getRuntimeHttpPort() ile
// substitute eder. Bu sayede multi-instance kullanımda (her instance kendi
// portunu bind eder) browser doğru orchestrator'a POST atar.
const MYCL_ENDPOINT = "http://localhost:{{MYCL_RUNTIME_PORT}}/__mycl/runtime-error";

const BROWSER_SCRIPT = `
(function () {
  if (window.__myclRuntimeErrorBooted) return;
  window.__myclRuntimeErrorBooted = true;
  var endpoint = ${JSON.stringify(MYCL_ENDPOINT)};
  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      // sendBeacon: unload sırasında bile iletilir, async fire-and-forget
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () { /* MyCL kapalıysa sessiz */ });
    } catch (_e) { /* defensive */ }
  }
  // 1) Global error handler — render crash, runtime exception
  window.addEventListener("error", function (ev) {
    if (!ev) return;
    var err = ev.error || {};
    send({
      kind: "window_error",
      message: ev.message || String(err.message || "(unknown error)"),
      source: (ev.filename || "") + (ev.lineno ? ":" + ev.lineno : "") + (ev.colno ? ":" + ev.colno : ""),
      stack: err.stack || null,
    });
  });
  // 2) Unhandled promise rejection
  window.addEventListener("unhandledrejection", function (ev) {
    var reason = ev && ev.reason;
    var msg = "(unknown rejection)";
    var stack = null;
    if (reason instanceof Error) { msg = reason.message; stack = reason.stack; }
    else if (typeof reason === "string") { msg = reason; }
    else if (reason && typeof reason === "object") {
      msg = reason.message || JSON.stringify(reason).slice(0, 200);
      stack = reason.stack || null;
    }
    send({ kind: "unhandled_rejection", message: msg, source: "promise", stack: stack });
  });
  // 3) Fetch wrapper — 4xx/5xx response'lar için
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      return origFetch(input, init).then(function (res) {
        if (res && !res.ok && res.status >= 400) {
          send({
            kind: "fetch_error",
            message: method.toUpperCase() + " " + url + " → HTTP " + res.status + " " + (res.statusText || ""),
            source: url,
            url: url,
            status: res.status,
          });
        }
        return res;
      }).catch(function (err) {
        send({
          kind: "fetch_error",
          message: method.toUpperCase() + " " + url + " → network error: " + (err && err.message ? err.message : String(err)),
          source: url,
          url: url,
        });
        throw err;
      });
    };
  }
})();
`;

/** @returns {import("vite").Plugin} */
function myclRuntimeErrorPlugin() {
  return {
    name: "mycl-runtime-error-reporter",
    apply: "serve", // sadece dev mode — vite build etkilenmez
    transformIndexHtml(html) {
      // </head>'in hemen öncesine inject; head yoksa start'a ekle.
      const tag = `<script type="text/javascript">${BROWSER_SCRIPT}</script>`;
      if (html.includes("</head>")) {
        return html.replace("</head>", `${tag}\n</head>`);
      }
      return tag + html;
    },
  };
}

module.exports = myclRuntimeErrorPlugin;
module.exports.default = myclRuntimeErrorPlugin;
