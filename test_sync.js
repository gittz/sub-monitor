// 云端同步合并逻辑的测试（node test_sync.js）
const S = require("./sync.js");
const DAY = 86400000, NOW = Date.now();
let pass = 0, fail = 0;
const t = (n, c, x) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || x === undefined ? "" : "  → " + JSON.stringify(x))); c ? pass++ : fail++; };

const full = { id: "1", name: "Netflix", price: 15.49, currency: "$", mode: "activity", provider: "netflix", catalogId: "netflix",
  updatedAt: NOW - 5 * DAY, lastUsed: NOW - DAY, sig: { ids: ["v1", "v2"] }, signal: { ok: true }, hist: { days30: 3 }, notified: 123,
  account: { status: "ok", plan: { label: "Premium", paid: true }, url: "https://www.netflix.com/account", checkedAt: NOW - DAY } };
const clean = S.sanitize(full);
t("上传时去掉活动指纹、读取状态、浏览历史汇总、提醒标记", !clean.sig && !clean.signal && !clean.hist && !clean.notified && clean.name === "Netflix" && clean.lastUsed === full.lastUsed);
t("账户页结果只留结论，不留页面地址", clean.account.plan.label === "Premium" && !clean.account.url);

let m = S.merge({ subs: [full], deleted: {} }, { subs: [], deleted: {} }, NOW);
t("云端为空：保留本机全部（包括本机专用字段）", m.subs.length === 1 && m.subs[0].sig);

m = S.merge({ subs: [], deleted: {} }, { subs: [clean, { id: "2", name: "Notion", mode: "browser", updatedAt: NOW }], deleted: {} }, NOW);
t("换了台新电脑：从云端恢复全部订阅", m.subs.length === 2 && m.subs[1].name === "Notion");

const edited = Object.assign({}, clean, { price: 22.99, name: "Netflix 高级", updatedAt: NOW });
m = S.merge({ subs: [full], deleted: {} }, { subs: [edited], deleted: {} }, NOW);
t("另一台设备后改的价格和名字生效，本机专用字段保留", m.subs[0].price === 22.99 && m.subs[0].name === "Netflix 高级" && m.subs[0].sig);

const older = Object.assign({}, clean, { price: 9.99, updatedAt: NOW - 10 * DAY, lastUsed: NOW - 2 * 3600e3 });
m = S.merge({ subs: [full], deleted: {} }, { subs: [older], deleted: {} }, NOW);
t("云端的编辑更旧：保留本机的价格", m.subs[0].price === 15.49);
t("最近使用取两边较晚的（任一设备在用就是在用）", m.subs[0].lastUsed === NOW - 2 * 3600e3);

const floor = Object.assign({}, clean, { lastUsed: NOW - 90 * DAY, lastUsedFloor: true });
m = S.merge({ subs: [Object.assign({}, full, { lastUsed: NOW - 40 * DAY })], deleted: {} }, { subs: [floor], deleted: {} }, NOW);
t("「90 天没访问」占位不会盖掉真实日期", m.subs[0].lastUsed === NOW - 40 * DAY && !m.subs[0].lastUsedFloor);

const newerAcct = Object.assign({}, clean, { account: { status: "ok", plan: { label: "Standard", paid: true }, checkedAt: NOW } });
m = S.merge({ subs: [full], deleted: {} }, { subs: [newerAcct], deleted: {} }, NOW);
t("账户页结果取读得较晚的", m.subs[0].account.plan.label === "Standard");

const otherDevice = Object.assign({}, clean, { id: "0999" });
m = S.merge({ subs: [full], deleted: {} }, { subs: [otherDevice], deleted: {} }, NOW);
t("两台设备各加了一次 Netflix：合成一条，id 统一成较小的", m.subs.length === 1 && m.subs[0].id === "0999");
m = S.merge({ subs: [{ id: "a", mode: "activity", provider: "claude", name: "Claude", updatedAt: 1 }], deleted: {} },
            { subs: [{ id: "b", mode: "activity", provider: "claude", name: "Claude", updatedAt: 2 }], deleted: {} }, NOW);
t("两台设备各加了一次 Claude：合成一条", m.subs.length === 1);

m = S.merge({ subs: [], deleted: { "1": NOW - 3600e3 } }, { subs: [clean], deleted: {} }, NOW);
t("本机删了：云端那条不会被同步回来", m.subs.length === 0 && m.deleted["1"]);
m = S.merge({ subs: [full], deleted: {} }, { subs: [], deleted: { "1": NOW - 3600e3 } }, NOW);
t("另一台设备删了：本机也删掉", m.subs.length === 0);
m = S.merge({ subs: [Object.assign({}, full, { updatedAt: NOW })], deleted: {} }, { subs: [], deleted: { "1": NOW - 3600e3 } }, NOW);
t("删了之后又在别的设备上改过：保留（以最后的操作为准）", m.subs.length === 1 && !m.deleted["1"]);
m = S.merge({ subs: [], deleted: { old: NOW - 100 * DAY, fresh: NOW - DAY } }, { subs: [], deleted: {} }, NOW);
t("删除记录 90 天后清掉", !m.deleted.old && m.deleted.fresh);

t("内容一样时判定为不用上传", S.sameSynced({ subs: [full], deleted: {} }, { subs: [clean], deleted: {} }));
t("只是本机专用字段不同，也不用上传", S.sameSynced({ subs: [Object.assign({}, full, { sig: { ids: ["x"] } })], deleted: {} }, { subs: [clean], deleted: {} }));
t("改了价格要上传", !S.sameSynced({ subs: [edited], deleted: {} }, { subs: [clean], deleted: {} }));
// 手动排序
{
  const a = { id: "10", name: "A", catalogId: "netflix", updatedAt: 1 }, b = { id: "20", name: "B", updatedAt: 1 };
  const a2 = { id: "05", name: "A", catalogId: "netflix", updatedAt: 1 };  // 另一台设备加的同一个服务，id 更小
  let r = S.merge({ subs: [a, b], deleted: {}, order: { ids: ["20", "10"], at: 100 } }, { subs: [a2], deleted: {}, order: { ids: ["05"], at: 50 } }, NOW);
  t("排序：取较晚排的那份，id 统一后顺序跟着换", r.order && r.order.at === 100 && r.order.ids.join(",") === "20,05");
  r = S.merge({ subs: [a, b], deleted: {}, order: { ids: ["20", "10"], at: 100 } }, { subs: [a, b], deleted: {}, order: { ids: null, at: 200 } }, NOW);
  t("排序：另一台设备后来恢复了自动排序", r.order.ids === null && r.order.at === 200);
  r = S.merge({ subs: [a], deleted: {} }, { subs: [a], deleted: {} }, NOW);
  t("排序：都没排过 → null，也不往上传", r.order === null && !("order" in S.payload(r.subs, r.deleted, r.order)));
  t("排序变了要上传", !S.sameSynced({ subs: [a, b], deleted: {}, order: { ids: ["20", "10"], at: 100 } }, { subs: [a, b], deleted: {} }));
  t("顺序一样不用上传", S.sameSynced({ subs: [a, b], deleted: {}, order: { ids: ["20", "10"], at: 100 } }, { subs: [b, a], deleted: {}, order: { ids: ["20", "10"], at: 100 } }));
}
// 访问时间点同步
{
  const H = 3600e3;
  const la = { id: "v1", name: "Netflix", catalogId: "netflix", updatedAt: 1, visitLog: [NOW - 5 * DAY, NOW - 2 * DAY], sig: "x" };
  const p = S.payload([la], {});
  t("上传访问时间点：压成分钟、不带网址和指纹", Array.isArray(p.subs[0].visits) && p.subs[0].visits.length === 2 && p.subs[0].visits[0] === Math.floor((NOW - 5 * DAY) / 60000) && !p.subs[0].visitLog && !p.subs[0].sig);
  const rb = { id: "v2", name: "Netflix", catalogId: "netflix", updatedAt: 1, visits: S.encodeVisits([NOW - 2 * DAY + 10 * 60000, NOW - DAY]) };
  let r = S.merge({ subs: [la], deleted: {} }, { subs: [rb], deleted: {} }, NOW);
  const vl = r.subs[0].visitLog;
  t("两台设备的访问合在一起，30 分钟内算同一次", vl.length === 3 && !r.subs[0].visits, vl.map(x => (NOW - x) / DAY));
  r = S.merge({ subs: [], deleted: {} }, { subs: [rb], deleted: {} }, NOW);
  t("新设备从云端恢复访问记录", r.subs[0].visitLog.length === 2 && !r.subs[0].visits);
  const old = { id: "v3", name: "A", updatedAt: 1, visitLog: [NOW - 100 * DAY, NOW - H] };
  t("只同步最近 90 天", S.payload([old], {}).subs[0].visits.length === 1);
  const many = { id: "v4", name: "B", updatedAt: 1, visitLog: Array.from({ length: 800 }, (_, i) => NOW - i * H) };
  t("最多同步 300 条（最新的）", S.payload([many], {}).subs[0].visits.length === 300);
  const merged = S.merge({ subs: [la], deleted: {} }, { subs: [], deleted: {} }, NOW);
  t("合并后和云端一致就不用重复上传", S.sameSynced(merged, { subs: S.payload(merged.subs, merged.deleted).subs, deleted: {} }));
  t("多了一次访问要上传", !S.sameSynced({ subs: [Object.assign({}, la, { visitLog: la.visitLog.concat([NOW - H]) })], deleted: {} }, { subs: S.payload([la], {}).subs, deleted: {} }));
}
// 插件自己打开网页的记录：同步并从访问次数里去掉
{
  const M = 60000, T = NOW - 2 * DAY;
  const own = S.mergeOwn([{ host: "claude.ai", time: T + 5000 }], [["claude.ai", Math.floor((T + 5000) / M)], ["netflix.com", Math.floor((NOW - DAY) / M)]], NOW);
  t("检查记录：两边合并去重", own.length === 2 && own.some(o => o.host === "netflix.com"));
  const p2 = S.payload([], {}, null, [{ host: "claude.ai", time: T }]);
  t("检查记录上传为 [网站, 分钟]", Array.isArray(p2.own) && p2.own[0][0] === "claude.ai" && p2.own[0][1] === Math.floor(T / M));
  const subs = [{ id: "c", name: "Claude", mode: "activity", provider: "claude", visitLog: [T - 3 * DAY, T + 20 * 1000, T + 2 * M, NOW - 3600e3] },
                { id: "b", name: "Mymagic", mode: "browser", urlPattern: "mymagic.io", lastUsed: NOW - 5 * DAY, visitLog: [NOW - 5 * DAY] },
                { id: "p", name: "Pan", mode: "browser", urlPattern: "pan.baidu.com", lastUsed: T + 60000, visitLog: [T - 9 * DAY, T + 60000] }];
  const dom = (s) => s.provider === "claude" ? ["claude.ai"] : [s.urlPattern];
  const n = S.purgeOwn(subs, own.concat([{ host: "pan.baidu.com", time: T }]), dom);
  t("去掉检查那几分钟的访问，别的保留", subs[0].visitLog.length === 2 && subs[0].visitLog[0] === T - 3 * DAY && n === 3, subs[0].visitLog);
  t("没被检查过的订阅不动", subs[1].visitLog.length === 1 && subs[1].lastUsed === NOW - 5 * DAY);
  t("浏览器访问型的最近使用正好是检查那会儿：改回剩下的最近一次", subs[2].lastUsed === T - 9 * DAY);
  t("检查记录变了要上传", !S.sameSynced({ subs: [], deleted: {}, own: [{ host: "a.com", time: NOW }] }, { subs: [], deleted: {} }));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
