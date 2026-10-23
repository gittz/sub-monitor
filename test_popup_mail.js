const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopup, delay, mailScan, candidate } = require("./tests/popup-fixture");

async function openMail(test, subscriptionCandidate, options = {}, overrides = {}) {
  const ui = await createPopup(test, {mailScan: mailScan([subscriptionCandidate]), ...overrides}, options);
  ui.$('[data-pane="mail"].tab').click();
  return ui;
}

test("邮箱中有网址的候选直接加入订阅，保留月费与币种，不跳手动页", async t => {
  const ui = await openMail(t, candidate());
  ui.$("[data-madd]").click(); await delay(100);
  assert.equal(ui.store.subs.length, 1, "点击应直接持久化订阅");
  const sub = ui.store.subs[0];
  assert.equal(sub.urlPattern, "cloudflare.com"); assert.equal(sub.price, 10); assert.equal(sub.currency, "$");
  assert.equal(sub.mode, "browser"); assert.equal(sub.idleDays, 30);
  assert.equal(ui.$("#sec-mail").hidden, false);
  assert.equal(ui.$("#sec-manual").hidden, true);
  assert.match(ui.$("#m-list").textContent, /已在订阅中/);
  assert.equal(ui.$("[data-madd]"), null);
  assert.notEqual(ui.window.document.activeElement, ui.window.document.body);
});

test("未知周期不猜月费，连续点击只保存一次", async t => {
  const ui = await openMail(t, candidate({cadence: null, monthly: null, amount: {currency: "HK$", value: 90}}));
  const button = ui.$("[data-madd]"); button.click(); button.click(); await delay(100);
  assert.equal(ui.store.subs.length, 1);
  assert.equal(ui.store.subs[0].price, 0); assert.equal(ui.store.subs[0].currency, "HK$");
  assert.equal(ui.messages.filter(message => message.type === "SAVE_SUB").length, 1);
});

test("无商家网址的候选在原页补填名称网址，取消不添加，非法网址不能保存", async t => {
  const ui = await openMail(t, candidate({domain: "", key: "paypal|merchant", name: "PayPal", viaName: "PayPal"}));
  ui.$("[data-madd]").click(); await delay();
  assert.ok(ui.$("#mailCandidateForm"), "应在当前页展示补填弹窗");
  assert.equal(ui.$("#sec-mail").hidden, false);
  ui.$("#mailCandidateCancel").click(); await delay();
  assert.equal(ui.store.subs.length, 0);
  ui.$("[data-madd]").click(); await delay();
  ui.$("#mailCandidateUrl").value = "javascript:alert(1)";
  ui.$("#mailCandidateForm").dispatchEvent(new ui.window.Event("submit", {bubbles: true, cancelable: true}));
  assert.match(ui.$("#mailCandidateError").textContent, /网址/);
  assert.equal(ui.store.subs.length, 0);
  ui.$("#mailCandidateName").value = "Namecheap"; ui.$("#mailCandidateUrl").value = "https://www.namecheap.com/account";
  ui.$("#mailCandidateForm").dispatchEvent(new ui.window.Event("submit", {bubbles: true, cancelable: true}));
  await delay(100);
  assert.equal(ui.store.subs[0].urlPattern, "namecheap.com"); assert.equal(ui.store.subs[0].name, "Namecheap");
});

test("后台拒绝超限时不显示添加成功，候选仍可重试", async t => {
  const ui = await openMail(t, candidate(), {saveReply: {ok: false, reason: "limit", limit: 5}});
  ui.$("[data-madd]").click(); await delay(100);
  assert.equal(ui.store.subs.length, 0);
  assert.match(ui.$("#m-add-status")?.textContent || "", /上限|登录|5/);
  assert.ok(ui.$("[data-madd]"));
  assert.equal(ui.$("#sec-mail").hidden, false);
});

test("保存失败不产生假成功，显示可见错误", async t => {
  const ui = await openMail(t, candidate(), {saveReply: {ok: false, error: "Storage unavailable"}});
  ui.$("[data-madd]").click(); await delay(100);
  assert.equal(ui.store.subs.length, 0);
  assert.match(ui.$("#m-add-status")?.textContent || "", /失败/);
  assert.ok(ui.$("[data-madd]"));
});

test("已收录服务继续走原目录添加和权限流程", async t => {
  const ui = await openMail(t, candidate({key: "youtube", name: "YouTube", domain: "youtube.com"}));
  ui.$("[data-madd]").click(); await delay(100);
  assert.equal(ui.messages.filter(message => message.type === "CATALOG_ADD").length, 1);
  assert.equal(ui.messages.some(message => message.type === "SAVE_SUB"), false);
  assert.equal(ui.store.subs[0].catalogId, "youtube");
  assert.notEqual(ui.window.document.activeElement, ui.window.document.body);
  assert.equal(ui.$("#sec-mail").hidden, false);
});

test("已添加域名和达到游客上限时不重复保存", async t => {
  const ui = await openMail(t, candidate(), {}, {subs: [{id: "old", name: "Cloudflare", urlPattern: "cloudflare.com", mode: "browser"}]});
  assert.equal(ui.$("[data-madd]"), null);
  ui.store.subs = Array.from({length: 5}, (_, i) => ({id: String(i), name: "Service" + i, mode: "browser", urlPattern: `s${i}.com`}));
  await ui.window.refresh();
  ui.$("[data-madd]").click(); await delay(100);
  assert.equal(ui.messages.some(message => message.type === "SAVE_SUB"), false);
  assert.match(ui.$("#m-add-status")?.textContent || "", /上限|登录|5/);
});

test("补填商家后标记原候选已添加，重复点击不会再次保存", async t => {
  const ui = await openMail(t, candidate({domain: "", name: "PayPal"}));
  ui.$("[data-madd]").click(); await delay();
  ui.$("#mailCandidateName").value = "Namecheap";
  ui.$("#mailCandidateUrl").value = "namecheap.com";
  ui.$("#mailCandidateForm").dispatchEvent(new ui.window.Event("submit", {bubbles: true, cancelable: true}));
  await delay(100);
  assert.equal(ui.store.subs.length, 1);
  assert.equal(ui.$("[data-madd]"), null);
  assert.match(ui.$("#m-list").textContent, /已在订阅中/);
});

test("键盘取消补填后，焦点回到候选添加按钮", async t => {
  const ui = await openMail(t, candidate({domain: "", name: "PayPal"}));
  ui.$("[data-madd]").focus(); ui.$("[data-madd]").click(); await delay();
  ui.$("#mailCandidateUrl").dispatchEvent(new ui.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
  await delay();
  assert.equal(ui.$("#mailCandidateForm"), null);
  assert.equal(ui.window.document.activeElement, ui.$("[data-madd]"));
});
