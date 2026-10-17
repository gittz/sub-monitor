// llm.js 的测试：纯函数 + 用模拟接口跑一遍页面读取函数（node test_llm.js）
const fs = require("fs"), vm = require("vm"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "llm.js"), "utf8");

function load(fetchImpl, href) {
  const ctx = { console, setTimeout, Promise, JSON, Date, Math, Set, fetch: fetchImpl, location: { href: href || "https://claude.ai/" } };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(SRC, ctx);
  return ctx.LlmLib;
}
const L = load(null);
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n); } };
const DAY = 86400000;
const NOW = new Date(2026, 8, 28, 12).getTime();

console.log("== parseTs ==");
check("ISO", L.parseTs("2026-09-20T10:00:00Z") === Date.parse("2026-09-20T10:00:00Z"));
check("秒级时间戳（ChatGPT 常见）", L.parseTs(1790000000.123) === 1790000000123);
check("毫秒", L.parseTs(1790000000123) === 1790000000123);
check("数字字符串", L.parseTs("1790000000") === 1790000000000);
check("无效", L.parseTs("abc") === null && L.parseTs(null) === null);

console.log("== normalizePlan ==");
check("Claude Max 5x", L.normalizePlan("claude", { rate_limit_tier: "default_claude_max_5x", capabilities: ["chat", "claude_max"] }).key === "max5x");
check("Claude Max 20x", L.normalizePlan("claude", { rate_limit_tier: "default_claude_max_20x" }).label === "Max 20x");
check("Claude Pro", L.normalizePlan("claude", { capabilities: ["chat", "claude_pro"] }).key === "pro");
check("Claude Free", L.normalizePlan("claude", { capabilities: ["chat"] }).paid === false);
check("Claude 团队", L.normalizePlan("claude", { business: true }).business === true);
check("ChatGPT Plus", L.normalizePlan("chatgpt", { plan_type: "plus" }).key === "plus");
check("ChatGPT Go", L.normalizePlan("chatgpt", { plan_type: "go" }).label === "Go");
check("ChatGPT Team 算公司付费", L.normalizePlan("chatgpt", { plan_type: "team" }).business === true);
check("ChatGPT Free", L.normalizePlan("chatgpt", { plan_type: "free" }).paid === false);
check("付费渠道", L.normalizeOrigin("chatgpt_ios") === "apple" && L.normalizeOrigin("chatgpt_android") === "google" && L.normalizeOrigin("chatgpt_web") === "web" && L.normalizeOrigin("") === null);

console.log("== llmStats ==");
const ts = [NOW - 1 * 3600e3, NOW - 2 * 3600e3, NOW - 3 * DAY, NOW - 10 * DAY, NOW - 40 * DAY];
const st = L.llmStats(ts.map(t => new Date(t).toISOString()), NOW);
check("最近使用", st.lastUsed === NOW - 3600e3);
check("近 30 天活跃天数（同一天算一天）", st.activeDays30 === 3);
check("近 7 天对话数", st.convs7 === 3 && st.activeDays7 === 2);
check("近 30 天对话数", st.convs30 === 4 && !st.capped);
check("空列表", L.llmStats([], NOW).lastUsed === null && L.llmStats([], NOW).activeDays30 === 0);

console.log("== 用量与采样 ==");
const u = L.pickUsage({ five_hour: { utilization: 12.4, resetsAt: "x" }, seven_day: { utilization: 30 }, seven_day_opus: { utilization: 5 } });
check("映射 5 小时 / 本周 / 高阶模型", u.fiveHour === 12 && u.week === 30 && u.weekOpus === 5);
check("没有用量", L.pickUsage(null) === null);
let samples = [];
for (let i = 27; i >= 0; i--) samples = L.addSample(samples, { fiveHour: 10, week: 8 + (i % 3) }, NOW - i * DAY);
check("每天一个采样，28 个", samples.length === 28);
check("超过 90 天的丢掉", L.addSample([{ t: NOW - 100 * DAY, wk: 1 }], null, NOW).length === 0);
const pk = L.weeklyPeaks(samples, NOW, 4);
check("4 周峰值", pk.length === 4 && pk.every(p => p && p.week === 10 && p.fiveHour === 10));

console.log("== 建议 ==");
const mk = (kind, planRaw, statsOverride, smp) => {
  const plan = L.normalizePlan(kind, planRaw);
  return { plan, stats: Object.assign({ lastUsed: NOW - DAY, activeDays30: 15, activeDays7: 4, convs30: 60, convs7: 12 }, statsOverride || {}), samples: smp || [] };
};
check("30 天没用 → 考虑退订", L.llmAdvice("claude", mk("claude", { capabilities: ["claude_pro"] }, { activeDays30: 0, lastUsed: NOW - 45 * DAY }), NOW).level === "cancel");
const down = L.llmAdvice("claude", mk("claude", { rate_limit_tier: "max_5x" }, {}, samples), NOW);
check("Max 5x 连续 4 周峰值 10% → 建议降到 Pro", down.level === "downgrade" && /Pro/.test(down.text) && /\$80/.test(down.text));
check("Max 5x 数据不足 3 周 → 先等", L.llmAdvice("claude", mk("claude", { rate_limit_tier: "max_5x" }, {}, samples.slice(-10)), NOW).level === "wait");
const high = samples.map(s => Object.assign({}, s, { wk: 60 }));
check("Max 5x 用到 60% → 档位合适", L.llmAdvice("claude", mk("claude", { rate_limit_tier: "max_5x" }, {}, high), NOW).level === "keep");
const capped = samples.map((s, i) => Object.assign({}, s, { fh: i % 10 === 0 ? 100 : 20 }));
check("经常用满 → 花得值", /花得值/.test(L.llmAdvice("claude", mk("claude", { rate_limit_tier: "max_5x" }, {}, capped), NOW).text));
check("5 小时额度偶尔超过 Pro 的量 → 不建议降", L.llmAdvice("claude", mk("claude", { rate_limit_tier: "max_5x" }, {}, samples.map(s => Object.assign({}, s, { fh: 50 }))), NOW).level === "keep");
check("ChatGPT Plus 只用 3 天 → 考虑降档", L.llmAdvice("chatgpt", mk("chatgpt", { plan_type: "plus" }, { activeDays30: 3 }), NOW).level === "downgrade");
check("ChatGPT Pro 只用 8 天 → 考虑换 Plus", /Plus/.test(L.llmAdvice("chatgpt", mk("chatgpt", { plan_type: "pro" }, { activeDays30: 8 }), NOW).text));
check("正常使用 → keep", L.llmAdvice("chatgpt", mk("chatgpt", { plan_type: "plus" }), NOW).level === "keep");
check("公司付费不给建议", L.llmAdvice("chatgpt", mk("chatgpt", { plan_type: "team" }, { activeDays30: 0 }), NOW).level === "none");
check("免费版不给建议", L.llmAdvice("claude", mk("claude", { capabilities: ["chat"] }, { activeDays30: 0 }), NOW).level === "none");
const cross = L.crossAdvice([
  { id: "a", name: "Claude", llm: mk("claude", { capabilities: ["claude_pro"] }, { activeDays30: 20 }) },
  { id: "b", name: "ChatGPT", llm: mk("chatgpt", { plan_type: "plus" }, { activeDays30: 3 }) }]);
check("两家都付费、一家用得很少 → 只留一个", cross && cross.drop === "b" && /只留 Claude/.test(cross.text));
check("两家都常用 → 不提", L.crossAdvice([
  { id: "a", name: "Claude", llm: mk("claude", { capabilities: ["claude_pro"] }, { activeDays30: 20 }) },
  { id: "b", name: "ChatGPT", llm: mk("chatgpt", { plan_type: "plus" }, { activeDays30: 12 }) }]) === null);
check("价格估算", L.priceHint("claude", "max5x") === 100 && L.priceHint("chatgpt", "pro") === null);

// ---------- 页面读取函数（模拟两个网站的接口） ----------
function res(status, body, ct) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => ct || "application/json" }, json: async () => body };
}
async function pageTests() {
  console.log("== llmReadPage：Claude ==");
  const calls = [];
  let P = load(async (url) => {
    calls.push(url);
    if (url === "/api/organizations") return res(200, [
      { uuid: "team1", capabilities: ["chat", "raven"], rate_limit_tier: "default_raven", name: "Company" },
      { uuid: "org1", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_5x", billing_type: "stripe_subscription", name: "me@x.com's Organization" }]);
    if (url.startsWith("/api/organizations/org1/chat_conversations")) return res(200, [
      { uuid: "c1", name: "SECRET TITLE", updated_at: "2026-09-27T10:00:00Z" }, { uuid: "c2", name: "x", updated_at: "2026-09-20T10:00:00Z" }]);
    if (url === "/api/organizations/org1/usage") return res(200, { five_hour: { utilization: 22, resets_at: "2026-09-28T15:00:00Z" }, seven_day: { utilization: 41, resets_at: "2026-10-01T00:00:00Z" }, seven_day_opus: null });
    if (url === "/api/organizations/org1/subscription_details") return res(200, { status: "active", next_charge_date: "2026-10-05", payment_method: { type: "card" } });
    return res(404, {});
  });
  let r = await P.llmReadPage({ kind: "claude" });
  check("读取成功、已登录", r.ok && r.loggedOut === false);
  check("跳过团队组织，选个人付费组织", r.plan.rate_limit_tier === "default_claude_max_5x" && !r.plan.business && calls.some(c => c.indexOf("org1") >= 0) && !calls.some(c => c.indexOf("team1/") >= 0));
  check("对话时间 2 条", r.timestamps.length === 2 && r.convCount === 2);
  check("用量", r.usage.five_hour.utilization === 22 && r.usage.seven_day.utilization === 41);
  check("续费日", r.renew === "2026-10-05");
  const shapeStr = JSON.stringify(r.shapes);
  check("诊断结构里不含对话标题和组织名", shapeStr.indexOf("SECRET") < 0 && shapeStr.indexOf("me@x.com") < 0);
  check("诊断结构保留套餐字段取值", shapeStr.indexOf("default_claude_max_5x") >= 0);

  P = load(async () => res(401, { error: "unauthorized" }));
  r = await P.llmReadPage({ kind: "claude" });
  check("401 → 未登录", r.loggedOut === true && !r.ok);
  P = load(async () => res(403, "<html>", "text/html"));
  r = await P.llmReadPage({ kind: "claude" });
  check("被安全验证拦住（HTML）→ 读取失败，不当成未登录", r.loggedOut !== true && !r.ok && r.error === "read_failed");

  // 插件后台直接请求（不开网页）：带网站地址前缀
  const calls2 = [];
  P = load(async (url) => { calls2.push(url); return res(401, {}); });
  r = await P.llmReadPage({ kind: "claude", base: "https://claude.ai" });
  check("后台直接请求：用完整地址 https://claude.ai/api/...，标记 via=direct", calls2[0] === "https://claude.ai/api/organizations" && r.via === "direct" && r.loggedOut === true);

  console.log("== llmReadPage：ChatGPT ==");
  let auth = [];
  P = load(async (url, init) => {
    if (init && init.headers && init.headers.authorization) auth.push(url);
    if (url === "/api/auth/session") return res(200, { user: { email: "me@x.com" }, accessToken: "TKN", account: { planType: "plus" } });
    if (url.startsWith("/backend-api/accounts/check")) return res(200, { accounts: { default: {
      account: { plan_type: "plus", structure: "personal" },
      entitlement: { subscription_plan: "chatgptplusplan", has_active_subscription: true, expires_at: "2026-10-10T00:00:00Z" },
      last_active_subscription: { purchase_origin_platform: "chatgpt_ios", will_renew: true } } } });
    if (url.startsWith("/backend-api/conversations")) return res(200, { items: [
      { id: "1", title: "SECRET", update_time: 1790500000.5 }, { id: "2", title: "y", update_time: "2026-09-01T00:00:00Z" }], total: 2 });
    return res(404, {});
  }, "https://chatgpt.com/");
  r = await P.llmReadPage({ kind: "chatgpt" });
  check("读取成功", r.ok && r.loggedOut === false);
  check("套餐 / 渠道 / 自动续费", r.plan.plan_type === "plus" && r.plan.origin === "chatgpt_ios" && r.plan.will_renew === true && !r.plan.business);
  check("续费日", r.renew === "2026-10-10T00:00:00Z");
  check("对话时间（秒级和 ISO 都有）", r.timestamps.length === 2 && L.parseTs(r.timestamps[0]) === 1790500000500);
  check("后端接口都带了令牌", auth.length === 2);
  check("诊断结构里没有令牌、邮箱、标题", !/TKN|me@x\.com|SECRET/.test(JSON.stringify(r.shapes)));

  P = load(async (url) => url === "/api/auth/session" ? res(200, {}) : res(404, {}), "https://chatgpt.com/");
  r = await P.llmReadPage({ kind: "chatgpt" });
  check("没有令牌 → 未登录", r.loggedOut === true && !r.ok);

  P = load(async (url) => {
    if (url === "/api/auth/session") return res(200, { accessToken: "T", account: { planType: "pro" } });
    return res(500, {});
  }, "https://chatgpt.com/");
  r = await P.llmReadPage({ kind: "chatgpt" });
  check("账户接口失败时退回会话里的套餐", r.ok && r.plan.plan_type === "pro" && r.timestamps.length === 0);
}
pageTests().then(() => { console.log(`\n结果：${pass} 通过 / ${fail} 失败`); process.exit(fail ? 1 : 0); });
