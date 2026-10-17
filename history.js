// 浏览历史（chrome.history）→ 按域名汇总的访问日期。纯逻辑，后台和测试共用。
// 只用到「哪个域名、哪天访问过」，不保存网址和标题。
(function () {
  const DAY = 86400000;
  const WINDOW_DAYS = 90;          // Chrome 默认大约保留 90 天
  const OWN_BEFORE = 10 * 1000;    // 插件后台打开网页前后这段时间内、同一网站的访问不算用户在用
  const OWN_AFTER = 3 * 60 * 1000;

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
  }
  function matches(host, domain) {
    const d = String(domain || "").toLowerCase().replace(/^www\./, "");
    return !!d && (host === d || host.endsWith("." + d));
  }
  function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

  // 历史条目里哪些网址值得逐条查访问时间（只查我们关心的域名）
  function pickUrls(items, domains, start, cap) {
    return (items || [])
      .filter(it => it && it.url && (it.lastVisitTime || 0) >= start && domains.some(d => matches(hostOf(it.url), d)))
      .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
      .slice(0, cap || 400)
      .map(it => it.url);
  }

  function isOwn(host, time, own) {
    return (own || []).some(o => o && o.host && (host === o.host || host.endsWith("." + o.host) || o.host.endsWith("." + host)) &&
      time >= o.time - OWN_BEFORE && time <= o.time + OWN_AFTER);
  }

  // visits: [{ url, time }]；domains: 关心的域名；own: 插件自己打开网页的记录 [{ host, time }]
  // 返回 { start, byDomain: { 域名: { last, days30, days90 } }, hits: [{ hostname, time }]（每个域名每天一条，给「发现」用），
  //        times: { 域名: [每次访问时间] }（给访问次数统计用） }
  function aggregate(visits, domains, own, now, days) {
    now = now || Date.now();
    const start = now - (days || WINDOW_DAYS) * DAY;
    const since30 = now - 30 * DAY;
    const per = {};
    for (const v of visits || []) {
      if (!v || !v.url || !(v.time >= start) || v.time > now + 60000) continue;
      const host = hostOf(v.url);
      if (!host || isOwn(host, v.time, own)) continue;
      for (const d of domains) {
        if (!matches(host, d)) continue;
        const e = per[d] || (per[d] = { last: 0, d30: {}, d90: {}, times: [] });
        e.times.push(v.time);
        if (v.time > e.last) e.last = v.time;
        const k = dayKey(v.time);
        e.d90[k] = Math.max(e.d90[k] || 0, v.time);
        if (v.time >= since30) e.d30[k] = 1;
      }
    }
    const byDomain = {}, hits = [], times = {};
    for (const d of Object.keys(per)) {
      const e = per[d];
      byDomain[d] = { last: e.last, days30: Object.keys(e.d30).length, days90: Object.keys(e.d90).length };
      times[d] = e.times;
      for (const k of Object.keys(e.d90)) hits.push({ hostname: d, time: e.d90[k] });
    }
    return { start, byDomain, hits, times };
  }

  // 某个订阅（可能对应多个域名）的汇总
  function statsFor(byDomain, domains) {
    let last = 0, days30 = 0, days90 = 0;
    for (const d of domains || []) {
      const e = byDomain && byDomain[String(d).toLowerCase().replace(/^www\./, "")];
      if (!e) continue;
      last = Math.max(last, e.last); days30 = Math.max(days30, e.days30); days90 = Math.max(days90, e.days90);
    }
    return { last, days30, days90 };
  }

  const api = { DAY, WINDOW_DAYS, hostOf, matches, pickUrls, aggregate, statsFor, isOwn };
  globalThis.HistLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
