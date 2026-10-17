// 云端同步（登录后可选）：要上传哪些字段、两边数据怎么合并。纯逻辑，后台和测试共用。
// 同步订阅清单本身（名称、价格、套餐、续费日、最近使用日期等）和每个订阅的访问时间点（算访问次数用：只到分钟、最近 90 天、不含网址）；
// 活动记录指纹、浏览历史汇总、读取状态、提醒去重标记这些只和本机有关的明细不上传。
(function () {
  const DAY = 86400000;
  const TOMBSTONE_DAYS = 90;          // 删除记录保留多久（防止另一台设备把删掉的订阅又同步回来）
  const MAX_BYTES = 256 * 1024;       // 单个用户的同步数据上限（和服务端一致）

  // 允许上传的字段（白名单）。新增字段默认不上传，要上传得显式加在这里。
  const SYNC_FIELDS = ["id", "name", "urlPattern", "price", "currency", "priceSource", "priceEstimated", "idleDays",
    "mode", "provider", "activityUrl", "idPattern", "containerSelector", "catalogId",
    "lastUsed", "lastUsedFloor", "lastWatched", "watchAt", "createdAt", "updatedAt", "account", "llm"];
  // 账户页 / 大模型读取结果里也只留结论，不留页面地址之类
  const ACCOUNT_FIELDS = ["status", "plan", "price", "renewAt", "storage", "checkedAt", "updatedAt"];
  const LLM_FIELDS = ["kind", "plan", "origin", "willRenew", "stats", "convCount", "usage", "renewAt", "advice", "updatedAt"];

  function pick(o, keys) {
    if (!o || typeof o !== "object") return undefined;
    const r = {};
    for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
    return r;
  }

  // ---- 访问时间点 ----
  // 本机存 visitLog（毫秒）；上传时压成「分钟数」数组 visits，只留最近 90 天、最多 300 条，控制体积。
  // 合并 = 两边取并集，30 分钟内的算同一次访问（和本机统计规则一致）。
  const VISIT_GAP = 30 * 60 * 1000, VISIT_DAYS = 90, VISIT_SYNC_MAX = 300, MIN = 60000;
  function encodeVisits(log, now) {
    const since = (now || Date.now()) - VISIT_DAYS * DAY;
    const mins = (log || []).filter(t => typeof t === "number" && t >= since).map(t => Math.floor(t / MIN));
    return Array.from(new Set(mins)).sort((a, b) => a - b).slice(-VISIT_SYNC_MAX);
  }
  function decodeVisits(v) { return Array.isArray(v) ? v.filter(x => typeof x === "number").map(x => x * MIN) : []; }
  function unionVisits(a, b, now) {
    const base = now || Date.now(), since = base - VISIT_DAYS * DAY;
    const all = (a || []).concat(b || []).filter(t => typeof t === "number" && t >= since && t <= base + MIN).sort((x, y) => x - y);
    const out = [];
    for (const t of all) if (!out.length || t - out[out.length - 1] >= VISIT_GAP) out.push(t);
    return out.slice(-1000);
  }
  // 云端来的订阅：visits（分钟）→ visitLog（毫秒）
  function fromRemote(s) {
    const o = Object.assign({}, s);
    if (o.visits) { o.visitLog = decodeVisits(o.visits); delete o.visits; }
    return o;
  }

  // ---- 插件自己打开网页的记录（检查时在后台打开的账户页、活动页等）----
  // Chrome 开了历史记录同步时，另一台设备读浏览历史会看到这台设备检查时打开的页面。
  // 所以把「哪个网站、哪一分钟插件自己打开过」也同步过去，各设备统计访问时一起排除。
  // 本机格式 [{ host, time }]；上传格式 [[host, 分钟数], …]，只留 100 天、最多 600 条。
  const OWN_DAYS = 100, OWN_MAX = 600;
  const OWN_BEFORE = 10 * 1000, OWN_AFTER = 3 * 60 * 1000 + MIN;   // 分钟取整，往后多留一分钟
  function ownList(x) {
    return (Array.isArray(x) ? x : []).map(o => Array.isArray(o) ? { host: String(o[0] || ""), time: Number(o[1]) * MIN }
      : (o && o.host ? { host: String(o.host), time: Math.floor(Number(o.time) / MIN) * MIN } : null)).filter(o => o && o.host && o.time > 0);
  }
  function mergeOwn(a, b, now) {
    const since = (now || Date.now()) - OWN_DAYS * DAY, seen = {}, out = [];
    for (const o of ownList(a).concat(ownList(b))) {
      if (o.time < since) continue;
      const k = o.host + "|" + o.time;
      if (!seen[k]) { seen[k] = 1; out.push(o); }
    }
    return out.sort((x, y) => x.time - y.time).slice(-OWN_MAX);
  }
  function encodeOwn(x) { return mergeOwn(x, [], Date.now()).map(o => [o.host, Math.floor(o.time / MIN)]); }
  const hostRel = (h, d) => h === d || h.endsWith("." + d) || d.endsWith("." + h);
  // 从各订阅的访问记录里去掉「插件自己打开」那几分钟的访问。domainsOf(sub) 返回该订阅统计的域名。
  // 浏览器访问型的「最近使用」如果正好落在这些时间里，也改回剩下的最近一次访问。返回去掉了几条。
  function purgeOwn(subs, own, domainsOf) {
    const list = ownList(own);
    if (!list.length) return 0;
    let removed = 0;
    for (const s of subs || []) {
      const doms = (domainsOf(s) || []).map(d => String(d).toLowerCase().replace(/^www\./, ""));
      const mine = list.filter(o => doms.some(d => hostRel(o.host.replace(/^www\./, ""), d)));
      if (!mine.length) continue;
      const inOwn = (t) => mine.some(o => t >= o.time - OWN_BEFORE && t <= o.time + OWN_AFTER);
      if (Array.isArray(s.visitLog)) {
        const keep = s.visitLog.filter(t => !inOwn(t));
        removed += s.visitLog.length - keep.length;
        s.visitLog = keep;
      }
      if (s.mode === "browser" && s.lastUsed && !s.lastUsedFloor && inOwn(s.lastUsed)) {
        const last = (s.visitLog || []).reduce((m, t) => Math.max(m, t), 0);
        s.lastUsed = last || null;
      }
    }
    return removed;
  }

  function sanitize(sub) {
    const r = pick(sub, SYNC_FIELDS);
    if (sub.account) r.account = pick(sub.account, ACCOUNT_FIELDS);
    if (sub.llm) r.llm = pick(sub.llm, LLM_FIELDS);
    // 本机数据用 visitLog；直接拿云端数据来比较时它已经是 visits 了
    const v = sub.visitLog ? encodeVisits(sub.visitLog) : (Array.isArray(sub.visits) ? sub.visits : null);
    if (v && v.length) r.visits = v;
    return r;
  }

  // 同一个订阅的识别：先看 id，再看「同一个服务」（目录服务 / 大模型），避免两台设备各加一次变成两条
  function keyOf(s) {
    if (s.catalogId) return "cat:" + s.catalogId;
    if (s.mode === "activity" && (s.provider === "claude" || s.provider === "chatgpt")) return "llm:" + s.provider;
    return "id:" + s.id;
  }

  const ts = (x) => (x && (x.updatedAt || x.checkedAt)) || 0;

  // 合并同一个订阅的两份数据：
  // - 用户编辑的字段（名称、价格、判断方式…）以 updatedAt 新的为准
  // - 最近使用日期取较晚的（任一设备看到在用就是在用）
  // - 账户页 / 大模型读取结果取读得较晚的
  // - 只存在本机的字段（指纹、读取状态等）保留本机的
  function mergeOne(local, remote) {
    if (!local) return fromRemote(remote);
    if (!remote) return local;
    remote = fromRemote(remote);
    const newer = (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
    const out = Object.assign({}, local);
    // 两台设备各自加的同一个服务 id 不同：统一用较小的那个，几次同步后各设备的 id 就一致了，删除记录才能对上
    if (remote.id && String(remote.id) < String(local.id)) out.id = remote.id;
    for (const k of SYNC_FIELDS) {
      if (k === "id" || k === "lastUsed" || k === "lastUsedFloor" || k === "lastWatched" || k === "watchAt" || k === "account" || k === "llm") continue;
      if (newer[k] !== undefined) out[k] = newer[k]; else delete out[k];
    }
    // 最近使用：真实日期优先于「90 天没访问」占位
    const lu = (s) => (s.lastUsedFloor ? 0 : s.lastUsed || 0);
    if (lu(remote) > lu(local)) { out.lastUsed = remote.lastUsed; out.lastUsedFloor = false; }
    else if (!local.lastUsed && remote.lastUsed) { out.lastUsed = remote.lastUsed; out.lastUsedFloor = !!remote.lastUsedFloor; }
    // 观看记录读出来的最近观看日：以「读得较晚」的那台设备为准（同一个账号的观看记录两边一样，读得晚的更新），
    // 并且这时最近使用就等于最近观看 —— 不能再按「取较晚」合并，否则以前误记的「今天」会一直盖住真实日期
    if (local.watchAt || remote.watchAt) {
      const src = (remote.watchAt || 0) > (local.watchAt || 0) ? remote : local;
      out.lastWatched = src.lastWatched; out.watchAt = src.watchAt;
      if (src.lastWatched) { out.lastUsed = src.lastWatched; out.lastUsedFloor = false; }
    }
    if (remote.account && ts(remote.account) > ts(local.account)) out.account = Object.assign({}, local.account, remote.account);
    if (remote.llm && ts(remote.llm) > ts(local.llm)) out.llm = Object.assign({}, local.llm, remote.llm);
    // 访问时间点：两台设备的访问合在一起
    if (local.visitLog || remote.visitLog) out.visitLog = unionVisits(local.visitLog, remote.visitLog);
    delete out.visits;
    return out;
  }

  // 用户手动排的顺序：{ ids: [订阅 id…], at: 排序时间 }；ids 为 null 表示用自动排序。整体以较晚排的为准。
  function cleanOrder(o) {
    if (!o || typeof o !== "object" || typeof o.at !== "number") return null;
    const ids = Array.isArray(o.ids) ? o.ids.filter(x => typeof x === "string").slice(0, 1000) : null;
    return { ids, at: o.at };
  }

  // local / remote: { subs: [...], deleted: { id: 删除时间 }, order?: { ids, at } }
  // 返回合并后的 { subs, deleted, order }。subs 保留本机的顺序，云端新增的排在后面。
  function merge(local, remote, now) {
    now = now || Date.now();
    const deleted = Object.assign({}, (remote && remote.deleted) || {});
    for (const [id, t] of Object.entries((local && local.deleted) || {})) deleted[id] = Math.max(deleted[id] || 0, t);
    for (const id of Object.keys(deleted)) if (now - deleted[id] > TOMBSTONE_DAYS * DAY) delete deleted[id];

    const out = [], index = {}, keysOf = {};
    const add = (s, isRemote) => {
      if (!s || !s.id) return;
      const k = keyOf(s);
      keysOf[s.id] = k;
      if (k in index) { out[index[k]] = isRemote ? mergeOne(out[index[k]], s) : mergeOne(s, out[index[k]]); return; }
      index[k] = out.length;
      out.push(isRemote ? fromRemote(s) : s);
    };
    ((local && local.subs) || []).forEach(s => add(s, false));
    ((remote && remote.subs) || []).forEach(s => add(s, true));
    // 删除后又重新编辑过的不算删除（删除时间早于最后修改）
    const subs = out.filter(s => !(deleted[s.id] && deleted[s.id] >= (s.updatedAt || s.createdAt || 0)));
    for (const s of subs) if (deleted[s.id]) delete deleted[s.id];
    // 顺序：取较晚排的那份；合并后 id 可能统一成了另一台设备的，顺序里的 id 跟着换
    const lo = cleanOrder(local && local.order), ro = cleanOrder(remote && remote.order);
    let order = lo && ro ? (ro.at > lo.at ? ro : lo) : (lo || ro);
    if (order && order.ids) {
      const seen = {};
      const ids = [];
      for (const id of order.ids) {
        const k = keysOf[id];
        const nid = k && k in index ? out[index[k]].id : id;
        if (!seen[nid]) { seen[nid] = 1; ids.push(nid); }
      }
      order = { ids, at: order.at };
    }
    const own = (local && local.own) || (remote && remote.own) ? mergeOwn(local && local.own, remote && remote.own, now) : null;
    return { subs, deleted, order: order || null, own };
  }

  function payload(subs, deleted, order, own) {
    const p = { v: 1, subs: (subs || []).map(sanitize), deleted: deleted || {} };
    const o = cleanOrder(order);
    if (o) p.order = o;
    const ow = own ? encodeOwn(own) : [];
    if (ow.length) p.own = ow;
    return p;
  }

  function sizeOf(p) { return new TextEncoder().encode(JSON.stringify(p)).length; }

  // 两份数据在「要同步的字段」上是否一致（一致就不用上传）
  function canonical(x) {
    if (Array.isArray(x)) return x.map(canonical);
    if (x && typeof x === "object") { const o = {}; Object.keys(x).sort().forEach(k => { o[k] = canonical(x[k]); }); return o; }
    return x;
  }
  function sameSynced(a, b) {
    const norm = (d) => { const p = payload(d.subs, d.deleted, d.order, d.own); p.subs.sort((x, y) => String(x.id) < String(y.id) ? -1 : 1); return JSON.stringify(canonical(p)); };
    return norm(a) === norm(b);
  }

  const api = { TOMBSTONE_DAYS, MAX_BYTES, SYNC_FIELDS, mergeOwn, purgeOwn, encodeVisits, decodeVisits, unionVisits, sanitize, keyOf, mergeOne, merge, payload, sizeOf, sameSynced };
  globalThis.SyncLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
