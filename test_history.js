// 浏览历史汇总的测试（node test_history.js）
const H = require("./history.js");
const DAY = 86400000, NOW = new Date(2026, 9, 14, 15, 0).getTime();
let pass = 0, fail = 0;
const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); c ? pass++ : fail++; };
const at = (d, h) => { const x = new Date(NOW - d * DAY); x.setHours(h || 12, 0, 0, 0); return x.getTime(); };
const visits = [
  { url: "https://www.netflix.com/browse", time: at(1, 21) },
  { url: "https://www.netflix.com/watch/1", time: at(1, 22) },
  { url: "https://www.netflix.com/browse", time: at(40) },
  { url: "https://pan.baidu.com/disk/home", time: at(70) },
  { url: "https://www.notion.so/x", time: at(2) }, { url: "https://www.notion.so/y", time: at(3) }, { url: "https://notion.so/z", time: at(20) },
  { url: "https://www.netflix.com/account/membership", time: at(0, 10) },      // 插件后台打开的
  { url: "https://notnetflix.com/", time: at(1) },                              // 不是同一个网站
  { url: "https://www.netflix.com/old", time: at(120) }                        // 超出 90 天
];
const own = [{ host: "netflix.com", time: at(0, 10) - 2000 }];
const r = H.aggregate(visits, ["netflix.com", "baidu.com", "notion.so"], own, NOW);
t("按域名汇总最近访问时间", r.byDomain["netflix.com"].last === at(1, 22));
t("插件自己打开的账户页不算", r.byDomain["netflix.com"].last !== at(0, 10));
t("同一天多次访问只算 1 天；超出 90 天的不算", r.byDomain["netflix.com"].days90 === 2 && r.byDomain["netflix.com"].days30 === 1);
t("子域名归到主域名（pan.baidu.com → baidu.com）", r.byDomain["baidu.com"].days90 === 1 && r.byDomain["baidu.com"].days30 === 0);
t("近 30 天访问天数", r.byDomain["notion.so"].days30 === 3);
t("相似域名不会误匹配", !Object.keys(r.byDomain).some(d => d.indexOf("not") === 0 && d !== "notion.so"));
t("给「发现」用的命中：每个域名每天一条", r.hits.filter(h => h.hostname === "netflix.com").length === 2);
t("一个订阅多个域名取最大", H.statsFor(r.byDomain, ["baidu.com", "notion.so"]).last === at(2));
t("没有记录的订阅", H.statsFor(r.byDomain, ["figma.com"]).last === 0);
const items = [{ url: "https://www.netflix.com/browse", lastVisitTime: at(1) }, { url: "https://example.com/", lastVisitTime: at(1) },
               { url: "https://www.notion.so/x", lastVisitTime: at(200) }];
t("只挑关心的域名、时间范围内的网址去查访问", JSON.stringify(H.pickUrls(items, ["netflix.com", "notion.so"], NOW - 90 * DAY)) === '["https://www.netflix.com/browse"]');
// 访问次数
require("./lib.js");
const L = globalThis.SubLib;
const MIN = 60000;
let log = L.mergeVisits([], [NOW - 10 * MIN, NOW - 5 * MIN, NOW], NOW);
t("30 分钟内连续打开只算 1 次访问", log.length === 1 && log[0] === NOW - 10 * MIN);
log = L.mergeVisits(log, [NOW - 2 * DAY, NOW - 10 * DAY, NOW - 40 * DAY, NOW - 100 * DAY], NOW);
t("超过 90 天的不保留", log.length === 4 && log[0] === NOW - 40 * DAY);
log = L.mergeVisits(log, [NOW - 2 * DAY + 5 * MIN], NOW);
t("浏览历史补进来的和已有记录重复时不重复计数", log.length === 4);
const vs = L.visitStats(log, NOW);
t("近 7 天 / 近 30 天 / 最近访问", vs.d7 === 2 && vs.d30 === 3 && vs.d90 === 4 && vs.last === NOW - 10 * MIN);
t("没有记录时", L.visitStats(undefined, NOW).last === null && L.visitStats([], NOW).d30 === 0);
t("浏览历史汇总也给出每个域名的访问时间", r.times["notion.so"].length === 3 && !r.times["netflix.com"].includes(at(0, 10)));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
