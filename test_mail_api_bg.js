// Gmail 接口模式已移除：确认即使收到旧版弹窗发来的 source: "api"，也只走「读 Gmail 网页」，不会请求 Gmail 接口
// （模拟 chrome API，node test_mail_api_bg.js）
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = __dirname;
const store = {}, calls = [], fetches = [], listeners = {};
const ev = (n) => ({ addListener: (f) => { listeners[n] = f; }, removeListener() {} });
const chrome = {
  storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                      set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
  permissions: { contains: async ({ origins }) => (origins || []).every(o => o === "https://mail.google.com/*"), onAdded: ev("padd") },
  tabs: { create: async (o) => { calls.push(o.url); setTimeout(() => listeners.tu && listeners.tu(7, { status: "complete" }), 5); return { id: 7 }; },
          update: async () => {}, remove: async () => {}, onUpdated: ev("tu"), onRemoved: ev("tr") },
  scripting: { executeScript: async () => [{ result: { rows: [], fp: "A", stats: { rowEls: 0 } } }] },
  identity: { getRedirectURL: () => "x", launchWebAuthFlow: async () => { fetches.push("oauth"); throw new Error("no"); } },
  webNavigation: { onCompleted: ev("a"), onHistoryStateUpdated: ev("b") },
  alarms: { onAlarm: ev("c"), create() {} }, runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
  notifications: { onClicked: ev("f"), create() {} }
};
const ctx = { console, chrome, setTimeout, clearTimeout, Promise, Date, JSON, Math, Set, Map, URL, URLSearchParams,
  fetch: async (u) => { fetches.push(u); throw new Error("no network"); }, importScripts: () => {} };
ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ["i18n.js", "i18n-en.js", "lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) process.exitCode = 1; };
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
(async () => {
  const resp = await new Promise(r => listeners.msg({ type: "MAIL_SCAN_START", source: "api", clientId: "12-x.apps.googleusercontent.com", account: "0", pages: "3" }, {}, r));
  for (let i = 0; i < 300 && (!store.mailScan || store.mailScan.status === "running"); i++) await new Promise(r => setTimeout(r, 10));
  t("旧的 source: api 也只走网页扫描", resp.ok && calls[0] && calls[0].startsWith("https://mail.google.com/mail/u/0/") && store.mailScan.source === "web");
  t("没有请求 Gmail 接口、没有弹 Google 授权", !fetches.some(u => String(u).includes("gmail.googleapis.com")) && !fetches.includes("oauth"));
  t("manifest 不再申请 gmail.googleapis.com", !JSON.stringify(manifest).includes("gmail.googleapis.com"));
  t("后台代码里没有 Gmail 接口模式了", !/runMailScanApi|gmail\.googleapis\.com/.test(fs.readFileSync(path.join(dir, "background.js"), "utf8")));
})();
