// 「检查」流程测试：并发读取、单独检查一个订阅、读取期间编辑不丢（模拟 chrome API，node test_check_bg.js）
const fs = require("fs"), vm = require("vm"), path = require("path");
const DAY = 86400000;
const realTimeout = setTimeout;
function boot(readMs, withWindows) {
  const store = { subs: [] }, listeners = {}, log = [];
  let active = 0, maxActive = 0, tabSeq = 100;
  const wins = {}, created = [], removedWins = [];
  let winSeq = 1;
  const ev = (n) => ({ addListener: (f) => { (listeners[n] = listeners[n] || []).push(f); }, removeListener() {} });
  const chrome = {
    storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                        set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
                        remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); } } },
    permissions: { contains: async () => true, onAdded: ev("padd") },
    tabs: {
      query: async () => [],
      create: async (o) => { const id = ++tabSeq; created.push({ id, windowId: o.windowId == null ? 0 : o.windowId, url: o.url, active: o.active });
        if (o.windowId != null) { if (!wins[o.windowId]) throw new Error("No window with id"); wins[o.windowId].push(id); }
        realTimeout(() => (listeners.tu || []).forEach(f => f(id, { status: "complete" })), 1); return { id, windowId: o.windowId == null ? 0 : o.windowId }; },
      remove: async (id) => { for (const w of Object.keys(wins)) wins[w] = wins[w].filter(x => x !== id); (listeners.tr || []).forEach(f => f(id)); },
      onUpdated: ev("tu"), onRemoved: ev("tr") },
    scripting: { executeScript: async (o) => {
      active++; maxActive = Math.max(maxActive, active); log.push(o.args && o.args[0] && o.args[0].kind || "activity");
      await new Promise(r => realTimeout(r, readMs));
      active--;
      if (o.args && o.args[0] && o.args[0].kind) {
        const kind = o.args[0].kind;
        return [{ result: { kind, ok: true, loggedOut: false, plan: kind === "claude" ? { capabilities: ["claude_pro"] } : { plan_type: "plus" },
          timestamps: [new Date(Date.now() - DAY).toISOString()], convCount: 1 } }];
      }
      return [{ result: { ids: ["v" + Math.random()], topLabel: "", loggedOut: false, historyOff: false } }];
    } },
    webNavigation: { onCompleted: ev("a"), onHistoryStateUpdated: ev("b") },
    windows: withWindows ? {
      create: async (o) => { const id = ++winSeq; wins[id] = []; created.push({ window: id, state: o.state, focused: o.focused, url: o.url }); return { id, tabs: [{ id: ++tabSeq, windowId: id }] }; },
      get: async (id) => { if (!wins[id]) throw new Error("No window"); return { id }; },
      remove: async (id) => { delete wins[id]; removedWins.push(id); (listeners.wr || []).forEach(f => f(id)); },
      onRemoved: ev("wr") } : undefined,
    alarms: { onAlarm: ev("c"), create() {} }, runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
    notifications: { onClicked: ev("f"), create() {} }
  };
  // 后台脚本里的固定等待（等页面渲染）在测试里缩短
  const ctx = { console, chrome, setTimeout: (f, ms) => realTimeout(f, Math.min(ms || 0, 5)), clearTimeout, Promise, Date, JSON, Math, Set, Map, URL, URLSearchParams, importScripts: () => {} };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "activity.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  const send = (m) => new Promise(r => listeners.msg[0](m, {}, r));
  return { store, send, stats: () => ({ maxActive }), log, created, removedWins, wins };
}
const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) process.exitCode = 1; };
const subsFixture = () => [
  { id: "yt", name: "YouTube", mode: "activity", provider: "youtube", idleDays: 30 },
  { id: "c", name: "Claude", mode: "activity", provider: "claude", idleDays: 30 },
  { id: "g", name: "ChatGPT", mode: "activity", provider: "chatgpt", idleDays: 30 },
  { id: "n", name: "Notion", mode: "browser", urlPattern: "notion.so", idleDays: 30, lastUsed: Date.now() - DAY }
];

(async () => {
  const READ = 300;
  let B = boot(READ);
  B.store.subs = subsFixture();
  let t0 = Date.now();
  await B.send({ type: "RUN_CHECK" });
  let took = Date.now() - t0;
  t(`3 个需要读取的订阅并发读取（${took}ms，顺序执行要 ${3 * READ}ms 以上）`, took < 2 * READ && B.stats().maxActive === 3);
  t("全部读到了结果", B.store.subs.find(s => s.id === "c").llm.plan.key === "pro" && B.store.subs.find(s => s.id === "g").llm.plan.key === "plus" && B.store.subs.find(s => s.id === "yt").sig);
  t("全部检查会更新「上次检查」时间", typeof B.store.lastCheck === "number");

  B = boot(READ);
  B.store.subs = subsFixture();
  t0 = Date.now();
  await B.send({ type: "RUN_CHECK", ids: ["c"] });
  took = Date.now() - t0;
  t("单独检查一个：只读了 Claude", B.log.length === 1 && B.log[0] === "claude");
  t("其它订阅没被动", !B.store.subs.find(s => s.id === "g").llm && !B.store.subs.find(s => s.id === "yt").sig);
  t("单独检查不更新「上次检查」时间", B.store.lastCheck === undefined);
  t("单独检查一个浏览器访问型订阅：不需要读取，立即完成", await (async () => { const a = Date.now(); await B.send({ type: "RUN_CHECK", ids: ["n"] }); return Date.now() - a < 100 && B.log.length === 1; })());

  B = boot(READ);
  B.store.subs = subsFixture();
  const p = B.send({ type: "RUN_CHECK" });
  await new Promise(r => realTimeout(r, 50));
  // 读取进行中，用户改了 Claude 的月费和名字
  await B.send({ type: "SAVE_SUB", sub: Object.assign({}, B.store.subs.find(s => s.id === "c"), { price: 18, name: "Claude Pro" }) });
  await p;
  const c = B.store.subs.find(s => s.id === "c");
  t("读取期间的编辑不会被检查结果覆盖", c.price === 18 && c.name === "Claude Pro" && c.llm && c.llm.plan.key === "pro");

  B = boot(READ);
  B.store.subs = subsFixture();
  await Promise.all([B.send({ type: "RUN_CHECK" }), B.send({ type: "RUN_CHECK", ids: ["c"] })]);
  t("同时点了「立即检查」和单独检查：同一个订阅只读一次", B.log.filter(k => k === "claude").length === 1);

  B = boot(READ);
  const many = [];
  for (let i = 0; i < 9; i++) many.push({ id: "s" + i, name: "S" + i, mode: "activity", provider: "youtube", idleDays: 30 });
  B.store.subs = many;
  await B.send({ type: "RUN_CHECK" });
  t("并发有上限（最多同时 4 个，避免一下开太多标签页）", B.stats().maxActive === 4 && B.log.length === 9);

  // 后台读取放进最小化的专用窗口
  B = boot(READ, true);
  B.store.subs = many;
  await B.send({ type: "RUN_CHECK" });
  const winsMade = B.created.filter(c => c.window);
  const tabsMade = B.created.filter(c => !c.window);
  t("9 个读取只建了 1 个窗口，而且是最小化、不抢焦点的", winsMade.length === 1 && winsMade[0].state === "minimized" && winsMade[0].focused === false);
  t("所有读取的标签页都开在这个窗口里，当前窗口一个都没有", tabsMade.length === 9 && tabsMade.every(c => c.windowId === winsMade[0].window && c.active === false));
  await new Promise(r => realTimeout(r, 60));
  t("读完后自动关掉这个窗口", B.removedWins.length === 1 && B.removedWins[0] === winsMade[0].window);
  await B.send({ type: "RUN_CHECK", ids: ["s1"] });
  t("下次检查重新建一个窗口", B.created.filter(c => c.window).length === 2);
})();
