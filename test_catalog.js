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

console.log("== 目录 ==");
check("4 个分类都有服务", C.CATEGORIES.every((c) => C.PROVIDERS.some((p) => p.cat === c.key)));
check("id 不重复", new Set(C.PROVIDERS.map((p) => p.id)).size === C.PROVIDERS.length);
check("除 Claude/ChatGPT 外都有账户页和套餐规则", C.PROVIDERS.filter((p) => !p.special).every((p) => p.accountUrl && p.plans && p.plans.length));
check("权限来源包含账户页所在域名", C.originsOf(C.BY_ID.prime).indexOf("https://www.amazon.com/*") >= 0);

console.log("== 账户页解析 ==");
let r = parse("netflix", "Membership\nPremium\n4K + HDR\nNext payment: November 3, 2026\n$24.99/month\nChange plan");
check("Netflix Premium、价格、下次付款日", r.status === "ok" && r.plan.label === "Premium" && r.price.value === 24.99 && r.price.period === "month" && r.renewAt === new Date(2026, 10, 3).getTime());
check("Netflix 含广告标准版不会被认成标准版", parse("netflix", "Standard with ads\n$7.99/month").plan.label === "Standard with ads");
r = parse("spotify", "Your plan\nPremium Family\nYour next bill is for ¥26.00 on 2026/11/01.");
check("Spotify Family + 下次扣费日", r.plan.label === "Premium Family" && r.renewAt === new Date(2026, 10, 1).getTime());
check("Spotify 免费版", parse("spotify", "Your plan\nSpotify Free\nJoin Premium").plan.paid === false);
r = parse("iqiyi", "我的会员\n黄金VIP会员\n2026-12-31 到期\n连续包月 ¥25/月");
check("爱奇艺黄金 VIP、到期日（日期在关键词前）、月费", r.plan.label === "黄金VIP" && r.renewAt === new Date(2026, 11, 31).getTime() && r.price.value === 25 && r.price.currency === "¥");
r = parse("bilibili", "大会员\n年度大会员\n有效期至 2027年3月1日\n¥148/年");
check("B站年度大会员、年费折月", r.plan.label === "年度大会员" && r.price.period === "year" && r.price.monthly === 12.33 && r.renewAt === new Date(2027, 2, 1).getTime());
r = parse("baidu-pan", "超级会员 SVIP\n容量 1.2T/5T\n到期时间 2026-10-20");
check("百度网盘：超级会员 + 空间 24%", r.plan.label === "超级会员" && r.storage.pct === 24 && /1\.2 TB \/ 5 TB/.test(r.storage.label));
r = parse("google-one", "Google AI Pro (2 TB)\nStorage\n180 GB of 2 TB used\nRenews on Nov 15, 2026");
check("Google One：AI Pro + 空间 9% + 续费日", r.plan.label === "Google AI Pro" && r.storage.pct === 9 && r.renewAt === new Date(2026, 10, 15).getTime());
check("YouTube Premium Lite 优先于 Premium", parse("youtube", "Memberships\nYouTube Premium Lite\nNext billing date Oct 30").plan.label === "Premium Lite");
check("YouTube 没有会员", parse("youtube", "Memberships\nYou have no memberships\nGet YouTube Premium").plan.paid === false);
check("Copilot Pro+ 优先于 Pro", parse("copilot", "GitHub Copilot\nYou are on Copilot Pro+ plan").plan.label === "Copilot Pro+");
check("Midjourney Standard", parse("midjourney", "Your Plan\nStandard Plan\n$30 per month\nRenews on 2026-11-02").price.monthly === 30);
check("Microsoft 365 家庭版 + 中文续费", parse("m365", "服务和订阅\nMicrosoft 365 家庭版\n续费日期：2027年1月5日").renewAt === new Date(2027, 0, 5).getTime());

console.log("== 未登录 / 认不出 ==");
check("被跳到登录页 → 未登录", parse("netflix", "Sign In\nEmail or mobile number\nPassword", "https://www.netflix.com/login").status === "logged_out");
check("页面很短且只有登录字样 → 未登录", parse("iqiyi", "扫码登录\n密码登录").status === "logged_out");
check("读到页面但没有套餐关键词 → unknown，不瞎猜", parse("adobe", "Welcome back. Lots of other content here that does not mention any plan names at all, " + "x".repeat(4000)).status === "unknown");

console.log("== 小工具 ==");
check("空间：12.3 GB of 2 TB", C.parseStorage("12.3 GB of 2 TB used").pct === 1);
check("空间：已使用 45GB / 50GB", C.parseStorage("已使用 45GB / 50GB").pct === 90);
check("空间：明显不合理的数字不算", C.parseStorage("500 GB of 2 GB") === null);
check("价格：找不到每月字样就不填", C.parsePrice("Total 30", H.parseAmount, "$") === null);
check("续费：太久远的日期不算", C.parseRenew("Renews on 2099-01-01", H.parseDate, NOW) === null);

console.log("== 建议 ==");
const p = C.BY_ID["google-one"];
check("付费 + 闲置 → 考虑退订", C.accountAdvice(p, { status: "ok", plan: { label: "Google AI Pro", paid: true } }, { state: "idle", days: 45 }).level === "cancel");
check("空间只用 9% → 考虑小一档", C.accountAdvice(p, { status: "ok", plan: { label: "Google AI Pro", paid: true }, storage: { pct: 9, label: "180 GB / 2 TB", totalGB: 2048 } }, { state: "active" }).level === "downgrade");
check("免费版 → 不给建议", C.accountAdvice(p, { status: "ok", plan: { label: "免费版", paid: false } }, null).level === "none");
check("未登录 → 提示登录", /没有登录/.test(C.accountAdvice(p, { status: "logged_out" }, null).text));

console.log("== 发现 ==");
const recs = [{ hostname: "www.netflix.com", time: NOW - DAY }, { hostname: "open.spotify.com", time: NOW - DAY }, { hostname: "open.spotify.com", time: NOW - 2 * DAY },
              { hostname: "www.netflix.com", time: NOW - 40 * DAY }, { hostname: "vip.iqiyi.com", time: NOW - 3 * DAY }];
const d = C.discover(recs, ["iqiyi"], NOW, 30);
check("按访问次数排序、排除已加入、只看 30 天内", d.join() === "spotify,netflix");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
