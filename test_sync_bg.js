// 云端同步的后台流程：两台设备 + 服务端（模拟 chrome API；node test_sync_bg.js）
// 加 E2E=http://localhost:8787 时连真实的本地服务端
const fs = require("fs"), vm = require("vm"), path = require("path");
const realTimeout = setTimeout;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
function boot(fetchImpl) {
  const store = { subs: [], records: [] }, listeners = {};
  const ev = (n) => ({ addListener: (f) => { (listeners[n] = listeners[n] || []).push(f); }, removeListener() {} });
  const chrome = {
    storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                        set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
                        remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); } } },
    permissions: { contains: async () => true, onAdded: ev("padd") },
    tabs: { query: async () => [], create: async () => ({ id: 1 }), remove: async () => {}, onUpdated: ev("tu"), onRemoved: ev("tr") },
    scripting: { executeScript: async () => [{ result: null }] },
    webNavigation: { onCompleted: ev("a"), onHistoryStateUpdated: ev("b") },
    alarms: { onAlarm: ev("c"), create() {} }, runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
    notifications: { onClicked: ev("f"), create() {} }
  };
  const timers = [];
  const ctx = { console, chrome, fetch: fetchImpl, setTimeout: (f, ms) => { const h = realTimeout(f, Math.min(ms || 0, 30)); timers.push(h); return h; }, clearTimeout, Promise, Date, JSON, Math, Set, Map, URL, URLSearchParams, RegExp, TextEncoder, importScripts: () => {} };
  ctx.globalThis = ctx; ctx.crypto = require("crypto").webcrypto; vm.createContext(ctx);
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  const send = (m) => new Promise(r => listeners.msg[0](m, {}, r));
  return { store, send, listeners, ctx };
}
const t = (n, c, x) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || x === undefined ? "" : "  → " + JSON.stringify(x))); if (!c) process.exitCode = 1; };
const wait = (ms) => new Promise(r => realTimeout(r, ms));

function mockServer() {
  const users = {}, sessions = {}, data = {};
  const json = (status, body, headers) => ({ ok: status < 300, status, headers: { get: (k) => (headers || {})[k.toLowerCase()] || null }, json: async () => body });
  const f = async (url, o) => {
    const p = new URL(url).pathname, body = o.body ? JSON.parse(o.body) : {};
    const who = sessions[(o.headers.Authorization || "").replace("Bearer ", "")];
    if (p === "/api/auth/sign-up/email" || p === "/api/auth/sign-in/email") {
      if (p.includes("up")) users[body.email] = body.password; else if (users[body.email] !== body.password) return json(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
      const k = "tk" + Math.random(); sessions[k] = body.email; return json(200, { token: k }, { "set-auth-token": k });
    }
    if (p === "/api/me") return who ? json(200, { ok: true, user: { id: who, email: who }, subLimit: null }) : json(401, {});
    if (p === "/api/sync") {
      if (!who) return json(401, {});
      const row = data[who];
      if (o.method === "GET" || !o.method) return json(200, { ok: true, version: row ? row.version : 0, data: row ? row.data : null });
      if (o.method === "DELETE") { delete data[who]; return json(200, { ok: true }); }
      if (o.method === "PUT") {
        f.puts++;
        if ((row ? row.version : 0) !== body.baseVersion) return json(409, { ok: false, reason: "conflict", version: row ? row.version : 0, data: row ? row.data : null });
        data[who] = { version: body.baseVersion + 1, data: body.data }; return json(200, { ok: true, version: body.baseVersion + 1 });
      }
    }
    if (p === "/api/auth/sign-out") return json(200, {});
    return json(404, {});
  };
  f.puts = 0; f.data = data;
  return f;
}
const sub = (id, name, extra) => Object.assign({ id, name, mode: "browser", urlPattern: name.toLowerCase() + ".com", idleDays: 30 }, extra || {});

async function suite(label, fetchImpl, email) {
  console.log(label);
  const A = boot(fetchImpl), B = boot(fetchImpl);
  for (let i = 0; i < 3; i++) await A.send({ type: "SAVE_SUB", sub: sub("a" + i, "Svc" + i, { price: 10 + i }) });
  let r = await A.send({ type: "SYNC_SET", enabled: true });
  t("没登录不能开同步", !r.ok && r.reason === "logged_out");
  await A.send({ type: "AUTH_SIGN_UP", email, password: "correct-horse-9" });
  await wait(150);
  t("设备 A 第一次登录：自动开启云端同步并上传 3 个订阅", A.store.sync && A.store.sync.enabled && A.store.sync.lastSyncAt && !A.store.sync.userSet, A.store.sync);
  r = await A.send({ type: "SYNC_NOW" });
  t("云端已经有这 3 个订阅（不用再上传）", r.ok && r.pushed === false && r.count === 3, r);
  A.store.subs[0].sig = { ids: ["secret-video-id"] }; A.store.subs[0].hist = { days30: 9 };

  const checked = [];
  B.ctx.runCheck = async (ids) => { checked.push(ids); };   // 记下同步后触发了哪些检查
  await B.send({ type: "AUTH_SIGN_IN", email, password: "correct-horse-9" });
  r = await B.send({ type: "SYNC_SET", enabled: true });
  t("设备 B 登录并开启：从云端恢复 3 个订阅", r.ok && B.store.subs.length === 3 && B.store.subs[2].price === 12, r);
  await wait(80);
  t("新设备第一次同步：只对云端带来的这 3 个订阅各检查一次", checked.length >= 1 && checked[0].length === 3 && checked.every(c => Array.isArray(c) && c.length), checked);
  const nCheck = checked.length;
  await B.send({ type: "SYNC_NOW" }); await wait(80);
  t("没有新订阅的同步不触发检查", checked.length === nCheck);

  await B.send({ type: "SAVE_SUB", sub: Object.assign({}, B.store.subs[1], { price: 99 }) });
  await B.send({ type: "SAVE_SUB", sub: sub("b9", "Spotify") });
  await B.send({ type: "DELETE_SUB", id: "a0" });
  await wait(120);   // 等改动后的自动上传
  r = await A.send({ type: "SYNC_NOW" });
  t("设备 B 的改价、新增、删除都同步到了设备 A", r.ok && A.store.subs.length === 3 && A.store.subs.find(s => s.id === "a1").price === 99 &&
    A.store.subs.some(s => s.name === "Spotify") && !A.store.subs.some(s => s.id === "a0"), A.store.subs.map(s => s.name + ":" + s.price));

  // 两台设备同时改（冲突）：都保住
  await A.send({ type: "SAVE_SUB", sub: sub("a5", "Figma") });
  await B.send({ type: "SAVE_SUB", sub: sub("b5", "Canva") });
  await Promise.all([A.send({ type: "SYNC_NOW" }), B.send({ type: "SYNC_NOW" })]);
  await wait(150);
  await A.send({ type: "SYNC_NOW" }); await B.send({ type: "SYNC_NOW" });
  const names = (st) => st.subs.map(s => s.name).sort().join(",");
  t("两台设备同时新增：冲突后合并，两边都有 Figma 和 Canva", names(A.store) === names(B.store) && /Canva/.test(names(A.store)) && /Figma/.test(names(A.store)), [names(A.store), names(B.store)]);

  if (fetchImpl.data) {
    const up = JSON.stringify(Object.values(fetchImpl.data)[0].data);
    t("上传内容里没有活动指纹和浏览历史汇总", !up.includes("secret-video-id") && !up.includes("days30\":9"));
  }
  // 手动排序：A 排好，B 同步后顺序一样
  const ids = A.store.subs.map(s => s.id).reverse();
  await A.send({ type: "SET_ORDER", ids });
  await A.send({ type: "SYNC_NOW" }); await B.send({ type: "SYNC_NOW" });
  const gb = await B.send({ type: "GET_STATE" });
  t("手动排序：设备 A 排的顺序同步到设备 B", gb.order && gb.order.join(",") === ids.join(","), [gb.order, ids]);
  // 访问次数：A 上的访问同步到 B
  A.store.subs[0].visitLog = [Date.now() - 3 * 86400000, Date.now() - 86400000];
  A.store.subs = A.store.subs.slice();
  await A.send({ type: "SYNC_NOW" }); await B.send({ type: "SYNC_NOW" });
  const bs = B.store.subs.find(x => x.name === A.store.subs[0].name);
  t("访问次数：设备 A 的访问同步到设备 B", bs && (bs.visitLog || []).length === 2, bs && bs.visitLog);
  // A 检查时在后台打开过某网站；B 经 Chrome 历史同步把那次算成了访问 → 同步后 B 去掉它
  const tgt = A.store.subs[0], tdom = String(tgt.urlPattern || "").replace(/^www\./, "");
  const tCheck = Date.now() - 2 * 3600e3;
  A.store.ownVisits = (A.store.ownVisits || []).concat([{ host: tdom, time: tCheck }]);
  await A.send({ type: "SYNC_NOW" });
  const bt = B.store.subs.find(x => x.name === tgt.name);
  bt.visitLog = (bt.visitLog || []).concat([tCheck + 30 * 1000]).sort((x, y) => x - y);
  B.store.subs = B.store.subs.slice();
  const nBefore = bt.visitLog.length;
  await B.send({ type: "SYNC_NOW" });
  const bt2 = B.store.subs.find(x => x.name === tgt.name);
  t("设备 A 检查时打开的页面：同步到 B 后从访问次数里去掉", tdom && bt2.visitLog.length === nBefore - 1 && (B.store.ownVisits || []).some(o => o.host === tdom), [tdom, bt2.visitLog.length, nBefore]);
  // 访问触发的同步：只有新的一次访问才上传，同一次访问里的页面跳转不上传
  if (fetchImpl.puts !== undefined) {
    const vs = A.store.subs.find(x => x.mode === "browser" && x.urlPattern);
    const vdom = String(vs.urlPattern).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    vs.visitLog = []; A.store.subs = A.store.subs.slice();
    await A.send({ type: "SYNC_NOW" });
    const p0 = fetchImpl.puts;
    A.listeners.a[0]({ frameId: 0, tabId: 7, url: "https://" + vdom + "/home" });
    await wait(150);
    const p1 = fetchImpl.puts;
    for (let i = 0; i < 3; i++) { A.listeners.b[0]({ frameId: 0, tabId: 7, url: "https://" + vdom + "/page" + i }); await wait(10); }
    await wait(150);
    const vs2 = A.store.subs.find(x => x.id === vs.id);
    t("新的一次访问：上传一次；同一次访问里的跳转：不再上传，只更新本机最近使用", p1 === p0 + 1 && fetchImpl.puts === p1 && Date.now() - vs2.lastUsed < 1000, [p0, p1, fetchImpl.puts]);
    const rr = await A.send({ type: "SYNC_NOW" });
    t("下次同步时把最新的最近使用一起带上", rr.ok && rr.pushed === true);
  }
  const before = fetchImpl.puts;
  r = await A.send({ type: "SYNC_NOW" });
  t("没有变化时不重复上传", r.ok && r.pushed === false && (fetchImpl.puts === undefined || fetchImpl.puts === before), r);

  const st = await A.send({ type: "GET_STATE" });
  t("弹窗能看到同步状态", st.sync.enabled && st.sync.lastSyncAt > 0 && !st.sync.lastError);
  r = await A.send({ type: "SYNC_SET", enabled: false, deleteCloud: true });
  t("关闭同步并删除云端数据；本机订阅保留", r.ok && r.cloudDeleted && A.store.subs.length >= 4);
  await A.send({ type: "AUTH_SIGN_OUT" });
  await A.send({ type: "AUTH_SIGN_IN", email, password: "correct-horse-9" });
  await wait(100);
  t("自己关掉过同步的，再登录不会自动打开", A.store.sync && !A.store.sync.enabled);
  r = await B.send({ type: "SYNC_NOW" });
  t("云端删掉后，B 再同步时把自己的数据重新传上去（不会把 B 清空）", r.ok && B.store.subs.length >= 4);
}

(async () => {
  await suite("模拟服务端：", mockServer(), "u@example.com");
  if (process.env.E2E) {
    const real = (url, o) => fetch(url.replace(/^https?:\/\/[^/]+/, process.env.E2E), Object.assign({}, o, { headers: Object.assign({ Origin: ORIGIN }, o.headers) }));
    await suite(`\n真实服务端（${process.env.E2E}）：`, real, `sync${Date.now()}@example.com`);
  }
})();
