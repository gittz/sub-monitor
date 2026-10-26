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
      if (n === n && n !== Infinity && n > 0) return n < 100000000000 ? n * 1000 : n;   // 秒 → 毫秒
      let str = String(v);
      // tsUtc：接口给的是不带时区的 UTC 时间（如 "2026-10-24T05:04:29.319566"），补上 Z，免得被当成本地时间
      if (spec.tsUtc && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(str)) str = str.replace(/(\.\d{3})\d+$/, "$1") + "Z";
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
    for (const url of [].concat(spec.urls || [])) {
      try {
        if (typeof fetch !== "function") break;
        const init = { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } };
        if (spec.method && spec.method !== "GET") {
          init.method = spec.method;
          if (spec.body != null) { init.body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body); init.headers["Content-Type"] = "application/json"; }
        }
        const resp = await fetch(url, init);
        if (resp.status === 401 || resp.status === 403) { out.loggedOut = true; continue; }
        const json = await resp.json();
        const rawCode = spec.codePath ? get(json, spec.codePath) : null;
        const code = rawCode == null ? null : Number(rawCode);
        const message = String(first(json, spec.messagePath || ["message", "msg"]) || "");
        if ((code != null && loggedCodes.indexOf(code) >= 0) || (loggedRe && loggedRe.test(message))) { out.loggedOut = true; continue; }
        if (code != null && okCodes.indexOf(code) < 0) continue;
        let list = null;
        for (const p of [].concat(spec.list || [""])) { const v = p ? get(json, p) : json; if (Array.isArray(v)) { list = v; break; } }
        if (!list) continue;
        apiReady = true;
        list.forEach(item => {
          if (!item || typeof item !== "object") return;
          const title = clean(first(item, spec.title));
          const id = idOf(first(item, spec.id)) || title;
          if (id) items.push({ id, ts: tsOf(first(item, spec.ts)), title });
        });
        break;
      } catch (e) { /* 接口地址或跨域策略变了：试下一个 */ }
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
    if (!Array.isArray(spec.urls) || !spec.urls.length) errs.push("urls 不能为空");
    (spec.urls || []).forEach(u => { if (!/^https:\/\//.test(u)) errs.push("接口地址必须是 https：" + u); });
    if (!spec.ts) errs.push("缺少 ts（观看时间字段）");
    if (!spec.id && !spec.title) errs.push("id 和 title 至少要有一个");
    ["idPattern", "loggedOutText", "historyOffText"].forEach(k => { if (spec[k]) { try { new RegExp(spec[k]); } catch (e) { errs.push(k + " 不是合法正则"); } } });
    if (spec.fallbackLink && spec.fallbackLink.pattern) { try { new RegExp(spec.fallbackLink.pattern); } catch (e) { errs.push("fallbackLink.pattern 不是合法正则"); } }
    return errs;
  }

  const api = { apiExtract, googleRpcExtract, validateApiSpec };
  globalThis.ActivityLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
