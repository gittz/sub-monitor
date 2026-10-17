// 观看记录页的通用接口监听（优酷等）：只在插件读取观看记录的那几秒里注册，读完立刻注销。
// 在页面自己的环境里（页面脚本运行前）挂上 fetch / XHR 的监听，把页面收到的 JSON 结果留一份给插件，
// 插件再从里面找出「带观看时间和片名的列表」。不改请求、不改返回，也不发任何额外请求。
(function () {
  if (window.__idlesubsHistHooked) return;
  window.__idlesubsHistHooked = true;
  const H = window.__idlesubsHist = { calls: [], bodies: [] };
  function pathOf(url) { try { const u = new URL(String(url), location.href); return u.host + u.pathname; } catch (e) { return String(url).slice(0, 80); } }
  function keep(url, text) {
    try {
      if (typeof text !== "string" || text.length < 2 || text.length > 1500000) return;
      let t = text.trim();
      // mtop 之类的 JSONP 包装：callback({...})
      const m = t.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?$/);
      if (m) t = m[1];
      if (t[0] !== "{" && t[0] !== "[") return;
      const j = JSON.parse(t);
      if (H.calls.length < 60) H.calls.push({ path: pathOf(url), size: text.length });
      if (H.bodies.length < 40) H.bodies.push({ path: pathOf(url), json: j });
    } catch (e) {}
  }
  const of = window.fetch;
  if (of) {
    window.fetch = function (input) {
      const p = of.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url);
        p.then(r => { const ct = (r.headers && r.headers.get && r.headers.get("content-type")) || ""; if (/json|javascript|text/i.test(ct)) r.clone().text().then(t => keep(url, t)).catch(() => {}); }).catch(() => {});
      } catch (e) {}
      return p;
    };
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__ihUrl = url; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    try {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") keep(this.__ihUrl, this.responseText);
          else if (this.responseType === "json" && this.response) H.calls.length < 60 && keep(this.__ihUrl, JSON.stringify(this.response));
        } catch (e) {}
      });
    } catch (e) {}
    return XS.apply(this, arguments);
  };
})();
