// 读取模板测试（node test_activity.js）：api 模板 + 目录里每份 api 配置的自检
const fs = require("fs"), vm = require("vm"), path = require("path");
const A = require("./activity.js");
let fail = 0;
const t = (n, c, x) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || x === undefined ? "" : "  → " + JSON.stringify(x))); if (!c) { fail++; process.exitCode = 1; } };

// 在模拟的页面环境里跑 apiExtract（和真实情况一样：函数被序列化后单独运行）
async function runInPage(spec, { responses = {}, links = [], text = "", onFetch = null, scripts = {}, storage = {} } = {}) {
  const ctx = {
    location: { href: "https://www.example.com/history" },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null) },
    document: { body: { innerText: text }, getElementById: (id) => (id in scripts ? { textContent: scripts[id] } : null), querySelectorAll: () => links.map(([href, title]) => ({ getAttribute: (k) => k === "href" ? href : k === "title" ? title : null, textContent: title })) },
    fetch: async (url, init) => {
      if (onFetch) onFetch(url, init);
      const r = responses[url];
      if (!r) throw new Error("network");
      return { status: r.status || 200, headers: { get: (k) => (/content-type/i.test(k) ? (r.ct || "application/json") : null) }, json: async () => r.body };
    },
    Date, Number, String, Math, Promise, Array, Set, RegExp, JSON, isNaN, Infinity, Object, encodeURIComponent, setTimeout
  };
  return vm.runInNewContext("(" + A.apiExtract.toString() + ")", ctx)(spec);
}

(async () => {
  // 取出 background.js 里的 CATALOG（不跑整个后台）
  const bg = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const catSrc = bg.slice(bg.indexOf("const CATALOG = {"), bg.indexOf("\n};", bg.indexOf("const CATALOG = {")) + 3);
  const CATALOG = vm.runInNewContext(catSrc + "; CATALOG");
  const apiProviders = Object.keys(CATALOG).filter(k => CATALOG[k].strategy === "api");
  t("目录里至少有一个用 api 模板的服务", apiProviders.length >= 1);
  apiProviders.forEach(k => { const errs = A.validateApiSpec(CATALOG[k].api); t(`${CATALOG[k].name} 的 api 配置写全了`, !errs.length, errs); });
  t("配置自检能发现漏写的字段", A.validateApiSpec({ urls: ["http://x"], id: ["id"] }).length === 2);

  const bili = CATALOG.bilibili.api, now = Math.floor(Date.now() / 1000);
  const ok = await runInPage(bili, { responses: { [bili.urls[0]]: { body: { code: 0, data: { list: [
    { title: "旧视频", view_at: now - 86400, history: { bvid: "BV1old" } },
    { title: "<em>最新</em>视频 &amp; 花絮", view_at: now - 60, history: { bvid: "BV1new" } },
    { title: "番剧", view_at: now - 3600, history: { epid: 778, oid: 1 } }] } } } } });
  t("B站：按观看时间取最近一条", ok.lastTs === (now - 60) * 1000 && ok.ids[0].indexOf("BV1new@") === 0, ok);
  t("B站：片名去掉了标签和转义", ok.sample[0] === "最新视频 & 花絮", ok.sample);
  t("B站：没有 bvid 的条目用其它 ID 字段", ok.ids.some(x => x.indexOf("778@") === 0), ok.ids);

  const out = await runInPage(bili, { responses: { [bili.urls[0]]: { body: { code: -101, message: "账号未登录" } }, [bili.urls[1]]: { body: { code: -101 } } } });
  t("B站：接口返回 -101 → 标记未登录", out.loggedOut === true && !out.ids.length);

  const second = await runInPage(bili, { responses: { [bili.urls[1]]: { body: { code: 0, data: { list: [{ title: "备用", view_at: now, bvid: "BV9" }] } } } } });
  t("第一个接口不通时试下一个", second.count === 1 && second.ids[0].indexOf("BV9@") === 0);

  const fb = await runInPage(bili, { links: [["//www.bilibili.com/video/BV1abc/", "页面里的视频"], ["/bangumi/play/ep123", "番剧"], ["/about", "关于"]] });
  t("接口都不通：退回读页面链接（只有 ID，没有时间）", fb.source === "页面" && fb.ids.join() === "BV1abc,ep123" && !fb.lastTs, fb);

  const off = await runInPage(bili, { responses: { [bili.urls[0]]: { body: { code: 0, data: { list: [] } } } }, text: "历史记录功能已暂停" });
  t("历史记录被暂停：标记 historyOff", off.historyOff === true && !off.ids.length);

  // googleRpc 模板（Gemini）：用页面令牌调用 batchexecute，按下标取 ID 和时间，不取标题
  {
    const g = CATALOG.gemini.rpc;
    const inner = JSON.stringify([null, null, [["c_old", "旧对话", null, null, null, [now - 86400, 5e8]], ["c_new", "新对话", null, null, null, [now - 120, 617407000]]]]);
    const respText = ")]}'\n\n296\n" + JSON.stringify([["wrb.fr", "MaZiqc", inner, null, null, null, "generic"], ["di", 421]]) + "\n25\n[[\"e\",4]]\n";
    let sent = null;
    const mk = (W, href) => ({
      location: { href: href || "https://gemini.google.com/app", origin: "https://gemini.google.com", pathname: "/app" }, window: { WIZ_global_data: W },
      fetch: async (url, o) => { sent = { url, body: String(o.body) }; return { status: 200, text: async () => respText }; },
      URLSearchParams, Date, Number, String, Math, Promise, Array, JSON
    });
    const run = (ctx) => vm.runInNewContext("(" + A.googleRpcExtract.toString() + ")", ctx)(g);
    const r = await run(mk({ SNlM0e: "tok123", cfb2h: "boq_x", FdrFJe: "-1" }));
    t("Gemini：最近一次对话 = 最新的更新时间", r.lastTs === (now - 120) * 1000 + 617 && r.ids[0].indexOf("c_new@") === 0 && r.count === 2, r);
    t("Gemini：不取对话标题", !r.sample.length);
    t("Gemini：请求带上页面令牌和 rpc 编号", /rpcids=MaZiqc/.test(sent.url) && /at=tok123/.test(sent.body) && sent.body.indexOf(encodeURIComponent("MaZiqc")) >= 0);
    const lo = await run(mk({}));
    t("Gemini：页面没有令牌（没登录）→ 标记未登录", lo.loggedOut === true && !lo.ids.length);
  }

  // Perplexity：POST 请求对话列表；时间是不带时区的 UTC 字符串
  {
    const pp = CATALOG.perplexity.api;
    let sentInit = null;
    const ctx = {
      location: { href: "https://www.perplexity.ai/library" }, document: { body: { innerText: "" }, querySelectorAll: () => [] },
      fetch: async (url, init) => { sentInit = init; return { status: 200, json: async () => [
        { uuid: "t-old", title: "旧", query_str: "q", last_query_datetime: "2026-10-20T08:00:00.123456" },
        { uuid: "t-new", title: "新", query_str: "q2", last_query_datetime: "2026-10-24T05:04:29.319566" }] }; },
      Date, Number, String, Math, Promise, Array, Set, RegExp, JSON, isNaN, Infinity, Object, setTimeout
    };
    const pr = await vm.runInNewContext("(" + A.apiExtract.toString() + ")", ctx)(pp);
    t("Perplexity：用 POST 请求、带 JSON 请求体", sentInit.method === "POST" && JSON.parse(sentInit.body).limit === 20 && sentInit.headers["Content-Type"] === "application/json");
    t("Perplexity：不带时区的时间按 UTC 算，取最近一次提问", pr.lastTs === Date.parse("2026-10-24T05:04:29.319Z") && pr.ids[0].indexOf("t-new@") === 0, pr);
    t("Perplexity：不取标题和问题内容", !pr.sample.length);
    const lo = await vm.runInNewContext("(" + A.apiExtract.toString() + ")", Object.assign({}, ctx, { fetch: async () => ({ status: 401, json: async () => ({}) }) }))(pp);
    t("Perplexity：401 → 未登录", lo.loggedOut === true);
  }

  // Microsoft Copilot：「所有聊天」页按 JSON 请求，列表在 store.chatLandingPageHistoryList.chats
  {
    const cp = CATALOG.copilot.api;
    const body = { store: { chatLandingPageHistoryList: { chats: [
      { conversationId: "c-old", chatName: "旧", preview: "…", createTimeUtc: 1793000000000, updateTimeUtc: 1793000100000 },
      { conversationId: "c-new", chatName: "你好", preview: "你好！", createTimeUtc: 1793027432933, updateTimeUtc: 1793027439228 }] } } };
    const cr = await runInPage(cp, { responses: { [cp.urls[0]]: { body } } });
    t("Copilot：最近一次对话 = 最新的 updateTimeUtc，不取聊天名称", cr.lastTs === 1793027439228 && cr.ids[0].indexOf("c-new@") === 0 && !cr.sample.length, cr);
  }

  // DeepSeek：令牌取自 localStorage.userToken.value，带 Bearer 请求；updated_at 是秒（带小数），实测结构
  {
    const dk = CATALOG.deepseek.api;
    let sent = null;
    const body = { code: 0, msg: "", data: { biz_code: 0, biz_data: { chat_sessions: [
      { id: "476dcad9", title: "SpreadJS竞品分析", pinned: false, updated_at: 1789958335.77 },
      { id: "521cc3d0", title: "婚礼筹备清单", pinned: false, updated_at: 1789877650.938 }], has_more: true } } };
    const st = { userToken: JSON.stringify({ value: "TKN123", __version: "0" }) };
    const dr = await runInPage(dk, { storage: st, responses: { [dk.urls[0]]: { body } }, onFetch: (u, init) => { sent = init; } });
    t("DeepSeek：最近一次对话 = 最新 updated_at（秒 → 毫秒），不取标题", dr.lastTs === 1789958335770 && !dr.sample.length, dr);
    t("DeepSeek：请求带 Bearer 令牌", !!(sent && sent.headers.Authorization === "Bearer TKN123"));
    t("DeepSeek：令牌不出现在返回结果里", !/TKN123/.test(JSON.stringify(dr)));
    const dn = await runInPage(dk, { storage: {}, responses: { [dk.urls[0]]: { body } } });
    t("DeepSeek：页面里没有令牌 → 没登录", dn.loggedOut === true && !dn.empty, dn);
    const di = await runInPage(dk, { storage: st, responses: { [dk.urls[0]]: { body: { code: 40003, msg: "INVALID_TOKEN", data: null } } } });
    t("DeepSeek：40003 INVALID_TOKEN → 没登录", di.loggedOut === true, di);
    const de = await runInPage(dk, { storage: st, responses: { [dk.urls[0]]: { body: { code: 0, data: { biz_code: 0, biz_data: { chat_sessions: [], has_more: false } } } } } });
    t("DeepSeek：没有对话 → 空记录", de.empty === true, de);
  }

  // DeepSeek 开放平台：余额 + 近 30 天按天调用（实测结构）
  {
    let urls = [], auths = [];
    const ctx = {
      location: { href: "https://platform.deepseek.com/usage" },
      localStorage: { getItem: (k) => (k === "userToken" ? JSON.stringify({ value: "PTKN" }) : null) },
      fetch: async (u, init) => { urls.push(u); auths.push(init.headers.Authorization);
        if (u.startsWith("/api/v0/users/get_user_summary")) return { json: async () => ({ code: 0, data: { biz_code: 0, biz_data: {
          normal_wallets: [{ currency: "CNY", balance: "18.7129518800000000", token_estimation: "0" }], bonus_wallets: [{ currency: "CNY", balance: "0" }],
          total_costs: [{ currency: "CNY", amount: "1.2870481200000000" }] } } }) };
        if (u.startsWith("/api/v0/usage/by_api_key/amount")) return { json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { bucket: 86400, series: [
          { api_key: { name: "k", sensitive_id: "sk-xx" }, model: "deepseek-flash", buckets: [
            { time: 1792900800, usage: { REQUEST: 6, RESPONSE_TOKEN: 81593 } }, { time: 1792987200, usage: { REQUEST: 6 } }, { time: 1793073600, usage: { REQUEST: 0 } }] }] } } }) };
        return { json: async () => ({}) }; },
      Date, Number, String, Math, Promise, Array, Set, JSON, Object
    };
    const pr = await vm.runInNewContext("(" + A.deepseekPlatformExtract.toString() + ")", ctx)();
    t("DeepSeek 开放平台：余额 ¥18.71、累计消费 ¥1.29", pr.info && pr.info.balance === 18.71 && pr.info.totalCost === 1.29 && pr.info.currency === "CNY", pr);
    t("DeepSeek 开放平台：最近一次有调用的那天（REQUEST > 0）", pr.lastTs === 1792987200000 && pr.count === 2 && pr.info.lastApiDay === 1792987200000, pr);
    const q = new URLSearchParams(urls[1].split("?")[1]);
    t("DeepSeek 开放平台：查 30 天，end 对齐到本地零点", Number(q.get("end")) - Number(q.get("start")) === 30 * 86400 && new Date(Number(q.get("end")) * 1000).getHours() === 0, urls[1]);
    t("DeepSeek 开放平台：带令牌，结果里不含令牌和 Key", auths.every(a => a === "Bearer PTKN") && !/PTKN|sk-xx/.test(JSON.stringify(pr)));
    const ctx2 = Object.assign({}, ctx, { localStorage: { getItem: () => null } });
    const pn = await vm.runInNewContext("(" + A.deepseekPlatformExtract.toString() + ")", ctx2)();
    t("DeepSeek 开放平台：没登录 → loggedOut", pn.loggedOut === true && !pn.ids.length);
  }

  // 智谱：令牌在 cookie；余额 / 订阅 / 额度 / 按天账单
  {
    const mk = (resp) => {
      const calls = [];
      const ctx = {
        location: { href: "https://bigmodel.cn/finance-center/finance/overview" },
        document: { cookie: "a=1; bigmodel_token_production=eyJTOKEN; b=2" },
        fetch: async (u, init) => { calls.push({ u, auth: init.headers.Authorization }); const k = Object.keys(resp).find(x => u.startsWith(x)); return { json: async () => (k ? resp[k](u) : { code: 404 }) }; },
        Date, Number, String, Math, Promise, Array, Set, JSON, Object, isFinite, isNaN, decodeURIComponent
      };
      return { run: () => vm.runInNewContext("(" + A.zhipuExtract.toString() + ")", ctx)(), calls };
    };
    // 实测：没有订阅、没有 Coding Plan、余额 0、账单为空
    const real = mk({
      "/api/biz/account/query-customer-account-report": () => ({ code: 200, msg: "操作成功", data: { balance: 0, rechargeAmount: 0, giveAmount: 0, totalSpendAmount: 0, availableBalance: 0, creditStatus: "NOT_OPEN" }, success: true }),
      "/api/biz/subscription/list": () => ({ code: 200, msg: "操作成功", data: [], success: true }),
      "/api/monitor/usage/quota/limit": () => ({ code: 500, msg: "当前用户不存在coding plan", success: false }),
      "/api/finance/expenseBill/expenseBillListByDay": () => ({ total: 0, rows: [], code: 200, msg: "查询成功" })
    });
    const zr = await real.run();
    t("智谱（实测空账号）：余额 0、没有订阅和额度、账单为空 → 空记录", zr.info.balance === 0 && !zr.info.planName && !zr.info.quota && zr.empty === true && zr.loggedOut !== true, zr);
    t("智谱：令牌放 Authorization（不加 Bearer），结果里不含令牌", real.calls.every(c => c.auth === "eyJTOKEN") && !/eyJTOKEN/.test(JSON.stringify(zr)));
    const bills = real.calls.filter(c => /expenseBillListByDay/.test(c.u)).map(c => c.u.match(/billingMonth=([\d-]+)/)[1]);
    t("智谱：查本月和上月的账单", bills.length === 2 && bills[0] !== bills[1], bills);
    // 有数据时（字段按已知格式，待实测）
    const full = mk({
      "/api/biz/account/query-customer-account-report": () => ({ code: 200, data: { availableBalance: 12.345, totalSpendAmount: 30 } }),
      "/api/biz/subscription/list": () => ({ code: 200, data: [{ productName: "GLM Coding Pro", status: "VALID" }] }),
      "/api/monitor/usage/quota/limit": () => ({ code: 200, data: { limits: [{ type: "TIME_LIMIT", percentage: 3 }, { type: "TOKENS_LIMIT", percentage: 42, nextResetTime: 1793300000000 }] } }),
      "/api/finance/expenseBill/expenseBillListByDay": (u) => ({ code: 200, total: 2, rows: /billingMonth=2026-10|billingMonth=\d{4}-\d\d/.test(u) ? [{ billingDate: "2026-10-20", amount: 1.5 }, { billingDate: "2026-10-18", amount: 0 }] : [] })
    });
    const zf = await full.run();
    t("智谱：订阅名、5 小时额度和重置时间、余额", zf.info.planName === "GLM Coding Pro" && zf.info.quota.pct === 42 && zf.info.quota.resetAt === 1793300000000 && zf.info.balance === 12.35, zf.info);
    t("智谱：有消费的那天算用过（金额 0 的不算）", zf.lastTs === new Date("2026-10-20T00:00:00").getTime() && zf.count === 1, zf);
    const nolog = mk({ "/api/biz/account/query-customer-account-report": () => ({ code: 1001, msg: "未登录", success: false }) });
    const zn = await vm.runInNewContext("(" + A.zhipuExtract.toString() + ")", { location: { href: "" }, document: { cookie: "" }, fetch: async () => ({ json: async () => ({}) }), Date, Number, String, Math, Promise, Array, Set, JSON, Object, isFinite, isNaN, decodeURIComponent })();
    t("智谱：没有令牌 → 没登录", zn.loggedOut === true);
    const zl = await nolog.run();
    t("智谱：接口 code 1001 → 没登录", zl.loggedOut === true && !zl.empty);
  }

  // Midjourney：用户 ID 从页面 initialProps 取，带 X-Csrf-Protection 请求；时间是不带时区的 UTC（空格分隔）
  {
    const mj = CATALOG.midjourney.api;
    const props = JSON.stringify({ initialUserInfo: { status: "authenticated", firebase: { id: "11111111-2222-3333-4444-555555555555", abilities: { subscription: { type: "none" } } } } });
    const url = "https://www.midjourney.com/api/imagine?user_id=11111111-2222-3333-4444-555555555555&page_size=50";
    let sent = null;
    const body = { data: [
      { id: "job-old", enqueue_time: "2026-10-20 01:00:00.000000", full_command: "a cat" },
      { id: "job-new", enqueue_time: "2026-10-27 06:54:09.123456", full_command: "a dog" }], cursor: null };
    const mr = await runInPage(mj, { scripts: { initialProps: props }, responses: { [url]: { body } }, onFetch: (u, init) => { sent = init; } });
    t("Midjourney：最近一次生成 = 最新 enqueue_time（按 UTC），不取提示词", mr.lastTs === Date.parse("2026-10-27T06:54:09.123Z") && !mr.sample.length, mr);
    t("Midjourney：请求带 X-Csrf-Protection", !!(sent && sent.headers["X-Csrf-Protection"] === "1"), sent);
    const me = await runInPage(mj, { scripts: { initialProps: props }, responses: { [url]: { body: { data: [], cursor: null, checkpoint: "x" } } } });
    t("Midjourney：未订阅 / 没作品（实测 {data:[]}）→ 空记录", me.empty === true, me);
    const mn = await runInPage(mj, { scripts: {}, responses: { [url]: { body } } });
    t("Midjourney：页面里没有用户 ID（没登录）→ 不请求，读取失败", mn.count === 0 && !mn.empty, mn);
    const m401 = await runInPage(mj, { scripts: { initialProps: props }, responses: { [url]: { status: 401, body: { error: "Unauthorized" } } } });
    t("Midjourney：401 → 未登录", m401.loggedOut === true && !m401.empty, m401);
  }

  // Poe：读页面里的 __NEXT_DATA__，时间是微秒（实测结构）
  {
    const pc = CATALOG.poe.api;
    const nd = { props: { pageProps: { data: { mainQuery: { chats: { edges: [
      { node: { id: "Q2hhdDox", chatId: 1509152001, chatCode: "ahhudy", title: "你好问候", lastInteractionTime: 1793084458042895 } },
      { node: { id: "Q2hhdDoy", chatId: 1500000000, chatCode: "old", title: "旧", lastInteractionTime: 1792000000000000 } }] } } } } } };
    const pr = await runInPage(pc, { scripts: { __NEXT_DATA__: JSON.stringify(nd) } });
    t("Poe：最近一次对话 = 最新 lastInteractionTime（微秒换成毫秒），不取标题", pr.lastTs === 1793084458042 && pr.count === 2 && !pr.sample.length, pr);
    const pn = await runInPage(pc, { scripts: {} });
    t("Poe：页面里没有数据（多半被跳到登录页）→ 读取失败，不算空记录", pn.count === 0 && !pn.empty, pn);
    const pe = await runInPage(pc, { scripts: { __NEXT_DATA__: JSON.stringify({ props: { pageProps: { data: { mainQuery: { chats: { edges: [] } } } } } }) } });
    t("Poe：对话列表为空 → 空记录", pe.empty === true, pe);
  }

  // Grok：对话列表（字段为实测结构）
  {
    const gk = CATALOG.grok.api;
    const body = { conversations: [
      { conversationId: "c0172cd8", title: "你好", starred: false, createTime: "2026-10-27T06:54:09.809Z", modifyTime: "2026-10-27T06:54:13.152Z" },
      { conversationId: "old1", title: "旧", createTime: "2026-10-01T01:00:00.000Z", modifyTime: "2026-10-02T01:00:00.000Z" }], textSearchMatches: [] };
    const gr = await runInPage(gk, { responses: { [gk.urls[0]]: { body } } });
    t("Grok：最近一次对话 = 最新 modifyTime，不取标题", gr.lastTs === Date.parse("2026-10-27T06:54:13.152Z") && !gr.sample.length, gr);
    const ge = await runInPage(gk, { responses: { [gk.urls[0]]: { body: { conversations: [], textSearchMatches: [] } } } });
    t("Grok：没有对话 → 空记录", ge.empty === true, ge);
  }

  // Cursor：POST 使用记录，请求体里的日期占位会换成毫秒；没有记录时返回 {}（实测）
  {
    const cu = CATALOG.cursor.api;
    const body = { totalUsageEventsCount: 2, usageEventsDisplay: [
      { timestamp: "1793020000000", model: "auto", kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO" },
      { timestamp: "1793027000000", model: "claude-4-sonnet", kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO" }] };
    let sent = null;
    const cr = await runInPage(cu, { responses: { [cu.urls[0]]: { body } }, onFetch: (u, init) => { sent = init; } });
    t("Cursor：最近一次 AI 请求 = 最新 timestamp", cr.lastTs === 1793027000000 && cr.count === 2 && !cr.sample.length, cr);
    if (sent) {
      const b = JSON.parse(sent.body);
      t("Cursor：请求体日期占位已换成毫秒", /^\d{13}$/.test(b.endDate) && Number(b.endDate) - Number(b.startDate) === 90 * 86400000, b);
    }
    const ce = await runInPage(cu, { responses: { [cu.urls[0]]: { body: {} } } });
    t("Cursor：没有记录（{}）→ 标记为空记录（后台按闲置算）", ce.count === 0 && ce.empty === true && ce.loggedOut !== true, ce);
    const cx = await runInPage(cu, { responses: { [cu.urls[0]]: { body: { error: "something" } } } });
    t("Cursor：认不出的返回 → 不算空记录（读取失败）", cx.count === 0 && !cx.empty, cx);
    const pp = CATALOG.perplexity.api;
    const pe = await runInPage(pp, { responses: { [pp.urls[0]]: { body: [] } } });
    t("Perplexity：对话列表是空数组 → 空记录", pe.empty === true && pe.count === 0, pe);
    const p401 = await runInPage(pp, { responses: { [pp.urls[0]]: { status: 401, body: {} } } });
    t("Perplexity：401 → 未登录，不算空记录", p401.loggedOut === true && !p401.empty, p401);
    // 第一次 401、重试成功（登录凭证刚刷新好）
    let n = 0;
    const gk2 = CATALOG.grok.api;
    const okBody = { conversations: [{ conversationId: "c1", modifyTime: "2026-10-27T06:54:13.152Z" }] };
    const rr = await runInPage(gk2, { responses: new Proxy({}, { get: (o, u) => (u === gk2.urls[0] ? (n++ === 0 ? { status: 401, body: {} } : { body: okBody }) : undefined) }) });
    t("Grok：第一次 401、重试成功 → 正常读到", rr.count === 1 && rr.loggedOut !== true, rr);
    // 403 + 网页（人机验证）→ 不算没登录
    const cf = await runInPage(gk2, { responses: { [gk2.urls[0]]: { status: 403, body: {}, ct: "text/html; charset=UTF-8" } } });
    t("Grok：403 返回网页（人机验证）→ 读取失败，不算没登录", cf.loggedOut !== true && !cf.empty && /拦截/.test(cf.debug.join()), cf);
  }

  const http = await runInPage({ urls: ["https://x.example/api"], list: ["items"], id: ["id"], ts: ["at"] }, { responses: { "https://x.example/api": { status: 401, body: {} } } });
  t("HTTP 401/403 → 标记未登录", http.loggedOut === true);

  const iso = await runInPage({ urls: ["https://x.example/api"], list: [""], id: ["id"], ts: ["lastPlayed"], title: ["name"] },
    { responses: { "https://x.example/api": { body: [{ id: "a", lastPlayed: "2026-10-20T08:00:00Z", name: "A" }] } } });
  t("时间是 ISO 字符串、列表在最外层也能读", iso.lastTs === Date.parse("2026-10-20T08:00:00Z") && iso.sample[0] === "A", iso);
})();
