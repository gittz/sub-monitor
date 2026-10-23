// 读取模板测试（node test_activity.js）：api 模板 + 目录里每份 api 配置的自检
const fs = require("fs"), vm = require("vm"), path = require("path");
const A = require("./activity.js");
let fail = 0;
const t = (n, c, x) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || x === undefined ? "" : "  → " + JSON.stringify(x))); if (!c) { fail++; process.exitCode = 1; } };

// 在模拟的页面环境里跑 apiExtract（和真实情况一样：函数被序列化后单独运行）
async function runInPage(spec, { responses = {}, links = [], text = "" } = {}) {
  const ctx = {
    location: { href: "https://www.example.com/history" },
    document: { body: { innerText: text }, querySelectorAll: () => links.map(([href, title]) => ({ getAttribute: (k) => k === "href" ? href : k === "title" ? title : null, textContent: title })) },
    fetch: async (url) => {
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

  const http = await runInPage({ urls: ["https://x.example/api"], list: ["items"], id: ["id"], ts: ["at"] }, { responses: { "https://x.example/api": { status: 401, body: {} } } });
  t("HTTP 401/403 → 标记未登录", http.loggedOut === true);

  const iso = await runInPage({ urls: ["https://x.example/api"], list: [""], id: ["id"], ts: ["lastPlayed"], title: ["name"] },
    { responses: { "https://x.example/api": { body: [{ id: "a", lastPlayed: "2026-10-20T08:00:00Z", name: "A" }] } } });
  t("时间是 ISO 字符串、列表在最外层也能读", iso.lastTs === Date.parse("2026-10-20T08:00:00Z") && iso.sample[0] === "A", iso);
})();
