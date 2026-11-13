const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { createPopup } = require("./tests/popup-fixture");
const ctx = vm.createContext({ console });
for (const file of ["lib.js", "llm.js", "sync.js"]) vm.runInContext(fs.readFileSync(`${__dirname}/${file}`, "utf8"), ctx);
const DAY = 86400000, now = Date.now();
function subscription(provider = "chatgpt", usage = { week: 75 }) {
  return { id: provider, name: provider, provider, mode: "activity", idleDays: 30,
    lastUsed: now - 142 * DAY, signal: { ok: true }, price: 20,
    llm: { kind: provider, plan: { key: "plus", label: "Plus", paid: true },
      stats: { lastUsed: now - 142 * DAY, activeDays7: 0, activeDays30: 0, convs7: 0, convs30: 0 },
      usage, updatedAt: now } };
}
test("两种 AI 的周额度证明七天内用过，不改写对话时间", () => {
  for (const kind of ["claude", "chatgpt"]) {
    const sub = subscription(kind), status = ctx.SubLib.computeStatus(sub, now);
    assert.equal(status.state, "active");
    assert.equal(status.source, "quota");
    assert.equal(status.days, 7);
    assert.equal(sub.lastUsed, now - 142 * DAY);
    assert.equal(ctx.LlmLib.llmAdvice(kind, sub.llm, now).level, "wait");
  }
});
test("零额度、月额度、过期或无效额度都不证明本周用过", () => {
  for (const usage of [{ week: 0 }, { month: 75 }, { week: -1 }, { week: 101 }, { week: NaN },
    { week: 75, weekReset: now - DAY }]) {
    assert.equal(ctx.SubLib.computeStatus(subscription("chatgpt", usage), now).state, "idle");
  }
  const sub = subscription();
  sub.llm.updatedAt = now - 8 * DAY;
  assert.equal(ctx.SubLib.computeStatus(sub, now).state, "idle");
  sub.llm.updatedAt = now + DAY;
  assert.equal(ctx.SubLib.computeStatus(sub, now).state, "idle");
});
test("额度不覆盖较新的对话或读取失败，五小时额度也能证明近期使用", () => {
  const sub = subscription("chatgpt", { fiveHour: 25 });
  assert.equal(ctx.SubLib.computeStatus(sub, now).source, "quota");
  sub.lastUsed = now - 60000;
  assert.notEqual(ctx.SubLib.computeStatus(sub, now).source, "quota");
  sub.signal.ok = false;
  assert.equal(ctx.SubLib.computeStatus(sub, now).state, "signal_lost");
});
test("额度证据按重置窗口和采样时间推移，不永远显示七天内", () => {
  const sub = subscription("claude", { week: 1, weekReset: now + 2 * DAY });
  assert.equal(ctx.SubLib.computeStatus(sub, now).days, 5);
  assert.equal(ctx.SubLib.computeStatus(sub, now + 3 * DAY).days, 8);
});
test("旧占位时间和无对话的新订阅也可按额度判断，沿用现有同步字段", () => {
  for (const lastUsed of [null, now - 90 * DAY]) {
    const sub = subscription();
    sub.lastUsed = lastUsed;
    sub.lastUsedFloor = true;
    sub.llm.stats.lastUsed = null;
    assert.equal(ctx.SubLib.computeStatus(sub, now).state, "active");
    const synced = ctx.SyncLib.sanitize(sub);
    assert.equal(ctx.SubLib.computeStatus(synced, now).source, "quota");
    assert.equal(sub.lastUsed, lastUsed);
  }
});
test("有额度证据时不按不完整对话数量建议只留另一家", () => {
  const low = subscription(), high = subscription("claude", { week: 0 });
  high.llm.stats.activeDays30 = 20;
  assert.equal(ctx.LlmLib.crossAdvice([low, high], now), null);
});
test("不足百分之一的非零额度也保留使用证据", () => {
  const usage = ctx.LlmLib.pickUsage({ seven_day: { utilization: 0.001 } });
  assert.equal(ctx.SubLib.computeStatus(subscription("claude", usage), now).state, "active");
});
test("列表、详情和收藏显示额度使用证据，隐藏旧零使用建议", async t => {
  const sub = subscription();
  sub.llm.advice = { level: "cancel", text: "近 30 天一次都没用过" };
  sub.llm.cross = "只留 Claude";
  const ui = await createPopup(t, { subs: [sub], pinned: [sub.id] });
  const row = ui.$(".sv-row");
  assert.match(row.textContent, /7 天内用过/);
  assert.doesNotMatch(row.textContent, /142 天未使用|一次都没用过|只留 Claude/);
  assert.match(row.textContent, /按额度判断/);
  assert.match(ui.$("#pinCard").textContent, /7 天内用过/);
  assert.doesNotMatch(row.textContent, /近 30 天用了 0 天/);
});
