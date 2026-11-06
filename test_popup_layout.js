const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopup, delay } = require("./tests/popup-fixture");

function subscriptionState(pinned = []) {
  const subs = ["Bigmodel", "Cloudflare", "DeepSeek"].map((name, index) => ({
    id: String(index + 1), name, mode: "browser", urlPattern: `service${index}.example.com`,
    price: 10, currency: "¥", idleDays: 30, lastUsed: Date.now()
  }));
  return { subs, pinned, auth: { user: { name: "测试用户" } },
    sync: { enabled: true, lastSyncAt: Date.now() } };
}

function assertDashboardBeforeSubscriptions(ui) {
  const { $, window } = ui;
  const stats = $(".sv-stats"), sync = $("#syncBar"), pins = $("#pinCard");
  const follows = window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(stats.compareDocumentPosition(sync) & follows, "看板应在同步信息上方");
  assert.ok(sync.compareDocumentPosition(pins) & follows, "同步信息应在收藏卡片上方");
  assert.ok(pins.compareDocumentPosition($(".sv-table")) & follows, "收藏卡片应在普通列表上方");
}

test("空订阅首页从看板开始，不保留宣传区占位，添加入口仍可用", async t => {
  const ui = await createPopup(t);
  assert.equal(ui.$("#view-subs").firstElementChild, ui.$(".sv-stats"));
  assert.equal(ui.$("#pinCard").hidden, true);
  assert.equal(ui.$("#cnt").textContent, "0/5");
  ui.$("[data-goadd]").click();
  assert.equal(ui.$("#view-add").hidden, false);
});

for (const pinned of [["1"], ["3", "1", "2"]]) {
  test(`恢复 ${pinned.length} 个收藏时，看板和同步信息始终在所有订阅上方`, async t => {
    const ui = await createPopup(t, subscriptionState(pinned));
    assert.equal(ui.$("#syncBar").hidden, false);
    assert.equal(ui.$("#pinCard").hidden, false);
    assertDashboardBeforeSubscriptions(ui);
    const cards = [...ui.$("#pinCard").querySelectorAll("[data-pin]")];
    assert.deepEqual(cards.map(button => button.dataset.pin), pinned);
    assert.equal(ui.$("#cnt").textContent, "3/5");
    assert.equal(ui.$("#subList").querySelectorAll(".sv-row").length, 3);
  });
}

test("点击星标及取消收藏只更新订阅区域，统计金额和看板位置保持不变", async t => {
  const ui = await createPopup(t, subscriptionState());
  const spend = ui.$("#spend").textContent;
  ui.$('#subList [data-pin="1"]').click();
  await delay();
  assert.equal(ui.$("#pinCard").hidden, false);
  assert.match(ui.$("#pinCard").textContent, /Bigmodel/);
  assertDashboardBeforeSubscriptions(ui);
  assert.equal(ui.$('#subList [data-pin="1"]').getAttribute("aria-pressed"), "true");
  ui.$('#pinCard [data-pin="1"]').click();
  await delay();
  assert.equal(ui.$("#pinCard").hidden, true);
  assert.equal(ui.$('#subList [data-pin="1"]').getAttribute("aria-pressed"), "false");
  assert.equal(ui.$("#spend").textContent, spend);
  assertDashboardBeforeSubscriptions(ui);
});

test("排序模式结束后收藏卡片恢复到看板下方，普通列表置顶仍生效", async t => {
  const ui = await createPopup(t, { ...subscriptionState(["1"]), order: ["1", "2", "3"] });
  ui.$("#sortToggle").click();
  assert.equal(ui.$("#pinCard").hidden, true);
  ui.$('[data-mv="top"][data-id="3"]').click();
  await delay();
  ui.$("#sortDone").click();
  assert.equal(ui.$("#pinCard").hidden, false);
  assert.equal(ui.$("#subList .sv-row").dataset.id, "3");
  assert.equal(ui.$("#pinCard [data-pin]").dataset.pin, "1");
  assertDashboardBeforeSubscriptions(ui);
});
