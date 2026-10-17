// 弹窗「邮箱发现」页的冒烟测试（需要 jsdom：NODE_PATH=<装了 jsdom 的目录>/node_modules node test_popup.js）
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const dir = __dirname;
const NOW = Date.now(), DAY = 86400000;
const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8").replace(/<script src=.*?<\/script>/g, "");
const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://x/popup.html" });
const w = dom.window;
const sent = [];
const mailScan = { status: "done", finishedAt: NOW, email: "me@gmail.com", pagesRead: 2, rowsRead: 80, billingRows: 12, account: 0, pages: 5,
  candidates: [
    { key: "openai.com", name: "OpenAI", domain: "openai.com", via: null, mails: 7, charges: 7, last: NOW - 18*DAY,
      cadence: { key: "monthly", label: "每月", unit: "月", days: 30.44 }, amount: { currency: "$", value: 20 }, monthly: { currency: "$", value: 20 },
      nextCharge: NOW + 12*DAY, status: "active", confidence: "high", samples: ["Your ChatGPT Plus receipt"] },
    { key: "notion.so", name: "Notion", domain: "notion.so", via: null, mails: 2, charges: 2, last: NOW - 22*DAY,
      cadence: { key: "yearly", label: "每年", unit: "年", days: 365.25 }, amount: { currency: "$", value: 96 }, monthly: { currency: "$", value: 8 },
      nextCharge: NOW + 340*DAY, status: "active", confidence: "high", samples: ["Your Notion invoice"] },
    { key: "stripe.com|raycast", name: "Raycast", domain: "", via: "stripe.com", viaName: "Stripe", mails: 1, charges: 1, last: NOW - 11*DAY,
      cadence: null, amount: { currency: "$", value: 8 }, monthly: null, nextCharge: null, status: "active", confidence: "medium", samples: ["<b>Your receipt</b>"] },
    { key: "apple.com|apple", name: "Apple", domain: "", via: "apple.com", viaName: "Apple", mails: 3, charges: 3, last: NOW - 5*DAY,
      cadence: null, amount: null, monthly: null, nextCharge: null, status: "active", confidence: "medium", samples: [] }
  ] };
function document_click(w, sel) { w.document.querySelector(sel).click(); }
const store = { subs: [{ id: "1", name: "Notion", urlPattern: "notion.so", mode: "browser", lastUsed: NOW },
  { id: "2", name: "百度网盘", catalogId: "baidu-pan", urlPattern: "pan.baidu.com", mode: "browser", lastUsed: NOW,
    account: { status: "ok", plan: { label: "超级会员 SVIP", paid: true }, storage: { pct: 2, label: "120 GB / 5 TB", totalGB: 5120 } } },
  { id: "3", name: "Spotify", catalogId: "spotify", urlPattern: "spotify.com", mode: "browser", lastUsed: NOW, account: { status: "logged_out" } }],
  records: [{ url: "https://www.netflix.com/browse", hostname: "www.netflix.com", time: NOW - DAY }], mailScan, mailIgnored: ["apple.com|apple"] };
w.chrome = {
  runtime: { sendMessage: (m, cb) => { sent.push(m); setTimeout(() => cb(m.type === "GET_STATE"
      ? { ok: true, ...store, lastCheck: null, paused: false, subLimit: 5, guestLimit: 5, auth: null, googleLogin: true, providers: [{ key: "youtube", name: "YouTube", verified: true, note: "" }], noActivityPage: [] }
      : { ok: true }), m.type === "CATALOG_ADD" ? 60 : 0); } },
  storage: { onChanged: { addListener() {} } },
  permissions: { request: async () => true, contains: async () => w.__has !== false },
  tabs: { create() {} },
  identity: { getRedirectURL: () => "https://abcdef.chromiumapp.org/" }
};
w.confirm = () => { throw new Error("不能用原生 confirm"); };
w.close = () => { w.__closed = (w.__closed || 0) + 1; };
w.Element.prototype.scrollIntoView = function () {};
Object.defineProperty(w.navigator, "language", { value: "zh-CN" });   // 这些用例按中文界面写；英文界面另有用例
w.eval(fs.readFileSync(path.join(dir, "i18n.js"), "utf8"));
w.eval(fs.readFileSync(path.join(dir, "i18n-en.js"), "utf8"));
w.eval(fs.readFileSync(path.join(dir, "lib.js"), "utf8"));
w.eval(fs.readFileSync(path.join(dir, "catalog.js"), "utf8"));
w.eval(fs.readFileSync(path.join(dir, "auth.js"), "utf8"));
w.eval(fs.readFileSync(path.join(dir, "sync.js"), "utf8"));
w.eval(fs.readFileSync(path.join(dir, "popup.js"), "utf8"));
setTimeout(async () => {
  const $ = (id) => w.document.getElementById(id);
  const list = $("m-list").innerHTML, ok = [];
  const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) process.exitCode = 1; };
  t("渲染 3 个候选（Apple 已忽略）", $("m-list").querySelectorAll(".sub").length === 3);
  t("已忽略提示", /已忽略 1 项/.test($("m-hidden").textContent));
  t("Notion 已在订阅中、没有添加按钮", /已在订阅中/.test(list) && !$("m-list").querySelector('[data-madd="notion.so"]'));
  t("年付显示折算", /\$96 \/ 年（约 \$8\/月）/.test($("m-list").textContent));
  t("主题做了转义", list.includes("&lt;b&gt;Your receipt"));
  t("摘要", /读了 2 页、80 封/.test($("m-summary").textContent));
  $("m-list").querySelector('[data-madd="openai.com"]').click();
  t("没收录的服务点「添加网址」→ 填进手动添加表单", !$("view-add").hidden && $("view-subs").hidden && /添加网址/.test($("m-list").textContent));
  t("表单预填名称/网址/月费", $("f-name").value === "OpenAI" && $("f-url").value === "openai.com" && $("f-price").value === "20");
  t("预填提示显示", !$("prefillNote").hidden);
  $("m-list").querySelector('[data-madd="stripe.com|raycast"]').click();
  t("周期不明 → 月费留空并提示", $("f-price").value === "" && /看不出扣费周期/.test($("prefillNote").textContent) && /Stripe/.test($("prefillNote").textContent));
  $("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  t("没有网址不能添加（靠网址统计访问）", !sent.some(m => m.type === "SAVE_SUB") && /请填网址/.test($("formErr").textContent));
  $("f-url").value = "raycast.com";
  $("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  const save = sent.find(m => m.type === "SAVE_SUB");
  t("保存时带上币种与 id", save && save.sub.currency === "$" && save.sub.id && save.sub.id !== "undefined");
  w.document.querySelector('.tab[data-view="add"]').click();
  t("手动打开添加页会清掉预填提示", $("prefillNote").hidden && $("f-name").value === "");
  t("添加页包含四种方式：常见服务 / 浏览记录发现 / 邮箱发现 / 手动添加", !!$("sec-known") && !!$("sec-history") && !!$("sec-mail") && !!$("sec-manual") && !w.document.querySelector('[data-view="mail"]'));
  $("f-url").value = "netflix.com"; $("f-url").dispatchEvent(new w.Event("input"));
  t("手动填的网址是收录服务 → 提示用常见服务添加", !$("catalogHint").hidden && /Netflix/.test($("catalogHint").textContent));
  $("f-url").value = "mymagicapp.io"; $("f-url").dispatchEvent(new w.Event("input")); $("f-name").value = ""; $("f-url").dispatchEvent(new w.Event("blur"));
  t("没收录的网址：不提示，名称自动填域名", $("catalogHint").hidden && $("f-name").value === "Mymagicapp");
  t("月费旁边有币种可选（人民币 / 美元 / 港币…）", $("f-currency").tagName === "SELECT" && [...$("f-currency").options].map(o => o.value).join(",").indexOf("¥,$,HK$") === 0);
  $("f-currency").value = "HK$"; $("f-price").value = "38";
  sent.length = 0;
  $("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  const sv = sent.find(m => m.type === "SAVE_SUB");
  t("手动添加：浏览器访问型，只统计访问", sv && sv.sub.mode === "browser" && sv.sub.urlPattern === "mymagicapp.io");
  t("保存时带上选的币种", sv && sv.sub.currency === "HK$" && sv.sub.price === 38);
  w.resetForm({ id: "x9", name: "爱奇艺", catalogId: "iqiyi", urlPattern: "iqiyi.com", price: 25 });
  t("编辑收录的国内服务：币种默认人民币", $("f-currency").value === "¥");
  w.resetForm({ id: "x8", name: "Foo", urlPattern: "foo.com", price: 5, currency: "€" });
  t("编辑时显示订阅原来的币种", $("f-currency").value === "€");
  w.resetForm();
  w.document.querySelector('.tab[data-view="add"]').click();
  $("m-scan").click();
  await new Promise(r => setTimeout(r, 20));
  const st = sent.find(m => m.type === "MAIL_SCAN_START");
  t("扫描按钮发出开始消息（只有网页方式）", st && st.pages === "5" && st.account === "0" && !st.source && !st.clientId);
  t("没有 Gmail 接口模式的选项了", !$("m-source") && !$("m-client"));

  // 常见服务
  t("从浏览记录发现：最近访问过 Netflix → 添加按钮", /Netflix/.test($("discList").textContent) && !!$("discList").querySelector('[data-cat="netflix"]'));
  const cards = $("catGrid").querySelectorAll(".ad-card");
  t("目录列出全部服务，已添加的标记为已添加", cards.length === 29 && $("catGrid").querySelectorAll(".ad-card.added").length === 2);
  t("分类标签：全部 + 4 类", $("catCats").querySelectorAll("span").length === 5);
  $("catCats").querySelectorAll("span")[3].click();
  t("点分类只显示该类", !/Netflix/.test($("catGrid").textContent) && /爱奇艺/.test($("catGrid").textContent));
  $("catCats").querySelectorAll("span")[0].click();
  $("catSearch").value = "网盘"; $("catSearch").dispatchEvent(new w.Event("input"));
  t("按分类名/名字搜索", /百度网盘/.test($("catGrid").textContent));
  t("顶部四个标签：我的订阅 / 邮箱发现 / 历史发现 / 手动添加", [...w.document.querySelectorAll("nav.tabs .tab > span")].map(x => x.textContent.trim()).join("|") === "我的订阅|邮箱发现|历史发现|手动添加");
  w.document.querySelector('.tab[data-pane="mail"]').click();
  t("切到邮箱发现：只显示邮箱分页，标签高亮", !$("sec-mail").hidden && $("sec-known").hidden && w.document.querySelector('.tab[data-pane="mail"]').classList.contains("on"));
  w.document.querySelector('.tab[data-pane="manual"]').click();
  t("手动添加 = 常见服务 + 手动填网址", !$("sec-known").hidden && !$("sec-manual").hidden && $("sec-mail").hidden);
  $("catSearch").value = "zzzunknown"; $("catSearch").dispatchEvent(new w.Event("input"));
  w.document.querySelector('#catGrid [data-goto="manual"]').click();
  t("搜不到 → 一键转到手动添加并带上搜索词", !$("sec-manual").hidden && $("f-url").value === "zzzunknown");
  w.document.querySelector('.tab[data-pane="manual"]').click();
  const sub2 = $("subList").innerHTML;
  {
    const btn = () => $("subList").querySelector('[data-cdiag="2"]');
    t("平时没有「诊断」按钮", !btn() && !/>诊断</.test($("subList").innerHTML));
    sent.length = 0;
    $("subList").querySelector('[data-chk="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true, altKey: true }));
    await new Promise(r => setTimeout(r, 30));
    const opened = !!$("subList").querySelector(".cdiag") && btn() && btn().textContent === "收起诊断";
    t("按住 Alt 点「检查」= 诊断：发 CATALOG_DIAGNOSE，不发 RUN_CHECK", opened && sent.some(m => m.type === "CATALOG_DIAGNOSE") && !sent.some(m => m.type === "RUN_CHECK"));
    btn().click(); await new Promise(r => setTimeout(r, 10));
    t("诊断结果可以收起，收起后按钮也消失", !$("subList").querySelector(".cdiag") && !btn());
    sent.length = 0;
    $("subList").querySelector('[data-chk="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    t("普通点「检查」照常检查", sent.some(m => m.type === "RUN_CHECK"));
  }
  {
    const cap = w.subCaption;
    t("列表小字：Claude 显示套餐和本周额度", cap({ provider: "claude", llm: { plan: { label: "Pro" }, usage: { fiveHour: 62, week: 47 } } }) === "Pro · 本周额度 47%");
    t("列表小字：ChatGPT 没有额度时显示近 7 天对话数", cap({ provider: "chatgpt", llm: { plan: { label: "Free" }, stats: { convs7: 0 } } }) === "Free · 近 7 天 0 个对话");
    t("列表小字：Netflix 显示套餐和续费日", /^Standard · \d\d\/\d\d 续费$/.test(cap({ catalogId: "netflix", account: { status: "ok", plan: { label: "Standard" }, renewAt: Date.now() + 5 * DAY } })));
    t("列表小字：没登录读不到时退回分类", cap({ catalogId: "netflix", account: { status: "logged_out", plan: { label: "Standard" } } }) === "影音娱乐");
  }
  {
    const vs = { last: Date.now(), d7: 27, d30: 92 };
    const W = Date.now() - 5 * DAY;
    const h1 = w.usageCells({ mode: "activity", provider: "youtube", lastUsed: W, lastWatched: W, sig: "a", signal: { ok: true } }, vs, false);
    t("视频类：「最近使用 5 天前 · 按观看记录」和「最近访问 今天 · 打开网站」分开显示", /最近使用<\/span><b>5 天前<\/b><small>按观看记录/.test(h1) && /最近访问<\/span><b>今天<\/b><small>打开网站/.test(h1) && /近 7 天访问/.test(h1));
    const h2 = w.usageCells({ provider: "claude", llm: {}, lastUsed: Date.now() }, vs, true);
    t("大模型：最近使用按对话记录", /按对话记录/.test(h2));
    const h3 = w.usageCells({ mode: "browser", urlPattern: "x.com", lastUsed: Date.now() }, vs, false);
    t("手动网址：最近使用按浏览器访问", /按浏览器访问/.test(h3));
  }
  t("网盘：列表里直接显示空间用量", /空间 120 GB \/ 5 TB · 2%/.test(sub2));
  t("账户信息：套餐 + 空间 + 降档建议", /超级会员 SVIP/.test(sub2) && /120 GB/.test(sub2) && /换小一档/.test(sub2));
  t("未登录：提示不代表没在用，给「打开账户页」", /不代表你没在用/.test(sub2) && /data-copen="3"/.test(sub2));
  sent.length = 0;
  $("catSearch").value = ""; $("catSearch").dispatchEvent(new w.Event("input"));
  $("catGrid").querySelector('[data-cat="netflix"]').click();
  await new Promise(r => setTimeout(r, 20));
  t("添加中：卡片转圈显示「正在读取…」，底部有加载提示", !!$("catGrid").querySelector(".ad-card.busy") && /正在读取/.test($("catGrid").textContent) &&
    $("busyToast") && !$("busyToast").hidden && /正在添加 Netflix/.test($("busyToast").textContent));
  await new Promise(r => setTimeout(r, 100));
  t("添加完：卡片恢复，提示换成结果", !$("catGrid").querySelector(".ad-card.busy") && /Netflix/.test($("busyToast").textContent) && !/正在添加/.test($("busyToast").textContent));
  t("点服务名：申请权限后发 CATALOG_ADD", sent.some(m => m.type === "CATALOG_ADD" && m.id === "netflix"));
  t("已经有权限：不弹授权，也不用登记，直接添加", !sent.some(m => m.type === "PENDING_GRANT" || m.type === "OPEN_GRANT_WINDOW"));
  // 登录
  t("未登录：顶部显示「登录」，订阅数显示 3/5", /登录/.test($("acct").textContent) && $("cnt").textContent === "3/5");
  t("没满 5 个不显示上限提示", $("limitBar").hidden);
  $("acct").querySelector("[data-login]").click();
  t("点登录打开登录页", !$("view-auth").hidden && $("view-subs").hidden);
  $("a-email").value = "bad"; $("a-pass").value = "12345678";
  $("authForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  t("邮箱格式不对在本地提示", !$("authErr").hidden && /邮箱/.test($("authErr").textContent));
  document_click(w, '[data-amode="up"]');
  $("a-email").value = "me@example.com"; $("a-pass").value = "12345678"; $("a-pass2").value = "12345679";
  $("authForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  t("注册时两次密码不一致提示", /不一样/.test($("authErr").textContent));
  sent.length = 0;
  $("a-pass2").value = "12345678";
  $("authForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await new Promise(r => setTimeout(r, 80));
  t("注册发 AUTH_SIGN_UP，回到原来的页面", sent.some(m => m.type === "AUTH_SIGN_UP" && m.email === "me@example.com" && m.name === "") && $("view-auth").hidden);
  $("acct").querySelector("[data-login]").click();
  t("开了 Google 登录：登录页顶部显示 Google 按钮", !$("authSocial").hidden);
  sent.length = 0;
  $("authGoogle").click();
  await new Promise(r => setTimeout(r, 20));
  t("点 Google 按钮发 AUTH_GOOGLE", sent.some(m => m.type === "AUTH_GOOGLE"));
  w.document.querySelector("#authForgot").click();
  t("忘记密码：只留邮箱和说明，不显示密码框和提交按钮", $("a-pass-wrap").hidden && $("authSubmit").hidden && !$("forgotInfo").hidden && $("authTitle").textContent === "忘记密码");
  w.document.querySelector('#authFooter [data-amode="in"]').click();
  w.document.querySelector('[data-eye="a-pass"]').click();
  t("点眼睛图标显示密码，再点隐藏", $("a-pass").type === "text" && (w.document.querySelector('[data-eye="a-pass"]').click(), $("a-pass").type === "password"));
  $("authCancel").click();

  t("没登录时不显示云端同步栏", $("syncBar").hidden);
  t("订阅列表：表格行（产品 / 费用 / 最近使用 / 状态）", $("subList").querySelectorAll(".sv-row").length === 3 && !!$("subList").querySelector(".sv-status") && !!w.document.querySelector(".sv-thead"));
  t("详情默认收起", !$("subList").querySelector(".sv-row.open"));
  $("subList").querySelector(".sv-main .sv-prod b").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  t("点一行展开详情：访问指标和操作按钮", !!$("subList").querySelector(".sv-row.open") && /近 7 天/.test($("subList").querySelector(".sv-row.open").textContent));
  $("subList").querySelector('.sv-row.open .sv-icon[data-edit] svg').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  t("点到图标里的 svg 也能打开编辑", !$("view-add").hidden && $("view-add").classList.contains("editing"));
  $("cancel").click();
  $("subList").querySelector('[data-edit="2"]').click();
  t("编辑收录服务：网址锁定并说明原因", $("f-url").readOnly && !$("urlLock").hidden && /pan\.baidu\.com/.test($("f-url").value) && /固定/.test($("urlLock").textContent));
  sent.length = 0;
  $("f-name").value = "网盘"; $("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  const svk = sent.find(m => m.type === "SAVE_SUB");
  t("保存收录服务：网址保持原样，只改名称等", svk && svk.sub.urlPattern === "pan.baidu.com" && svk.sub.name === "网盘");
  $("subList").querySelector('[data-edit="1"]').click();
  t("编辑手动添加的网址：可以改", !$("f-url").readOnly && $("urlLock").hidden && $("f-url").value === "notion.so");
  $("cancel").click();
  { const d = new Date(); d.setHours(9, 5, 0, 0); const y = new Date(d.getTime() - 86400000);
    t("当天检查显示时分", w.fmtCheck(d.getTime()) === "今天 09:05" && w.fmtCheck(y.getTime()) === "昨天 09:05"); }
  sent.length = 0;
  $("subList").querySelector('[data-del="1"]').click();
  await new Promise(r => setTimeout(r, 10));
  const dlg = w.document.querySelector(".dlg-mask");
  t("删除：弹出插件内的确认框（不用原生 confirm）", !!dlg && /删除「Notion」/.test(dlg.textContent));
  [...dlg.querySelectorAll(".dlg-btn")].find(b => b.textContent === "取消").click();
  await new Promise(r => setTimeout(r, 10));
  t("点取消：关闭确认框，不删除", !w.document.querySelector(".dlg-mask") && !sent.some(m => m.type === "DELETE_SUB"));
  $("subList").querySelector('[data-del="1"]').click();
  await new Promise(r => setTimeout(r, 10));
  w.document.querySelector(".dlg-btn.danger").click();
  await new Promise(r => setTimeout(r, 20));
  t("点删除：发送 DELETE_SUB", sent.some(m => m.type === "DELETE_SUB" && m.id === "1") && !w.document.querySelector(".dlg-mask"));
  // 手动排序：点「排序」进入排序模式
  const rowIds = (sel) => [...$("subList").querySelectorAll(sel)].map(r => r.dataset.id);
  const order0 = rowIds(".sv-row");
  t("平时列表里没有拖动手柄，表头有「排序」按钮", !$("subList").querySelector("[data-grip]") && !!$("sortToggle") && $("sortBar").hidden);
  $("sortToggle").click();
  t("点「排序」：进入排序模式，每行有手柄和上移 / 下移 / 置顶", !$("sortBar").hidden && $("subList").querySelectorAll(".sv-srow [data-grip]").length === 3 &&
    $("subList").querySelectorAll('[data-mv="top"]').length === 3 && rowIds(".sv-srow").join(",") === order0.join(","));
  t("没排过时不显示「恢复自动排序」；第一行不能上移", $("sortReset").hidden && $("subList").querySelector('[data-mv="up"]').disabled);
  sent.length = 0;
  const lastId = order0[order0.length - 1];
  $("subList").querySelector(`[data-mv="top"][data-id="${lastId}"]`).click();
  await new Promise(r => setTimeout(r, 20));
  let so = sent.find(m => m.type === "SET_ORDER");
  t("置顶：最后一项移到第一并保存", rowIds(".sv-srow")[0] === lastId && so && so.ids[0] === lastId);
  sent.length = 0;
  $("subList").querySelector(`[data-mv="down"][data-id="${lastId}"]`).click();
  await new Promise(r => setTimeout(r, 20));
  t("下移一位", rowIds(".sv-srow")[1] === lastId && sent.some(m => m.type === "SET_ORDER"));
  const grip = [...$("subList").querySelectorAll("[data-grip]")].find(g => g.dataset.grip === lastId);
  grip.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  t("选中手柄按 ↑ 也能移动", rowIds(".sv-srow")[0] === lastId);
  t("排过之后显示「恢复自动排序」", !$("sortReset").hidden);
  $("sortDone").click();
  t("点「完成」：回到正常列表，按排好的顺序显示", $("sortBar").hidden && rowIds(".sv-row")[0] === lastId && !$("subList").querySelector("[data-grip]"));
  $("sortToggle").click();
  sent.length = 0;
  $("sortReset").click();
  await new Promise(r => setTimeout(r, 20));
  $("sortDone").click();
  t("恢复自动排序：发 SET_ORDER null，回到原来的顺序", sent.some(m => m.type === "SET_ORDER" && m.ids === null) && rowIds(".sv-row").join(",") === order0.join(","));
  t("没授权浏览历史：显示读取按钮", !!$("histOn"));
  // 工具栏弹窗里没有权限：登记后打开独立授权小窗口，弹窗自己关掉（不在弹窗里弹授权框）
  sent.length = 0; w.__has = false; w.__closed = 0;
  $("histOn").click();
  await new Promise(r => setTimeout(r, 30));
  t("没权限：先登记，再打开授权小窗口，并关掉弹窗", sent[0] && sent[0].type === "PENDING_GRANT" && sent[0].permissions[0] === "history" &&
    sent.some(m => m.type === "OPEN_GRANT_WINDOW") && w.__closed === 1 && !sent.some(m => m.type === "HISTORY_SCAN"));
  // 已经有权限：直接继续，不弹窗口
  sent.length = 0; w.__has = true;
  $("histOn").click();
  await new Promise(r => setTimeout(r, 30));
  t("已有权限：直接读取，不开小窗口", sent.some(m => m.type === "HISTORY_SCAN") && !sent.some(m => m.type === "OPEN_GRANT_WINDOW"));

  const mf = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  t("点图标打开侧边栏：manifest 配了 side_panel，没有 default_popup", mf.side_panel && /panel=1/.test(mf.side_panel.default_path) && !mf.action.default_popup && mf.permissions.includes("sidePanel"));
  // 授权小窗口（popup.html?win=1&grant=1）
  const dom2 = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://x/popup.html?win=1&grant=1" });
  const w2 = dom2.window, sent2 = [];
  let reqArg = null;
  w2.chrome = {
    runtime: { sendMessage: (m, cb) => { sent2.push(m); setTimeout(() => cb(m.type === "GET_STATE"
        ? { ok: true, ...store, lastCheck: null, paused: false, subLimit: 5, guestLimit: 5, auth: null, googleLogin: true, providers: [], noActivityPage: [],
            pendingGrant: { action: "catalog", id: "netflix", origins: ["https://netflix.com/*"], permissions: [], at: Date.now() } }
        : { ok: true }), 0); } },
    storage: { onChanged: { addListener() {} } },
    permissions: { request: async (q) => { reqArg = q; return true; }, contains: async () => false },
    tabs: { create() {} }, identity: { getRedirectURL: () => "https://abcdef.chromiumapp.org/" }
  };
  w2.close = () => { w2.__closed = 1; };
  w2.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(w2.navigator, "language", { value: "zh-CN" });
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "catalog.js", "auth.js", "sync.js", "popup.js"]) w2.eval(fs.readFileSync(path.join(dir, f), "utf8"));
  await new Promise(r => setTimeout(r, 60));
  const dlg2 = w2.document.querySelector(".dlg-mask");
  t("授权小窗口：说明要授权什么，有「继续授权」", !!dlg2 && /Netflix/.test(dlg2.textContent) && /继续授权/.test(dlg2.textContent) && !w2.document.getElementById("view-add").hidden);
  w2.document.querySelector(".dlg-btn.primary").click();
  await new Promise(r => setTimeout(r, 40));
  t("点「继续授权」：在小窗口里申请权限，授权后让后台接着做，窗口不关", reqArg && reqArg.origins[0] === "https://netflix.com/*" &&
    sent2.some(m => m.type === "PENDING_GRANT" && m.inWindow) && sent2.some(m => m.type === "RESUME_PENDING") && !w2.__closed);

  // 英文界面：浏览器语言不是中文时默认英文
  const dom3 = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://x/popup.html?panel=1" });
  const w3 = dom3.window;
  w3.chrome = {
    runtime: { sendMessage: (m, cb) => setTimeout(() => cb(m.type === "GET_STATE"
        ? { ok: true, ...store, lastCheck: Date.now(), paused: false, subLimit: 5, guestLimit: 5, auth: null, googleLogin: true, providers: [], noActivityPage: [] }
        : { ok: true }), 0) },
    storage: { onChanged: { addListener() {} } },
    permissions: { request: async () => true, contains: async () => true },
    tabs: { create() {} }, identity: { getRedirectURL: () => "https://abcdef.chromiumapp.org/" }
  };
  w3.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(w3.navigator, "language", { value: "en-US" });
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "catalog.js", "auth.js", "sync.js", "popup.js"]) w3.eval(fs.readFileSync(path.join(dir, f), "utf8"));
  await new Promise(r => setTimeout(r, 80));
  const txt3 = w3.document.body.textContent;
  t("英文浏览器：界面默认英文，没有残留中文", w3.I18N.getLang() === "en" && /My subscriptions/.test(txt3) && w3.document.documentElement.lang === "en" &&
    w3.I18N.missing.size === 0 || (console.log("  未翻译：", [...w3.I18N.missing]), false));
  t("英文界面：语言按钮显示「中」可切回中文", w3.document.getElementById("langToggle").textContent.trim() === "中");
}, 50);
