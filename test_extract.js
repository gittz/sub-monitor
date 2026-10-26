// 测试 background.js 里的 genericExtract —— 加载真实文件，用假的 DOM 跑
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// chrome API 桩：任何 chrome.x.y.addListener 都能安全调用
function apiStub() {
  return new Proxy(function () {}, {
    get(t, p) {
      if (p === "addListener" || p === "removeListener") return () => {};
      if (typeof p === "symbol") return undefined;
      return apiStub();
    },
    apply() { return apiStub(); }
  });
}

function loadBackground(fakeLocationHref, fakeDoc) {
  const ctx = {
    console,
    chrome: apiStub(),
    importScripts: () => {},
    setTimeout, clearTimeout,
    Promise, JSON, Object, Array, RegExp, Math, Date, String,
    location: { href: fakeLocationHref, pathname: "/" },
    document: fakeDoc,
    window: {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  return ctx;
}

// 造一个只含若干链接的假页面
function fakeDocWith(hrefs, containerHrefs) {
  const mk = (list) => ({
    querySelectorAll: () => list.map(h => ({ getAttribute: () => h }))
  });
  return {
    body: mk(hrefs),
    querySelector: (sel) => (containerHrefs && sel ? mk(containerHrefs) : null)
  };
}

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name); }
};

(async () => {
console.log("== genericExtract：通用活动页抓取 ==");

// 1) 用 idPattern 抽取条目 ID
let ctx = loadBackground("https://www.netflix.com/settings/viewing-history",
  fakeDocWith(["/title/81234567", "/title/70264888", "/browse", "/title/81234567"]));
let r = await ctx.genericExtract({ idPattern: "/(?:title|watch)/(\\d+)" });
check("按正则抽出 ID", r.ids[0] === "81234567" && r.ids[1] === "70264888");
check("自动去重（重复的 81234567 只算一次）", r.ids.length === 2);
check("忽略不匹配的链接（/browse）", r.ids.indexOf("browse") === -1);
check("登录态未被误判为未登录", r.loggedOut !== true);

// 2) 被重定向到登录页 → 判定未登录
ctx = loadBackground("https://www.netflix.com/login?next=/settings", fakeDocWith([]));
r = await ctx.genericExtract({});
check("重定向到 /login 判定为未登录", r.loggedOut === true);

ctx = loadBackground("https://www.primevideo.com/ap/signin?x=1", fakeDocWith([]));
r = await ctx.genericExtract({ loginUrlPattern: "/ap/signin|/gp/sign-in" });
check("自定义登录页正则也能识别", r.loggedOut === true);

// 3) 没给 idPattern 时退回用链接路径，并去掉 query
ctx = loadBackground("https://x.com/history", fakeDocWith(["/watch/abc123?t=5", "/watch/abc123?t=99"]));
r = await ctx.genericExtract({});
check("无正则时用链接路径兜底", r.ids[0] === "/watch/abc123");
check("去掉 query 后两条视为同一项", r.ids.length === 1);

// 4) 容器选择器生效：只抓容器内的链接，忽略页面其它部分
ctx = loadBackground("https://x.com/history",
  fakeDocWith(["/ad/999"], ["/title/111", "/title/222"]));
r = await ctx.genericExtract({ containerSelector: ".history", idPattern: "/title/(\\d+)" });
check("只抓容器内条目", r.ids.length === 2 && r.ids[0] === "111");

// 5) 空页面 → 抓不到（会被上层判成信号中断，从而冻结闲置判断）
ctx = loadBackground("https://x.com/history", fakeDocWith([]));
r = await ctx.genericExtract({ idPattern: "/title/(\\d+)" });
check("空页面抓不到条目（安全：上层会冻结判断）", r.ids.length === 0);

// 6) 上限保护：条目再多也只取前 20 个
const many = [];
for (let i = 0; i < 60; i++) many.push("/title/" + i);
ctx = loadBackground("https://x.com/history", fakeDocWith(many));
r = await ctx.genericExtract({ idPattern: "/title/(\\d+)" });
check("最多取 20 个条目", r.ids.length === 20);

// 7) 坏正则不能让整个流程崩掉
ctx = loadBackground("https://x.com/history", fakeDocWith(["/title/1"]));
let threw = false;
try { r = await ctx.genericExtract({ idPattern: "([unclosed" }); } catch (e) { threw = true; }
check("非法正则不抛异常", !threw);

console.log("== 服务目录 ==");
ctx = loadBackground("https://x.com/", fakeDocWith([]));
// 注意：顶层 const 声明只存在于该 context 的全局词法作用域，不会挂到 context 对象上，
// 所以要用 runInContext 求值来取（函数声明则可以直接 ctx.xxx 拿到）。
const eval_ = (expr) => vm.runInContext(expr, ctx);
const cat = eval_("CATALOG");
check("YouTube 标为已实测", cat.youtube.verified === true);
check("只保留适配好的读取方式", Object.keys(cat).sort().join() === "bilibili,chatgpt,claude,gemini,perplexity,tencent,youtube");
check("每个读取方式都实测过或有专用读法", Object.keys(cat).every(k => cat[k].verified === true || cat[k].strategy === "llm"));
check("已知无活动页的服务被登记（Spotify 等）",
  eval_("NO_ACTIVITY_PAGE").some(x => x.match === "spotify.com"));

console.log("== getProviderConfig：用户填的值应覆盖默认值 ==");
const cfg = ctx.getProviderConfig({ provider: "bilibili", idPattern: "/custom/(\\d+)" });
check("用户自定义正则覆盖默认", cfg.idPattern === "/custom/(\\d+)");
check("未覆盖的字段沿用目录默认",
  cfg.activityUrl === "https://www.bilibili.com/account/history" && cfg.api && cfg.api.urls.length === 2);
check("未知服务返回 null", ctx.getProviderConfig({ provider: "不存在" }) === null);

// 通用抓取：等前端渲染出列表、读分组标题（目前没有服务用到，留给以后）
{
  const nodes = [];
  const doc = {
    body: { querySelectorAll: () => nodes.map(h => ({ getAttribute: () => h })) },
    querySelector: () => null,
    querySelectorAll: () => nodes.map(h => ({ getAttribute: () => h })),
    createTreeWalker: () => { const texts = ["今日更新:", "更早", "看至85%"]; let i = 0; return { nextNode: () => (i < texts.length ? { nodeValue: texts[i++] } : null) }; }
  };
  const c2 = loadBackground("https://v.qq.com/biu/u/history?selectTab=history", doc);
  c2.NodeFilter = { SHOW_TEXT: 4 };
  setTimeout(() => nodes.push("https://v.qq.com/x/cover/mzc00200abc/w0047xyz.html", "/x/cover/mzc00200def.html", "/channel/tv"), 400);
  const t0 = Date.now();
  const r2 = await c2.genericExtract({ idPattern: "/x/(?:cover|page)/([A-Za-z0-9]+(?:/[A-Za-z0-9]+)?)\\.html", waitMs: 3000, labels: true });
  check("前端渲染的列表：等出来再抓", r2.ids.length === 2 && r2.ids[0] === "mzc00200abc/w0047xyz" && Date.now() - t0 < 2500);
  check("读到第一组标题「更早」", r2.topLabel === "更早");
  check("parseLabelToTs：前天 / 3 天前 / 10-16", !!c2.parseLabelToTs("前天", Date.now()) && !!c2.parseLabelToTs("3 天前", Date.now()) && !!c2.parseLabelToTs("10-16", Date.now()) && c2.parseLabelToTs("更早", Date.now()) === null);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
})();
