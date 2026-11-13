const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopup, delay } = require("./tests/popup-fixture");

test("云同步位于顶部账号前，简洁显示状态并保留立即同步", async t => {
  const ui = await createPopup(t, { auth: { user: { name: "王" } },
    sync: { enabled: true, lastSyncAt: Date.now() } });
  const sync = ui.$("#syncBar");
  assert.equal(sync.closest("header"), ui.$("header"));
  assert.equal(sync.nextElementSibling, ui.$("#acct"));
  assert.match(sync.textContent, /云同步/);
  assert.doesNotMatch(sync.textContent, /云端同步：已开启|关闭/);
  assert.equal(ui.$("#syncOff"), null);
  assert.equal(ui.$("#syncRun").getAttribute("aria-label"), "立即同步");
  ui.$("#syncRun").click();
  assert.match(sync.textContent, /正在同步/);
  await delay(60);
  assert.equal(ui.messages.filter(message => message.type === "SYNC_NOW").length, 1);
  assert.ok(ui.$("#syncRun"));
});

test("云同步隐藏于游客，关闭状态仍可开启", async t => {
  const guest = await createPopup(t);
  assert.equal(guest.$("#syncBar").hidden, true);
  const ui = await createPopup(t, { auth: { user: { name: "王" } }, sync: { enabled: false } });
  assert.ok(ui.$("header #syncOn"));
  assert.ok(ui.$("#syncBar").textContent.length < 20);
  ui.$("#syncOn").click();
  await delay(60);
  assert.ok(ui.messages.some(message => message.type === "SYNC_SET" && message.enabled));
});

test("顶部同步失败可诊断，并支持英文状态", async t => {
  const state = { auth: { user: { name: "王" } }, sync: { enabled: true, lastError: "server" } };
  const ui = await createPopup(t, state);
  assert.match(ui.$("#syncBar").textContent, /同步失败/);
  assert.match(ui.$("#syncBar [title]").title, /服务器出错/);
  const en = await createPopup(t, { ...state, auth: { user: { name: "Alex" } } }, { language: "en-US" });
  assert.match(en.$("#syncBar").textContent, /Cloud sync/);
  assert.deepEqual([...en.window.I18N.missing], []);
});

test("手动同步请求失败后显示错误，并恢复重试按钮", async t => {
  const ui = await createPopup(t, { auth: { user: { name: "Alex" } }, sync: { enabled: true } });
  const original = ui.window.chrome.runtime.sendMessage;
  ui.window.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === "SYNC_NOW") return callback({ ok: false, reason: "server" });
    return original(message, callback);
  };
  ui.$("#syncRun").click();
  await delay(60);
  assert.match(ui.$("#syncBar .bad").textContent, /服务器出错/);
  assert.ok(ui.$("#syncRun"));
});

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
