// 后台「大模型订阅」流程测试：一键添加、定时检查、二选一建议、续费提醒（模拟 chrome API，node test_llm_bg.js）
const fs = require("fs"), vm = require("vm"), path = require("path");
const DAY = 86400000;
function boot(pages, opts) {
  opts = opts || {};
  const store = { subs: [] }, log = [], listeners = {}, notes = [];
  const ev = (n) => ({ addListener: (f) => { listeners[n] = f; }, removeListener() {} });
  const chrome = {
    storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                        set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
                        remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); } } },
    permissions: { contains: async ({ origins }) => !(opts.denied || []).includes(origins[0]), onAdded: ev("padd") },
    tabs: {
      query: async ({ url }) => (opts.openTabs || []).filter(t => url.indexOf(t.domain) >= 0).map(t => ({ id: t.id, status: "complete", url: "https://" + t.domain + "/" })),
      create: async (o) => { log.push(["create", o.url, o.active]); setTimeout(() => listeners.tu && listeners.tu(99, { status: "complete" }), 1); return { id: 99 }; },
      remove: async (id) => { log.push(["remove", id]); }, onUpdated: ev("tu"), onRemoved: ev("tr") },
    scripting: { executeScript: async (o) => { log.push(["exec", o.target.tabId, o.args[0].kind, o.world]); return [{ result: pages[o.args[0].kind] }]; } },
    webNavigation: { onCompleted: ev("a"), onHistoryStateUpdated: ev("b") },
    alarms: { onAlarm: ev("c"), create() {} }, runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
    notifications: { onClicked: ev("f"), create: (id, o) => notes.push([id, o]) }
  };
  const ctx = { console, chrome, fetch: opts.fetch, setTimeout: (f) => setTimeout(f, 0), clearTimeout, Promise, Date, JSON, Math, Set, Map, URL, URLSearchParams, importScripts: () => {} };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ["lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  const send = (m) => new Promise(r => listeners.msg(m, {}, r));
  return { store, log, notes, send };
}
const now = Date.now();
const iso = (d) => new Date(now - d * DAY).toISOString();
// 按本地日期算的「第 k 天前中午」：不管几点跑测试，每个时间都落在不同的自然日
const noon = (k) => { const x = new Date(now); x.setHours(12, 0, 0, 0); return new Date(x.getTime() - k * DAY).toISOString(); };
const claudePage = { kind: "claude", ok: true, loggedOut: false,
  plan: { capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_5x", business: false },
  timestamps: [iso(0.001), noon(1), noon(2), noon(5), noon(9), noon(12), noon(15), noon(20), noon(25)], convCount: 9,
  usage: { five_hour: { utilization: 8 }, seven_day: { utilization: 9 } }, renew: new Date(now + 2 * DAY).toISOString() };
const gptPage = { kind: "chatgpt", ok: true, loggedOut: false,
  plan: { plan_type: "plus", structure: "personal", origin: "chatgpt_ios", will_renew: true, business: false },
  timestamps: [iso(3), iso(28)], convCount: 2, renew: new Date(now + 1 * DAY).toISOString() };
const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) process.exitCode = 1; };

(async () => {
  let B = boot({ claude: claudePage, chatgpt: gptPage }, { openTabs: [{ id: 5, domain: "claude.ai" }] });
  let r = await B.send({ type: "LLM_QUICK_ADD", kind: "claude" });
  t("一键添加 Claude 成功", r.ok && r.sub.name === "Claude" && r.sub.mode === "activity" && r.sub.provider === "claude");
  t("识别 Max 5x，月费按公开价估 $100", r.sub.llm.plan.key === "max5x" && r.sub.price === 100 && r.sub.priceEstimated === true);
  t("借用已打开的 claude.ai 标签页，不新开", B.log.some(x => x[0] === "exec" && x[1] === 5 && x[3] === "MAIN") && !B.log.some(x => x[0] === "create"));
  t("最近使用时间来自对话时间", Math.abs(r.sub.lastUsed - (now - 0.001 * DAY)) < 5000);
  t("近 30 天活跃 9 天", r.sub.llm.stats.activeDays30 === 9);
  t("额度数据不足 3 周 → 先等", r.sub.llm.advice.level === "wait");

  r = await B.send({ type: "LLM_QUICK_ADD", kind: "chatgpt" });
  t("一键添加 ChatGPT：没开着就后台开一个，读完关掉", r.ok && B.log.some(x => x[0] === "create" && x[1] === "https://chatgpt.com/" && x[2] === false) && B.log.some(x => x[0] === "remove" && x[1] === 99));
  t("ChatGPT Plus 经 App Store", r.sub.llm.plan.key === "plus" && r.sub.llm.origin === "apple" && r.sub.price === 20);
  t("ChatGPT 近 30 天只用 2 天 → 考虑降档", r.sub.llm.advice.level === "downgrade");
  t("二选一建议挂在 ChatGPT 上", /只留 Claude/.test(r.sub.llm.cross || ""));
  t("重复添加不会重复建订阅", (await B.send({ type: "LLM_QUICK_ADD", kind: "chatgpt" })).ok && B.store.subs.length === 2);

  await B.send({ type: "RUN_CHECK" });
  const gpt = B.store.subs.find(s => s.provider === "chatgpt");
  t("定时检查后仍有二选一建议", /只留 Claude/.test(gpt.llm.cross || ""));
  t("ChatGPT 明天续费 + 有建议 → 发续费提醒", B.notes.some(n => n[0] === "renew-" + gpt.id && /明天|1 天后/.test(n[1].title) && /只留 Claude/.test(n[1].message)));
  const claude = B.store.subs.find(s => s.provider === "claude");
  t("Claude 没有退订/降档建议 → 不发续费提醒", !B.notes.some(n => n[0] === "renew-" + claude.id));
  const before = B.notes.length;
  await B.send({ type: "RUN_CHECK" });
  t("同一次续费只提醒一次", B.notes.filter(n => n[0].startsWith("renew-")).length === B.notes.slice(0, before).filter(n => n[0].startsWith("renew-")).length);
  t("每次检查累积一个额度采样", claude.llm.samples.length >= 2);

  // 登录过期：冻结判断，不给退订建议
  B = boot({ claude: { kind: "claude", ok: false, loggedOut: true } });
  B.store.subs = [{ id: "c", name: "Claude", mode: "activity", provider: "claude", lastUsed: now - 90 * DAY, idleDays: 30, price: 20 }];
  await B.send({ type: "RUN_CHECK" });
  t("登录过期 → 信号中断，不是闲置", B.store.subs[0].signal.ok === false && B.store.subs[0].signal.reason === "logged_out" && !B.notes.some(n => n[0].startsWith("idle-")));

  // 没授权
  B = boot({}, { denied: ["https://claude.ai/*"] });
  r = await B.send({ type: "LLM_QUICK_ADD", kind: "claude" });
  t("没授权 → 不添加，返回原因", !r.ok && r.reason === "no_permission" && B.store.subs.length === 0);

  // 后台直接调接口读到了：不开任何网页
  {
    const J = (st, body) => ({ status: st, ok: st < 300, headers: { get: () => "application/json" }, json: async () => body });
    const B2 = boot({}, { fetch: async (url) => {
      if (url === "https://claude.ai/api/organizations") return J(200, [{ uuid: "o1", capabilities: ["chat", "claude_pro"], rate_limit_tier: "default_claude_pro" }]);
      if (url.indexOf("chat_conversations") >= 0) return J(200, [{ updated_at: iso(1) }]);
      return J(404, {});
    } });
    const r2 = await B2.send({ type: "LLM_QUICK_ADD", kind: "claude" });
    t("后台直接调接口读到套餐：不打开网页", r2.ok && B2.store.subs[0].llm.plan.key === "pro" && !B2.log.some(x => x[0] === "create" || x[0] === "exec"), B2.log);
    // 直接读不到（比如没登录、或接口拒绝）：退回打开网页读，由网页判断是否登录
    const B3 = boot({ claude: { kind: "claude", ok: false, loggedOut: true, plan: null, timestamps: [], shapes: {} } }, { fetch: async () => J(401, {}) });
    const r3 = await B3.send({ type: "LLM_QUICK_ADD", kind: "claude" });
    t("直接读不到：退回打开网页确认，没登录就提示去登录", !r3.ok && r3.reason === "logged_out" && B3.log.some(x => x[0] === "exec"), r3);
  }

  // 诊断
  B = boot({ claude: Object.assign({ shapes: { organizations: [{ uuid: "string" }] } }, claudePage) });
  r = await B.send({ type: "DIAGNOSE", sub: { provider: "claude" } });
  t("诊断返回套餐、统计、用量和字段结构", r.ok && r.llm && r.result.plan.key === "max5x" && r.result.stats.activeDays30 === 9 && r.result.usage.week === 9 && r.result.shapes.organizations);
})();
