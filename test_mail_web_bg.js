// 后台「读 Gmail 网页」扫描流程的测试（模拟 chrome API，node test_mail_web_bg.js）
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = __dirname;
function run(pagesResults, opts) {
  const store = {}; const calls = []; let execN = 0; const listeners = {};
  const ev = (n) => ({ addListener: (f) => { listeners[n] = f; }, removeListener() {} });
  const chrome = {
    storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                        set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
    permissions: { contains: async () => opts.perm !== false, onAdded: ev("padd") },
    tabs: { create: async (o) => { calls.push(["create", o.url, o.active]); setTimeout(() => listeners.tabsUpdated && listeners.tabsUpdated(7, { status: "complete" }), 5); return { id: 7 }; },
            update: async (id, o) => { calls.push(["update", o.url]); }, remove: async () => { calls.push(["remove"]); }, onUpdated: ev("tabsUpdated"), onRemoved: ev("tr") },
    scripting: { executeScript: async (o) => { calls.push(["exec", o.args[0].prevFp]); const r = pagesResults[execN++]; return [{ result: r }]; } },
    webNavigation: { onCompleted: ev("a"), onHistoryStateUpdated: ev("b") },
    alarms: { onAlarm: ev("c"), create() {} }, runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
    notifications: { onClicked: ev("f"), create() {} }
  };
  const ctx = { console, chrome, setTimeout, clearTimeout, Promise, Date, JSON, Math, Set, Map, importScripts: () => {} };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ["lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
  return new Promise((resolve) => {
    listeners.msg({ type: "MAIL_SCAN_START", account: "1", pages: "5" }, {}, async (resp) => {
      for (let i = 0; i < 300 && resp.ok && (!store.mailScan || store.mailScan.status === "running"); i++) await new Promise(r => setTimeout(r, 10));
      resolve({ resp, store, calls });
    });
  });
}
const mkRows = (p, n) => Array.from({ length: n }, (_, i) => ({ email: "billing@x" + (i % 3) + ".com", name: "X" + (i % 3), subject: "Your receipt", snippet: "$5", date: "2026年" + (9 - p) + "月" + (i % 28 + 1) + "日", threadId: p + "-" + i, threadCount: 1 }));
const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) process.exitCode = 1; };
(async () => {
  let r = await run([
    { rows: mkRows(1, 50), fp: "A", stats: { rowEls: 50 }, account: "me@gmail.com" },
    { rows: mkRows(2, 50), fp: "B" },
    { rows: mkRows(3, 12), fp: "C" }
  ], {});
  t("启动立即返回 ok", r.resp.ok);
  t("读完 3 页（第 3 页不满即停）", r.store.mailScan.status === "done" && r.store.mailScan.pagesRead === 3 && r.store.mailScan.rowsRead === 112);
  t("账号序号 1、后台标签页", r.calls[0][1].startsWith("https://mail.google.com/mail/u/1/#search/") && r.calls[0][2] === false);
  t("翻页 URL 带 /p2 /p3", r.calls.filter(c => c[0] === "update").map(c => c[1].slice(-3)).join() === "/p2,/p3");
  t("翻页时传上一页指纹", r.calls.filter(c => c[0] === "exec").map(c => c[1]).join() === ",A,B");
  t("有候选、记下账号", r.store.mailScan.candidates.length === 3 && r.store.mailScan.email === "me@gmail.com");
  t("标签页最后被关掉", r.calls[r.calls.length - 1][0] === "remove");

  r = await run([{ loggedOut: true, rows: [] }], {});
  t("未登录 → error logged_out", r.store.mailScan.status === "error" && r.store.mailScan.error === "logged_out");
  r = await run([{ rows: [], fp: "", timedOut: true, stats: { rowEls: 0, withSender: 0, withSubject: 0, withDate: 0 } }], {});
  t("读不到行 → error read_failed（不是「没有订阅」）", r.store.mailScan.error === "read_failed" && r.store.mailScan.stats.rowEls === 0);
  r = await run([{ rows: [], noResults: true }], {});
  t("没有搜索结果 → done、0 个候选", r.store.mailScan.status === "done" && r.store.mailScan.candidates.length === 0);
  r = await run([{ rows: mkRows(1, 50), fp: "A" }, { rows: mkRows(1, 50), fp: "A", timedOut: true }], {});
  t("翻页内容不变 → 停在第 1 页", r.store.mailScan.pagesRead === 1);
  r = await run([], { perm: false });
  t("没权限 → 拒绝启动", r.resp.ok === false && r.resp.reason === "no_permission" && !r.store.mailScan);
})();
