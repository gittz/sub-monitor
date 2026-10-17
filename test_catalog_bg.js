// 常见服务流程测试：从目录添加、检查时读账户页、诊断、后台标签页不算访问（模拟 chrome API，node test_catalog_bg.js）
const fs = require("fs"), vm = require("vm"), path = require("path");
const DAY = 86400000;
const realTimeout = setTimeout;
function boot(pages, opts) {
  opts = opts || {};
  const store = { subs: [], records: [] }, listeners = {}, notes = [], opened = [], popups = [];
  const tabUrl = {}, alarmsMade = [];
  let tabSeq = 100;
  const ev = (n) => ({ addListener: (f) => { (listeners[n] = listeners[n] || []).push(f); }, removeListener() {} });
  const chrome = {
    storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                        set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
                        remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); } } },
    permissions: { contains: async (q) => (q && q.permissions && q.permissions.indexOf("history") >= 0) ? !!opts.history : opts.perm !== false, onAdded: ev("padd") },
    history: { search: async () => (opts.history || []).map(v => ({ url: v.url, lastVisitTime: v.time })),
               getVisits: async ({ url }) => (opts.history || []).filter(v => v.url === url).map(v => ({ visitTime: v.time, isLocal: v.isLocal })) },
    action: { openPopup: async () => { if (opts.noPopup) throw new Error("no window"); popups.push(1); } },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, url: tabUrl[id] }),
      create: async (o) => { const id = ++tabSeq; tabUrl[id] = o.url; opened.push(o.url);
        realTimeout(() => { (listeners.tu || []).forEach(f => f(id, { status: "complete" }));
          // 模拟浏览器对后台标签页也触发导航事件
          (listeners.nav || []).forEach(f => f({ frameId: 0, tabId: id, url: o.url })); }, 1);
        return { id }; },
      remove: async (id) => { (listeners.tr || []).forEach(f => f(id)); }, onUpdated: ev("tu"), onRemoved: ev("tr") },
    scripting: {
      registerContentScripts: async (a) => { (opts.reg = opts.reg || []).push(...a.map(x => x.id)); },
      unregisterContentScripts: async (q) => { opts.reg = (opts.reg || []).filter(id => q.ids.indexOf(id) < 0); },
      executeScript: async (o) => {
      const url = tabUrl[o.target.tabId];
      if (o.func && o.func.name === "tencentExtract") { opts.txHookAtRead = (opts.reg || []).slice(); return [{ result: opts.tx || null }]; }
      if (o.args && typeof o.args[0] === "string" && o.args[0].indexOf("/api/quota") === 0) return [{ result: opts.quota || { errno: -6 } }];
      if (o.args && o.args[0] && "waitRe" in o.args[0]) {
        const pg = pages[url];
        if (pg === "THROW") throw new Error("Cannot access contents of url");
        return [{ result: Object.assign({ url, title: "" }, pg || { text: "" }) }];
      }
      return [{ result: { ids: ["v" + Math.random()], topLabel: opts.topLabel || "", loggedOut: false, historyOff: false } }];
    } },
    webNavigation: { onCompleted: ev("nav"), onHistoryStateUpdated: ev("b") },
    alarms: { onAlarm: ev("c"), get: async (n) => alarmsMade.filter(x => x.name === n).pop() || null, create: (n, o) => alarmsMade.push(Object.assign({ name: n }, o)) },
    runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
    notifications: { onClicked: ev("f"), create: (id, o) => notes.push({ id, o }) }
  };
  const ctx = { console, chrome, setTimeout: (f, ms) => realTimeout(f, Math.min(ms || 0, 5)), clearTimeout, Promise, Date, JSON, Math, Set, Map, URL, URLSearchParams, RegExp, importScripts: () => {} };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  const send = (m) => new Promise(r => listeners.msg[0](m, {}, r));
  const grant = () => (listeners.padd || []).forEach(f => f({ origins: [] }));
  return { store, send, notes, opened, ctx, popups, grant, listeners, alarmsMade };
}
const t = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) process.exitCode = 1; };
const wait = (ms) => new Promise(r => realTimeout(r, ms));

(async () => {
  const C = require("./catalog.js");
  const nf = C.BY_ID.netflix, bp = C.BY_ID["baidu-pan"], sp = C.BY_ID.spotify;
  const in5 = new Date(Date.now() + 2 * DAY);
  const renewTxt = `${in5.getFullYear()}年${in5.getMonth() + 1}月${in5.getDate()}日`;
  const pages = {
    [nf.accountUrl]: { text: "Account\nMembership\nPremium plan\n4K + HDR\n$22.99/month\nNext payment: " + in5.toDateString().slice(4) + "\nCancel membership\n" + "x".repeat(300) },
    [bp.accountUrl]: { text: "我的会员\n超级会员 SVIP\n到期时间：" + renewTxt + "\n已用 120GB / 5TB\n" + "x".repeat(300) },
    [sp.accountUrl]: "THROW"
  };

  // 1. 从目录添加 Netflix（有观看记录页 → 活动记录型）
  let B = boot(pages);
  let r = await B.send({ type: "CATALOG_ADD", id: "netflix" });
  await wait(60);
  let s = B.store.subs[0];
  t("添加 Netflix：建好订阅并读到套餐", r.ok && s.catalogId === "netflix" && s.account.status === "ok" && /Premium/.test(s.account.plan.label));
  t("页面价格写入月费", s.price === 22.99 && s.priceSource === "page");
  t("有观看记录页 → 活动记录型，并顺便读了一次活动", s.mode === "activity" && s.provider === "netflix" && !!s.sig);
  t("续费日读到了", !!s.account.renewAt && Math.abs(s.account.renewAt - in5.getTime()) < 2 * DAY);
  r = await B.send({ type: "CATALOG_ADD", id: "netflix" });
  t("重复添加不会多出一条", B.store.subs.length === 1);

  // 2. 百度网盘（浏览器访问型）：访问记录里有历史访问 → 直接作为起点
  B = boot(pages);
  B.store.records = [{ url: "https://pan.baidu.com/disk", hostname: "pan.baidu.com", time: Date.now() - 3 * DAY }];
  r = await B.send({ type: "CATALOG_ADD", id: "baidu-pan" });
  await wait(30);
  s = B.store.subs[0];
  t("百度网盘：读到 SVIP 和空间用量", s.account.plan && /SVIP|超级会员/.test(s.account.plan.label) && s.account.storage && s.account.storage.pct < 5);
  t("浏览器访问型：用访问记录里最近一次访问作起点", s.mode === "browser" && Math.abs(s.lastUsed - (Date.now() - 3 * DAY)) < 1000);
  await B.send({ type: "RUN_CHECK", ids: [s.id] });
  await wait(30);
  t("只读账户页的服务：检查后也记下「最近检查」", Date.now() - (B.store.subs[0].lastChecked || 0) < 5000);
  t("检查时插件后台打开的账户页不算「用户在用」", B.opened.length === 2 && Math.abs(B.store.subs[0].lastUsed - (Date.now() - 3 * DAY)) < 1000);
  s = B.store.subs[0];
  const adv = C.accountAdvice(bp, s.account, { state: "active" });
  t("空间只用了一点 → 建议降档", adv.level === "downgrade");

  // 3. 检查：读账户页失败时保留上次的套餐
  B.store.subs[0].lastUsed = Date.now() - 1 * DAY;
  const keepPlan = B.store.subs[0].account.plan.label;
  pages[bp.accountUrl] = { url: "https://passport.baidu.com/v2/?login", text: "登录 百度帐号" };
  // 模拟跳到登录页：页面返回的 url 是登录地址
  await B.send({ type: "RUN_CHECK", ids: [s.id] });
  s = B.store.subs[0];
  t("检查时发现未登录：状态改为 logged_out，保留上次读到的套餐", s.account.status === "logged_out" && s.account.plan && s.account.plan.label === keepPlan);

  // 4. 注入失败（被跳到别的域名）→ read_failed
  B = boot(pages);
  r = await B.send({ type: "CATALOG_ADD", id: "spotify" });
  t("账户页注入失败：订阅照样建好，状态 read_failed", r.ok && B.store.subs[0].account.status === "read_failed");

  // 5. 没授权
  B = boot(pages, { perm: false });
  r = await B.send({ type: "CATALOG_ADD", id: "netflix" });
  t("没授权：不建订阅，返回 no_permission", !r.ok && r.reason === "no_permission" && B.store.subs.length === 0);

  // 6. 诊断
  pages[bp.accountUrl] = { text: "我的会员\n超级会员 SVIP\n到期时间：" + renewTxt + "\n已用 120GB / 5TB\n" + "x".repeat(300) };
  B = boot(pages);
  r = await B.send({ type: "CATALOG_DIAGNOSE", id: "baidu-pan" });
  t("诊断：返回解析结果和页面开头文字，不会新建订阅", r.ok && r.result.status === "ok" && r.excerpt.indexOf("超级会员") >= 0 && B.store.subs.length === 0);
  r = await B.send({ type: "CATALOG_ADD", id: "claude" });
  t("大模型不走目录添加（有专门的读取）", !r.ok);

  // 7. 闲置 + 续费前 3 天 → 提醒一次
  B = boot(pages);
  await B.send({ type: "CATALOG_ADD", id: "baidu-pan" });
  B.store.subs[0].lastUsed = Date.now() - 40 * DAY;
  await B.send({ type: "RUN_CHECK" });
  const renewNote = B.notes.filter(n => n.id.indexOf("renew-") === 0);
  t("闲置且 3 天内续费：发续费提醒", renewNote.length === 1 && /自动续费/.test(renewNote[0].o.title));
  await B.send({ type: "RUN_CHECK" });
  t("同一个续费日只提醒一次", B.notes.filter(n => n.id.indexOf("renew-") === 0).length === 1);

  // 授权小窗口：点「允许」后小窗口让后台马上接着做；结果留在小窗口里，不重开弹窗、不发通知，也不会做两遍
  B = boot(pages);
  await B.send({ type: "PENDING_GRANT", action: "catalog", id: "netflix", origins: C.originsOf(nf), inWindow: true });
  B.grant();                                  // onAdded（1.5 秒后也会尝试接着做）
  await B.send({ type: "RESUME_PENDING" });   // 小窗口主动要求马上做
  await wait(1700);
  t("授权小窗口：后台马上完成添加，只添加一次", B.store.subs.length === 1 && B.store.subs[0].catalogId === "netflix" && !B.store.pendingGrant &&
    B.opened.filter(u => u === nf.accountUrl).length === 1);
  t("授权小窗口：结果写进 grantResult，不重开弹窗、不发通知", B.store.grantResult && B.store.grantResult.res.ok && B.popups.length === 0 && !B.notes.some(n => /已添加/.test(n.o.title)));

  // 9. 授权框把弹窗关掉：后台接着做完
  B = boot(pages);
  await B.send({ type: "PENDING_GRANT", action: "catalog", id: "netflix", origins: C.originsOf(nf) });
  B.grant();
  await wait(1700);
  t("授权后弹窗已关闭：后台自动完成添加", B.store.subs.length === 1 && B.store.subs[0].catalogId === "netflix" && !B.store.pendingGrant);
  t("结果写进 grantResult，并重新打开弹窗", B.store.grantResult && B.store.grantResult.res.ok && !B.store.grantResult.running && B.popups.length === 1);
  B = boot(pages, { noPopup: true });
  await B.send({ type: "PENDING_GRANT", action: "diag", id: "baidu-pan", origins: C.originsOf(bp) });
  B.grant();
  await wait(1700);
  t("打不开弹窗时发通知；诊断结果也保留", B.notes.some(n => /诊断完成/.test(n.o.title)) && B.store.grantResult.res.result.status === "ok");
  B = boot(pages);
  await B.send({ type: "PENDING_GRANT", action: "catalog", id: "netflix", origins: C.originsOf(nf) });
  B.grant();
  await B.send({ type: "CATALOG_ADD", id: "netflix" });   // 弹窗没被关掉，自己接着做了
  await wait(1700);
  t("弹窗自己接着做了：后台不重复", B.store.subs.length === 1 && !B.store.grantResult && B.opened.filter(u => u === nf.accountUrl).length === 1);
  B = boot(pages);
  await B.send({ type: "PENDING_GRANT", action: "catalog", id: "netflix", origins: C.originsOf(nf) });
  B.store.pendingGrant.at -= 10 * 60000;
  B.grant();
  await wait(1700);
  t("过期的登记不会被执行", B.store.subs.length === 0);

  // 10. 浏览历史
  const H = [
    { url: "https://pan.baidu.com/disk/home", time: Date.now() - 5 * DAY },
    { url: "https://www.notion.so/a", time: Date.now() - 2 * DAY },
    { url: "https://www.netflix.com/browse", time: Date.now() - 1 * DAY }
  ];
  B = boot(pages, { history: H });
  B.store.subs = [{ id: "n", name: "Notion", mode: "browser", urlPattern: "notion.so", idleDays: 30, lastUsed: null },
                  { id: "f", name: "Figma", mode: "browser", urlPattern: "figma.com", idleDays: 30, lastUsed: null }];
  r = await B.send({ type: "HISTORY_SCAN" });
  let n = B.store.subs.find(x => x.id === "n"), f = B.store.subs.find(x => x.id === "f");
  t("读浏览历史：装插件前的访问直接作为最近使用", r.ok && Math.abs(n.lastUsed - H[1].time) < 1000 && n.hist.days30 === 1);
  t("90 天都没访问过：直接判为闲置，不用等基线", f.lastUsedFloor === true && B.ctx.computeStatus(f, Date.now()).state === "idle");
  let gs = await B.send({ type: "GET_STATE" });
  t("「发现」能用到历史里的访问", gs.historyPermission && gs.history.hits.some(h => h.hostname === "netflix.com"));
  await B.send({ type: "CATALOG_ADD", id: "baidu-pan" });
  await wait(50);
  const bpSub = B.store.subs.find(x => x.catalogId === "baidu-pan");
  t("添加浏览器访问型服务：马上用历史补上最近使用（后台打开的账户页不算）", Math.abs(bpSub.lastUsed - H[0].time) < 1000);
  await B.send({ type: "HISTORY_OFF" });
  f = B.store.subs.find(x => x.id === "f"); n = B.store.subs.find(x => x.id === "n");
  t("停用：清掉汇总和推断出的占位，保留真实访问时间", !B.store.history && f.lastUsed === null && !n.hist && n.lastUsed);
  B = boot(pages);
  r = await B.send({ type: "HISTORY_SCAN" });
  t("没授权：不读", !r.ok && r.reason === "no_permission");

  // 11. 访问次数：所有订阅都记（收录的和没收录的），插件自己打开的不算，浏览历史补上装插件前的
  const H2 = [
    { url: "https://www.netflix.com/browse", time: Date.now() - 3 * DAY },
    { url: "https://www.netflix.com/watch/1", time: Date.now() - 3 * DAY + 5 * 60000 },
    { url: "https://www.netflix.com/browse", time: Date.now() - 20 * DAY },
    { url: "https://mymagicapp.io/app", time: Date.now() - 1 * DAY }
  ];
  B = boot(pages, { history: H2 });
  B.store.subs = [{ id: "nf", name: "Netflix", catalogId: "netflix", mode: "activity", provider: "netflix", urlPattern: "netflix.com", idleDays: 30 },
                  { id: "mm", name: "Mymagic", mode: "browser", urlPattern: "mymagicapp.io", idleDays: 30 }];
  const nav = (url, tabId) => B.ctx.chrome.webNavigation.onCompleted;
  await B.send({ type: "HISTORY_SCAN" });
  let nfs = B.store.subs.find(x => x.id === "nf"), mms = B.store.subs.find(x => x.id === "mm");
  let vsn = B.ctx.visitStats(nfs.visitLog, Date.now());
  t("收录的服务（活动记录型）也统计访问：历史里 3 次打开算 2 次访问", vsn.d90 === 2 && vsn.d7 === 1 && vsn.d30 === 2, nfs.visitLog);
  t("没收录的网址：统计访问次数和最近访问", B.ctx.visitStats(mms.visitLog, Date.now()).d7 === 1);
  t("浏览器访问型：最近使用 = 最近访问", Math.abs(mms.lastUsed - (Date.now() - DAY)) < 1000);
  t("视频类活动记录型：电脑上打开也算在用，历史补上最近使用", nfs.lastUsed && Date.now() - nfs.lastUsed < 7 * DAY && !nfs.lastUsedFloor);
  // 老的按读取方式添加的 YouTube，网址填错（youtue.com）：打开 youtube.com 照样算
  B.store.subs.push({ id: "yt", name: "youtube", mode: "activity", provider: "youtube", urlPattern: "youtue.com", idleDays: 30, lastUsed: Date.now() - 40 * DAY },
                    { id: "cg", name: "ChatGPT", mode: "activity", provider: "chatgpt", urlPattern: "chatgpt.com", idleDays: 30, lastUsed: Date.now() - 40 * DAY });
  B.listeners.nav[0]({ frameId: 0, url: "https://www.youtube.com/watch?v=x", tabId: 99 });
  B.listeners.nav[0]({ frameId: 0, url: "https://chatgpt.com/", tabId: 99 });
  await wait(30);
  const yts = B.store.subs.find(x => x.id === "yt"), cgs = B.store.subs.find(x => x.id === "cg");
  t("YouTube 网址填错也按 youtube.com 统计，并算作在用", Date.now() - yts.lastUsed < 5000 && B.ctx.visitStats(yts.visitLog, Date.now()).d7 === 1);
  t("访问流水只存网站和时间，不存完整网址", B.store.records.length > 0 && B.store.records.every(r => !r.url && r.hostname));
  B.store.subs.push({ id: "tv2", name: "B站大会员", catalogId: "bilibili", mode: "activity", provider: "bilibili", urlPattern: "bilibili.com", idleDays: 30,
                     lastUsed: Date.now() - 1 * DAY, sig: "a,b,c", signal: { ok: true } });
  B.listeners.nav[0]({ frameId: 0, url: "https://www.bilibili.com/", tabId: 98 });
  await wait(30);
  const tv2 = B.store.subs.find(x => x.id === "tv2");
  t("观看记录已读通：只打开网站不改最近使用（以观看记录为准），访问照常统计", Math.abs(tv2.lastUsed - (Date.now() - DAY)) < 2000 && B.ctx.visitStats(tv2.visitLog, Date.now()).d7 === 1);
  t("大模型：打开页面只记访问，不算在用", Date.now() - cgs.lastUsed > 30 * DAY && B.ctx.visitStats(cgs.visitLog, Date.now()).d7 === 1);

  // 别的设备的访问（Chrome 历史同步过来的，isLocal=false）不在这里统计
  {
    const now = Date.now();
    const H3 = [{ url: "https://www.mymagic.io/a", time: now - 2 * DAY, isLocal: true }, { url: "https://www.mymagic.io/b", time: now - DAY / 2, isLocal: false }];
    const B3 = boot(pages, { history: H3 });
    B3.store.subs = [{ id: "mg", name: "Mymagic", mode: "browser", urlPattern: "mymagic.io", idleDays: 30 }];
    await B3.send({ type: "HISTORY_SCAN" });
    const mg = B3.store.subs[0];
    t("读浏览历史只算本机的访问（别的设备的由它自己同步过来）", B3.ctx.visitStats(mg.visitLog, now).d90 === 1 && Math.abs(mg.lastUsed - (now - 2 * DAY)) < 1000);
  }

  // 插件替用户打开的页面（点通知、「打开账户页」「去处理」）不算在用
  B = boot(pages, {});
  B.store.subs = [{ id: "tx", name: "腾讯视频", catalogId: "tencent-video", mode: "browser", urlPattern: "v.qq.com", idleDays: 30, lastUsed: Date.now() - 40 * DAY }];
  await B.send({ type: "OPEN_TAB", url: "https://film.qq.com/vip/my/" });
  await wait(20);
  const txTab = B.opened.length + 100;
  B.listeners.nav[0]({ frameId: 0, tabId: txTab, url: "https://v.qq.com/login" });   // 跳转到同一服务的其它域名
  await wait(20);
  let tx = B.store.subs[0];
  t("「打开账户页」：打开和跳转都不算在用", Date.now() - tx.lastUsed > 30 * DAY && !(tx.visitLog || []).length);
  t("跳转到的网站也记进排除名单（读浏览历史时排除）", (B.store.ownVisits || []).some(o => o.host === "v.qq.com") && B.store.ownVisits.some(o => o.host === "film.qq.com"));
  vm.runInContext("ownTabs.forEach((v, k) => ownTabs.set(k, 0))", B.ctx);   // 模拟 2 分钟后
  B.listeners.nav[0]({ frameId: 0, tabId: txTab, url: "https://v.qq.com/x/cover/abc.html" });
  await wait(20);
  tx = B.store.subs[0];
  t("2 分钟后用户在这个标签里接着看：算在用", Date.now() - tx.lastUsed < 5000);
  const r2 = await B.send({ type: "OPEN_TAB", url: "javascript:alert(1)" });
  t("OPEN_TAB 只接受 https 网址", r2.ok && B.opened.indexOf("javascript:alert(1)") < 0);

  // 升级：以前按浏览器访问添加的 B站，改成读观看记录；读取方式已不存在的（腾讯视频）改回浏览器访问
  {
    const B4 = boot(pages, {});
    B4.store.subs = [{ id: "b1", name: "B站大会员", catalogId: "bilibili", mode: "browser", urlPattern: "bilibili.com" },
                     { id: "t1", name: "腾讯视频", catalogId: "tencent-video", mode: "activity", provider: "tencent", urlPattern: "v.qq.com", sig: "x" },
                     { id: "n1", name: "Notion", catalogId: "notion", mode: "browser", urlPattern: "notion.so" }];
    await B4.listeners.d[0]();
    await wait(20);
    const g = (id) => B4.store.subs.find(x => x.id === id);
    t("升级：有观看记录的服务改为读观看记录，没有的不变", g("b1").mode === "activity" && g("b1").provider === "bilibili" && g("n1").mode === "browser");
    t("腾讯视频保留读观看记录", g("t1").mode === "activity" && g("t1").provider === "tencent");
  }

  // 腾讯视频：用观看记录接口返回的观看时间（view_date_ms）作为最近使用
  {
    const watchedAt = Date.now() - 5 * DAY;
    const o6 = { tx: { ids: ["v1@1", "v2@0"], lastTs: watchedAt, count: 2, sample: ["美人余 第13集"], strategy: "tencent" } };
    const B6 = boot(pages, o6);
    const r6 = await B6.send({ type: "CATALOG_ADD", id: "tencent-video" });
    await wait(40);
    const s6 = B6.store.subs[0];
    t("腾讯视频：添加后读观看记录，最近使用 = 接口里最近一次观看时间", r6.ok && s6.mode === "activity" && s6.provider === "tencent" &&
      Math.abs(s6.lastUsed - watchedAt) < 1000 && Math.abs(s6.lastWatched - watchedAt) < 1000, s6);
    t("腾讯视频：记下最近看的片名（只存本机）", s6.watchTitle && s6.watchTitle.title === "美人余 第13集" && s6.watchTitle.at === s6.lastWatched &&
      !("watchTitle" in B6.ctx.SyncLib.payload([s6], {}).subs[0]));
    t("腾讯视频：读取时临时挂上接口监听，读完就注销", (o6.txHookAtRead || []).indexOf("idlesubs-tx-hook") >= 0 && !(o6.reg || []).length);
    // 云端同步过来的旧数据（按浏览器访问）：检查前自动改成读观看记录
    const o7 = { tx: { ids: ["v9@1"], lastTs: watchedAt, count: 1, strategy: "tencent" } };
    const B7 = boot(pages, o7);
    B7.store.subs = [{ id: "t7", name: "腾讯视频", catalogId: "tencent-video", mode: "browser", urlPattern: "v.qq.com", idleDays: 30, lastUsed: Date.now() }];
    await B7.send({ type: "RUN_CHECK", ids: ["t7"] });
    await wait(40);
    const s7 = B7.store.subs[0];
    t("旧的腾讯视频订阅：检查时改成读观看记录，最近使用按观看时间", s7.mode === "activity" && s7.provider === "tencent" && Math.abs(s7.lastUsed - watchedAt) < 1000, s7);
    // 接口监听脚本：多次调用的结果都收集起来
    {
      const resp = (o) => Promise.resolve({ clone: () => ({ text: () => Promise.resolve(JSON.stringify(o)) }) });
      const queue = [{ ret: 0, data: { msgs: [{ msg: { vid: "old", view_date_ms: "1000" } }] } }, { ret: 0, data: { msgs: [{ msg: { vid: "new", view_date_ms: "2000" } }] } }];
      const win = { fetch: () => resp(queue.shift()) };
      win.window = win;
      function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {};
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, "tx-hook.js"), "utf8"), Object.assign(win, { XMLHttpRequest: XHR, JSON, String, Date }));
      await win.fetch("https://pbaccess.video.qq.com/x/GetList?video_appid=1200022&a=1");
      await win.fetch("https://pbaccess.video.qq.com/x/GetList?video_appid=1200001&a=1");
      await wait(10);
      const c = win.__idlesubsTx;
      t("接口监听：几次调用的记录都收集到", c && c.msgs.length === 2 && c.calls.length === 2 && c.calls[1].appid === "1200001");
    }
    // 页面里的提取函数
    const fake = { window: { __idlesubsTx: { ret: 0, req: { url: "https://pbaccess.video.qq.com/GetList?video_appid=1200022", method: "POST", body: "{}" }, msgs: [
      { msg: { vid: "b", view_date: "1792100000" } }, { msg: {} }] } }, document: { body: { innerText: "看过" } }, location: { href: "x" }, setTimeout,
      // 跳过缓存重取到的最新结果：片名在 poster 里（和 msg 同级）
      fetch: async (u, o) => { fake.fetched = o; return { json: async () => ({ ret: 0, data: { msgs: [{ msg: { vid: "a", view_date_ms: "1792222531174" }, poster: { title: "美人余 第13集" } }] } }) }; } };
    fake.window.window = fake.window;
    const ex = vm.runInNewContext("(" + B6.ctx.tencentExtract.toString() + ")", Object.assign({}, fake, { window: fake.window, Date, Number, String, Math, Promise, Array }));
    const er = await ex();
    t("提取：按观看时间取最近一条，条目 ID 带时间做指纹", er.lastTs === 1792222531174 && er.count === 2 && er.ids[0].indexOf("a@") === 0 && er.sample[0] === "美人余 第13集" && fake.fetched.cache === "no-store" && fake.fetched.method === "POST" && er.fresh.n === 1);
    const fake2 = { window: { __idlesubsTx: { ret: -1, msgs: null } }, document: { body: { innerText: "" } }, location: { href: "x" }, setTimeout, Date, Number, String, Math, Promise, Array };
    const er2 = await vm.runInNewContext("(" + B6.ctx.tencentExtract.toString() + ")", fake2)();
    t("提取：接口报错（没登录）→ 标记未登录", er2.loggedOut === true && !er2.ids.length);
  }

  // 登录判断以账户页为准：账户页没登录时，观看记录（可能是游客记录）不采用
  {
    const tvUrl = C.BY_ID["tencent-video"].accountUrl;
    const old = Date.now() - 40 * DAY;
    const mk = (text, url) => Object.assign({}, pages, { [tvUrl]: { url: url || tvUrl, text } });
    const sub0 = () => [{ id: "g1", name: "腾讯视频", catalogId: "tencent-video", mode: "activity", provider: "tencent", urlPattern: "v.qq.com", idleDays: 30, lastUsed: old, sig: "s" }];
    const tx = { ids: ["guest@1"], lastTs: Date.now() - 3600000, count: 1, sample: ["游客看的片"], strategy: "tencent" };
    const Bg = boot(mk("腾讯视频 VIP会员 请登录 登录后查看会员权益 " + "x".repeat(300), "https://film.qq.com/login"), { tx });
    Bg.store.subs = sub0();
    await Bg.send({ type: "RUN_CHECK", ids: ["g1"] });
    await wait(30);
    const g1 = Bg.store.subs[0];
    t("账户页没登录：观看记录不采用，标成「读不到：没登录」，最近使用不变", g1.signal && g1.signal.ok === false && g1.signal.reason === "logged_out" &&
      g1.lastUsed === old && !g1.watchTitle && g1.loginState === "logged_out", { signal: g1.signal, lastUsed: g1.lastUsed, ls: g1.loginState });
    const Bu = boot(mk("页面改版了 " + "x".repeat(300)), { tx });
    Bu.store.subs = sub0();
    await Bu.send({ type: "RUN_CHECK", ids: ["g1"] });
    await wait(30);
    const u1 = Bu.store.subs[0];
    t("账户页读不准、观看记录有内容：照常用，记「登录状态未确认」", u1.signal.ok && Math.abs(u1.lastUsed - tx.lastTs) < 1000 && u1.loginState === "unconfirmed");
    const Bo = boot(mk("我的VIP 超级影视VIP 有效期至2027年1月1日 " + "x".repeat(300)), { tx });
    Bo.store.subs = sub0();
    await Bo.send({ type: "RUN_CHECK", ids: ["g1"] });
    await wait(30);
    t("账户页读到套餐：登录了，正常用观看记录", Bo.store.subs[0].signal.ok && Bo.store.subs[0].loginState === "ok");
  }

  // 优酷：从页面收到的 JSON 里找带观看时间和片名的列表
  {
    const watchedAt = Date.now() - 2 * DAY;
    const o8 = { tx: null };
    const B8 = boot(pages, o8);
    const ex = B8.ctx.youkuExtract;
    const sec = Math.floor(watchedAt / 1000);
    const body = { api: "mtop.youku.ucenter.history", data: { model: { list: [
      { videoId: "XNa", title: "庆余年 第二季 第5集", lastPlayTime: sec - 3600, extra: { showName: "庆余年" } },
      { videoId: "XNb", title: "繁花 第1集", lastPlayTime: String(sec), showUpdateTime: Date.now() - 1000 },
      { videoId: "XNc", title: "", lastPlayTime: sec } ] }, banner: [{ name: "广告", img: "x" }] } };
    const win = { __idlesubsHist: { calls: [{ path: "acs.youku.com/h5/mtop.youku.ucenter.history/1.0/", size: 500 }], bodies: [{ path: "acs.youku.com/h5/x", json: body }] } };
    win.window = win;
    const ctx8 = Object.assign(win, { Date, Number, String, Math, Promise, Array, Object, JSON, RegExp, isFinite, setTimeout,
      document: { body: { innerText: "" }, querySelectorAll: () => [] }, location: { href: "https://www.youku.com/ku/usc/index" } });
    const yr = await vm.runInNewContext("(" + ex.toString() + ")", ctx8)();
    t("优酷：找到观看记录列表，最近一次 = 最新的观看时间，带片名", yr.count === 2 && Math.abs(yr.lastTs - sec * 1000) < 1 && yr.sample[0] === "繁花 第1集" && yr.ids[0].indexOf("XNb@") === 0, yr);
    // 监听脚本：JSONP 包装也能解析
    const win2 = { fetch: () => Promise.resolve({ headers: { get: () => "application/javascript" }, clone: () => ({ text: () => Promise.resolve('mtopjsonp3({"ret":["SUCCESS"],"data":{"a":1}})') }) }) };
    win2.window = win2;
    function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {}; XHR.prototype.addEventListener = function () {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "hist-hook.js"), "utf8"), Object.assign(win2, { XMLHttpRequest: XHR, JSON, String, URL, location: { href: "https://www.youku.com/ku/usc/index" } }));
    await win2.fetch("https://acs.youku.com/h5/mtop.youku.x/1.0/?jsonp=mtopjsonp3");
    await wait(10);
    t("通用监听：JSONP 包装的结果也能留下", win2.__idlesubsHist.bodies.length === 1 && win2.__idlesubsHist.bodies[0].json.data.a === 1 && win2.__idlesubsHist.calls[0].path === "acs.youku.com/h5/mtop.youku.x/1.0/");
    // 添加优酷：读观看记录
    const o9 = {};
    const B9 = boot(pages, o9);
    vm.runInContext("youkuExtract.__isYouku = 1", B9.ctx);
    const r9 = await B9.send({ type: "CATALOG_ADD", id: "youku" });
    await wait(40);
    t("添加优酷：按观看记录判断，读取时挂上通用监听并在读完后注销", r9.ok && B9.store.subs[0].mode === "activity" && B9.store.subs[0].provider === "youku" && !(o9.reg || []).length);
  }

  // 百度网盘：页面文字里没有空间时，用网盘自己的用量接口
  {
    const G = 1024 ** 3;
    const pg2 = Object.assign({}, pages); pg2["https://pan.baidu.com/disk/main"] = { url: "https://pan.baidu.com/disk/main", text: "首页 我的文件 超级会员 SVIP " + "x".repeat(300) };
    const B5 = boot(pg2, { quota: { used: 1651 * G, total: 3181 * G, errno: 0 } });
    const r5 = await B5.send({ type: "CATALOG_ADD", id: "baidu-pan" });
    const b5 = B5.store.subs[0];
    t("百度网盘：从用量接口读到空间 1.6 TB / 3.1 TB", r5.ok && b5.account.storage && b5.account.storage.pct === 52, b5 && b5.account);
    B5.store.subs[0].account = { status: "ok", plan: { label: "超级会员", paid: true } };   // 旧数据：没有空间
    const d5 = await B5.send({ type: "CATALOG_DIAGNOSE", id: "baidu-pan" });
    t("诊断读成功：结果存进订阅，列表里能看到空间", d5.ok && B5.store.subs[0].account.storage && B5.store.subs[0].account.storage.pct === 52 && B5.store.subs[0].lastChecked);
  }

  // 全部检查（定时 / 立即检查）：3 天内读过套餐的不再打开账户页；单独检查仍然完整读
  {
    const B6 = boot(pages, {});
    B6.store.subs = [{ id: "nf6", name: "Netflix", catalogId: "netflix", mode: "browser", urlPattern: "netflix.com",
                       account: { status: "ok", plan: { label: "Premium", paid: true }, checkedAt: Date.now() - DAY } }];
    await B6.send({ type: "RUN_CHECK" });
    await wait(30);
    t("全部检查：套餐 3 天内读过 → 不开账户页，但记下检查时间", B6.opened.filter(u => u === nf.accountUrl).length === 0 && Date.now() - (B6.store.subs[0].lastChecked || 0) < 5000, B6.opened);
    await B6.send({ type: "RUN_CHECK", ids: ["nf6"] });
    await wait(30);
    t("单独检查这一个：完整读一次账户页", B6.opened.filter(u => u === nf.accountUrl).length === 1);
    B6.store.subs[0].account.checkedAt = Date.now() - 5 * DAY;
    await B6.send({ type: "RUN_CHECK" });
    await wait(30);
    t("全部检查：超过 3 天没读的照常打开账户页", B6.opened.filter(u => u === nf.accountUrl).length === 2);
  }

  // 观看记录第一组标题「星期一」→ 最近观看 = 上周一，最近使用跟着它（不是检查当天）
  {
    const B7 = boot(pages, { topLabel: "星期一" });
    B7.store.subs = [{ id: "yt7", name: "YouTube Premium", catalogId: "youtube", mode: "activity", provider: "youtube", urlPattern: "youtube.com", sig: "old", signal: { ok: true }, lastUsed: Date.now() }];
    await B7.send({ type: "RUN_CHECK", ids: ["yt7"] });
    await wait(30);
    const y7 = B7.store.subs[0], exp = B7.ctx.parseLabelToTs("星期一", Date.now());
    t("YouTube：最近观看取观看记录的日期（星期一），最近使用也是它", y7.lastWatched === exp && y7.lastUsed === exp, y7);
  }

  // 定时检查：每 12 小时；装好 / 浏览器启动时不马上检查，按上次全部检查时间接着算
  {
    const B8 = boot(pages, {});
    await B8.listeners.d[0](); await wait(10);
    const a1 = B8.alarmsMade[0];
    t("刚装好：12 小时一次，第一次在 12 小时后（不是 1 分钟后）", a1 && a1.periodInMinutes === 720 && a1.delayInMinutes === 720, a1);
    await B8.listeners.e[0](); await wait(10);
    t("浏览器重启：闹钟已经在，不重置计时", B8.alarmsMade.length === 1);
    const B9 = boot(pages, {});
    B9.store.lastCheck = Date.now() - 2 * 3600e3;
    await B9.listeners.e[0](); await wait(10);
    t("上次检查是 2 小时前：10 小时后再检查", Math.abs(B9.alarmsMade[0].delayInMinutes - 600) <= 1);
    const B10 = boot(pages, {});
    B10.store.lastCheck = Date.now() - 20 * 3600e3;
    await B10.listeners.e[0](); await wait(10);
    t("超过 12 小时没检查：启动后 15 分钟补一次", B10.alarmsMade[0].delayInMinutes === 15);
  }

  // 8. B站活动记录 provider 存在
  const st = await B.send({ type: "GET_STATE" });
  t("B站有观看记录读取配置", st.providers.some(p => p.key === "bilibili"));
})();
