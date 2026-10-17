// 订阅闲置监控 · 后台
// 两种使用信号：
//   mode = "browser"  → 监控浏览器是否访问过该订阅的网址
//   mode = "activity" → 读取服务自身的活动记录（目前支持 YouTube 观看历史，设备无关）
//   mode = "none"     → 用户标注"我在电视/手机上用"，不参与闲置判断（防误报）

// 注意：importScripts 载入的脚本与本文件共享同一个全局作用域，
// lib.js 里的 DAY / hostMatches / parseLabelToTs / computeStatus 等可直接使用。
// 千万不要再用 const 解构一遍同名变量 —— 会触发 "Identifier has already been declared"。
importScripts("lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js");

const MAX_RECORDS = 2000;

// ---------- 串行化存储读写，避免并发覆盖 ----------
let chain = Promise.resolve();
function withLock(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function getSubs() {
  const { subs = [] } = await chrome.storage.local.get("subs");
  return subs;
}
async function setSubs(subs, opts) {
  await chrome.storage.local.set({ subs });
  if (!(opts && opts.fromSync)) scheduleSync();   // 开了云端同步的话，稍后上传
}

// ---------- 插件自己在后台打开的标签页 ----------
// 读账户页 / 活动页时会在后台打开网站，这些访问不是用户在用，不能算进「浏览器访问」。
// 插件自己打开的标签页 → 到什么时候为止这个标签里的访问都不算「用户在用」
// 后台读取用的标签：一直不算；给用户看的（点通知、「打开账户页」「去处理」）：打开后 2 分钟内不算，之后用户在里面接着用就算
const ownTabs = new Map();
const OWN_USER_TAB_MS = 2 * 60 * 1000;
// 后台读取的网页统一放进一个「最小化的专用窗口」里打开：你当前窗口的标签栏里什么都不会出现。
// 窗口里留一个空白页撑着，一次检查里连续读好几个网站时不用反复建窗口；都读完 5 秒后关掉整个窗口。
// active=true（如 Gmail 扫描勾了「显示标签页」）时仍在当前窗口正常打开。
let readerWindowId = null;
let readerWindowLock = Promise.resolve();
const readerTabs = new Set();
let readerCloseTimer = null;
async function ensureReaderWindow() {
  if (readerWindowId != null) {
    try { await chrome.windows.get(readerWindowId); return readerWindowId; } catch (e) { readerWindowId = null; }
  }
  const win = await chrome.windows.create({ url: "about:blank", state: "minimized", focused: false });
  readerWindowId = win.id;
  return readerWindowId;
}
async function openInReaderWindow(url) {
  if (!chrome.windows || !chrome.windows.create) return chrome.tabs.create({ url, active: false });
  if (readerCloseTimer) { clearTimeout(readerCloseTimer); readerCloseTimer = null; }
  // 串行化：同时有好几个读取时，只建一个窗口
  const job = readerWindowLock.then(async () => {
    try {
      const windowId = await ensureReaderWindow();
      return await chrome.tabs.create({ windowId, url, active: false });
    } catch (e) {
      // 建不了最小化窗口（个别系统）或窗口刚被关掉：退回到当前窗口的后台标签
      readerWindowId = null;
      return chrome.tabs.create({ url, active: false });
    }
  });
  readerWindowLock = job.catch(() => {});
  const tab = await job;
  if (tab && tab.windowId === readerWindowId) readerTabs.add(tab.id);
  return tab;
}
function onReaderTabGone(tabId) {
  if (!readerTabs.delete(tabId) || readerTabs.size || readerWindowId == null) return;
  if (readerCloseTimer) clearTimeout(readerCloseTimer);
  readerCloseTimer = setTimeout(() => {
    readerCloseTimer = null;
    if (readerTabs.size || readerWindowId == null) return;
    const id = readerWindowId;
    readerWindowId = null;
    chrome.windows.remove(id).catch(() => {});
  }, 5000);
}
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener(id => { if (id === readerWindowId) { readerWindowId = null; readerTabs.clear(); } });
}

// 插件打开的网页也会进 Chrome 的浏览历史；记下网站和时间，读历史时排除
async function recordOwnVisit(host) {
  if (!host) return;
  try {
    const { ownVisits = [] } = await chrome.storage.local.get(["ownVisits"]);
    const now = Date.now();
    // 同一网站 1 分钟内只记一条
    if (ownVisits.some(o => o.host === host && now - o.time < 60000)) return;
    ownVisits.push({ host, time: now });
    await chrome.storage.local.set({ ownVisits: ownVisits.filter(o => now - o.time < 100 * DAY).slice(-500) });
  } catch (e) {}
}
async function openBgTab(url, active) {
  const tab = active ? await chrome.tabs.create({ url, active: true }) : await openInReaderWindow(url);
  ownTabs.set(tab.id, Infinity);
  await recordOwnVisit(HistLib.hostOf(url));
  return tab;
}
// 给用户看的页面（点通知、「打开账户页」「去处理」）：打开的那一下不算在用
async function openUserTab(url) {
  try { const tab = await openBgTab(url, true); ownTabs.set(tab.id, Date.now() + OWN_USER_TAB_MS); } catch (e) {}
}
chrome.tabs.onRemoved.addListener(id => { ownTabs.delete(id); onReaderTabGone(id); });

// ---------- 信号一：浏览器访问 ----------
async function onVisit(url, tabId) {
  if (!/^https?:/i.test(url)) return;
  if (tabId != null && ownTabs.has(tabId)) {
    if (Date.now() < ownTabs.get(tabId)) {
      // 跳转到的其它网站（比如登录页、子域名）也记下来，读浏览历史时一并排除
      let h = null; try { h = new URL(url).hostname; } catch (e) {}
      await recordOwnVisit(h && h.replace(/^www\./, ""));
      return;
    }
    ownTabs.delete(tabId);
  }
  let host;
  try { host = new URL(url).hostname; } catch (e) { return; }

  await withLock(async () => {
    // 记录访问日志（供"访问记录"页查看）
    const { records = [], paused = false } = await chrome.storage.local.get(["records", "paused"]);
    if (!paused) {
      // 只记网站和时间（用于「历史发现」和新订阅的起点），不存完整网址
      records.push({ hostname: host, time: Date.now() });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
      await chrome.storage.local.set({ records });
    }

    // 命中订阅：记一次访问（所有订阅都记）；浏览器访问型、视频类活动记录型还要刷新「最近使用」
    const subs = await getSubs();
    let changed = false, newVisit = false;
    const now = Date.now();
    for (const s of subs) {
      if (!subDomains(s).some(d => hostMatches(host, d))) continue;
      const lastBefore = (s.visitLog || [])[(s.visitLog || []).length - 1];
      s.visitLog = mergeVisits(s.visitLog, [now], now);
      // 记录满 1000 条时长度不变，所以看最后一条有没有变
      if (s.visitLog[s.visitLog.length - 1] !== lastBefore) changed = newVisit = true;
      if (visitCountsAsUse(s)) {
        s.lastUsed = now;
        s.lastUsedFloor = false;
        s.notified = null; // 重新活跃，清掉提醒去重标记
        changed = true;
      }
    }
    // 只有新的一次访问开始时才触发云端同步；同一次访问里的页面跳转只更新本机的「最近使用」，下次同步时一起带上
    if (changed) await setSubs(subs, { fromSync: !newVisit });
  });
}

chrome.webNavigation.onCompleted.addListener(d => { if (d.frameId === 0) onVisit(d.url, d.tabId); });
chrome.webNavigation.onHistoryStateUpdated.addListener(d => { if (d.frameId === 0) onVisit(d.url, d.tabId); });

// ---------- 信号二：服务自身的活动记录 ----------
// 服务目录。每一项描述"去哪个页面、怎么取出活动项"，而不是写死一段解析代码。
//
// 核心思路：判断"还在用"靠的是【指纹比对】—— 把活动列表里的条目 ID 取出来做指纹，
// 两次检查之间指纹变了，说明用户又用了。这个思路是服务无关的：
// 不需要看懂每家的数据模型，只要能稳定地抓到"最近活动项的 ID"就行。
// 所以绝大多数服务用通用抓取（generic）即可，只有 YouTube 这种把数据放在
// 页面 JS 变量里的才需要专用解析。
//
// verified 字段是诚实标注：
//   true  = 页面地址和解析方式都实测过
//   false = 地址有官方依据，但页面结构未实测 —— 请用弹窗里的「诊断」按钮验证
const CATALOG = {
  youtube: {
    name: "YouTube",
    domain: "youtube.com",
    activityUrl: "https://www.youtube.com/feed/history",
    strategy: "youtube",
    verified: true,
    note: "读取观看历史。需在本浏览器登录，且未关闭/暂停观看记录。"
  },
  netflix: {
    name: "Netflix",
    domain: "netflix.com",
    activityUrl: "https://www.netflix.com/settings/viewing-history",
    strategy: "generic",
    idPattern: "/(?:title|watch)/(\\d+)",
    loginUrlPattern: "/login|/signin",
    verified: false,
    note: "官方帮助中心确认该页面存在，且按当前选中的「个人档案」显示。页面结构未实测，请先点「诊断」验证。"
  },
  primevideo: {
    name: "Prime Video",
    domain: "primevideo.com",
    activityUrl: "https://www.primevideo.com/settings/watch-history",
    strategy: "generic",
    idPattern: "/detail/([A-Za-z0-9]+)",
    loginUrlPattern: "/ap/signin|/gp/sign-in",
    verified: false,
    note: "Amazon 官方页面。页面结构未实测，请先点「诊断」验证。"
  },
  claude: {
    name: "Claude",
    domain: "claude.ai",
    activityUrl: "https://claude.ai/",
    strategy: "llm",
    verified: false,
    note: "读取套餐、对话时间（不读内容）和「设置 → 用量」里的额度百分比。对话会跨设备同步，手机上用的也算。需要在本浏览器登录 claude.ai。建议用「我的订阅」页的一键添加。"
  },
  chatgpt: {
    name: "ChatGPT",
    domain: "chatgpt.com",
    activityUrl: "https://chatgpt.com/",
    strategy: "llm",
    verified: false,
    note: "读取套餐和对话时间（不读内容）。对话会跨设备同步，手机上用的也算。需要在本浏览器登录 chatgpt.com。建议用「我的订阅」页的一键添加。"
  },
  bilibili: {
    name: "B站",
    domain: "bilibili.com",
    activityUrl: "https://www.bilibili.com/account/history",
    strategy: "generic",
    idPattern: "/video/(BV[0-9A-Za-z]+)",
    loginUrlPattern: "passport\\.bilibili\\.com|/login",
    verified: false,
    note: "读取 B站的历史记录页（网页、App、电视上看的都会同步到这里）。页面结构未实测，请先点「诊断」验证。"
  },
  custom: {
    name: "自定义（自己填活动页地址）",
    activityUrl: "",
    strategy: "generic",
    verified: false,
    note: "填入该服务「最近活动/播放记录」页面的地址。可选填条目 ID 的正则和容器选择器，再用「诊断」看抓到了什么。"
  }
};

// 已知【没有】网页版活动页的服务 —— 与其让用户白试，不如直接说清楚该怎么办
const NO_ACTIVITY_PAGE = [
  { match: "spotify.com",    tip: "Spotify 网页端没有可访问的收听历史页（只在 App 内的 Recents 里）。" },
  { match: "disneyplus.com", tip: "Disney+ 未提供观看历史页面。" },
  { match: "hulu.com",       tip: "Hulu 未提供可抓取的观看历史页面。" },
  { match: "max.com",        tip: "HBO Max 未提供观看历史页面。" },
  { match: "hbomax.com",     tip: "HBO Max 未提供观看历史页面。" }
];

// 通用抓取：适用于任何"活动页里是一串条目链接"的服务。
// 两种失败方式都是安全的：抓不到 → 信号中断（冻结判断）；抓到无关内容 →
// 指纹一直在变 → 判成"在用" → 顶多漏提醒，绝不会误报让你退订。
async function genericExtract(cfg) {
  const out = { ids: [], topLabel: "", loggedOut: null, historyOff: false, pageUrl: location.href };
  // 前端渲染的列表：最多等 waitMs，等到能抓到条目为止
  if (cfg.waitMs && cfg.idPattern) {
    let re0 = null; try { re0 = new RegExp(cfg.idPattern); } catch (e) {}
    const until = Date.now() + cfg.waitMs;
    while (re0 && Date.now() < until && ![...document.querySelectorAll("a[href]")].some(a => re0.test(a.getAttribute("href") || ""))) {
      await new Promise(r => setTimeout(r, 300));
    }
    out.pageUrl = location.href;
  }
  try {
    const lp = cfg.loginUrlPattern
      ? new RegExp(cfg.loginUrlPattern, "i")
      : /\/(login|signin|sign-in|auth)\b/i;
    if (lp.test(location.href)) out.loggedOut = true;
  } catch (e) { /* 忽略 */ }

  let root = null;
  try { root = cfg.containerSelector ? document.querySelector(cfg.containerSelector) : document.body; }
  catch (e) { root = document.body; }
  if (!root) return out;

  let idRe = null;
  try { if (cfg.idPattern) idRe = new RegExp(cfg.idPattern); } catch (e) { idRe = null; }

  const seen = Object.create(null);
  const anchors = root.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length && out.ids.length < 20; i++) {
    const href = anchors[i].getAttribute("href") || "";
    let id = null;
    if (idRe) {
      const m = href.match(idRe);
      if (m) id = m[1] || m[0];
    } else if (/\d/.test(href) && href.length > 3) {
      id = href.split("?")[0]; // 没给正则时退而求其次：用链接路径本身
    }
    if (id && !seen[id]) { seen[id] = 1; out.ids.push(id); }
  }
  // 分组标题（今天 / 昨天 / 更早 / 10月16日…）：取页面上第一个
  if (cfg.labels) {
    const LABEL = /^(今天|今日|昨天|昨日|前天|\d{1,2}\s*天前|本周|一周内|7\s*天内|更早|\d{1,2}\s*月\s*\d{1,2}\s*日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/]\d{1,2})$/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || "").trim();
      if (t && t.length <= 12 && LABEL.test(t)) { out.topLabel = t; break; }
    }
  }
  return out;
}

// YouTube 专用：数据在页面的 ytInitialData 变量里，不是 DOM 链接
function youtubeExtract() {
      const ids = [];
      let topLabel = "";
      let loggedOut = null;   // true=确认未登录, false=确认已登录, null=判断不出来
      let historyOff = false;
      const txt = (n) => {
        if (!n) return "";
        if (n.simpleText) return n.simpleText;
        if (Array.isArray(n.runs)) return n.runs.map(r => r.text).join("");
        return "";
      };
      const data = window.ytInitialData;

      // 登录态信号一：YouTube 自己的配置里有 LOGGED_IN 布尔值
      try {
        if (window.ytcfg && typeof window.ytcfg.get === "function") {
          const li = window.ytcfg.get("LOGGED_IN");
          if (typeof li === "boolean") loggedOut = !li;
        }
      } catch (e) { /* 忽略 */ }

      // 登录态信号二：响应上下文里的 loggedOut 字段
      if (loggedOut === null && data) {
        try {
          const rc = data.responseContext && data.responseContext.mainAppWebResponseContext;
          if (rc && typeof rc.loggedOut === "boolean") loggedOut = rc.loggedOut;
        } catch (e) { /* 忽略 */ }
      }

      if (data) {
        (function walk(n) {
          if (Array.isArray(n)) { for (const x of n) walk(x); return; }
          if (n && typeof n === "object") {
            if (!topLabel && n.itemSectionRenderer) {
              const h = n.itemSectionRenderer.header;
              const t = h && h.itemSectionHeaderRenderer && h.itemSectionHeaderRenderer.title;
              if (t) topLabel = txt(t);
            }
            if (n.videoRenderer && n.videoRenderer.videoId && ids.length < 10) {
              ids.push(n.videoRenderer.videoId);
            }
            // 新版观看记录页用 lockupViewModel 渲染视频
            if (n.lockupViewModel && n.lockupViewModel.contentId && ids.length < 10 &&
                (!n.lockupViewModel.contentType || /VIDEO/.test(n.lockupViewModel.contentType)) && ids.indexOf(n.lockupViewModel.contentId) < 0) {
              ids.push(n.lockupViewModel.contentId);
            }
            for (const k in n) walk(n[k]);
          }
        })(data);
      }
      if (!ids.length) { // DOM 兜底
        document.querySelectorAll("ytd-video-renderer a#video-title, ytd-browse a[href*='/watch?v=']").forEach(a => {
          const m = (a.href || "").match(/[?&]v=([^&]+)/);
          if (m && ids.length < 10) ids.push(m[1]);
        });
      }

      // 没读到视频时，再判断是不是"历史记录被关闭/暂停"（和"未登录"要分开处理）
      if (!ids.length && data) {
        try {
          const s = JSON.stringify(data);
          if (/观看记录已暂停|記錄已暫停|watch history is paused|history is off|turn on watch history/i.test(s)) {
            historyOff = true;
          }
        } catch (e) { /* 忽略 */ }
      }

      return { ids, topLabel, loggedOut, historyOff };
}

// 把目录项和用户在订阅里填的覆盖值合成一份最终配置
function getProviderConfig(sub) {
  const base = CATALOG[sub && sub.provider] || null;
  if (!base) return null;
  return {
    key: sub.provider,
    name: base.name,
    strategy: base.strategy,
    activityUrl: sub.activityUrl || base.activityUrl,
    idPattern: sub.idPattern || base.idPattern || null,
    containerSelector: sub.containerSelector || base.containerSelector || null,
    waitMs: base.waitMs || 0,
    labels: !!base.labels,
    loginUrlPattern: base.loginUrlPattern || null
  };
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// 后台悄悄开标签读活动记录（第一方环境，登录 Cookie 才生效），读完即关
async function readActivity(cfg) {
  if (!cfg || !cfg.activityUrl) return null;
  const tab = await openBgTab(cfg.activityUrl, false);
  try {
    await waitForComplete(tab.id);
    await new Promise(r => setTimeout(r, 1200)); // 等页面渲染（有些站点是前端渲染的）
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      ...(cfg.strategy === "youtube"
        ? { func: youtubeExtract }
        : { func: genericExtract, args: [{
            idPattern: cfg.idPattern,
            containerSelector: cfg.containerSelector,
            loginUrlPattern: cfg.loginUrlPattern,
            waitMs: cfg.waitMs || 0,
            labels: !!cfg.labels
          }] })
    });
    return (res && res[0] && res[0].result) || null;
  } catch (e) {
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// 用活动记录更新某订阅的"最近使用"
// 核心技巧：比对最近视频 ID 指纹。指纹变了 = 这段时间又看了新内容 = 现在在用。
// 这比解析"今天/昨天"这类日期文案更稳，也不受语言/改版影响。
async function updateFromActivity(sub) {
  const r = await readActivity(getProviderConfig(sub));
  const now = Date.now();
  sub.lastChecked = now;
  if (!sub.signal) sub.signal = { ok: true, reason: null, since: null, lastOk: null, fails: 0 };

  // 读取失败 → 标记信号中断。
  // 注意这里绝不能动 lastUsed：我们不知道用户用没用，只是测不到。
  // computeStatus 会因为 signal.ok===false 把状态判成 signal_lost，从而不发退订建议。
  const markFail = (reason) => {
    sub.signal.ok = false;
    sub.signal.reason = reason;
    sub.signal.fails = (sub.signal.fails || 0) + 1;
    if (!sub.signal.since) sub.signal.since = now;
    return false;
  };

  if (!r) return markFail("read_failed");
  if (r.loggedOut === true) return markFail("logged_out");
  if (!r.ids || !r.ids.length) return markFail(r.historyOff ? "history_off" : "read_failed");

  // 读取成功 → 信号恢复
  const wasBroken = sub.signal.ok === false;
  sub.signal = { ok: true, reason: null, since: null, lastOk: now, fails: 0 };
  sub.signalNotified = null;

  const sig = r.ids.slice(0, 5).join(",");
  // 观看记录第一组的日期标题（今天 / 昨天 / 星期一 / 10月12日…）= 最近一次观看的日子。读得出来就以它为准
  const watched = parseLabelToTs(r.topLabel, now);
  if (watched) {
    if (watched > (sub.lastWatched || 0) || sig !== sub.sig) sub.notified = null;
    sub.lastWatched = watched;
    sub.watchAt = now;          // 什么时候读的观看记录（多台设备同步时以读得晚的为准）
    sub.lastUsed = watched;
    sub.lastUsedFloor = false;
    sub.sig = sig;
    return true;
  }

  // 中断期间如果对方有了新记录，说明这段时间用户是在用的。
  // 我们不知道具体哪天用的，按"最近"算 —— 宁可漏提醒，也不要误报。
  if (wasBroken && sub.sig && sig !== sub.sig) {
    sub.lastUsed = now;
    sub.notified = null;
    sub.sig = sig;
    return true;
  }

  if (sub.sig && sig !== sub.sig) {
    // 指纹变化 → 确认在用
    sub.lastUsed = now;
    sub.notified = null;
  } else if (!sub.sig) {
    // 首次检查：尝试用日期标签估算；解析不出就只建立基线，不下结论（避免首次误判）
    const est = parseLabelToTs(r.topLabel, now);
    if (est) sub.lastUsed = est;
  }
  sub.sig = sig;
  return true;
}

// ---------- 邮箱发现：扫描 Gmail 搜索结果，找出可能在付费的订阅（手动触发） ----------
// 和读活动记录一样：后台开一个 Gmail 标签页，在已登录的页面里读列表，读完即关。
// 只读搜索结果列表，不打开邮件正文；结果只存在本机 chrome.storage.local。
const GMAIL_ORIGIN = "https://mail.google.com/*";
let mailScanning = false;

async function setMailScan(patch) {
  const { mailScan = {} } = await chrome.storage.local.get("mailScan");
  const next = { ...mailScan, ...patch };
  await chrome.storage.local.set({ mailScan: next });
  return next;
}

// 有限并发地处理一批任务（「检查」时最多同时读 4 个订阅）
async function mapLimit(items, limit, fn, onEach) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { __error: e }; }
      done++;
      if (onEach) await onEach(done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// 邮箱发现只保留「读取 Gmail 网页」一种方式（Gmail 接口模式已移除）
async function mailScanPrecheck(o) {
  if (mailScanning) return { ok: false, reason: "busy" };
  const has = await chrome.permissions.contains({ origins: [GMAIL_ORIGIN] });
  return has ? { ok: true } : { ok: false, reason: "no_permission" };
}

async function runMailScan(opts) {
  const o = opts || {};
  const account = Math.max(0, parseInt(o.account, 10) || 0);
  const pages = Math.min(20, Math.max(1, parseInt(o.pages, 10) || 5));
  const query = MailLib.DEFAULT_QUERY;
  mailScanning = true;
  await setMailScan({ status: "running", source: "web", startedAt: Date.now(), account, pages, progress: 0, rowsRead: 0, error: null, errorDetail: null });

  let tab = null, stats = null;
  try {
    tab = await openBgTab(MailLib.gmailSearchUrl(account, query, 1), !!o.showTab);
    await waitForComplete(tab.id);

    const rows = [], seen = new Set();
    let prevFp = "", firstCount = 0, pagesRead = 0, email = "", warn = null;

    for (let p = 1; p <= pages; p++) {
      if (p > 1) await chrome.tabs.update(tab.id, { url: MailLib.gmailSearchUrl(account, query, p) });
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: MailLib.gmailExtractPage,
        args: [{ prevFp, timeoutMs: p === 1 ? 25000 : 12000 }]
      });
      const r = res && res[0] && res[0].result;
      if (!r) { if (p === 1) throw new Error("read_failed"); break; }
      if (r.loggedOut) throw new Error("logged_out");
      if (p === 1) stats = r.stats;
      if (r.account) email = r.account;
      if (r.noResults) break;                       // 没有（更多）结果
      if (!r.rows.length) { if (p === 1) throw new Error("read_failed"); break; }
      if (r.fp === prevFp) break;                   // 翻页后内容没变 = 已经是最后一页
      if (r.timedOut) warn = "timeout";

      for (const row of r.rows) {
        const k = row.threadId || [row.email, row.subject, row.date].join("|");
        if (!seen.has(k)) { seen.add(k); rows.push(row); }
      }
      pagesRead++;
      prevFp = r.fp;
      await setMailScan({ progress: p, rowsRead: rows.length });

      if (p === 1) { firstCount = r.rows.length; if (firstCount < 10) break; } // Gmail 每页至少 10 封，不满说明只有一页
      else if (r.rows.length < firstCount) break;   // 这页没满 = 最后一页
    }

    const agg = MailLib.aggregateMails(rows, Date.now());
    await setMailScan({
      status: "done", source: "web", finishedAt: Date.now(), email, pagesRead, rowsRead: rows.length, bodyRead: 0,
      billingRows: agg.billingRows, candidates: agg.candidates, warn, stats, error: null
    });
  } catch (e) {
    const reason = /logged_out/.test(String(e && e.message)) ? "logged_out" : "read_failed";
    await setMailScan({ status: "error", finishedAt: Date.now(), error: reason, stats });
  } finally {
    mailScanning = false;
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}


// ---------- 大模型订阅（ChatGPT / Claude） ----------
// 在已登录的网站页面里读套餐、对话时间、用量。优先借用你已经打开的该网站标签页；
// 没有的话在后台开一个，读完即关。只读时间和数字，不读对话标题和内容。
const LLM_ORIGINS = { claude: "https://claude.ai/*", chatgpt: "https://chatgpt.com/*" };

async function readLlm(kind) {
  const site = LlmLib.LLM_SITES[kind];
  if (!site) return { error: "unknown_kind" };
  const has = await chrome.permissions.contains({ origins: [LLM_ORIGINS[kind]] });
  if (!has) return { error: "no_permission" };

  // 先在后台直接调它网页用的接口（带浏览器里的登录状态），不用开任何窗口；读不到再退回打开网页读
  try {
    const d = await LlmLib.llmReadPage({ kind, base: "https://" + site.domain });
    if (d && d.ok) return d;
  } catch (e) { /* 退回打开网页 */ }

  let tabId = null, created = false;
  try {
    const open = await chrome.tabs.query({ url: `https://${site.domain}/*` });
    const usable = open.find(t => t.status === "complete" && !t.discarded);
    if (usable) {
      tabId = usable.id;
    } else {
      const tab = await openBgTab(site.home, false);
      tabId = tab.id; created = true;
      await waitForComplete(tabId);
      await new Promise(r => setTimeout(r, 1500));
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: LlmLib.llmReadPage, args: [{ kind }]
    });
    return (res && res[0] && res[0].result) || { error: "read_failed" };
  } catch (e) {
    return { error: "read_failed", detail: String(e && e.message || e) };
  } finally {
    if (created && tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// 把一次读取结果写进订阅。返回 true = 读取成功。
function applyLlmResult(sub, r, now) {
  const kind = sub.provider;
  sub.lastChecked = now;
  if (!sub.signal) sub.signal = { ok: true, reason: null, since: null, lastOk: null, fails: 0 };
  const markFail = (reason) => {
    sub.signal.ok = false;
    sub.signal.reason = reason;
    sub.signal.fails = (sub.signal.fails || 0) + 1;
    if (!sub.signal.since) sub.signal.since = now;
    return false;
  };
  if (!r) return markFail("read_failed");
  if (r.error === "no_permission") return markFail("no_permission");
  if (r.loggedOut === true) return markFail("logged_out");
  if (!r.ok) return markFail("read_failed");

  const prev = sub.llm || {};
  const plan = LlmLib.normalizePlan(kind, r.plan);
  const usage = LlmLib.pickUsage(r.usage);
  const renewTs = LlmLib.parseTs(r.renew);
  const llm = {
    kind, plan,
    origin: LlmLib.normalizeOrigin(r.plan && r.plan.origin),
    willRenew: r.plan && typeof r.plan.will_renew === "boolean" ? r.plan.will_renew : null,
    stats: LlmLib.llmStats(r.timestamps, now),
    convCount: r.convCount || 0,
    usage,
    samples: LlmLib.addSample(prev.samples, usage, now),
    renewAt: renewTs && renewTs > now - DAY ? renewTs : null,
    updatedAt: now
  };
  llm.advice = LlmLib.llmAdvice(kind, llm, now);
  sub.llm = llm;

  // 真实的「最近使用时间」直接来自对话时间，不需要指纹和基线
  if (llm.stats.lastUsed && llm.stats.lastUsed > (sub.lastUsed || 0)) {
    sub.lastUsed = llm.stats.lastUsed;
    sub.notified = null;
  }
  sub.signal = { ok: true, reason: null, since: null, lastOk: now, fails: 0 };
  sub.signalNotified = null;
  return true;
}

async function updateFromLlm(sub) {
  const r = await readLlm(sub.provider);
  return applyLlmResult(sub, r, Date.now());
}

// 两家都付费、其中一家用得少很多 → 在用得少的那条上挂「考虑只留一个」
function applyCrossAdvice(subs) {
  const items = subs.filter(s => s.mode === "activity" && s.llm && (s.provider === "claude" || s.provider === "chatgpt"));
  items.forEach(s => { s.llm.cross = null; });
  const c = LlmLib.crossAdvice(items);
  if (c) {
    const drop = items.find(s => s.id === c.drop);
    if (drop) drop.llm.cross = c.text;
  }
}

// ---------- 常见服务：读「账户 / 会员页」上的套餐、价格、续费日、空间用量 ----------
// 后台打开该服务的账户页，取页面文字交给 catalog.js 解析。只保存解析结果，不保存页面文字。
// 在插件后台直接调用量接口（带浏览器里的登录状态），不打开网页
async function readQuotaDirect(p) {
  try {
    const r = await fetch("https://" + p.domains[0] + p.quotaApi, { credentials: "include" });
    const j = await r.json();
    return j && j.total ? { used: j.used, total: j.total } : null;
  } catch (e) { return null; }
}
async function readAccount(p) {
  let has = false;
  try { has = await chrome.permissions.contains({ origins: SubCatalog.originsOf(p) }); } catch (e) { has = false; }
  if (!has) return { error: "no_permission" };
  let tab = null;
  try {
    tab = await openBgTab(p.accountUrl, false);
    await waitForComplete(tab.id);
    await new Promise(r => setTimeout(r, 800));
    let page = null;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: SubCatalog.pageTextExtract,
        args: [{ waitRe: SubCatalog.waitPattern(p), needRe: SubCatalog.needPattern(p), timeoutMs: 12000 }]
      });
      page = res && res[0] && res[0].result;
      // 有用量接口的服务（百度网盘）：在网站里调它自己的接口拿已用 / 总空间
      if (page && p.quotaApi) {
        try {
          const q = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: "MAIN",
            func: async (path) => {
              try {
                const r = await fetch(path, { credentials: "include" });
                const j = await r.json();
                return j && j.total ? { used: j.used, total: j.total, errno: j.errno } : { errno: j && j.errno };
              } catch (e) { return { error: String(e && e.message || e) }; }
            },
            args: [p.quotaApi]
          });
          const qr = q && q[0] && q[0].result;
          if (qr && qr.total) page.quota = { used: qr.used, total: qr.total };
          else page.quotaError = qr ? (qr.error || ("errno " + qr.errno)) : "no result";
        } catch (e) { page.quotaError = String(e && e.message || e); }
      }
    } catch (e) {
      // 注入失败通常是被跳到了别的域名（多半是登录页），记下最终地址交给解析判断
      let url = "";
      try { url = (await chrome.tabs.get(tab.id)).url || ""; } catch (e2) {}
      page = { url, text: "", injectError: String(e && e.message || e) };
    }
    return { page: page || { url: "", text: "" } };
  } catch (e) {
    return { error: "read_failed", detail: String(e && e.message || e) };
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// 把账户页读取结果写进订阅。失败时保留上次读到的套餐数据，只更新状态。
function applyAccount(sub, p, r, now) {
  const prev = sub.account || {};
  if (!r || r.error) {
    sub.account = Object.assign({}, prev, { status: r && r.error === "no_permission" ? "no_permission" : "read_failed", checkedAt: now });
    return;
  }
  const a = SubCatalog.parseAccountPage(p, r.page, { parseAmount: MailLib.parseAmount, parseDate: MailLib.parseMailDate }, now);
  if (r.page.injectError && a.status === "unknown") a.status = "read_failed";
  if (a.status === "ok") {
    sub.account = Object.assign(a, { checkedAt: now, updatedAt: now });
    // 页面上读到了价格：用户没手填过就用它（按月折算）
    if (a.price && (!sub.price || sub.priceSource === "page" || sub.priceEstimated)) {
      sub.price = a.price.monthly; sub.currency = a.price.currency; sub.priceSource = "page"; sub.priceEstimated = false;
    }
  } else {
    sub.account = Object.assign({}, prev, { status: a.status, checkedAt: now, url: a.url });
  }
}

// ---------- 浏览历史：装插件之前的使用情况也能算 ----------
// 需要可选权限 history（用户点按钮时才申请）。只按域名统计「哪天访问过」，不保存网址和标题。
async function hasHistoryPermission() {
  try { return !!(chrome.history && await chrome.permissions.contains({ permissions: ["history"] })); } catch (e) { return false; }
}
// 打开网站算不算「在用」：浏览器访问型当然算；视频 / 音乐这类活动记录型，在电脑上打开也是在看，
// 活动记录用来补上电视、手机上的使用。大模型只看有没有发起对话，打开页面不算。
// 观看记录已经读通了（有指纹、最近一次读取成功）就以观看记录为准：打开网站不等于看了视频；
// 观看记录还没读通（第一次、没登录、读取失败）时，退回用「打开网站」判断。
function visitCountsAsUse(s) {
  if (s.mode === "browser") return true;
  if (s.mode !== "activity") return false;
  const c = CATALOG[s.provider];
  if (!c || c.strategy === "llm") return false;
  return !(s.sig && s.signal && s.signal.ok !== false);
}
function subDomains(s) {
  const cp = s.catalogId && SubCatalog.BY_ID[s.catalogId];
  const doms = cp ? [cp.activityDomain].concat(cp.domains) : [];
  // 按读取方式（provider）添加的订阅：服务本身的域名也算，不受手填网址影响
  const pc = s.provider && CATALOG[s.provider];
  if (pc && pc.domain) doms.push(pc.domain);
  if (s.urlPattern) doms.push(normalizeDomain(s.urlPattern));
  return doms.filter(Boolean).map(d => String(d).toLowerCase().replace(/^www\./, ""));
}
async function historyScan() {
  if (!(await hasHistoryPermission())) return { ok: false, reason: "no_permission" };
  const now = Date.now(), start = now - HistLib.WINDOW_DAYS * DAY;
  const subs0 = await getSubs();
  const domains = new Set();
  SubCatalog.PROVIDERS.forEach(p => [p.activityDomain].concat(p.domains).filter(Boolean).forEach(d => domains.add(d)));
  subs0.forEach(s => subDomains(s).forEach(d => domains.add(d)));
  const doms = Array.from(domains);
  const items = await chrome.history.search({ text: "", startTime: start, maxResults: 100000 });
  const urls = HistLib.pickUrls(items, doms, start, 400);
  const visits = [];
  for (const url of urls) {
    // 只算这台设备上的访问（isLocal）：开了 Chrome 历史同步时，别的设备的访问也会出现在这里，
    // 那些访问由那台设备自己统计、经云端同步过来，这里再算就重复了（还会把那台设备检查时打开的页面算进来）
    try { (await chrome.history.getVisits({ url })).forEach(v => { if (v.isLocal !== false) visits.push({ url, time: v.visitTime }); }); } catch (e) {}
  }
  const { ownVisits = [] } = await chrome.storage.local.get(["ownVisits"]);
  const agg = HistLib.aggregate(visits, doms, ownVisits, now);
  const timesFor = (s) => [].concat(...subDomains(s).map(d => agg.times[d] || []));
  const history = { scannedAt: now, start: agg.start, byDomain: agg.byDomain, hits: agg.hits };
  let updated = 0;
  await withLock(async () => {
    const subs = await getSubs();
    // 以前（含别的设备检查时）混进来的「插件自己打开」的访问先去掉
    SyncLib.purgeOwn(subs, ownVisits, subDomains);
    for (const s of subs) {
      // 访问次数：所有订阅都用浏览历史补上装插件前的访问
      s.visitLog = mergeVisits(s.visitLog, timesFor(s), now);
      if (!visitCountsAsUse(s)) continue;
      const st = HistLib.statsFor(agg.byDomain, subDomains(s));
      if (s.mode !== "browser") {  // 视频类活动记录型：只用历史把「最近使用」往后推，不加「90 天没访问」占位
        if (st.last && st.last > (s.lastUsed || 0)) { s.lastUsed = st.last; s.lastUsedFloor = false; s.notified = null; updated++; }
        continue;
      }
      s.hist = { days30: st.days30, days90: st.days90, at: now };
      if (st.last && st.last > (s.lastUsed || 0)) { s.lastUsed = st.last; s.lastUsedFloor = false; s.notified = null; updated++; }
      else if (!st.last && !s.lastUsed) { s.lastUsed = agg.start; s.lastUsedFloor = true; updated++; }  // 90 天内都没访问过
    }
    await setSubs(subs);
    await chrome.storage.local.set({ history });
  });
  return { ok: true, updated, domains: Object.keys(agg.byDomain).length };
}

// ---------- 账号（Better Auth） ----------
// 未登录最多 5 个订阅；登录后不限（上限由服务端 /api/me 下发）。已有的订阅不会因为退出登录被删，只是不能再加新的。
async function getAuth() {
  const { auth = null } = await chrome.storage.local.get(["auth"]);
  return auth && auth.token && auth.user ? auth : null;
}
function publicAuth(a) { return a ? { user: a.user, subLimit: a.subLimit, verifiedAt: a.verifiedAt } : null; }
async function limitResult() {
  const a = await getAuth();
  return { ok: false, reason: "limit", limit: AuthLib.subLimit(a), loggedIn: !!a };
}
// 读取前先查一次：已经加过的（exists 为真）不受限制；超限就不用白白打开网页
async function limitCheck(exists) {
  const subs = await getSubs();
  if (exists(subs)) return null;
  return AuthLib.canAdd(subs.length, await getAuth()) ? null : await limitResult();
}
async function authSignIn(isSignUp, email, password, name) {
  email = String(email || "").trim().toLowerCase();
  if (!AuthLib.validEmail(email)) return { ok: false, error: AuthLib.ERR.INVALID_EMAIL };
  if (String(password || "").length < 8) return { ok: false, error: AuthLib.ERR.PASSWORD_TOO_SHORT };
  const path = isSignUp ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
  const body = isSignUp ? { email, password, name: String(name || "").trim().slice(0, 50) || email.split("@")[0] } : { email, password };
  const r = await AuthLib.call(AuthLib.AUTH_BASE_URL, path, { body });
  return finishSignIn(r, email);
}
// 登录接口返回后：拿 token、查 /api/me、存起来（邮箱密码和 Google 登录共用）
async function finishSignIn(r, email) {
  const token = r.token || (r.body && r.body.token);
  if (!r.ok || !token) return { ok: false, error: AuthLib.errorText(r.code, r.status) };
  const me = await AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/me", { token });
  const user = me.ok && me.body ? me.body.user : (r.body && r.body.user ? { id: r.body.user.id, email: r.body.user.email, name: r.body.user.name } : { email });
  const auth = { token, user, subLimit: me.ok && me.body ? me.body.subLimit : null, verifiedAt: Date.now() };
  await chrome.storage.local.set({ auth });
  // 登录后默认开启云端同步：用户自己没开关过（也没同步过）就自动打开；自己关掉过的不再自动开
  const { sync: sync0 } = await chrome.storage.local.get(["sync"]);
  if (!sync0 || (!sync0.userSet && !sync0.lastSyncAt && !sync0.enabled)) await setSyncState({ enabled: true, auto: true });
  syncNow("login").catch(() => {});   // 登录后马上合并一次
  return { ok: true, auth: publicAuth(auth) };
}
// Google 登录：用 Chrome 自带的授权窗口拿 Google 的 ID token，交给登录服务验证。
// 授权窗口弹出时插件弹窗会被关掉，所以整个流程在后台跑，结果写进 grantResult 并尝试重新打开弹窗。
async function googleSignIn() {
  if (!AuthLib.GOOGLE_CLIENT_ID) return { ok: false, error: AuthLib.ERR.PROVIDER_NOT_FOUND };
  const nonce = AuthLib.randomString(16), state = AuthLib.randomString(16);
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: AuthLib.googleAuthUrl(AuthLib.GOOGLE_CLIENT_ID, chrome.identity.getRedirectURL(), nonce, state), interactive: true });
  } catch (e) {
    // 用户关掉授权窗口时 Chrome 报 "The user did not approve access." 之类
    const msg = String(e && e.message || e);
    return { ok: false, cancelled: /did not approve|cancel|closed/i.test(msg),
             error: /did not approve|cancel|closed/i.test(msg) ? AuthLib.ERR.GOOGLE_CANCELLED : AuthLib.ERR.GOOGLE_FAILED };
  }
  const g = AuthLib.parseGoogleRedirect(redirect, state);
  if (g.error) return { ok: false, cancelled: g.error === "GOOGLE_CANCELLED", error: AuthLib.ERR[g.error] };
  const r = await AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/auth/sign-in/social",
    { body: { provider: "google", idToken: { token: g.idToken, nonce } } });
  return finishSignIn(r, null);
}

async function authSignOut() {
  const a = await getAuth();
  if (a) AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/auth/sign-out", { token: a.token, body: {} }).catch(() => {});
  await chrome.storage.local.remove("auth");
  return { ok: true };
}
// 向服务端确认登录还有效。force=false 时只在超过 VERIFY_EVERY 才查。
// 服务端明确说无效（401）才退出；连不上服务器时保持登录，不打扰用户。
let verifying = null;
async function verifyAuth(force) {
  const a = await getAuth();
  if (!a) return null;
  if (!force && Date.now() - (a.verifiedAt || 0) < AuthLib.VERIFY_EVERY) return a;
  if (verifying) return verifying;
  verifying = (async () => {
    const me = await AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/me", { token: a.token });
    if (me.status === 401) { await chrome.storage.local.remove("auth"); return null; }
    if (!me.ok || !me.body) return a;
    const next = Object.assign({}, a, { user: me.body.user, subLimit: me.body.subLimit, verifiedAt: Date.now() });
    await chrome.storage.local.set({ auth: next });
    return next;
  })().finally(() => { verifying = null; });
  return verifying;
}

// ---------- 云端同步（登录后可选） ----------
// 只同步订阅清单（SyncLib.sanitize 里的白名单字段），访问记录、浏览历史、邮件扫描结果、活动指纹都不上传。
// 流程：拉云端 → 和本机合并 → 有变化就带版本号上传；版本冲突（另一台设备先传了）就再拉一次重新合并。
const SYNC_DEBOUNCE_MS = 4000;
let syncTimer = null, syncRunning = null;
async function getSyncState() {
  const { sync = { enabled: false } } = await chrome.storage.local.get(["sync"]);
  return sync;
}
async function setSyncState(patch) {
  const cur = await getSyncState();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ sync: next });
  return next;
}
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow("change").catch(() => {}); }, SYNC_DEBOUNCE_MS);
}
function syncNow(reason) {
  if (syncRunning) return syncRunning.then(() => syncOnce(reason));   // 正在同步时排在后面再跑一次，保证最新改动能传上去
  syncRunning = syncOnce(reason).finally(() => { syncRunning = null; });
  return syncRunning;
}
async function syncOnce(reason) {
  const st = await getSyncState();
  if (!st.enabled) return { ok: false, reason: "disabled" };
  const a = await getAuth();
  if (!a) return { ok: false, reason: "logged_out" };
  // 换了账号：版本号从头来
  let version = st.userId === a.user.id ? (st.version || 0) : 0;
  const fail = async (err) => { await setSyncState({ lastError: err, lastTryAt: Date.now(), userId: a.user.id }); return { ok: false, reason: err }; };

  let remote = await AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/sync", { token: a.token });
  if (remote.status === 401) { await verifyAuth(true); return fail("unauthorized"); }
  if (!remote.ok || !remote.body) return fail(remote.code === "NETWORK" ? "network" : "server");
  let rv = remote.body.version || 0, rdata = remote.body.data;

  for (let attempt = 0; attempt < 3; attempt++) {
    // 合并在锁里做，避免和检查 / 编辑同时写
    const merged = await withLock(async () => {
      const ls = await chrome.storage.local.get(["subsDeleted", "subOrder", "ownVisits"]);
      const local = { subs: await getSubs(), deleted: ls.subsDeleted || {}, order: ls.subOrder || null, own: ls.ownVisits || [] };
      const m = SyncLib.merge(local, rdata || { subs: [], deleted: {} });
      // 其它设备检查时打开的页面（经 Chrome 历史同步可能被算成访问）：从访问记录里去掉
      SyncLib.purgeOwn(m.subs, m.own, subDomains);
      await setSubs(m.subs, { fromSync: true });
      await chrome.storage.local.set({ subsDeleted: m.deleted, subOrder: m.order, ownVisits: m.own || [] });
      return m;
    });
    const p = SyncLib.payload(merged.subs, merged.deleted, merged.order, merged.own);
    if (rdata && SyncLib.sameSynced(merged, rdata)) {
      await setSyncState({ version: rv, userId: a.user.id, lastSyncAt: Date.now(), lastError: null });
      return { ok: true, pushed: false, count: merged.subs.length };
    }
    if (SyncLib.sizeOf(p) > SyncLib.MAX_BYTES) return fail("too_large");
    const put = await AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/sync", { token: a.token, method: "PUT", body: { data: p, baseVersion: rv } });
    if (put.ok && put.body) {
      await setSyncState({ version: put.body.version, userId: a.user.id, lastSyncAt: Date.now(), lastError: null });
      return { ok: true, pushed: true, count: merged.subs.length };
    }
    if (put.status === 409 && put.body) { rv = put.body.version || 0; rdata = put.body.data; continue; }   // 另一台设备刚传过：重新合并
    if (put.status === 401) { await verifyAuth(true); return fail("unauthorized"); }
    return fail(put.status === 413 ? "too_large" : put.code === "NETWORK" ? "network" : "server");
  }
  return fail("conflict");
}

// ---------- 添加 / 诊断（弹窗和「授权后自动继续」共用） ----------
async function llmQuickAdd(kind) {
  const site = LlmLib.LLM_SITES[kind];
  if (!site) return { ok: false, reason: "unknown_kind" };
  const lim0 = await limitCheck(subs0 => subs0.some(x => x.mode === "activity" && x.provider === kind));
  if (lim0) return lim0;
  const r = await readLlm(kind);
  const now = Date.now();
  if (!r || r.error || r.loggedOut === true || !r.ok) {
    return { ok: false, reason: (r && r.error) || (r && r.loggedOut ? "logged_out" : "read_failed"), shapes: r && r.shapes };
  }
  const saved = await withLock(async () => {
    const subs = await getSubs();
    let s = subs.find(x => x.mode === "activity" && x.provider === kind);
    if (!s) {
      if (!AuthLib.canAdd(subs.length, await getAuth())) return null;
      s = { id: String(now), createdAt: now, updatedAt: now, name: site.name, urlPattern: site.domain, mode: "activity", provider: kind,
            idleDays: 30, currency: "$", price: 0, lastUsed: null, notified: null };
      subs.push(s);
    }
    applyLlmResult(s, r, now);
    if (!s.price) {
      const hint = LlmLib.priceHint(kind, s.llm.plan.key);
      if (hint && s.llm.plan.paid && !s.llm.plan.business) { s.price = hint; s.priceEstimated = true; }
    }
    applyCrossAdvice(subs);
    await setSubs(subs);
    return s;
  });
  if (!saved) return await limitResult();
  return { ok: true, sub: saved };
}

// 从服务目录添加：读一次账户页，建好订阅；有活动记录页的顺便读一次建立基线
const catalogInflight = new Map();
function catalogAdd(id) {
  if (catalogInflight.has(id)) return catalogInflight.get(id);
  const job = (async () => {
    const p = SubCatalog.BY_ID[id];
    if (!p || p.special) return { ok: false, reason: "unknown" };
    const lim0 = await limitCheck(subs0 => subs0.some(x => x.catalogId === p.id));
    if (lim0) return lim0;
    const r = await readAccount(p);
    if (r.error === "no_permission") return { ok: false, reason: "no_permission" };
    const now = Date.now();
    const saved = await withLock(async () => {
      const subs = await getSubs();
      let s = subs.find(x => x.catalogId === p.id);
      if (!s) {
        if (!AuthLib.canAdd(subs.length, await getAuth())) return null;
        s = { id: String(now), createdAt: now, updatedAt: now, name: p.name, catalogId: p.id, urlPattern: p.activityDomain || p.domains[0],
              mode: p.activity ? "activity" : "browser", provider: p.activity || null,
              idleDays: 30, currency: p.currency || "$", price: 0, lastUsed: null, notified: null };
        // 浏览器访问型：用访问记录里最近一次访问作为起点，不用从零建立基线
        if (s.mode === "browser") {
          const { records = [] } = await chrome.storage.local.get(["records"]);
          const doms = [p.activityDomain].concat(p.domains).filter(Boolean);
          const last = records.filter(x => x.hostname && doms.some(d => hostMatches(x.hostname, d)))
                              .reduce((m, x) => Math.max(m, x.time), 0);
          if (last) s.lastUsed = last;
        }
        subs.push(s);
      }
      applyAccount(s, p, r, now);
      await setSubs(subs);
      return s;
    });
    if (!saved) return await limitResult();
    // 账户页刚读过，这里只补读一次观看记录
    if (saved.mode === "activity") runCheck([saved.id], { skipAccount: true }).catch(() => {});
    else historyScan().catch(() => {});   // 授权过浏览历史的话，马上补上装插件前的访问
    return { ok: true, sub: saved, status: saved.account && saved.account.status };
  })().finally(() => catalogInflight.delete(id));
  catalogInflight.set(id, job);
  return job;
}

// 诊断账户页：读一次，把解析结果和页面开头的文字（只显示在你自己的弹窗里）返回
async function catalogDiagnose(id) {
  const p = SubCatalog.BY_ID[id];
  if (!p || p.special) return { ok: false, reason: "unknown" };
  const r = await readAccount(p);
  if (r.error) return { ok: true, error: r.error };
  const a = SubCatalog.parseAccountPage(p, r.page, { parseAmount: MailLib.parseAmount, parseDate: MailLib.parseMailDate }, Date.now());
  // 有观看记录的服务：顺便读一次观看记录，看看能不能抓到
  let activity = null;
  if (p.activity && CATALOG[p.activity]) {
    const ar = await readActivity(getProviderConfig({ provider: p.activity }));
    activity = ar ? { count: (ar.ids || []).length, ids: (ar.ids || []).slice(0, 5), topLabel: ar.topLabel || "", loggedOut: ar.loggedOut, url: ar.pageUrl || "" } : { error: true };
  }
  // 读成功了就顺便存进订阅（诊断看到的和列表里显示的一致）
  if (a.status === "ok") {
    await withLock(async () => {
      const subs = await getSubs();
      const sub = subs.find(x => x.catalogId === id);
      if (sub) { applyAccount(sub, p, r, Date.now()); sub.lastChecked = Date.now(); await setSubs(subs, { fromSync: true }); scheduleSync(); }
    });
  }
  return { ok: true, result: a, injectError: r.page.injectError || null, activity, quotaError: r.page.quotaError || null,
           textLength: (r.page.text || "").length, excerpt: (r.page.text || "").slice(0, 600) };
}

// ---------- 授权后自动继续 ----------
// Chrome 弹出授权框时插件弹窗会被关掉（失去焦点），点「允许」后弹窗里的代码不会再运行。
// 所以弹窗在申请权限前先登记要做的事（PENDING_GRANT），授权成功后这里接着做完，
// 结果写进 grantResult（重新打开弹窗时显示），并发通知、尝试重新打开弹窗。
async function clearPending(action, id) {
  const { pendingGrant } = await chrome.storage.local.get(["pendingGrant"]);
  if (pendingGrant && pendingGrant.action === action && pendingGrant.id === id) await chrome.storage.local.remove("pendingGrant");
}
// 同一时间只跑一个（授权小窗口主动调用和 onAdded 可能同时触发）
let resuming = null;
function resumePending() {
  if (!resuming) resuming = resumePendingOnce().finally(() => { resuming = null; });
  return resuming;
}
async function resumePendingOnce() {
  const { pendingGrant: pg } = await chrome.storage.local.get(["pendingGrant"]);
  if (!pg || Date.now() - pg.at > 3 * 60000) return;
  let ok = false;
  try { ok = await chrome.permissions.contains({ origins: pg.origins || [], permissions: pg.permissions || [] }); } catch (e) { ok = false; }
  if (!ok) return;
  await chrome.storage.local.remove("pendingGrant");
  const base = { action: pg.action, id: pg.id, at: Date.now() };
  await chrome.storage.local.set({ grantResult: Object.assign({ running: true }, base) });
  let res;
  try {
    if (pg.action === "catalog") res = await catalogAdd(pg.id);
    else if (pg.action === "llm") res = await llmQuickAdd(pg.id);
    else if (pg.action === "diag") res = await catalogDiagnose(pg.id);
    else if (pg.action === "recheck") { await runCheck([pg.id]); res = { ok: true }; }
    else if (pg.action === "history") res = await historyScan();
    else if (pg.action === "mail" && pg.params) {
      // 邮箱扫描本来就在后台跑、进度写在 storage 里，这里只负责把它启动起来
      await chrome.storage.local.remove("grantResult");
      const msg = Object.assign({}, pg.params);
      const pre = await mailScanPrecheck(msg);
      if (pre.ok) runMailScan(msg).catch(() => {});
      return;
    }
    else return;
  } catch (e) { res = { ok: false, reason: "read_failed" }; }
  await chrome.storage.local.set({ grantResult: Object.assign({ res }, base) });
  // 在授权小窗口里授权的：结果直接显示在小窗口里，不用再开弹窗或发通知
  if (pg.inWindow) { if (pg.action === "recheck") await chrome.storage.local.remove("grantResult"); return; }
  // 弹窗已经关了：先试着重新打开它（Chrome 127+），打不开就发个通知
  let reopened = false;
  try { if (chrome.action && chrome.action.openPopup) { await chrome.action.openPopup(); reopened = true; } } catch (e) { reopened = false; }
  if (pg.action === "recheck") await chrome.storage.local.remove("grantResult");
  if (!reopened && pg.action !== "recheck") {
    const subs = await getSubs();
    const sub = (res && res.sub) || subs.find(x => x.id === pg.id);
    const name = (sub && sub.name) || (SubCatalog.BY_ID[pg.id] || {}).name || (LlmLib.LLM_SITES[pg.id] || {}).name || "";
    const done = pg.action === "diag" ? `${name} 诊断完成` : res && res.ok ? `已添加 ${name}` : `添加 ${name} 没成功`;
    chrome.notifications.create("grant-" + Date.now(), { type: "basic", iconUrl: "icons/icon128.png",
      title: done, message: "点插件图标查看详情。" });
  }
}
chrome.permissions.onAdded.addListener(() => {
  // 给弹窗一点时间：如果弹窗没被关掉，它会自己接着做（并清掉登记），这里就不重复了
  setTimeout(() => { resumePending().catch(() => {}); }, 1500);
});

// 续费前 3 天：有建议（退订/降档/二选一）时提醒一次
function notifyRenewal(sub, days, planLabel, adviceText) {
  const adv = adviceText != null ? adviceText : (sub.llm.cross || (sub.llm.advice && sub.llm.advice.text) || "");
  const label = planLabel || (sub.llm && sub.llm.plan && sub.llm.plan.label) || "";
  chrome.notifications.create(`renew-${sub.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${sub.name} ${label} ${days <= 0 ? "今天" : days + " 天后"}自动续费`,
    message: adv + " 点此打开账单页。",
    priority: 2
  });
}

// ---------- 闲置检查与提醒 ----------
function notifyIdle(sub, days) {
  const money = sub.price ? `，每月 ${sub.currency || "$"}${sub.price}` : "";
  chrome.notifications.create(`idle-${sub.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${sub.name} 已闲置 ${days} 天`,
    message: `你已经 ${days} 天没用过它了${money}。考虑退订？`,
    priority: 1
  });
}

// 信号中断提醒：明确告诉用户"这不是闲置，是我读不到了"
function notifySignalLost(sub, reason, brokenDays) {
  const what = SIGNAL_REASONS[reason] || "读取失败";
  const howLong = brokenDays > 0 ? `已 ${brokenDays} 天读不到。` : "";
  chrome.notifications.create(`signal-${sub.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${sub.name}：${what}`,
    message: `${howLong}在恢复前不会给出退订建议，以免误判。点此前往处理。`,
    priority: 1
  });
}

// 检查时读取活动记录 / 大模型数据会写回订阅的这些字段
const REFRESH_FIELDS = ["lastChecked", "signal", "signalNotified", "sig", "lastUsed", "lastUsedFloor", "lastWatched", "watchAt", "notified", "llm",
                        "account", "price", "currency", "priceSource", "priceEstimated"];
const CHECK_CONCURRENCY = 4;          // 同时最多读几个（每个读取可能要在后台开一个标签页）
const ACCOUNT_FRESH_MS = 3 * DAY;     // 全部检查时，多久内读过的账户页不再重新打开
const inflight = new Map();           // 订阅 id → 正在进行的读取（同一个订阅不会被重复读）

// 读取一个订阅的最新数据。在订阅的副本上读，不占存储锁：读取要几秒，期间访问记录等照常写入。
function refreshOne(sub, opts) {
  if (inflight.has(sub.id)) return inflight.get(sub.id);
  const p = (async () => {
    // 常见服务：先读账户页（套餐 / 价格 / 续费日 / 空间）
    const cp = sub.catalogId && SubCatalog.BY_ID[sub.catalogId];
    const jobs = [];
    let light = false;
    if (cp && !cp.special && cp.accountUrl && !(opts && opts.skipAccount)) {
      // 全部检查（定时 / 立即检查）时，3 天内读到过套餐的就不再打开账户页（套餐很少变）；
      // 有用量接口的（网盘空间）直接在后台调接口刷新，不开窗口。单独点某一行的「检查」仍然完整读一次。
      const a0 = sub.account;
      light = !!(opts && opts.light && a0 && a0.status === "ok" && Date.now() - (a0.checkedAt || 0) < ACCOUNT_FRESH_MS);
      if (!light) jobs.push(readAccount(cp).then(r => applyAccount(sub, cp, r, Date.now())));
      else if (cp.quotaApi) jobs.push(readQuotaDirect(cp).then(q => {
        const st = q && SubCatalog.storageFromBytes(q.used, q.total);
        if (st) sub.account = Object.assign({}, sub.account, { storage: st, updatedAt: Date.now() });
      }));
    }
    // 再读使用情况（活动记录 / 大模型对话时间）；浏览器访问型不需要读
    if (sub.mode === "activity" && sub.provider) {
      const cfg = getProviderConfig(sub);
      if (cfg && cfg.strategy === "llm") jobs.push(updateFromLlm(sub));
      else if (cfg) jobs.push(updateFromActivity(sub));
    }
    await Promise.all(jobs);
    // 只读账户页的（网盘、国内影音等）也要记「最近检查」
    if (jobs.length || light) sub.lastChecked = Date.now();
    return sub;
  })().finally(() => inflight.delete(sub.id));
  inflight.set(sub.id, p);
  return p;
}

// ids 不传 = 检查全部；传了 = 只检查这些订阅。
// 读取并发进行（最多 CHECK_CONCURRENCY 个同时），全部读完后再在锁里合并结果、判断闲置、发提醒。
async function runCheck(ids, opts) {
  const only = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  // 全部检查时顺便用浏览历史更新「浏览器访问」型订阅（授权过才会读）
  if (!only) { try { await historyScan(); } catch (e) {} }
  // 全部检查默认用轻量模式（少开窗口）；单独检查某一个订阅时完整读取
  if (!only) opts = Object.assign({ light: true }, opts);
  const snapshot = await getSubs();
  const needsRead = (s) => (s.mode === "activity" && s.provider) ||
    !!(s.catalogId && SubCatalog.BY_ID[s.catalogId] && !SubCatalog.BY_ID[s.catalogId].special);
  const targets = snapshot.filter(s => (!only || only.has(s.id)) && needsRead(s));
  const refreshed = await mapLimit(targets, CHECK_CONCURRENCY, (s) => refreshOne(s, opts));

  return withLock(async () => {
    const subs = await getSubs();

    // 把读到的数据合并回最新的订阅列表（读取期间用户可能编辑过订阅，只覆盖读取相关的字段）
    refreshed.forEach((r, i) => {
      const fresh = r && !r.__error ? r : null;
      const s = subs.find(x => x.id === targets[i].id);
      if (!s || !fresh) return;
      for (const f of REFRESH_FIELDS) if (f in fresh) s[f] = fresh[f];
    });
    applyCrossAdvice(subs);

    // 再判断闲置（单独检查时只处理被检查的订阅）
    const now = Date.now();
    for (const s of subs) {
      if (only && !only.has(s.id)) continue;
      const { state, days, reason } = computeStatus(s, now);

      // 信号中断：只提醒"读不到了"，绝不发退订建议 —— 因为我们无法区分
      // "用户没在用"和"我们测不到"。连续失败 2 次才提醒，避免网络抖动造成噪音。
      if (state === "signal_lost") {
        if (shouldWarnSignal(s) && (!s.signalNotified || (now - s.signalNotified) > 7 * DAY)) {
          notifySignalLost(s, reason, days);
          s.signalNotified = now;
        }
        continue;
      }

      // 大模型订阅：续费前 3 天，如果有建议就提醒一次
      if (s.llm && s.llm.renewAt && s.llm.plan && s.llm.plan.paid && !s.llm.plan.business) {
        const days = Math.ceil((s.llm.renewAt - now) / DAY);
        const hasAdvice = s.llm.cross || (s.llm.advice && ["cancel", "downgrade"].indexOf(s.llm.advice.level) >= 0);
        if (days >= 0 && days <= 3 && hasAdvice && s.renewNotified !== s.llm.renewAt) {
          notifyRenewal(s, days);
          s.renewNotified = s.llm.renewAt;
        }
      }

      // 常见服务：续费前 3 天，如果闲置或空间用得很少就提醒一次
      if (s.account && s.account.renewAt && s.account.plan && s.account.plan.paid) {
        const cp = SubCatalog.BY_ID[s.catalogId];
        const adv = cp && SubCatalog.accountAdvice(cp, s.account, { state, days });
        const d = Math.ceil((s.account.renewAt - now) / DAY);
        if (adv && (adv.level === "cancel" || adv.level === "downgrade") && d >= 0 && d <= 3 && s.renewNotified !== s.account.renewAt) {
          notifyRenewal(s, d, s.account.plan.label, adv.text);
          s.renewNotified = s.account.renewAt;
        }
      }

      if (state !== "idle") continue;
      // 同一订阅 7 天内只提醒一次，避免打扰
      if (!s.notified || (now - s.notified) > 7 * DAY) {
        notifyIdle(s, days);
        s.notified = now;
      }
    }

    await setSubs(subs);
    if (!only) await chrome.storage.local.set({ lastCheck: now });
    return subs;
  });
}

// ---------- 定时任务 ----------
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "dailyCheck") { runCheck(); verifyAuth(false).catch(() => {}); }
});

// 点工具栏图标打开侧边栏（侧边栏在授权框弹出时不会被收起）
function usePanel() {
  try { if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}
}
usePanel();
chrome.runtime.onInstalled.addListener(async () => {
  usePanel();
  const cur = await chrome.storage.local.get(["subs", "records"]);
  if (!cur.subs) await chrome.storage.local.set({ subs: [] });
  if (!cur.records) await chrome.storage.local.set({ records: [], paused: false });
  // v2.16.3 起访问流水只存网站和时间：清掉以前存下的完整网址
  else if (cur.records.some(r => r && r.url)) await chrome.storage.local.set({ records: cur.records.map(r => ({ hostname: r.hostname, time: r.time })) });
  // v2.21 起腾讯视频等改为读观看记录：以前按「浏览器访问」添加的，改成读观看记录（打开网站仍然算在用）
  if (cur.subs && cur.subs.some(x => x.catalogId && x.mode === "browser" && !x.provider && SubCatalog.BY_ID[x.catalogId] && SubCatalog.BY_ID[x.catalogId].activity)) {
    await withLock(async () => {
      const subs = await getSubs();
      subs.forEach(x => {
        const cp = x.catalogId && SubCatalog.BY_ID[x.catalogId];
        if (cp && cp.activity && CATALOG[cp.activity] && x.mode === "browser" && !x.provider) { x.mode = "activity"; x.provider = cp.activity; x.updatedAt = Date.now(); }
      });
      await setSubs(subs);
    });
  }
  // v2.21.1 腾讯视频的观看记录读不到，退回「账户页 + 浏览器访问」：读取方式已不存在的订阅改回浏览器访问
  if (cur.subs && cur.subs.some(x => x.mode === "activity" && x.provider && !CATALOG[x.provider])) {
    await withLock(async () => {
      const subs = await getSubs();
      subs.forEach(x => {
        if (x.mode === "activity" && x.provider && !CATALOG[x.provider]) {
          x.mode = "browser"; x.provider = null; delete x.sig; delete x.signal; delete x.signalNotified; x.updatedAt = Date.now();
        }
      });
      await setSubs(subs);
    });
  }
  // v2.15 去掉了「主要在电视 / 手机上用，不参与判断」：老数据恢复成正常判断
  if (cur.subs && cur.subs.some(x => x.mode === "none")) {
    await withLock(async () => {
      const subs = await getSubs();
      subs.forEach(x => { if (x.mode === "none") { x.mode = x.provider ? "activity" : "browser"; x.updatedAt = Date.now(); } });
      await setSubs(subs);
    });
  }
  chrome.alarms.create("dailyCheck", { periodInMinutes: 60 * 12, delayInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("dailyCheck", { periodInMinutes: 60 * 12, delayInMinutes: 1 });
});

// 点通知直接打开该订阅网址，方便去退订
chrome.notifications.onClicked.addListener(async (id) => {
  const subs = await getSubs();
  // 闲置提醒 → 打开该服务，方便去退订
  if (id.startsWith("idle-")) {
    const s = subs.find(x => `idle-${x.id}` === id);
    if (s && s.urlPattern) openUserTab("https://" + normalizeDomain(s.urlPattern));
    return;
  }
  // 续费提醒 → 打开账单/订阅管理页
  if (id.startsWith("renew-")) {
    const s = subs.find(x => `renew-${x.id}` === id);
    const site = s && LlmLib.LLM_SITES[s.provider];
    const cp = s && SubCatalog.BY_ID[s.catalogId];
    if (site) openUserTab(site.billingUrl);
    else if (cp && cp.accountUrl) openUserTab(cp.accountUrl);
    return;
  }
  // 信号中断提醒 → 直接打开活动页，用户登录后下次检查即自动恢复
  if (id.startsWith("signal-")) {
    const s = subs.find(x => `signal-${x.id}` === id);
    const cfg = s && getProviderConfig(s);
    const url = (cfg && cfg.activityUrl) ||
                (s && s.urlPattern ? "https://" + normalizeDomain(s.urlPattern) : null);
    if (url) openUserTab(url);
  }
});

// ---------- 与弹窗通信 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "GET_STATE": {
          const { subs = [], records = [], lastCheck = null, paused = false, subOrder = null, pendingGrant = null } =
            await chrome.storage.local.get(["subs", "records", "lastCheck", "paused", "subOrder", "pendingGrant"]);
          const { mailScan = null, mailIgnored = [], mailPrefs = {}, grantResult = null, history = null } =
            await chrome.storage.local.get(["mailScan", "mailIgnored", "mailPrefs", "grantResult", "history"]);
          const histOn = await hasHistoryPermission();
          const authNow = await getAuth();
          verifyAuth(false).catch(() => {});   // 隔一段时间向服务端确认一次，不阻塞弹窗
          // 打开弹窗时如果超过 10 分钟没同步，拉一下云端（别的设备可能改过）
          getSyncState().then(s => { if (s.enabled && authNow && Date.now() - (s.lastSyncAt || 0) > 10 * 60000) syncNow("open").catch(() => {}); });
          sendResponse({ ok: true, subs, records, lastCheck, paused, pendingGrant, order: (subOrder && subOrder.ids) || null, mailScan, mailIgnored, mailPrefs, grantResult,
            history: histOn && history ? { scannedAt: history.scannedAt, hits: history.hits } : null, historyPermission: histOn,
            auth: publicAuth(authNow), subLimit: AuthLib.subLimit(authNow), guestLimit: AuthLib.GUEST_SUB_LIMIT,
            googleLogin: !!AuthLib.GOOGLE_CLIENT_ID,
            sync: await (async () => { const s = await getSyncState(); return { enabled: !!s.enabled, lastSyncAt: s.lastSyncAt || null, lastError: s.lastError || null }; })(),
            providers: Object.keys(CATALOG).map(k => ({
              key: k, name: CATALOG[k].name, url: CATALOG[k].activityUrl,
              verified: !!CATALOG[k].verified, note: CATALOG[k].note || ""
            })),
            noActivityPage: NO_ACTIVITY_PAGE });
          break;
        }
        case "SAVE_SUB": {
          const okSave = await withLock(async () => {
            const subs = await getSubs();
            const s = msg.sub;
            const i = subs.findIndex(x => x.id === s.id);
            if (i >= 0) subs[i] = { ...subs[i], ...s, updatedAt: Date.now() };
            else {
              if (!AuthLib.canAdd(subs.length, await getAuth())) return false;
              subs.push({ ...s, id: s.id || String(Date.now()), createdAt: Date.now(), updatedAt: Date.now(), lastUsed: null, notified: null });
            }
            await setSubs(subs);
            return true;
          });
          if (!okSave) { sendResponse(await limitResult()); break; }
          if (msg.sub.mode === "browser") historyScan().catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case "AUTH_SIGN_UP":
        case "AUTH_SIGN_IN": {
          sendResponse(await authSignIn(msg.type === "AUTH_SIGN_UP", msg.email, msg.password, msg.name));
          break;
        }
        case "AUTH_GOOGLE": {
          const at = Date.now();
          await chrome.storage.local.set({ grantResult: { action: "google", id: "google", at, running: true } });
          const res = await googleSignIn();
          await chrome.storage.local.set({ grantResult: { action: "google", id: "google", at: Date.now(), res } });
          // 弹窗多半已经被授权窗口关掉了：试着重新打开它显示结果（Chrome 127+）
          try { if (chrome.action && chrome.action.openPopup) await chrome.action.openPopup(); } catch (e) {}
          sendResponse(res);
          break;
        }
        case "SYNC_SET": {
          if (msg.enabled) {
            if (!(await getAuth())) { sendResponse({ ok: false, reason: "logged_out" }); break; }
            await setSyncState({ enabled: true, userSet: true });
            sendResponse(await syncNow("enable"));
          } else {
            await setSyncState({ enabled: false, version: 0, userSet: true });
            if (msg.deleteCloud) {
              const a = await getAuth();
              const r = a ? await AuthLib.call(AuthLib.AUTH_BASE_URL, "/api/sync", { token: a.token, method: "DELETE" }) : { ok: false };
              sendResponse({ ok: true, cloudDeleted: !!r.ok });
            } else sendResponse({ ok: true });
          }
          break;
        }
        case "SYNC_NOW": {
          sendResponse(await syncNow("manual"));
          break;
        }
        case "AUTH_SIGN_OUT": {
          sendResponse(await authSignOut());
          break;
        }
        case "AUTH_VERIFY": {
          sendResponse({ ok: true, auth: publicAuth(await verifyAuth(true)) });
          break;
        }
        case "SET_ORDER": {
          // 用户拖动排序：存本机，并同步到云端（ids 为 null = 恢复自动排序）
          const ids = Array.isArray(msg.ids) ? msg.ids.filter(x => typeof x === "string").slice(0, 1000) : null;
          await chrome.storage.local.set({ subOrder: { ids, at: Date.now() } });
          scheduleSync();
          sendResponse({ ok: true });
          break;
        }
        case "OPEN_TAB": {
          // 弹窗里的「打开账户页」「去处理」：由后台打开，这样能排除在「最近使用」之外
          if (typeof msg.url === "string" && /^https:\/\//.test(msg.url)) await openUserTab(msg.url);
          sendResponse({ ok: true });
          break;
        }
        case "DELETE_SUB": {
          await withLock(async () => {
            const subs = (await getSubs()).filter(x => x.id !== msg.id);
            // 记下删除，云端同步时其它设备也会删掉，而不是把它同步回来
            const { subsDeleted = {} } = await chrome.storage.local.get(["subsDeleted"]);
            subsDeleted[msg.id] = Date.now();
            for (const k of Object.keys(subsDeleted)) if (Date.now() - subsDeleted[k] > SyncLib.TOMBSTONE_DAYS * DAY) delete subsDeleted[k];
            await chrome.storage.local.set({ subsDeleted });
            await setSubs(subs);
          });
          sendResponse({ ok: true });
          break;
        }
        // 诊断：立刻去读一次，把"到底抓到了什么"原样返回给用户看。
        // 这是把"我猜的配置"变成"你能验证的配置"的关键 —— 不用盲信。
        case "CATALOG_DIAGNOSE": {
          await clearPending("diag", msg.id);
          sendResponse(await catalogDiagnose(msg.id));
          break;
        }
        case "CATALOG_ADD": {
          await clearPending("catalog", msg.id);
          sendResponse(await catalogAdd(msg.id));
          break;
        }
        case "PENDING_GRANT": {
          // 弹窗即将申请权限：Chrome 弹出授权框时会把插件弹窗关掉，弹窗里的后续代码就没了。
          // 先把「授权后要做的事」交给后台，授权成功后由后台接着做完。
          await chrome.storage.local.set({ pendingGrant: { action: msg.action, id: msg.id, origins: msg.origins || [], permissions: msg.permissions || [],
                                                            params: msg.params || null, inWindow: !!msg.inWindow, at: Date.now() } });
          sendResponse({ ok: true });
          break;
        }
        case "RESUME_PENDING": {
          // 授权小窗口：用户点了「允许」，马上接着做（不用等 onAdded 的 1.5 秒）
          await resumePending();
          sendResponse({ ok: true });
          break;
        }
        case "OPEN_GRANT_WINDOW": {
          // 工具栏弹窗里需要授权：Chrome 的授权框会把弹窗收起来，所以换到一个独立小窗口里授权
          try {
            const w = await chrome.windows.getLastFocused().catch(() => null);
            const W = 520, H = 720;
            const opt = { url: chrome.runtime.getURL("popup.html?win=1&grant=1"), type: "popup", width: W, height: H, focused: true };
            if (w && w.left != null && w.width) { opt.left = Math.max(0, w.left + w.width - W - 24); opt.top = Math.max(0, (w.top || 0) + 72); }
            await chrome.windows.create(opt);
            sendResponse({ ok: true });
          } catch (e) { sendResponse({ ok: false }); }
          break;
        }
        case "HISTORY_SCAN": {
          await clearPending("history", "history");
          sendResponse(await historyScan());
          break;
        }
        case "HISTORY_OFF": {
          // 停用：删掉汇总数据和由历史推出的「90 天没访问」占位（真实访问时间保留）
          await withLock(async () => {
            const subs = await getSubs();
            subs.forEach(s => { delete s.hist; if (s.lastUsedFloor) { s.lastUsed = null; s.lastUsedFloor = false; } });
            await setSubs(subs);
            await chrome.storage.local.remove(["history"]);
          });
          sendResponse({ ok: true });
          break;
        }
        case "CLEAR_RESULT": {
          await chrome.storage.local.remove("grantResult");
          sendResponse({ ok: true });
          break;
        }
        case "DIAGNOSE": {
          const cfg = getProviderConfig(msg.sub);
          if (!cfg) { sendResponse({ ok: false, reason: "no_provider" }); break; }
          if (cfg.strategy === "llm") {
            const r = await readLlm(cfg.key);
            const now = Date.now();
            sendResponse({
              ok: true, llm: true, url: cfg.activityUrl,
              result: {
                error: r.error || null, loggedOut: r.loggedOut, ok: !!r.ok,
                plan: r.plan ? LlmLib.normalizePlan(cfg.key, r.plan) : null,
                origin: LlmLib.normalizeOrigin(r.plan && r.plan.origin),
                convCount: r.convCount || 0,
                stats: LlmLib.llmStats(r.timestamps, now),
                usage: LlmLib.pickUsage(r.usage),
                renewAt: LlmLib.parseTs(r.renew),
                shapes: r.shapes || {}
              }
            });
            break;
          }
          const r = await readActivity(cfg);
          sendResponse({
            ok: true,
            url: cfg.activityUrl,
            strategy: cfg.strategy,
            idPattern: cfg.idPattern,
            result: r ? {
              loggedOut: r.loggedOut,
              historyOff: r.historyOff,
              count: (r.ids || []).length,
              sample: (r.ids || []).slice(0, 5),
              topLabel: r.topLabel || "",
              pageUrl: r.pageUrl || ""
            } : null
          });
          break;
        }
        case "MAIL_SCAN_START": {
          await clearPending("mail", "mail");
          const pre = await mailScanPrecheck(msg);
          if (!pre.ok) { sendResponse(pre); break; }
          // 在后台跑完；弹窗关了也不影响，进度写进 storage
          runMailScan(msg).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case "MAIL_PREFS": {
          // 记住扫描方式和 Client ID（Client ID 不是机密，可以保存；令牌从不保存）
          const { mailPrefs = {} } = await chrome.storage.local.get("mailPrefs");
          await chrome.storage.local.set({ mailPrefs: { ...mailPrefs, ...(msg.prefs || {}) } });
          sendResponse({ ok: true });
          break;
        }
        case "MAIL_IGNORE": {
          const { mailIgnored = [] } = await chrome.storage.local.get("mailIgnored");
          const set = new Set(mailIgnored);
          if (msg.all === true && msg.ignore === false) set.clear();
          else if (msg.ignore) set.add(msg.key); else set.delete(msg.key);
          await chrome.storage.local.set({ mailIgnored: Array.from(set) });
          sendResponse({ ok: true });
          break;
        }
        // 一键添加 ChatGPT / Claude：读一次，按读到的套餐建好订阅
        case "LLM_QUICK_ADD": {
          await clearPending("llm", msg.kind);
          sendResponse(await llmQuickAdd(msg.kind));
          break;
        }
        case "RUN_CHECK": {
          if (msg.ids && msg.ids.length === 1) await clearPending("recheck", msg.ids[0]);
          const subs = await runCheck(msg.ids);
          sendResponse({ ok: true, subs });
          break;
        }
        case "CLEAR_RECORDS": {
          await chrome.storage.local.set({ records: [] });
          sendResponse({ ok: true });
          break;
        }
        case "TOGGLE_PAUSE": {
          const { paused = false } = await chrome.storage.local.get("paused");
          await chrome.storage.local.set({ paused: !paused });
          sendResponse({ ok: true, paused: !paused });
          break;
        }
        default:
          sendResponse({ ok: false, reason: "unknown_message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 异步响应
});
