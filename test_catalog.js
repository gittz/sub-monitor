// 服务目录与账户页解析的测试：node test_catalog.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const C = require("./catalog.js");
const ctx = { console, URLSearchParams, TextDecoder, atob, btoa }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "mailscan.js"), "utf8"), ctx);
const M = ctx.MailLib;
const H = { parseAmount: M.parseAmount, parseDate: M.parseMailDate };
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n); } };
const DAY = 86400000, NOW = new Date(2026, 9, 9, 12).getTime();
const parse = (id, text, url) => C.parseAccountPage(C.BY_ID[id], { text, url: url || C.BY_ID[id].accountUrl }, H, NOW);

// 解析机制本身用一个示例服务测（不依赖目录里收了哪些服务）
const DEMO = { id: "demo", name: "Demo", accountUrl: "https://www.demo.example/account", currency: "$",
  plans: [[/Standard with ads/i, "Standard with ads", true], [/Premium/i, "Premium", true], [/Standard/i, "Standard", true]], free: /Free plan|Join Premium/i };
const parseDemo = (text, url) => C.parseAccountPage(DEMO, { text, url: url || DEMO.accountUrl }, H, NOW);

console.log("== 目录 ==");
check("4 个分类都有服务", C.CATEGORIES.every((c) => C.PROVIDERS.some((p) => p.cat === c.key)));
check("id 不重复", new Set(C.PROVIDERS.map((p) => p.id)).size === C.PROVIDERS.length);
check("除 Claude/ChatGPT 外都有账户页和套餐规则", C.PROVIDERS.filter((p) => !p.special).every((p) => p.accountUrl && p.plans && p.plans.length));
check("只收录已经适配好的服务", C.PROVIDERS.map((p) => p.id).sort().join() === "baidu-pan,bilibili,chatgpt,claude,copilot,cursor,gemini,perplexity,tencent-video,youtube");
check("权限来源包含账户页所在域名", C.originsOf(C.BY_ID["tencent-video"]).indexOf("https://film.qq.com/*") >= 0);

console.log("== 账户页解析 ==");
let r = parseDemo("Membership\nPremium\n4K + HDR\nNext payment: November 3, 2026\n$24.99/month\nChange plan");
check("套餐、价格、下次付款日", r.status === "ok" && r.plan.label === "Premium" && r.price.value === 24.99 && r.price.period === "month" && r.renewAt === new Date(2026, 10, 3).getTime());
check("规则按从具体到宽泛匹配：含广告标准版不会被认成标准版", parseDemo("Standard with ads\n$7.99/month").plan.label === "Standard with ads");
check("免费版", parseDemo("Your plan\nFree plan\nUpgrade any time").plan.paid === false);
r = parse("tencent-video", "我的VIP\n超级影视VIP\n2026-12-31 到期\n连续包月 ¥25/月");
check("腾讯视频超级影视 VIP、到期日（日期在关键词前）、月费", r.plan.label === "超级影视VIP" && r.renewAt === new Date(2026, 11, 31).getTime() && r.price.value === 25 && r.price.currency === "¥");
r = parse("bilibili", "大会员\n年度大会员\n有效期至 2027年3月1日\n¥148/年");
check("B站年度大会员、年费折月", r.plan.label === "年度大会员" && r.price.period === "year" && r.price.monthly === 12.33 && r.renewAt === new Date(2027, 2, 1).getTime());
r = parse("baidu-pan", "超级会员 SVIP\n容量 1.2T/5T\n到期时间 2026-10-20");
check("百度网盘：超级会员 + 空间 24%", r.plan.label === "超级会员" && r.storage.pct === 24 && /1\.2 TB \/ 5 TB/.test(r.storage.label));
check("YouTube Premium Lite 优先于 Premium", parse("youtube", "Memberships\nYouTube Premium Lite\nNext billing date Oct 30").plan.label === "Premium Lite");
check("YouTube 没有会员", parse("youtube", "Memberships\nYou have no memberships\nGet YouTube Premium").plan.paid === false);

{
  // Gemini 套餐在 Google One 页：页面上同时列着可购买的方案，只看「当前方案」后面那一行
  const g1 = parse("gemini", "您已获得 15 GB 的存储空间\n已使用 0.1 GB，共 15 GB\n您当前的方案\n15 GB\n已包含在您的 Google 账号中\n$0\n推荐\nBasic (100 GB)\nSGD 2.79 $0.48/月\nGoogle AI Plus (400 GB)\n" + "x".repeat(300));
  check("Gemini：免费账号不会被推荐方案（Google AI Plus）误认成已订阅", g1.status === "ok" && g1.plan.paid === false && g1.storage.totalGB === 15);
  const g2 = parse("gemini", "Storage\n180 GB of 2 TB used\nYour current plan\nGoogle AI Pro (2 TB)\nRecommended\nGoogle AI Ultra\n$19.99/month\n" + "x".repeat(300));
  check("Gemini：当前方案 Google AI Pro；页面上的价格是推荐优惠，不读", g2.plan.label === "Google AI Pro" && g2.plan.paid && !g2.price && g2.storage.pct === 9);
  check("Gemini：没有「当前方案」字样时不瞎猜", parse("gemini", "Google AI Ultra\nGoogle AI Pro\n" + "x".repeat(300)).plan === null);
}

{
  // Perplexity：套餐读设置接口返回的 JSON
  const pj = (o) => JSON.stringify(Object.assign({ pages_limit: 10, upload_limit: 3, pad: "x".repeat(300) }, o));
  check("Perplexity：没有订阅 → 免费版", parse("perplexity", pj({ subscription_status: "none", subscription_source: "none", subscription_tier: null })).plan.paid === false);
  check("Perplexity：Pro", parse("perplexity", pj({ subscription_status: "active", subscription_source: "stripe", subscription_tier: "pro" })).plan.label === "Pro");
  check("Perplexity：Max 优先", parse("perplexity", pj({ subscription_status: "active", subscription_tier: "max" })).plan.label === "Max");
}

{
  // Microsoft Copilot：微软账户「订阅」页
  const free = parse("copilot", "订阅\nMicrosoft 存储\nMicrosoft 免费服务\n使用 Microsoft 帐户，享受对这些免费服务的访问。\nMicrosoft 365 网页版\nOneDrive\nTeams\nOutlook.com\n" + "x".repeat(300));
  check("Copilot：免费账号（「Microsoft 365 网页版」不算付费）", free.status === "ok" && free.plan.paid === false);
  // 真实免费账号页面文本（含「首月使用免费 / 免费试用」推广位，不能误判成付费）
  const real = parse("copilot", "订阅\n首月使用免费\n联机或脱机访问生产力应用、安全云存储、高级安全性等 - 所有这些都包含在一个便捷订阅中。\n免费试用\n了解详细信息\n有预付费产品密钥? 开始订阅\nMicrosoft 存储\n已用总量\n< 0.1 GB / 5 GB\n获取更多存储\nMicrosoft 免费服务\n使用 Microsoft 帐户，享受对这些免费服务的访问。\nMicrosoft 365 网页版\nOneDrive\nTeams\nOutlook.com\n中文（中国）\n隐私与 Cookie\n使用条款");
  check("Copilot：真实免费账号页 → 免费", real.status === "ok" && real.plan && real.plan.paid === false);
  check("Copilot：Copilot Pro", parse("copilot", "订阅\nCopilot Pro\n下一次收费日期\n" + "x".repeat(300)).plan.label === "Copilot Pro");
  check("Copilot：Microsoft 365 家庭版", parse("copilot", "Subscriptions\nMicrosoft 365 Family\n" + "x".repeat(300)).plan.label === "Microsoft 365 家庭版");
}

{
  // Cursor：用量接口 JSON（free 为实测原文）
  const cfree = parse("cursor", '{"billingCycleStart":"2026-10-17T05:20:29.085Z","billingCycleEnd":"2026-11-17T05:20:29.085Z","membershipType":"free","limitType":"user","isUnlimited":false,"autoModelSelectedDisplayMessage":"You\'ve used 0% of your included total usage","individualUsage":{"plan":{"enabled":true,"used":0,"limit":0}}}');
  check("Cursor：membershipType free → 免费", cfree.status === "ok" && cfree.plan.paid === false);
  check("Cursor：pro", parse("cursor", '{"membershipType":"pro","limitType":"user"}' + " ".repeat(300)).plan.label === "Pro");
  check("Cursor：free_trial 不当成免费", parse("cursor", '{"membershipType":"free_trial"}' + " ".repeat(300)).plan.label === "Pro 试用");
  check("Cursor：ultra", parse("cursor", '{"membershipType":"ultra"}' + " ".repeat(300)).plan.label === "Ultra");
}

console.log("== 未登录 / 认不出 ==");
check("被跳到登录页 → 未登录", parseDemo("Sign In\nEmail or mobile number\nPassword", "https://www.demo.example/login").status === "logged_out");
check("页面很短且只有登录字样 → 未登录", parse("tencent-video", "扫码登录\n密码登录").status === "logged_out");
check("读到页面但没有套餐关键词 → unknown，不瞎猜", parseDemo("Welcome back. Lots of other content here that does not mention any plan names at all, " + "x".repeat(4000)).status === "unknown");

console.log("== 小工具 ==");
check("空间：12.3 GB of 2 TB", C.parseStorage("12.3 GB of 2 TB used").pct === 1);
check("空间：已使用 45GB / 50GB", C.parseStorage("已使用 45GB / 50GB").pct === 90);
check("空间：明显不合理的数字不算", C.parseStorage("500 GB of 2 GB") === null);
check("价格：找不到每月字样就不填", C.parsePrice("Total 30", H.parseAmount, "$") === null);
check("续费：太久远的日期不算", C.parseRenew("Renews on 2099-01-01", H.parseDate, NOW) === null);

console.log("== 建议 ==");
const p = C.BY_ID["baidu-pan"];
check("付费 + 闲置 → 考虑退订", C.accountAdvice(p, { status: "ok", plan: { label: "超级会员", paid: true } }, { state: "idle", days: 45 }).level === "cancel");
check("空间只用 9% → 考虑小一档", C.accountAdvice(p, { status: "ok", plan: { label: "超级会员", paid: true }, storage: { pct: 9, label: "180 GB / 2 TB", totalGB: 2048 } }, { state: "active" }).level === "downgrade");
check("免费版 → 不给建议", C.accountAdvice(p, { status: "ok", plan: { label: "免费版", paid: false } }, null).level === "none");
check("未登录 → 提示登录", /没有登录/.test(C.accountAdvice(p, { status: "logged_out" }, null).text));

console.log("== 发现 ==");
const recs = [{ hostname: "www.youtube.com", time: NOW - DAY }, { hostname: "www.bilibili.com", time: NOW - DAY }, { hostname: "www.bilibili.com", time: NOW - 2 * DAY },
              { hostname: "www.youtube.com", time: NOW - 40 * DAY }, { hostname: "v.qq.com", time: NOW - 3 * DAY }];
const d = C.discover(recs, ["tencent-video"], NOW, 30);
check("按访问次数排序、排除已加入、只看 30 天内", d.join() === "bilibili,youtube");

// 网盘：空间信息比套餐晚加载，要等它出来
(async () => {
  const bp = { plans: [[/超级会员|SVIP/i, "超级会员", true]], storage: true };   // 没有用量接口、空间写在页面上的网盘
  const head = "首页 我的文件 超级会员 SVIP " + "x".repeat(300);
  let text = head;
  global.document = { body: { get innerText() { return text; } } };
  global.location = { href: "https://pan.baidu.com/disk/main" };
  setTimeout(() => { text = head + "\n前往电脑端,立享50G\n1651G/3181G"; }, 1200);
  const r = await C.pageTextExtract({ waitRe: C.waitPattern(bp), needRe: C.needPattern(bp), timeoutMs: 6000 });
  const a = C.parseStorage(r.text);
  check("空间信息比套餐晚加载：等它出来再读（1651G/3181G）", a && a.usedGB === 1651 && a.totalGB === 3181 && a.pct === 52);
  check("没有空间信息的服务不用等", C.needPattern(C.BY_ID["youtube"]) === "");
  const G = 1024 ** 3;
  const sb = C.storageFromBytes(1651 * G, 3181 * G);
  check("百度网盘：用量接口给的字节数换算成 1.6 TB / 3.1 TB", sb && sb.usedGB === 1651 && sb.pct === 52 && sb.label === "1.6 TB / 3.1 TB");
  const pa = C.parseAccountPage(C.BY_ID["baidu-pan"], { url: "https://pan.baidu.com/disk/main", text: "超级会员 SVIP " + "x".repeat(300), quota: { used: 1651 * G, total: 3181 * G } }, {}, Date.now());
  check("百度网盘：页面上没有空间文字时用接口数据", pa.storage && pa.storage.totalGB === 3181);
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
