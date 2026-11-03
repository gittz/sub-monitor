const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopup, delay } = require("./tests/popup-fixture");

test("游客可从顶部菜单发邮件或复制反馈邮箱，不要求登录", async t => {
  const ui = await createPopup(t);
  assert.ok(ui.$("#accountMenuButton"), "顶部应提供反馈菜单入口");
  ui.$("#accountMenuButton").click();
  assert.equal(ui.$("#accountMenuPanel").hidden, false);
  const email = new URL(ui.$("#feedbackEmailLink").href);
  assert.equal(email.protocol, "mailto:");
  assert.equal(email.pathname, "jiago12345@gmail.com");
  ui.$("#copyFeedbackEmail").click();
  await delay();
  assert.deepEqual(ui.copied, ["jiago12345@gmail.com"]);
  assert.match(ui.$("#feedbackCopyStatus").textContent, /已复制/);
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

test("剪贴板失败时保留可手动复制的邮箱并显示失败提示", async t => {
  const ui = await createPopup(t, {}, {clipboardError: true});
  assert.ok(ui.$("#accountMenuButton"), "顶部应提供反馈菜单入口");
  ui.$("#accountMenuButton").click(); ui.$("#copyFeedbackEmail").click(); await delay();
  assert.match(ui.$("#feedbackCopyStatus").textContent, /复制失败/);
  assert.match(ui.$("#accountMenuPanel").textContent, /jiago12345@gmail.com/);
});

test("图标和产品标题共同指向官网并在新标签打开", async t => {
  const ui = await createPopup(t);
  const link = ui.$(".ih-logo").closest("a");
  assert.ok(link, "图标应在官网链接内");
  assert.equal(link.href, "https://idlesubs.com/");
  assert.equal(link.target, "_blank");
  assert.ok(link.contains(ui.$(".ih-name")));
  assert.match(link.rel, /noopener/);
});

test("剪贴板接口被拒（侧边栏没焦点）时改用 execCommand 复制", async t => {
  const ui = await createPopup(t, {}, {clipboardError: true});
  let used = null;
  ui.window.document.execCommand = (cmd) => { used = cmd; return true; };
  ui.$("#accountMenuButton").click(); ui.$("#copyFeedbackEmail").click(); await delay();
  assert.equal(used, "copy");
  assert.match(ui.$("#feedbackCopyStatus").textContent, /已复制/);
  assert.equal(ui.window.document.querySelectorAll("textarea[readonly]").length, 0, "临时文本框要移除");
});

test("在菜单里按下按钮时焦点短暂离开，不能把菜单收起（否则点击会丢）", async t => {
  const ui = await createPopup(t);
  ui.$("#accountMenuButton").click();
  const link = ui.$("#feedbackEmailLink"), copy = ui.$("#copyFeedbackEmail");
  link.focus();
  // 真实浏览器的顺序：按下 → 旧元素 focusout（此时 activeElement 是 body）→ 新元素获得焦点 → click
  link.dispatchEvent(new ui.window.FocusEvent("focusout", { bubbles: true, relatedTarget: copy }));
  await delay(5);
  assert.equal(ui.$("#accountMenuPanel").hidden, false, "焦点转到菜单内的按钮时不收起");
  link.dispatchEvent(new ui.window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  copy.click(); await delay();
  assert.equal(ui.$("#accountMenuPanel").hidden, false);
  assert.deepEqual(ui.copied, ["jiago12345@gmail.com"]);
  assert.match(ui.$("#feedbackCopyStatus").textContent, /已复制/);
});
