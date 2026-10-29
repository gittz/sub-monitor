// 观看 / 使用记录的「读取模板」。
//
// 每个服务怎么读最近使用，写成一份配置（见 background.js 的 CATALOG），套用这里的模板，
// 而不是每个服务各写一段解析代码。目前的模板：
//   api      在服务自己的页面里（带登录状态）请求它的内部接口，从 JSON 里按配置取出「条目 ID / 观看时间 / 片名」
//            —— 例：B站（/x/web-interface/history/cursor）。拿得到精确时间，最可靠。
//   generic  页面上是一串条目链接：取条目 ID 做指纹，必要时读日期分组标题（见 background.js genericExtract）
//   youtube  YouTube 观看记录页的页面数据（ytInitialData）
//   tencent  腾讯视频：临时挂接口监听，截获页面自己请求的观看记录接口（tx-hook.js）
//   llm      Claude / ChatGPT：对话列表 + 套餐 + 额度（llm.js）
//   googleRpc Google 系网页的 batchexecute 接口（Gemini 对话列表，每条带最后更新时间）
//
// api 模板的配置（cfg.api）：
//   urls          依次尝试的接口地址（同一个服务的页面里请求，会自动带上登录 Cookie）
//   method / body 可选：POST 等请求方式和 JSON 请求体（默认 GET）
//   tsUtc         可选：时间是不带时区的 UTC 字符串时设为 true
//   list          条目数组在 JSON 里的位置，可写多个候选，如 ["data.list", "data"]
//   id / ts / title  每个条目里对应字段的位置（候选列表，取第一个有值的），支持 "a.b.c" 这种路径
//   idPattern     可选：从 ID 原始值里再用正则取一段（第一个分组）
//   codePath / okCodes / loggedOutCodes / loggedOutText  接口的返回码：哪些算成功、哪些算没登录
//   historyOffText 页面文字里出现这些说明历史记录被关闭 / 暂停
//   fallbackLink  可选：接口不可用时退回读页面链接 { pattern: 正则（第一个分组是 ID）}
//
// 注意：apiExtract 会被 chrome.scripting.executeScript 序列化后放进页面里运行，
// 只能用函数内部定义的东西，不能引用外面的变量。
(function () {
  async function apiExtract(spec) {
    spec = spec || {};
    const out = { ids: [], topLabel: "", loggedOut: null, historyOff: false, pageUrl: location.href,
                  lastTs: 0, count: 0, sample: [], sampleTitles: [], strategy: "api", source: "api" };
    const get = (obj, path) => {
      if (obj == null || !path) return undefined;
      let cur = obj;
      for (const k of String(path).split(".")) { if (cur == null) return undefined; cur = cur[k]; }
      return cur;
    };
    const first = (obj, paths) => {
      for (const p of [].concat(paths || [])) { const v = get(obj, p); if (v != null && v !== "") return v; }
      return undefined;
    };
    const tsOf = (v) => {
      if (v == null || v === "") return 0;
      const n = Number(v);
      if (n === n && n !== Infinity && n > 0) return n < 100000000000 ? n * 1000 : n > 100000000000000 ? Math.floor(n / 1000) : n;   // 秒 → 毫秒；微秒（Poe）→ 毫秒
      let str = String(v);
      // tsUtc：接口给的是不带时区的 UTC 时间（如 "2026-10-24T05:04:29.319566"），补上 Z，免得被当成本地时间
      if (spec.tsUtc && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(str)) str = str.replace(" ", "T").replace(/(\.\d{3})\d+$/, "$1") + "Z";
      const t = Date.parse(str);
      return isNaN(t) ? 0 : t;
    };
    const clean = (v) => String(v == null ? "" : v).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
    let idRe = null; try { if (spec.idPattern) idRe = new RegExp(spec.idPattern, "i"); } catch (e) {}
    const idOf = (raw) => {
      if (raw == null || raw === "") return "";
      const s = String(raw);
      const m = idRe && s.match(idRe);
      return m ? (m.slice(1).find(Boolean) || m[0]) : s;
    };
    let loggedRe = null; try { if (spec.loggedOutText) loggedRe = new RegExp(spec.loggedOutText, "i"); } catch (e) {}
    const okCodes = [].concat(spec.okCodes == null ? [0] : spec.okCodes).map(Number);
    const loggedCodes = [].concat(spec.loggedOutCodes || []).map(Number);

    const items = [];
    let apiReady = false;
    // pageData：不请求接口，直接读页面里服务端渲染好的数据（如 Next.js 的 <script id="__NEXT_DATA__">）。
    // 每次检查都是新打开的页面，数据是当下的
    // urlVars：接口地址里的 {{名字}} 从页面里服务端渲染的 JSON 取（如 Midjourney 的用户 ID）。取不到就不请求（读取失败）
    const vars = {};
    let varsOk = true;
    for (const [name, src] of Object.entries(spec.urlVars || {})) {
      try {
        const el = document.getElementById(src.script);
        const v = el ? get(JSON.parse(el.textContent || "null"), src.path) : undefined;
        if (v == null || v === "") { varsOk = false; break; }
        vars[name] = encodeURIComponent(String(v));
      } catch (e) { varsOk = false; break; }
    }
    const fill = (u) => String(u).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
    const sources = !varsOk ? [] : spec.pageData ? ["#page"] : [].concat(spec.urls || []).map(fill);
    // 诊断用：每一步发生了什么（只记状态码 / 类型 / 条数，不记内容）
    out.debug = [];
    if (!varsOk) out.debug.push("页面里没找到接口参数（" + Object.keys(spec.urlVars || {}).join(",") + "）");
    for (const url of sources) {
      try {
        if (url === "#page") {
          const el = document.getElementById(spec.pageData);
          if (!el) { out.debug.push("页面里没有 " + spec.pageData); continue; }
          const json = JSON.parse(el.textContent || "null");
          let list = null;
          for (const p of [].concat(spec.list || [""])) { const v = p ? get(json, p) : json; if (Array.isArray(v)) { list = v; break; } }
          if (!list) continue;
          apiReady = true;
          list.forEach(item => {
            if (!item || typeof item !== "object") return;
            const id = idOf(first(item, spec.id));
            if (id) items.push({ id, ts: tsOf(first(item, spec.ts)), title: clean(first(item, spec.title)) });
          });
          break;
        }
        if (typeof fetch !== "function") break;
        const init = { credentials: "include", cache: "no-store", headers: Object.assign({ Accept: "application/json" }, spec.headers || {}) };
        // authFromStorage：网站把登录令牌放在 localStorage 里、请求时自己加到 Authorization 头（DeepSeek）。
        // 令牌只在页面里用来发这一个请求，不读出、不保存
        if (spec.authFromStorage) {
          let tk = null;
          try { const raw = localStorage.getItem(spec.authFromStorage.key); const v = raw && raw.charAt(0) === "{" ? JSON.parse(raw) : raw; tk = spec.authFromStorage.path && v && typeof v === "object" ? get(v, spec.authFromStorage.path) : v; } catch (e) {}
          if (!tk) { out.debug.push("页面里没有登录令牌"); out.loggedOut = true; continue; }
          init.headers.Authorization = (spec.authFromStorage.scheme || "") + tk;
        }
        if (spec.method && spec.method !== "GET") {
          init.method = spec.method;
          if (spec.body != null) {
            // 请求体里可以写日期占位：{{now}} = 现在，{{daysAgo:30}} = 30 天前（都是毫秒数字符串）
            const raw = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
            const nowMs = Date.now();
            init.body = raw.replace(/\{\{now\}\}/g, String(nowMs)).replace(/\{\{daysAgo:(\d+)\}\}/g, (m, d) => String(nowMs - Number(d) * 86400000));
            init.headers["Content-Type"] = "application/json";
          }
        }
        let resp = await fetch(url, init);
        const host = url.replace(/^https:\/\/([^/]+).*/, "$1");
        // 401 / 403：页面刚打开时登录凭证可能还没刷新好（Grok 等），等几秒重试一次
        if (resp.status === 401 || resp.status === 403) {
          await new Promise(r => setTimeout(r, 3000));
          resp = await fetch(url, init);
        }
        if (resp.status === 401 || resp.status === 403) {
          // 返回的是网页（多半是 Cloudflare 等人机验证页）不是接口的 JSON：被拦截了，不等于没登录
          const ct = (resp.headers && resp.headers.get ? resp.headers.get("content-type") : "") || "";
          if (/text\/html/i.test(ct)) { out.debug.push(host + " " + resp.status + " 被网站拦截（返回网页，可能是人机验证）"); continue; }
          out.debug.push(host + " " + resp.status + " 接口说没登录"); out.loggedOut = true; continue;
        }
        let json;
        try { json = await resp.json(); }
        catch (e) { out.debug.push(host + " " + resp.status + " 返回的不是 JSON（" + (resp.headers && resp.headers.get ? resp.headers.get("content-type") : "") + "）"); continue; }
        const rawCode = spec.codePath ? get(json, spec.codePath) : null;
        const code = rawCode == null ? null : Number(rawCode);
        const message = String(first(json, spec.messagePath || ["message", "msg"]) || "");
        if ((code != null && loggedCodes.indexOf(code) >= 0) || (loggedRe && loggedRe.test(message))) { out.loggedOut = true; continue; }
        if (code != null && okCodes.indexOf(code) < 0) continue;
        let list = null;
        for (const p of [].concat(spec.list || [""])) { const v = p ? get(json, p) : json; if (Array.isArray(v)) { list = v; break; } }
        // emptyIfNoList：这个接口没有记录时直接返回 {}（Cursor 实测），当成空列表
        if (!list && spec.emptyIfNoList && json && typeof json === "object" && !Array.isArray(json) && !Object.keys(json).length) list = [];
        if (!list) { out.debug.push(host + " " + resp.status + " 没找到列表（顶层字段：" + (json && typeof json === "object" ? Object.keys(json).slice(0, 6).join(",") : typeof json) + "）"); continue; }
        out.debug.push(host + " " + resp.status + " 列表 " + list.length + " 条");
        apiReady = true;
        list.forEach(item => {
          if (!item || typeof item !== "object") return;
          const title = clean(first(item, spec.title));
          const id = idOf(first(item, spec.id)) || title;
          if (id) items.push({ id, ts: tsOf(first(item, spec.ts)), title });
        });
        break;
      } catch (e) { out.debug.push("请求出错：" + String(e && e.message || e).slice(0, 80)); /* 接口地址或跨域策略变了：试下一个 */ }
    }

    // 接口不可用：退回读页面上的条目链接，至少保留条目 ID 和名称（指纹比对用）
    if (!items.length && !apiReady && spec.fallbackLink && spec.fallbackLink.pattern) {
      out.source = "页面";
      try {
        const re = new RegExp(spec.fallbackLink.pattern, "i");
        document.querySelectorAll("a[href]").forEach(a => {
          const m = (a.getAttribute("href") || "").match(re);
          if (!m) return;
          const id = m.slice(1).find(Boolean) || m[0];
          const title = clean((a.getAttribute("title") || a.getAttribute("aria-label")) || a.textContent);
          if (!items.some(x => x.id === id)) items.push({ id, ts: 0, title });
        });
      } catch (e) {}
    }

    items.sort((a, b) => b.ts - a.ts);
    const seen = new Set();
    const uniq = items.filter(x => { const k = x.id + "@" + x.ts; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50);
    out.ids = uniq.map(x => x.id + (x.ts ? "@" + Math.floor(x.ts / 60000) : ""));
    out.lastTs = uniq.reduce((m, x) => Math.max(m, x.ts), 0);
    out.count = uniq.length;
    out.sample = uniq.filter(x => x.title).slice(0, 3).map(x => x.title);
    out.sampleTitles = out.sample.slice();
    if (!out.ids.length && out.loggedOut !== true && spec.historyOffText) {
      try { if (new RegExp(spec.historyOffText, "i").test((document.body && document.body.innerText) || "")) out.historyOff = true; } catch (e) {}
    }
    // 官方接口正常回应、但一条记录都没有（从没用过 / 很久没用）：交给后台按闲置算
    if (apiReady && !uniq.length && out.loggedOut !== true && !out.historyOff) out.empty = true;
    return out;
  }

  // googleRpc 模板：Google 系网页（Gemini 等）用 batchexecute 接口取数据。
  // 在服务页面里取页面自带的令牌（WIZ_global_data），按配置调用指定的 rpc，从返回里按下标取出列表、ID 和时间。
  // spec: { rpcid, payload, sourcePath, list: [下标路径], id: 下标, ts: 下标（[秒, 纳秒] 或秒）, title: 下标（可选，不填就不取标题）}
  async function googleRpcExtract(spec) {
    spec = spec || {};
    const out = { ids: [], topLabel: "", loggedOut: null, historyOff: false, pageUrl: location.href,
                  lastTs: 0, count: 0, sample: [], sampleTitles: [], strategy: "googleRpc", source: "rpc:" + spec.rpcid };
    const W = window.WIZ_global_data || {};
    if (/accounts\.google\.com/.test(location.href) || !W.SNlM0e) { out.loggedOut = true; return out; }
    const at = (obj, path) => { let cur = obj; for (const k of [].concat(path == null ? [] : path)) { if (cur == null) return undefined; cur = cur[k]; } return cur; };
    const tsOf = (v) => {
      if (Array.isArray(v)) v = Number(v[0]) * 1000 + Math.floor(Number(v[1] || 0) / 1e6);
      else if (v != null) { v = Number(v); if (v > 0 && v < 1e11) v *= 1000; }
      return v > 0 && v === v ? v : 0;
    };
    try {
      const q = new URLSearchParams({ rpcids: spec.rpcid, "source-path": spec.sourcePath || location.pathname, bl: W.cfb2h || "", "f.sid": W.FdrFJe || "",
                                      hl: "en", _reqid: String(Math.floor(Math.random() * 900000) + 100000), rt: "c" });
      const body = new URLSearchParams({ "f.req": JSON.stringify([[[spec.rpcid, JSON.stringify(spec.payload), null, "generic"]]]), at: W.SNlM0e });
      const base = spec.endpoint || (location.origin + "/_/BardChatUi/data/batchexecute");
      const resp = await fetch(base + "?" + q, { method: "POST", credentials: "include", cache: "no-store",
                                                 headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body });
      if (resp.status === 401 || resp.status === 403) { out.loggedOut = true; return out; }
      const text = await resp.text();
      // 返回是 )]}' 开头的分块文本；找到 ["wrb.fr","<rpcid>","<JSON 字符串>"...]
      let inner = null;
      for (const line of text.split("\n")) {
        if (line.indexOf('"wrb.fr"') < 0) continue;
        try {
          const arr = JSON.parse(line);
          const hit = (arr || []).find(x => Array.isArray(x) && x[0] === "wrb.fr" && x[1] === spec.rpcid);
          if (hit && typeof hit[2] === "string") { inner = JSON.parse(hit[2]); break; }
          if (hit) { inner = []; break; }   // 有回应但没数据：当成空列表
        } catch (e) {}
      }
      if (inner === null) return out;   // 没认出返回格式：读取失败
      const list = at(inner, spec.list) || [];
      const items = (Array.isArray(list) ? list : []).filter(Array.isArray).map(x => ({
        id: String(at(x, spec.id) || ""), ts: tsOf(at(x, spec.ts)), title: spec.title != null ? String(at(x, spec.title) || "") : ""
      })).filter(x => x.id);
      items.sort((a, b) => b.ts - a.ts);
      out.ids = items.map(x => x.id + (x.ts ? "@" + Math.floor(x.ts / 60000) : ""));
      out.lastTs = items.reduce((m, x) => Math.max(m, x.ts), 0);
      out.count = items.length;
      out.sample = items.filter(x => x.title).slice(0, 3).map(x => x.title);
      out.sampleTitles = out.sample.slice();
      if (!items.length) out.empty = true;
    } catch (e) { out.error = String(e && e.message || e).slice(0, 80); }
    return out;
  }

  // 检查一份 api 配置是否写全（加新服务时的自检；测试里也会对 CATALOG 跑一遍）
  function validateApiSpec(spec) {
    const errs = [];
    if (!spec || typeof spec !== "object") return ["缺少 api 配置"];
    if (!spec.pageData && (!Array.isArray(spec.urls) || !spec.urls.length)) errs.push("urls 不能为空（或写 pageData）");
    if (spec.authFromStorage && !spec.authFromStorage.key) errs.push("authFromStorage 缺少 key");
    (spec.urls || []).forEach(u => { if (!/^https:\/\//.test(u)) errs.push("接口地址必须是 https：" + u); });
    if (!spec.ts) errs.push("缺少 ts（观看时间字段）");
    if (!spec.id && !spec.title) errs.push("id 和 title 至少要有一个");
    ["idPattern", "loggedOutText", "historyOffText"].forEach(k => { if (spec[k]) { try { new RegExp(spec[k]); } catch (e) { errs.push(k + " 不是合法正则"); } } });
    if (spec.fallbackLink && spec.fallbackLink.pattern) { try { new RegExp(spec.fallbackLink.pattern); } catch (e) { errs.push("fallbackLink.pattern 不是合法正则"); } }
    return errs;
  }

  // DeepSeek 开放平台（platform.deepseek.com/usage 页面用的接口，实测）：
  //   余额：/api/v0/users/get_user_summary（充值余额 + 赠送余额、累计消费）
  //   API 调用：/api/v0/usage/by_api_key/amount，按天分桶，最多查 30 天，start/end 必须对齐到本地零点
  // 两个接口都要带页面 localStorage 里的 userToken（只在页面里用来发请求，不读出、不保存）。
  // 有调用的那天算「用过」（只精确到天）；只取次数是否大于 0，不取 Key 名和 Token 数
  async function deepseekPlatformExtract() {
    const out = { ids: [], topLabel: "", loggedOut: null, historyOff: false, pageUrl: location.href, lastTs: 0, count: 0,
                  sample: [], sampleTitles: [], strategy: "deepseekPlatform", source: "开放平台", debug: [], info: null };
    let tok = null;
    try { const raw = localStorage.getItem("userToken"); const v = raw && raw.charAt(0) === "{" ? JSON.parse(raw) : raw; tok = v && typeof v === "object" ? v.value : v; } catch (e) {}
    if (!tok) { out.loggedOut = true; out.debug.push("开放平台没有登录令牌"); return out; }
    const h = { Accept: "application/json", Authorization: "Bearer " + tok };
    const call = async (path) => {
      const r = await fetch(path, { credentials: "include", cache: "no-store", headers: h });
      const j = await r.json();
      if (j && [40001, 40002, 40003].indexOf(Number(j.code)) >= 0) { out.loggedOut = true; out.debug.push("开放平台 " + j.code); return null; }
      if (!(j && Number(j.code) === 0 && j.data && Number(j.data.biz_code) === 0)) { out.debug.push(path.split("?")[0] + " " + (j && j.data ? j.data.biz_msg || j.data.biz_code : j && j.code)); return null; }
      return j.data.biz_data;
    };
    const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;
    try {
      const s = await call("/api/v0/users/get_user_summary");
      if (s) {
        const w = (s.normal_wallets || [])[0] || {}, b = (s.bonus_wallets || [])[0] || {}, c = (s.total_costs || [])[0] || {};
        out.info = { balance: r2(Number(w.balance || 0) + Number(b.balance || 0)), currency: w.currency || c.currency || "CNY", totalCost: r2(c.amount) };
      }
    } catch (e) { out.debug.push("余额接口出错"); }
    try {
      const d = new Date(); d.setHours(24, 0, 0, 0);
      const end = Math.floor(d.getTime() / 1000), tz = -new Date().getTimezoneOffset() * 60;
      const u = await call("/api/v0/usage/by_api_key/amount?start=" + (end - 30 * 86400) + "&end=" + end + "&tz=" + tz);
      if (u && Array.isArray(u.series)) {
        const days = new Set();
        u.series.forEach(se => (se && se.buckets || []).forEach(k => { if (k && k.usage && Number(k.usage.REQUEST) > 0 && k.time) days.add(Number(k.time)); }));
        const list = Array.from(days).sort((a, b) => b - a);
        out.ids = list.map(t => "api-day@" + Math.floor(t / 60));
        out.count = list.length;
        out.lastTs = list.length ? list[0] * 1000 : 0;
        out.apiReady = true;
        if (out.info) out.info.lastApiDay = out.lastTs || null;
      }
    } catch (e) { out.debug.push("用量接口出错"); }
    return out;
  }

  // 智谱 BigModel（bigmodel.cn 财务总览页用的接口）：登录令牌在 cookie bigmodel_token_production 里，请求时放进 Authorization 头。
  //   实测：/api/biz/account/query-customer-account-report（availableBalance / totalSpendAmount）、/api/biz/subscription/list（data 数组）、
  //         /api/monitor/usage/quota/limit（没有 Coding Plan 时 code 500「当前用户不存在coding plan」）、
  //         /api/finance/expenseBill/expenseBillListByDay?billingMonth=YYYY-MM（{ total, rows }）。
  //   没实测（账号没有数据）：订阅条目的套餐名字段、Coding Plan 额度的字段、按天账单每行的日期字段——按已知格式多给候选
  async function zhipuExtract() {
    const out = { ids: [], topLabel: "", loggedOut: null, historyOff: false, pageUrl: location.href, lastTs: 0, count: 0,
                  sample: [], sampleTitles: [], strategy: "zhipu", source: "智谱", debug: [], info: null };
    const m = document.cookie.match(/(?:^|; )bigmodel_token_production=([^;]+)/);
    const tok = m ? decodeURIComponent(m[1]) : "";
    if (!tok) { out.loggedOut = true; out.debug.push("没有登录令牌"); return out; }
    const h = { Accept: "application/json", Authorization: tok };
    const get = (o, path) => String(path).split(".").reduce((c, k) => (c == null ? undefined : c[k]), o);
    const first = (o, paths) => { for (const p of paths) { const v = get(o, p); if (v != null && v !== "") return v; } return undefined; };
    const call = async (path) => {
      const r = await fetch(path, { credentials: "include", cache: "no-store", headers: h });
      const j = await r.json();
      if (j && (j.code === 1001 || j.code === 401)) { out.loggedOut = true; out.debug.push(path.split("?")[0] + " 没登录"); return null; }
      return j;
    };
    const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;
    const info = { currency: "CNY" };
    try {
      const a = await call("/api/biz/account/query-customer-account-report");
      if (a && a.code === 200 && a.data) { info.balance = r2(a.data.availableBalance != null ? a.data.availableBalance : a.data.balance); info.totalCost = r2(a.data.totalSpendAmount); }
    } catch (e) { out.debug.push("余额接口出错"); }
    if (out.loggedOut) return out;
    try {
      const s = await call("/api/biz/subscription/list");
      const list = s && s.code === 200 && Array.isArray(s.data) ? s.data.filter(Boolean) : [];
      const active = list.filter(x => !/expire|cancel|invalid|过期|失效/i.test(String(first(x, ["status", "subscriptionStatus", "state"]) || "")));
      const name = active.length ? first(active[0], ["productName", "planName", "packageName", "name", "productTitle", "title"]) : null;
      if (active.length) info.planName = String(name || "GLM Coding Plan").slice(0, 40);
    } catch (e) { out.debug.push("订阅接口出错"); }
    try {
      const q = await call("/api/monitor/usage/quota/limit");
      const limits = q && q.code === 200 && q.data ? (Array.isArray(q.data) ? q.data : q.data.limits || []) : [];
      const tl = limits.find(x => /TOKEN/i.test(String(x && x.type))) || limits[0];
      if (tl) {
        const pct = Number(first(tl, ["percentage", "usedPercent", "percent"]));
        let reset = first(tl, ["nextResetTime", "resetTime", "nextResetAt"]);
        reset = typeof reset === "number" ? (reset < 1e11 ? reset * 1000 : reset) : (reset ? Date.parse(reset) || null : null);
        if (isFinite(pct)) info.quota = { pct: Math.round(pct * 10) / 10, resetAt: reset, label: "5 小时额度" };
      }
    } catch (e) { out.debug.push("额度接口出错"); }
    // 按天账单：本月 + 上月，有消费的那天算「用过」（只精确到天）
    try {
      const days = new Set();
      const d = new Date();
      const months = [0, 1].map(k => { const x = new Date(d.getFullYear(), d.getMonth() - k, 1); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0"); });
      let ok = false;
      for (const mo of months) {
        const b = await call("/api/finance/expenseBill/expenseBillListByDay?billingMonth=" + mo + "&billStatus=&modelProductName=&paymentType=&pageNum=1&pageSize=100");
        if (!(b && b.code === 200 && Array.isArray(b.rows))) continue;
        ok = true;
        b.rows.forEach(row => {
          const amt = Number(first(row, ["amount", "totalAmount", "expenseAmount", "originalAmount", "payAmount", "tokens", "usage"]) || 0);
          const ds = first(row, ["billingDate", "billDate", "expenseDate", "consumeDate", "statDate", "date", "day", "billingTime", "createTime"]);
          let t = typeof ds === "number" ? (ds < 1e11 ? ds * 1000 : ds) : ds ? Date.parse(String(ds).length === 10 ? ds + "T00:00:00" : String(ds).replace(" ", "T")) : NaN;
          if (amt > 0 && t && !isNaN(t)) days.add(t);
        });
      }
      if (ok) {
        const list = Array.from(days).sort((a, b) => b - a);
        out.ids = list.map(t => "bill-day@" + Math.floor(t / 60000));
        out.count = list.length;
        out.lastTs = list.length ? list[0] : 0;
        out.apiReady = true;
        info.lastApiDay = out.lastTs || null;
        if (!list.length) out.empty = true;
      }
    } catch (e) { out.debug.push("账单接口出错"); }
    out.info = info;
    return out;
  }

  const api = { apiExtract, googleRpcExtract, validateApiSpec, deepseekPlatformExtract, zhipuExtract };
  globalThis.ActivityLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
