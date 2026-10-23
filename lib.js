// 纯逻辑函数（无浏览器依赖，可被 background.js 引入，也可被 node 直接测试）

const DAY = 86400000;
const DEFAULT_IDLE_DAYS = 30;

// 把用户填的各种写法归一成域名：https://www.netflix.com/browse → netflix.com
function normalizeDomain(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")  // 去协议
    .replace(/\/.*$/, "")          // 去路径
    .replace(/:\d+$/, "")          // 去端口
    .replace(/^www\./, "");        // 去 www
}

// 访问的域名是否命中某个订阅（支持子域名，如 tv.netflix.com 命中 netflix.com）
function hostMatches(host, pattern) {
  const p = normalizeDomain(pattern);
  const h = normalizeDomain(host);
  if (!p || !h) return false;
  return h === p || h.endsWith("." + p);
}

// 把 YouTube 历史页的日期分组标签解析成时间戳（中英文都尽量支持）
// 解析不出来返回 null —— 宁可不知道，也不要瞎猜造成误报
function parseLabelToTs(label, now) {
  if (!label) return null;
  const base = typeof now === "number" ? now : Date.now();
  const s = String(label).trim();
  const today = new Date(base);
  today.setHours(0, 0, 0, 0);

  if (/^(今天|今日|today)$/i.test(s)) return today.getTime();
  if (/^(昨天|昨日|yesterday)$/i.test(s)) return today.getTime() - DAY;
  if (/^前天$/.test(s)) return today.getTime() - 2 * DAY;
  // 星期几（YouTube 观看记录一周内的分组标题）：取最近过去的那一天；和今天同一个星期几就是 7 天前（今天的会写「今天」）
  const WD = { "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
               sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  let w = s.match(/^(?:星期|周|禮拜|礼拜)([日天一二三四五六])$/);
  let wd = w ? WD[w[1]] : WD[s.toLowerCase()];
  if (wd !== undefined) {
    let diff = (today.getDay() - wd + 7) % 7;
    if (diff === 0) diff = 7;
    return today.getTime() - diff * DAY;
  }
  let n = s.match(/^(\d{1,2})\s*天前$/);
  if (n) return today.getTime() - parseInt(n[1], 10) * DAY;
  // 10-16 / 10/16（没写年份：按今年，晚于今天就算去年）
  n = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (n) {
    let d = new Date(new Date(base).getFullYear(), parseInt(n[1], 10) - 1, parseInt(n[2], 10));
    if (d.getTime() > base) d = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
    if (!isNaN(d.getTime())) return d.getTime();
  }
  // 2026-10-16 / 2026.10.16
  n = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (n) { const d = new Date(parseInt(n[1], 10), parseInt(n[2], 10) - 1, parseInt(n[3], 10)); if (!isNaN(d.getTime())) return d.getTime(); }

  // 2026年9月10日 / 9月10日
  let m = s.match(/^(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (m) {
    const y = m[1] ? parseInt(m[1], 10) : new Date(base).getFullYear();
    const d = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // Sep 10, 2026 / September 10, 2026 / Sep 10
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (m) {
    const year = m[3] ? m[3] : String(new Date(base).getFullYear());
    const t = Date.parse(`${m[1]} ${m[2]}, ${year}`);
    if (!isNaN(t)) return t;
  }

  return null;
}

// 信号中断的原因文案
const SIGNAL_REASONS = {
  logged_out: "需要重新登录",
  history_off: "该服务的历史记录已关闭",
  read_failed: "读取失败",
  no_permission: "还没授权读取该网站"
};

// 计算某个订阅现在处于什么状态
// unmonitored = 用户标注了在电视/手机上用，不参与判断（防误报）
// signal_lost = 读不到活动记录（未登录/cookie 失效/历史关闭）→ 这是"测不到"，不是"没在用"
// baseline    = 还没有可信的"最近使用"基线，暂不判断
// active      = 在用
// idle        = 闲置超过阈值，可提醒退订
//
// 关键原则：signal_lost 必须优先于 idle。
// 读不到数据时 lastUsed 会一直停在旧值，天数却在涨；
// 若不拦住，就会对一个天天在用的服务发出"已闲置 N 天，建议退订"的错误建议。
function computeStatus(sub, now) {
  const base = typeof now === "number" ? now : Date.now();
  if (!sub || sub.mode === "none") return { state: "unmonitored", days: null, reason: null };

  if (sub.mode === "activity" && sub.signal && sub.signal.ok === false) {
    const brokenDays = sub.signal.since ? Math.floor((base - sub.signal.since) / DAY) : 0;
    return { state: "signal_lost", days: brokenDays, reason: sub.signal.reason || "read_failed" };
  }

  if (!sub.lastUsed) return { state: "baseline", days: null, reason: null };
  const days = Math.floor((base - sub.lastUsed) / DAY);
  const threshold = sub.idleDays || DEFAULT_IDLE_DAYS;
  return { state: days >= threshold ? "idle" : "active", days, reason: null };
}

// 是否该就"信号中断"提醒用户。
// 单次失败可能只是网络抖动，连续失败 2 次才提醒，避免噪音。
function shouldWarnSignal(sub) {
  return !!(sub && sub.mode === "activity" && sub.signal &&
            sub.signal.ok === false && (sub.signal.fails || 0) >= 2);
}

// 闲置订阅每月共计浪费多少钱
function wastedPerMonth(subs, now) {
  let sum = 0;
  for (const s of subs || []) {
    if (computeStatus(s, now).state === "idle") sum += Number(s.price) || 0;
  }
  return Math.round(sum * 100) / 100;
}

// ---------- 访问次数 ----------
// 一次「访问」= 一段连续使用：同一个订阅的网站 30 分钟内的多次打开 / 页内跳转只算一次。
// visitLog 是每次访问开始的时间（只保留 90 天、最多 1000 条）。开了云端同步时按分钟精度同步（见 sync.js），不含网址。
const VISIT_GAP = 30 * 60 * 1000;
const VISIT_KEEP_DAYS = 90;
function mergeVisits(log, times, now) {
  const base = typeof now === "number" ? now : Date.now();
  const since = base - VISIT_KEEP_DAYS * DAY;
  const all = (log || []).concat(times || []).filter(t => typeof t === "number" && t >= since && t <= base + 60000).sort((a, b) => a - b);
  const out = [];
  for (const t of all) if (!out.length || t - out[out.length - 1] >= VISIT_GAP) out.push(t);
  return out.slice(-1000);
}
function visitStats(log, now) {
  const base = typeof now === "number" ? now : Date.now();
  const v = log || [];
  return {
    last: v.length ? v[v.length - 1] : null,
    d7: v.filter(t => t >= base - 7 * DAY).length,
    d30: v.filter(t => t >= base - 30 * DAY).length,
    d90: v.length
  };
}

// 这个订阅当前是否有可靠的「观看时间」信号：观看记录读取正常，且上次读到了具体时间或日期。
// 只有一串条目、没有时间的记录不算（不靠「列表变没变」推断，推断不稳）。
// timeOk 是 v2.28.1 起才有的字段；以前的数据看有没有读到过观看日期（lastWatched）
function hasWatchTime(s) {
  if (!s || s.mode !== "activity" || (s.signal && s.signal.ok === false)) return false;
  if (s.timeOk === true) return true;
  if (s.timeOk === false) return false;
  return !!s.lastWatched;
}

globalThis.SubLib = {
  hasWatchTime,
  DAY, DEFAULT_IDLE_DAYS, SIGNAL_REASONS,
  normalizeDomain, hostMatches, parseLabelToTs, computeStatus, wastedPerMonth, shouldWarnSignal,
  VISIT_GAP, mergeVisits, visitStats
};
