// 腾讯视频观看记录：只在插件读取观看记录的那几秒里注册（读完立刻注销）。
// 在页面自己的环境里（MAIN world、页面脚本运行前）挂上 fetch / XHR 的监听，
// 页面请求观看记录接口（GetList?video_appid=...）时，把返回结果留一份给插件读。
// 不改请求、不改返回，也不发任何额外请求。
(function () {
  if (window.__idlesubsTxHooked) return;
  window.__idlesubsTxHooked = true;
  const RE = /GetList\?[^#]*video_appid=/i;
  // 页面可能调用好几次（不同列表、翻页）：全部收集起来，插件按观看时间取最近一条
  function keep(url, text) {
    try {
      if (!RE.test(String(url || ""))) return;
      const j = JSON.parse(text);
      if (!j || typeof j !== "object") return;
      const c = window.__idlesubsTx || (window.__idlesubsTx = { at: 0, ret: null, msgs: null, calls: [] });
      const msgs = (j.data && Array.isArray(j.data.msgs)) ? j.data.msgs : null;
      c.at = Date.now();
      if (c.ret !== 0) c.ret = j.ret;
      let m = "";
      try { m = String(url).match(/video_appid=(\d+)/)[1]; } catch (e) {}
      if (c.calls.length < 20) c.calls.push({ appid: m, ret: j.ret, n: msgs ? msgs.length : -1 });
      if (msgs) c.msgs = (c.msgs || []).concat(msgs).slice(0, 500);
    } catch (e) {}
  }
  // 记下页面发出的观看记录请求（地址、方法、请求体、请求头），插件读取时用它绕过浏览器缓存再取一次最新的
  function remember(req) {
    try {
      const c = window.__idlesubsTx || (window.__idlesubsTx = { at: 0, ret: null, msgs: null, calls: [] });
      if (!c.req) c.req = req;
    } catch (e) {}
  }
  const of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      const p = of.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url);
        if (RE.test(String(url || ""))) {
          const o = init || {};
          remember({ url: String(url), method: o.method || (input && input.method) || "GET",
                     body: typeof o.body === "string" ? o.body : null, headers: o.headers && !(o.headers instanceof Headers) ? o.headers : null });
          p.then(r => r.clone().text().then(t => keep(url, t))).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, url) { this.__isUrl = url; this.__isMethod = m; this.__isHeaders = {}; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { if (this.__isHeaders) this.__isHeaders[k] = v; } catch (e) {} return XH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (RE.test(String(this.__isUrl || ""))) {
        remember({ url: String(new URL(this.__isUrl, location.href)), method: this.__isMethod || "GET",
                   body: typeof body === "string" ? body : null, headers: this.__isHeaders || null });
        this.addEventListener("load", () => {
          try { keep(this.__isUrl, this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response)); } catch (e) {}
        });
      }
    } catch (e) {}
    return XS.apply(this, arguments);
  };
})();
