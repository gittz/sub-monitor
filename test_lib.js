// 直接加载真实的 lib.js 来测（不是复制粘贴，测的就是插件里跑的那份代码）
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ctx = { globalThis: {}, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "lib.js"), "utf8"), ctx);
const L = ctx.SubLib;

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name); }
};

const DAY = 86400000;
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime(); // 2026-09-17 12:00

console.log("== normalizeDomain ==");
check("去协议和路径", L.normalizeDomain("https://www.netflix.com/browse") === "netflix.com");
check("去端口", L.normalizeDomain("http://localhost:3000/x") === "localhost");
check("已是裸域名", L.normalizeDomain("spotify.com") === "spotify.com");
check("空值安全", L.normalizeDomain("") === "" && L.normalizeDomain(null) === "");

console.log("== hostMatches ==");
check("精确匹配", L.hostMatches("netflix.com", "netflix.com"));
check("www 前缀", L.hostMatches("www.netflix.com", "netflix.com"));
check("子域名命中", L.hostMatches("tv.netflix.com", "netflix.com"));
check("用户填完整URL也行", L.hostMatches("www.netflix.com", "https://netflix.com/browse"));
check("不误命中相似域名", !L.hostMatches("notnetflix.com", "netflix.com"));
check("不误命中后缀域名", !L.hostMatches("netflix.com.evil.com", "netflix.com"));
check("空模式不匹配", !L.hostMatches("netflix.com", ""));

console.log("== parseLabelToTs ==");
const todayTs = new Date(2026, 8, 17).getTime();
check("今天", L.parseLabelToTs("今天", NOW) === todayTs);
{
  const sat = new Date(2026, 9, 17, 15).getTime(), satDay = new Date(2026, 9, 17).getTime();   // 2026-10-17 是星期六
  check("星期一 → 本周一（5 天前）", L.parseLabelToTs("星期一", sat) === satDay - 5 * 86400000);
  check("周五 → 昨天之前的那个周五", L.parseLabelToTs("周五", sat) === satDay - 1 * 86400000);
  check("和今天同一个星期几 → 7 天前", L.parseLabelToTs("星期六", sat) === satDay - 7 * 86400000);
  check("英文 Monday", L.parseLabelToTs("Monday", sat) === satDay - 5 * 86400000);
}
check("Today 大小写不敏感", L.parseLabelToTs("TODAY", NOW) === todayTs);
check("昨天", L.parseLabelToTs("昨天", NOW) === todayTs - DAY);
check("Yesterday", L.parseLabelToTs("Yesterday", NOW) === todayTs - DAY);
check("9月10日", L.parseLabelToTs("9月10日", NOW) === new Date(2026, 8, 10).getTime());
check("2025年12月1日", L.parseLabelToTs("2025年12月1日", NOW) === new Date(2025, 11, 1).getTime());
check("Sep 10, 2026", L.parseLabelToTs("Sep 10, 2026", NOW) === new Date(2026, 8, 10).getTime());
check("无法解析返回 null（不瞎猜）", L.parseLabelToTs("某种未知文案", NOW) === null);
check("空值返回 null", L.parseLabelToTs("", NOW) === null && L.parseLabelToTs(null, NOW) === null);

console.log("== computeStatus ==");
check("mode=none 永不判闲置（防误报）",
  L.computeStatus({ mode: "none", lastUsed: NOW - 999 * DAY }, NOW).state === "unmonitored");
check("无 lastUsed 只建基线，不下结论",
  L.computeStatus({ mode: "browser", lastUsed: null }, NOW).state === "baseline");
check("1天前=在用",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 1 * DAY, idleDays: 30 }, NOW).state === "active");
check("29天=还没到阈值",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 29 * DAY, idleDays: 30 }, NOW).state === "active");
check("30天=刚好触发闲置",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 30 * DAY, idleDays: 30 }, NOW).state === "idle");
check("天数计算正确",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 45 * DAY, idleDays: 30 }, NOW).days === 45);
check("自定义阈值 7 天生效",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 8 * DAY, idleDays: 7 }, NOW).state === "idle");
check("未填阈值时默认 30 天",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 31 * DAY }, NOW).state === "idle");

console.log("== 信号中断：不能把'测不到'当成'没在用' ==");
// 场景：用户 90 天前登录过一次，之后 cookie 失效。这 90 天他天天在看 YouTube，
// 但插件读不到。如果不拦住，就会误报"闲置 90 天，建议退订"。
const loggedOutSub = {
  mode: "activity", provider: "youtube", idleDays: 30,
  lastUsed: NOW - 90 * DAY,
  signal: { ok: false, reason: "logged_out", since: NOW - 88 * DAY, lastOk: NOW - 90 * DAY, fails: 12 }
};
const st1 = L.computeStatus(loggedOutSub, NOW);
check("未登录时状态是 signal_lost 而不是 idle", st1.state === "signal_lost");
check("绝不会因为读不到而建议退订", st1.state !== "idle");
check("带出中断原因", st1.reason === "logged_out");
check("中断天数按 since 算（88天）", st1.days === 88);

check("历史记录关闭也走 signal_lost",
  L.computeStatus({ mode: "activity", lastUsed: NOW - 90 * DAY, idleDays: 30,
    signal: { ok: false, reason: "history_off", since: NOW - 5 * DAY, fails: 3 } }, NOW).state === "signal_lost");

check("信号中断优先级高于 idle（即使早已超阈值）",
  L.computeStatus({ mode: "activity", lastUsed: NOW - 999 * DAY, idleDays: 1,
    signal: { ok: false, reason: "read_failed", since: NOW - 2 * DAY, fails: 2 } }, NOW).state === "signal_lost");

check("信号正常时照常判闲置",
  L.computeStatus({ mode: "activity", lastUsed: NOW - 60 * DAY, idleDays: 30,
    signal: { ok: true, reason: null, since: null, lastOk: NOW, fails: 0 } }, NOW).state === "idle");

check("信号恢复后能正确判回在用",
  L.computeStatus({ mode: "activity", lastUsed: NOW - 2 * DAY, idleDays: 30,
    signal: { ok: true, reason: null, since: null, lastOk: NOW, fails: 0 } }, NOW).state === "active");

check("浏览器访问型不受 signal 影响",
  L.computeStatus({ mode: "browser", lastUsed: NOW - 60 * DAY, idleDays: 30,
    signal: { ok: false, reason: "logged_out", since: NOW - 10 * DAY, fails: 5 } }, NOW).state === "idle");

console.log("== shouldWarnSignal：抖动不吵，真断才提醒 ==");
const mkSig = (fails) => ({ mode: "activity", signal: { ok: false, reason: "logged_out", since: NOW, fails } });
check("失败 1 次不提醒（可能只是网络抖动）", L.shouldWarnSignal(mkSig(1)) === false);
check("连续失败 2 次才提醒", L.shouldWarnSignal(mkSig(2)) === true);
check("信号正常不提醒",
  L.shouldWarnSignal({ mode: "activity", signal: { ok: true, fails: 0 } }) === false);
check("没有 signal 字段不提醒（老数据兼容）",
  L.shouldWarnSignal({ mode: "activity" }) === false);

console.log("== wastedPerMonth ==");
const subs = [
  { mode: "browser", lastUsed: NOW - 60 * DAY, idleDays: 30, price: 15.99 }, // 闲置
  { mode: "browser", lastUsed: NOW - 1 * DAY, idleDays: 30, price: 9.99 },   // 在用
  { mode: "none",    lastUsed: NOW - 90 * DAY, idleDays: 30, price: 20 },    // 不监控，不计
  { mode: "browser", lastUsed: NOW - 40 * DAY, idleDays: 30, price: 4.01 }   // 闲置
];
check("只累计闲置的订阅", L.wastedPerMonth(subs, NOW) === 20);
check("信号中断的不计入'可省'（因为根本没判定）",
  L.wastedPerMonth([{ mode: "activity", lastUsed: NOW - 90 * DAY, idleDays: 30, price: 99,
    signal: { ok: false, reason: "logged_out", since: NOW - 80 * DAY, fails: 9 } }], NOW) === 0);
check("空列表为 0", L.wastedPerMonth([], NOW) === 0 && L.wastedPerMonth(null, NOW) === 0);

// 回归测试：importScripts / 多个 <script> 会让脚本共享同一个全局作用域，
// 如果两个文件声明了同名的顶层 const，会报 "Identifier X has already been declared"。
// 把它们拼成一份来编译，就能在本地复现这种冲突（编译不执行，所以不需要 chrome API）。
console.log("== 全局作用域冲突检查 ==");
function checkNoScopeConflict(name, files) {
  const src = files.map(f => {
    let code = fs.readFileSync(path.join(__dirname, f), "utf8");
    return code.replace(/^\s*importScripts\(.*\);?\s*$/gm, ""); // 由拼接本身模拟
  }).join("\n;\n");
  try {
    new vm.Script(src, { filename: name });
    check(name + " 无重复声明", true);
  } catch (e) {
    check(name + " 无重复声明 —— " + e.message, false);
  }
}
checkNoScopeConflict("i18n + lib.js + mailscan.js + llm.js + catalog.js + history.js + auth.js + background.js（service worker）", ["i18n.js", "i18n-en.js", "lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "activity.js", "background.js"]);
checkNoScopeConflict("i18n + lib.js + catalog.js + auth.js + popup.js（弹窗页）", ["i18n.js", "i18n-en.js", "lib.js", "catalog.js", "auth.js", "sync.js", "popup.js"]);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
