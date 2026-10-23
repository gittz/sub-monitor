// 同步来的订阅在这台电脑上还没授权：顶部提示 + 一键授权（node test_popup_grant.js）
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopup, delay } = require("./tests/popup-fixture");

const needGrant = [
  { id: "n1", name: "Netflix", origins: ["https://netflix.com/*", "https://*.netflix.com/*"] },
  { id: "c1", name: "Claude", origins: ["https://claude.ai/*"] }
];
const subs = [{ id: "n1", name: "Netflix", catalogId: "netflix", mode: "activity", provider: "netflix", urlPattern: "netflix.com" },
              { id: "c1", name: "Claude", mode: "activity", provider: "claude", urlPattern: "claude.ai" }];

test("有没授权的订阅时显示提示，列出名称", async t => {
  const { $ } = await createPopup(t, { subs, needGrant });
  assert.equal($("#grantBar").hidden, false);
  assert.match($("#grantBarText").textContent, /Netflix、Claude/);
  assert.match($("#grantBarText").textContent, /还没授权/);
});

test("全部授权过就不显示", async t => {
  const { $ } = await createPopup(t, { subs, needGrant: [] });
  assert.equal($("#grantBar").hidden, true);
});

test("点「一键授权」：一个授权框申请全部网站，授权后检查这几个订阅", async t => {
  const { window, $, messages, store } = await createPopup(t, { subs, needGrant });
  let asked = null;
  window.chrome.permissions.request = async q => { asked = q; store.needGrant = []; return true; };
  $("#grantAll").click();
  await delay(200);
  assert.equal(JSON.stringify([...asked.origins].sort()), JSON.stringify(["https://*.netflix.com/*", "https://claude.ai/*", "https://netflix.com/*"].sort()));
  const pending = messages.find(m => m.type === "PENDING_GRANT");
  assert.equal(pending.action, "grantAll");
  const run = messages.find(m => m.type === "RUN_CHECK");
  assert.equal(JSON.stringify(run.ids), JSON.stringify(["n1", "c1"]));
  assert.equal(run.grantAll, true);
  assert.equal($("#grantBar").hidden, true);
});

test("拒绝授权：不检查，提示还在", async t => {
  const { window, $, messages } = await createPopup(t, { subs, needGrant });
  window.chrome.permissions.request = async () => false;
  $("#grantAll").click();
  await delay(60);
  assert.equal(messages.some(m => m.type === "RUN_CHECK"), false);
  assert.equal($("#grantBar").hidden, false);
});
