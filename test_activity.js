// 读取模板测试（node test_activity.js）：api 模板 + 目录里每份 api 配置的自检
const fs = require("fs"), vm = require("vm"), path = require("path");
const A = require("./activity.js");
let fail = 0;
const t = (n, c, x) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || x === undefined ? "" : "  → " + JSON.stringify(x))); if (!c) { fail++; process.exitCode = 1; } };

// 在模拟的页面环境里跑 apiExtract（和真实情况一样：函数被序列化后单独运行）
async function runInPage(spec, { responses = {}, links = [], text = "", onFetch = null } = {}) {
  const ctx = {
    location: { href: "https://www.example.com/history" },
    document: { body: { innerText: text }, querySelectorAll: () => links.map(([href, title]) => ({ getAttribute: (k) => k === "href" ? href : k === "title" ? title : null, textContent: title })) },
    fetch: async (url, init) => {
      if (onFetch) onFetch(url, init);
      const r = responses[url];
      if (!r) throw new Error("network");
      return { status: r.status || 200, json: async () => r.body };
    },
    Date, Number, String, Math, Promise, Array, Set, RegExp, JSON, isNaN, Infinity
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
      Date, Number, String, Math, Promise, Array, Set, RegExp, JSON, isNaN, Infinity
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
  }

  const http = await runInPage({ urls: ["https://x.example/api"], list: ["items"], id: ["id"], ts: ["at"] }, { responses: { "https://x.example/api": { status: 401, body: {} } } });
  t("HTTP 401/403 → 标记未登录", http.loggedOut === true);

  const iso = await runInPage({ urls: ["https://x.example/api"], list: [""], id: ["id"], ts: ["lastPlayed"], title: ["name"] },
    { responses: { "https://x.example/api": { body: [{ id: "a", lastPlayed: "2026-10-20T08:00:00Z", name: "A" }] } } });
  t("时间是 ISO 字符串、列表在最外层也能读", iso.lastTs === Date.parse("2026-10-20T08:00:00Z") && iso.sample[0] === "A", iso);
})();
