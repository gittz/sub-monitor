const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopup, delay } = require("./tests/popup-fixture");

test("游客可从顶部菜单发邮件反馈，不要求登录", async t => {
  const ui = await createPopup(t);
  assert.ok(ui.$("#accountMenuButton"), "顶部应提供反馈菜单入口");
  ui.$("#accountMenuButton").click();
  assert.equal(ui.$("#accountMenuPanel").hidden, false);
  const email = new URL(ui.$("#feedbackEmailLink").href);
  assert.equal(email.protocol, "mailto:");
  assert.equal(email.pathname, "jiago12345@gmail.com");
  assert.match(ui.$("#accountMenuPanel").textContent, /jiago12345@gmail.com/);
  assert.equal(ui.$("#copyFeedbackEmail"), null, "不再提供复制按钮（不申请剪贴板权限）");
  assert.ok(ui.$("#acct [data-login]"));
});

test("账号菜单支持 Escape 和外部点击关闭，退出仍需确认", async t => {
  const ui = await createPopup(t, { auth: {user: {name: "王", email: "test@example.com"}} });
  assert.ok(ui.$("#accountMenuButton"), "头像应是菜单按钮");
  ui.$("#accountMenuButton").click();
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
  assert.equal(ui.$("#accountMenuPanel").hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$("#accountMenuButton"));
  ui.$("#accountMenuButton").click(); ui.$("nav").click();
  assert.equal(ui.$("#accountMenuPanel").hidden, true);
  ui.$("#accountMenuButton").click(); ui.$("#signOut").click();
  assert.ok(ui.$(".dlg-mask"));
  ui.$(".dlg-btn:not(.primary)").click();
  assert.equal(ui.messages.some(message => message.type === "AUTH_SIGN_OUT"), false);
  ui.$("#accountMenuButton").click(); ui.$("#signOut").click();
  ui.$(".dlg-btn.primary").click(); await delay(60);
  assert.equal(ui.store.auth, null);
  assert.ok(ui.$("#acct [data-login]"));
});

test("在菜单里按下链接时焦点短暂离开，不能把菜单收起（否则点击会丢）", async t => {
  const ui = await createPopup(t);
  ui.$("#accountMenuButton").click();
  const link = ui.$("#feedbackEmailLink"), btn = ui.$("#accountMenuButton");
  btn.focus();
  btn.dispatchEvent(new ui.window.FocusEvent("focusout", { bubbles: true, relatedTarget: link }));
  await delay(5);
  assert.equal(ui.$("#accountMenuPanel").hidden, false, "焦点转到菜单内的链接时不收起");
});
