// mailscan.js 的测试：加载真实文件来测。
// 第二部分用 jsdom 造一个仿 Gmail 结构的页面来测抓取函数；没装 jsdom 时自动跳过。
//   装法（装在插件目录外即可）：npm i jsdom，然后 NODE_PATH=<那个目录>/node_modules node test_mailscan.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "mailscan.js"), "utf8");
const ctx = { console, setTimeout, clearTimeout, Promise, URLSearchParams, TextDecoder, atob, btoa };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const M = ctx.MailLib;

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name); }
};
const DAY = 86400000;
const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime(); // 2026-09-23
const d = (y, m, day) => new Date(y, m - 1, day).getTime();

console.log("== senderDomain ==");
check("去掉子域名", M.senderDomain("info@account.netflix.com") === "netflix.com");
check("大小写与空格", M.senderDomain("  Billing@Mail.OpenAI.com ") === "openai.com");
check("二级国家域名保留三段", M.senderDomain("x@mail.example.co.uk") === "example.co.uk");
check(".com.cn 同理", M.senderDomain("vip@service.iqiyi.com.cn") === "iqiyi.com.cn");
check("不是邮箱返回空", M.senderDomain("Netflix") === "" && M.senderDomain(null) === "");

console.log("== parseAmount ==");
const a1 = M.parseAmount("You were charged $15.49 for your plan");
check("美元", a1 && a1.currency === "$" && a1.value === 15.49);
const a2 = M.parseAmount("本次扣款 ¥25.00，下次续费日期");
check("人民币符号", a2 && a2.currency === "¥" && a2.value === 25);
const a3 = M.parseAmount("您已成功支付 68 元");
check("数字 + 元", a3 && a3.currency === "¥" && a3.value === 68);
const a4 = M.parseAmount("Total: US$1,199.00");
check("US$ 与千分位", a4 && a4.currency === "$" && a4.value === 1199);
check("欧元", M.parseAmount("€9.99 / month").currency === "€");
check("$0.00 试用不算价格", M.parseAmount("Your free trial: $0.00 today") === null);
check("没有金额", M.parseAmount("Welcome aboard") === null);

console.log("== classifyMail ==");
check("收据主题 → 收据", M.classifyMail({ subject: "Your receipt from OpenAI", snippet: "" }).billing);
check("中文续费 → 收据", M.classifyMail({ subject: "爱奇艺VIP会员自动续费成功", snippet: "扣款 ¥25" }).billing);
check("验证码邮件被排除", !M.classifyMail({ subject: "您的验证码", snippet: "订阅服务验证码 123456" }).billing);
check("安全提醒被排除", !M.classifyMail({ subject: "Security alert", snippet: "subscription" }).billing);
check("营销折扣被排除", !M.classifyMail({ subject: "50% off your subscription!", snippet: "" }).billing);
check("普通邮件不算", !M.classifyMail({ subject: "Lunch tomorrow?", snippet: "see you" }).billing);
check("只在摘要里提到但带金额 → 算", M.classifyMail({ subject: "Thanks!", snippet: "Your subscription payment of $9.99" }).billing);
const cx = M.classifyMail({ subject: "Your subscription has been canceled", snippet: "" });
check("取消通知识别为取消", cx.billing && cx.cancel);
check("主题选择器失效时用整行文字兜底", M.classifyMail({ subject: "", text: "Spotify Your receipt $11.99 Sep 3" }).billing);

console.log("== parseMailDate ==");
check("Gmail 中文 title", M.parseMailDate("2026年9月10日周四 上午10:23", NOW) === d(2026, 9, 10));
check("Gmail 英文 title", M.parseMailDate("Thu, Sep 10, 2026, 10:23 AM", NOW) === d(2026, 9, 10));
check("英式 10 Sep 2026", M.parseMailDate("Thu, 10 Sep 2026, 10:23", NOW) === d(2026, 9, 10));
check("单元格简写 9月10日 → 今年", M.parseMailDate("9月10日", NOW) === d(2026, 9, 10));
check("没写年份但比今天晚 → 去年", M.parseMailDate("12月5日", NOW) === d(2025, 12, 5));
check("Sep 10 简写", M.parseMailDate("Sep 10", NOW) === d(2026, 9, 10));
check("只有时间 → 今天", M.parseMailDate("上午10:23", NOW) === d(2026, 9, 23));
check("美式 9/10/25", M.parseMailDate("9/10/25", NOW) === d(2025, 9, 10));
check("2026/09/10", M.parseMailDate("2026/09/10", NOW) === d(2026, 9, 10));
check("非法日期返回 null", M.parseMailDate("2月30日", NOW) === null);
check("认不出返回 null（不瞎猜）", M.parseMailDate("前些天", NOW) === null);

console.log("== 周期 ==");
const monthly = [d(2026, 3, 5), d(2026, 4, 5), d(2026, 5, 5), d(2026, 6, 5), d(2026, 7, 5), d(2026, 8, 5), d(2026, 9, 5)];
check("每月", M.inferCadence(M.clusterEvents(monthly)).key === "monthly");
check("漏了一封收据仍认得出每月",
  M.inferCadence(M.clusterEvents([d(2026, 5, 5), d(2026, 6, 5), d(2026, 8, 5), d(2026, 9, 5)])).key === "monthly");
check("每年", M.inferCadence([d(2024, 9, 1), d(2025, 9, 1), d(2026, 9, 1)]).key === "yearly");
check("只有一次看不出周期", M.inferCadence([d(2026, 9, 1)]) === null);
check("不规律 → 不给周期", M.inferCadence([d(2026, 1, 1), d(2026, 1, 20), d(2026, 4, 2), d(2026, 4, 9)]) === null);
check("收据+发票同一天合并成一次", M.clusterEvents([d(2026, 9, 5), d(2026, 9, 5) + 3600e3, d(2026, 9, 6)]).length === 1);
const me = M.monthlyEquivalent({ currency: "$", value: 120 }, { key: "yearly" });
check("年费折月", me.value === 10);
check("周期不明不折算", M.monthlyEquivalent({ currency: "$", value: 9 }, null) === null);

console.log("== aggregateMails ==");
const rows = [];
monthly.forEach((t, i) => rows.push({
  email: "noreply@tm.openai.com", name: "OpenAI", subject: "Your ChatGPT Plus receipt",
  snippet: "Amount paid $20.00", date: new Date(t).toString(), ts: t, threadId: "o" + i }));
[d(2025, 9, 1), d(2026, 9, 1)].forEach((t, i) => rows.push({
  email: "billing@mail.notion.so", name: "Notion", subject: "Your Notion invoice",
  snippet: "Total $96.00", ts: t, threadId: "n" + i }));
rows.push({ email: "receipts+acct_1@stripe.com", name: "Raycast", subject: "Your receipt from Raycast", snippet: "$8.00", ts: d(2026, 9, 12) });
rows.push({ email: "receipts+acct_2@stripe.com", name: "Linear", subject: "Your receipt from Linear", snippet: "$10.00", ts: d(2026, 9, 14) });
rows.push({ email: "vip@iqiyi.com", name: "爱奇艺", subject: "会员自动续费成功", snippet: "扣款 ¥25", ts: d(2026, 6, 1) });
rows.push({ email: "vip@iqiyi.com", name: "爱奇艺", subject: "会员自动续费成功", snippet: "扣款 ¥25", ts: d(2026, 7, 1) });
rows.push({ email: "vip@iqiyi.com", name: "爱奇艺", subject: "您的会员自动续费已取消", snippet: "", ts: d(2026, 7, 10) });
rows.push({ email: "news@substack.com", name: "Some Newsletter", subject: "Weekly digest", snippet: "subscription", ts: d(2026, 9, 1) });
rows.push({ email: "no-reply@accounts.google.com", name: "Google", subject: "Security alert", snippet: "", ts: d(2026, 9, 2) });
// 以前每月扣费、最近两个多月没见到收据
[d(2026, 3, 3), d(2026, 4, 3), d(2026, 5, 3), d(2026, 6, 3)].forEach(t => rows.push({
  email: "billing@spotify.com", name: "Spotify", subject: "Your Spotify Premium receipt", snippet: "$11.99", ts: t }));

const agg = M.aggregateMails(rows, NOW);
const by = (n) => agg.candidates.find(c => c.name === n);
const oa = by("OpenAI");
check("OpenAI 归并成一个候选", !!oa && oa.mails === 7 && oa.domain === "openai.com");
check("OpenAI 每月、高可信", oa.cadence && oa.cadence.key === "monthly" && oa.confidence === "high");
check("OpenAI 金额 $20、月费 $20", oa.amount.value === 20 && oa.monthly.value === 20);
check("OpenAI 预计下次扣费约 10/5", Math.abs(oa.nextCharge - d(2026, 10, 5)) < 2 * DAY);
const no = by("Notion");
check("Notion 年付折成每月 $8", no.cadence.key === "yearly" && no.monthly.value === 8);
check("Stripe 代收的按商家分开", !!by("Raycast") && !!by("Linear") && by("Raycast").via === "stripe.com");
check("Stripe 代收的不把 stripe.com 当网址", by("Raycast").domain === "");
check("单次 + 有金额 = 中可信", by("Raycast").confidence === "medium");
check("最近一封是取消 → 标记可能已取消", by("爱奇艺").status === "cancelled" && !by("爱奇艺").nextCharge);
check("该扣没扣 → 标记近期没见到扣费", by("Spotify").status === "stale");
check("newsletter 和安全提醒不进候选", !by("Some Newsletter") && !by("Google"));
check("高可信排在前面", agg.candidates[0].confidence === "high");
check("统计收据类邮件数", agg.billingRows === rows.length - 2);
check("日期字符串也能用（没有 ts 时）",
  M.aggregateMails([{ email: "a@x.com", name: "X", subject: "Your receipt", snippet: "$5", date: "2026年9月1日周二 上午9:00" }], NOW)
    .candidates[0].last === d(2026, 9, 1));

console.log("== gmailSearchUrl ==");
check("第一页", M.gmailSearchUrl(0, "a b", 1) === "https://mail.google.com/mail/u/0/#search/a%20b");
check("翻页与账号序号", M.gmailSearchUrl(2, "a", 3) === "https://mail.google.com/mail/u/2/#search/a/p3");
check("默认搜索语句限定近一年", /newer_than:1y/.test(M.DEFAULT_QUERY));


console.log("== Gmail 接口模式：授权 ==");
check("Client ID 格式校验", M.isValidClientId("123-abc.apps.googleusercontent.com") && !M.isValidClientId("abc") && !M.isValidClientId(""));
const au = new URL(M.buildAuthUrl(" 123-abc.apps.googleusercontent.com ", "https://id.chromiumapp.org/", "st1"));
check("授权地址：隐式授权、只读权限、带 state",
  au.origin === "https://accounts.google.com" && au.searchParams.get("response_type") === "token" &&
  au.searchParams.get("scope") === "https://www.googleapis.com/auth/gmail.readonly" &&
  au.searchParams.get("state") === "st1" && au.searchParams.get("client_id") === "123-abc.apps.googleusercontent.com" &&
  au.searchParams.get("redirect_uri") === "https://id.chromiumapp.org/");
let pr = M.parseAuthRedirect("https://id.chromiumapp.org/#state=st1&access_token=ya29.x&token_type=Bearer&expires_in=3599&scope=https://www.googleapis.com/auth/gmail.readonly");
check("解析令牌", pr.token === "ya29.x" && pr.state === "st1" && pr.expiresIn === 3599 && /gmail\.readonly/.test(pr.scope));
pr = M.parseAuthRedirect("https://id.chromiumapp.org/?error=access_denied&state=st1");
check("解析 ? 里的错误", pr.error === "access_denied" && !pr.token);
pr = M.parseAuthRedirect("https://id.chromiumapp.org/#error=access_denied");
check("解析 # 里的错误", pr.error === "access_denied");

console.log("== Gmail 接口模式：邮件解析 ==");
check("From 头：带引号的显示名", JSON.stringify(M.parseFromHeader('"Netflix" <info@account.netflix.com>')) === JSON.stringify({ name: "Netflix", email: "info@account.netflix.com" }));
check("From 头：不带引号", M.parseFromHeader("OpenAI <noreply@tm.openai.com>").name === "OpenAI");
check("From 头：只有地址", M.parseFromHeader("billing@spotify.com").email === "billing@spotify.com");
const b64 = (t) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
check("中文发件人名（=?UTF-8?B?）", M.decodeMimeWords("=?UTF-8?B?" + b64("爱奇艺") + "?=") === "爱奇艺");
check("Q 编码", M.decodeMimeWords("=?utf-8?Q?Caf=C3=A9_Club?=") === "Café Club");
check("相邻编码词之间的空格去掉", M.decodeMimeWords("=?UTF-8?B?" + b64("会员") + "?= =?UTF-8?B?" + b64("续费") + "?=") === "会员续费");
check("HTML 实体", M.decodeEntities("You&#39;ve paid &yen;25 &amp; more") === "You've paid ¥25 & more");

const apiMsg = {
  id: "18a1", threadId: "t1", internalDate: String(d(2026, 9, 5)), snippet: "Amount paid &#36;20.00",
  payload: { headers: [
    { name: "From", value: '"OpenAI" <noreply@tm.openai.com>' },
    { name: "Subject", value: "Your ChatGPT Plus receipt" },
    { name: "Date", value: "Sat, 5 Sep 2026 10:00:00 +0000" }
  ] }
};
const ar = M.apiMessageToRow(apiMsg);
check("接口邮件 → 行：发件人/主题/时间/ID", ar.email === "noreply@tm.openai.com" && ar.name === "OpenAI" &&
  ar.subject === "Your ChatGPT Plus receipt" && ar.ts === d(2026, 9, 5) && ar.threadId === "18a1");
check("接口邮件 → 行：摘要实体解码后能读出金额", M.classifyMail(ar).amount && M.classifyMail(ar).amount.value === 20);
check("没有 internalDate 时退回 Date 头", M.apiMessageToRow({ id: "x", payload: { headers: [{ name: "Date", value: "Sat, 5 Sep 2026 10:00:00 +0000" }] } }).ts === Date.parse("Sat, 5 Sep 2026 10:00:00 +0000"));

const b64url = (t) => b64(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const full = { payload: { mimeType: "multipart/alternative", parts: [
  { mimeType: "text/html", body: { data: b64url("<html><style>.x{}</style><body><p>小计 ¥20.00</p><p>税费 ¥5.00</p><table><tr><td>实付金额</td><td>¥25.00</td></tr></table></body></html>") } }
] } };
const bt = M.messageBodyText(full);
check("HTML 正文转纯文本（去掉样式和标签）", /实付金额/.test(bt) && !/<|\.x\{/.test(bt));
check("正文金额优先取「实付」后面的", M.extractBodyAmount(bt).value === 25);
check("有 text/plain 时优先用它", M.messageBodyText({ payload: { parts: [
  { mimeType: "text/plain", body: { data: b64url("Total: $9.99") } },
  { mimeType: "text/html", body: { data: b64url("<b>other</b>") } }] } }) === "Total: $9.99");
check("英文 Total", M.extractBodyAmount("Subtotal $10.00\nTax $0.80\nTotal $10.80").value === 10.8);
check("没有关键词时退回第一个金额", M.extractBodyAmount("Thanks! You'll be billed €7.99 monthly").value === 7.99);

console.log("== 用正文金额补全候选 ==");
const lowRows = [{ email: "a@acme.io", name: "Acme", subject: "Your receipt", snippet: "Thanks for your purchase", ts: d(2026, 9, 1), threadId: "m1" }];
const low = M.aggregateMails(lowRows, NOW).candidates[0];
check("候选记下最近一封扣费邮件的 ID", low.latestId === "m1" && !low.amount && low.confidence === "low");
M.applyBodyAmount(low, { currency: "$", value: 12 });
check("补上金额后标记来源、可信度升为中", low.amount.value === 12 && low.amountFrom === "body" && low.confidence === "medium");
check("周期不明仍不折算月费", low.monthly === null);
const withCad = M.aggregateMails([d(2026, 7, 3), d(2026, 8, 3), d(2026, 9, 3)].map((t, i) => ({ email: "a@acme.io", name: "Acme", subject: "Your receipt", snippet: "", ts: t, threadId: "k" + i })), NOW).candidates[0];
check("多封时取最新那封的 ID", withCad.latestId === "k2");
M.applyBodyAmount(withCad, { currency: "$", value: 5 });
check("有周期时补金额后算出月费", withCad.monthly.value === 5);
const had = { amount: { currency: "$", value: 1 }, cadence: null, charges: 1, confidence: "medium" };
M.applyBodyAmount(had, { currency: "$", value: 99 });
check("已有金额不覆盖", had.amount.value === 1);

// ---------- 抓取函数：仿 Gmail 页面 ----------
async function domTests() {
  let JSDOM;
  try { ({ JSDOM } = require("jsdom")); } catch (e) {
    console.log("\n（未安装 jsdom，跳过页面抓取测试）");
    return;
  }
  console.log("== gmailExtractPage（仿 Gmail 结构） ==");
  const row = (i, email, name, subj, snip, title, extra = "") => `
    <tr class="zA zE" role="row">
      <td class="yX xY"><div class="yW"><span class="bA4"><span class="yP" email="${email}" name="${name}">${name}</span></span></div></td>
      <td class="xY a4W"><div class="xS"><div class="xT"><div class="y6"><span class="bog"><span data-thread-id="#thread-f:${i}">${subj}</span></span></div>
        <span class="y2"> - ${snip}</span></div></div>${extra}</td>
      <td class="xW xY"><span title="${title}"><span>9月${i}日</span></span></td>
    </tr>`;
  const html = (rowsHtml, hiddenRows = "") => `<!doctype html><html><head><title>搜索结果 - me@gmail.com - Gmail</title></head><body>
    <input name="q" value="receipt">
    <div role="main">
      <div style="display:none"><table><tbody>${hiddenRows}</tbody></table></div>
      <table role="grid"><tbody>${rowsHtml}</tbody></table>
    </div></body></html>`;

  const make = (h, url = "https://mail.google.com/mail/u/0/#search/receipt") => {
    const dom = new JSDOM(h, { url, runScripts: "outside-only" });
    dom.window.eval(SRC);
    return dom.window;
  };

  let w = make(html(
    row(1, "noreply@tm.openai.com", "OpenAI", "Your ChatGPT Plus receipt", "Amount paid $20.00", "2026年9月1日周二 上午9:00") +
    row(2, "billing@mail.notion.so", "Notion", "Your Notion invoice", "Total $96.00", "2026年9月2日周三 上午9:00", '<span class="bx0">3</span>'),
    row(9, "old@inbox.com", "Hidden", "should not be read", "", "2026年1月1日")
  ));
  let r = await w.MailLib.gmailExtractPage({ timeoutMs: 3000 });
  check("读到 2 行（隐藏视图里的不算）", r.rows.length === 2);
  check("发件人邮箱与显示名", r.rows[0].email === "noreply@tm.openai.com" && r.rows[0].name === "OpenAI");
  check("主题", r.rows[0].subject === "Your ChatGPT Plus receipt");
  check("摘要去掉开头的横杠", r.rows[0].snippet === "Amount paid $20.00");
  check("日期取 title 里的完整日期", r.rows[0].date === "2026年9月1日周二 上午9:00");
  check("会话 ID", r.rows[0].threadId === "#thread-f:1");
  check("会话里的邮件数", r.rows[1].threadCount === 3);
  check("从标题读出当前账号", r.account === "me@gmail.com");
  check("诊断统计", r.stats.rowEls === 2 && r.stats.withSender === 2 && r.stats.withDate === 2);
  check("没超时", r.timedOut === false && r.fp.length > 0);

  // 翻页：内容和上一页一样 → 超时返回同样的指纹，上层据此判断到底了
  r = await w.MailLib.gmailExtractPage({ timeoutMs: 1200, prevFp: r.fp });
  check("翻页后内容没变 → 超时且指纹不变", r.timedOut === true);

  // 自己回复过的会话：跳过自己，取对方为发件人
  w = make(html(`<tr class="zA"><td><span email="me@gmail.com" name="我">我</span>, <span email="billing@spotify.com" name="Spotify">Spotify</span></td>
    <td><span class="bog">Re: Your receipt</span></td><td class="xW"><span title="2026年9月3日">9月3日</span></td></tr>`));
  r = await w.MailLib.gmailExtractPage({ timeoutMs: 3000 });
  check("跳过自己，取对方为发件人", r.rows[0].email === "billing@spotify.com");

  // 无结果
  w = make(`<!doctype html><html><head><title>me@gmail.com</title></head><body><input name="q" value="x">
    <div role="main"><table><tr><td class="TC">没有符合搜索条件的邮件。</td></tr></table></div></body></html>`);
  r = await w.MailLib.gmailExtractPage({ timeoutMs: 3000 });
  check("识别「没有符合搜索条件的邮件」", r.noResults === true && r.rows.length === 0);

  // 未登录：被跳到 accounts.google.com
  w = make("<!doctype html><html><body>Sign in</body></html>", "https://accounts.google.com/v3/signin/identifier");
  r = await w.MailLib.gmailExtractPage({ timeoutMs: 1000 });
  check("跳到登录页 → 未登录", r.loggedOut === true);

  // 结构全变了：读不到行 → 超时、0 行（上层会报"读不到"而不是"没有订阅"）
  w = make(`<!doctype html><html><head><title>me@gmail.com</title></head><body><input name="q" value="x"><div role="main"><div class="new-list">...</div></div></body></html>`);
  r = await w.MailLib.gmailExtractPage({ timeoutMs: 1000 });
  check("页面结构变了 → 0 行且超时，不会当成「没有订阅」", r.rows.length === 0 && r.timedOut && !r.noResults);

  // 抓出来的行直接喂给归并，能得到候选
  w = make(html(row(1, "noreply@tm.openai.com", "OpenAI", "Your ChatGPT Plus receipt", "Amount paid $20.00", "2026年9月1日周二 上午9:00")));
  r = await w.MailLib.gmailExtractPage({ timeoutMs: 3000 });
  const c = M.aggregateMails(r.rows, NOW).candidates[0];
  check("端到端：页面 → 候选", c && c.name === "OpenAI" && c.amount.value === 20 && c.last === d(2026, 9, 1));
}

domTests().then(() => {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
