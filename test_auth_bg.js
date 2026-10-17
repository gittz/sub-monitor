// 登录与订阅数上限（模拟 chrome API；node test_auth_bg.js）
// 加 E2E=http://localhost:8787 时连真实的本地服务端（先在 auth-server 里 npx wrangler dev --local）
const fs = require("fs"), vm = require("vm"), path = require("path");
const realTimeout = setTimeout;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
function boot(fetchImpl, opts) {
  opts = opts || {};
  const store = { subs: [], records: [] }, listeners = {}, opened = [], authUrls = [], popups = [];
  let tabSeq = 100;
  const ev = (n) => ({ addListener: (f) => { (listeners[n] = listeners[n] || []).push(f); }, removeListener() {} });
  const chrome = {
    storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach(x => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; },
                        set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
                        remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); } } },
    permissions: { contains: async () => true, onAdded: ev("padd") },
    tabs: { query: async () => [], get: async (id) => ({ id }), create: async (o) => { opened.push(o.url); const id = ++tabSeq;
              realTimeout(() => (listeners.tu || []).forEach(f => f(id, { status: "complete" })), 1); return { id }; },
            remove: async () => {}, onUpdated: ev("tu"), onRemoved: ev("tr") },
    scripting: { executeScript: async () => [{ result: { url: "", text: "" } }] },
    webNavigation: { onCompleted: ev("a"), onHistoryStateUpdated: ev("b") },
    alarms: { onAlarm: ev("c"), create() {} }, runtime: { onInstalled: ev("d"), onStartup: ev("e"), onMessage: ev("msg") },
    notifications: { onClicked: ev("f"), create() {} },
    identity: { getRedirectURL: () => "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/",
                launchWebAuthFlow: async (o) => { authUrls.push(o.url); return opts.google ? opts.google(new URL(o.url)) : Promise.reject(new Error("no")); } },
    action: { openPopup: async () => { popups.push(1); } }
  };
  const ctx = { console, chrome, fetch: fetchImpl, setTimeout: (f, ms) => realTimeout(f, Math.min(ms || 0, 5)), clearTimeout, Promise, Date, JSON, Math, Set, Map, URL, URLSearchParams, RegExp, importScripts: () => {} };
  ctx.globalThis = ctx; vm.createContext(ctx);
  ctx.crypto = require("crypto").webcrypto;
  for (const f of ["i18n.js", "i18n-en.js", "lib.js", "mailscan.js", "llm.js", "catalog.js", "history.js", "auth.js", "sync.js", "background.js"]) {
    let src = fs.readFileSync(path.join(__dirname, f), "utf8");
    // 测试不依赖 auth.js 里实际填的 Client ID
    if (f === "auth.js") src = src.replace(/const GOOGLE_CLIENT_ID = "[^"]*";/, `const GOOGLE_CLIENT_ID = "${opts.clientId || ""}";`);
    vm.runInContext(src, ctx);
  }
  const send = (m) => new Promise(r => listeners.msg[0](m, {}, r));
  return { store, send, opened, authUrls, popups };
}
const t = (n, c, x) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || x === undefined ? "" : "  → " + JSON.stringify(x))); if (!c) process.exitCode = 1; };
const sub = (i) => ({ id: "s" + i, name: "S" + i, mode: "browser", urlPattern: `s${i}.com`, idleDays: 30 });

// 模拟服务端
function mockServer() {
  const users = {}, sessions = {};
  const json = (status, body, headers) => ({ ok: status < 300, status, headers: { get: (k) => (headers || {})[k.toLowerCase()] || null }, json: async () => body });
  const f = async (url, o) => {
    if (f.down) throw new TypeError("Failed to fetch");
    const p = new URL(url).pathname, body = o.body ? JSON.parse(o.body) : {};
    const tok = (o.headers.Authorization || "").replace("Bearer ", "");
    if (p === "/api/auth/sign-up/email") {
      if (users[body.email]) return json(422, { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
      users[body.email] = body.password; const k = "tk" + Math.random(); sessions[k] = body.email;
      return json(200, { token: k, user: { id: "u1", email: body.email } }, { "set-auth-token": k });
    }
    if (p === "/api/auth/sign-in/email") {
      if (users[body.email] !== body.password) return json(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
      const k = "tk" + Math.random(); sessions[k] = body.email; return json(200, { token: k, user: { id: "u1", email: body.email } }, { "set-auth-token": k });
    }
    if (p === "/api/auth/sign-in/social") {
      const g = f.google || {};
      if (body.provider !== "google" || body.idToken.token !== g.token || body.idToken.nonce !== g.nonce) return json(401, { code: "INVALID_TOKEN" });
      const k = "tk" + Math.random(); sessions[k] = g.email; return json(200, { token: k, user: { id: "g1", email: g.email } }, { "set-auth-token": k });
    }
    if (p === "/api/me") return sessions[tok] ? json(200, { ok: true, user: { id: "u1", email: sessions[tok] }, subLimit: null }) : json(401, { ok: false });
    if (p === "/api/auth/sign-out") { delete sessions[tok]; return json(200, { success: true }); }
    return json(404, {});
  };
  f.sessions = sessions;
  return f;
}

async function suite(name, fetchImpl, email) {
  console.log(name);
  const B = boot(fetchImpl);
  for (let i = 0; i < 4; i++) await B.send({ type: "SAVE_SUB", sub: sub(i) });
  let st = await B.send({ type: "GET_STATE" });
  t("未登录：上限 5", st.subLimit === 5 && !st.auth);
  let r = await B.send({ type: "SAVE_SUB", sub: sub(4) });
  t("第 5 个可以加", r.ok && B.store.subs.length === 5);
  r = await B.send({ type: "SAVE_SUB", sub: sub(5) });
  t("第 6 个被拦住", !r.ok && r.reason === "limit" && r.limit === 5 && B.store.subs.length === 5, r);
  r = await B.send({ type: "SAVE_SUB", sub: Object.assign(sub(0), { name: "改名" }) });
  t("满了也能编辑已有的订阅", r.ok && B.store.subs[0].name === "改名");
  r = await B.send({ type: "CATALOG_ADD", id: "netflix" });
  t("从服务目录添加也被拦住，而且不会白白打开网页", r.reason === "limit" && B.opened.length === 0, r);
  r = await B.send({ type: "LLM_QUICK_ADD", kind: "claude" });
  t("大模型一键添加也被拦住", r.reason === "limit" && B.opened.length === 0, r);

  r = await B.send({ type: "AUTH_SIGN_IN", email, password: "wrong-password" });
  t("没注册时登录失败，提示邮箱或密码不对", !r.ok && /邮箱或密码/.test(r.error), r);
  r = await B.send({ type: "AUTH_SIGN_UP", email, password: "short" });
  t("密码太短在插件里就拦住", !r.ok && /8 位/.test(r.error));
  r = await B.send({ type: "AUTH_SIGN_UP", email, password: "correct-horse-9" });
  t("注册并登录", r.ok && r.auth.user.email === email && B.store.auth && B.store.auth.token, r);
  t("token 不会发给弹窗", !JSON.stringify(await B.send({ type: "GET_STATE" })).includes(B.store.auth.token));
  st = await B.send({ type: "GET_STATE" });
  t("登录后不限数量", st.subLimit === null && st.auth.user.email === email);
  r = await B.send({ type: "SAVE_SUB", sub: sub(5) });
  t("登录后第 6 个可以加", r.ok && B.store.subs.length === 6);
  r = await B.send({ type: "AUTH_SIGN_UP", email, password: "correct-horse-9" });
  t("重复注册提示已注册", !r.ok && /注册过/.test(r.error), r);

  r = await B.send({ type: "AUTH_VERIFY" });
  t("向服务端确认登录有效", r.auth && r.auth.user.email === email);

  r = await B.send({ type: "AUTH_SIGN_OUT" });
  await new Promise(r => realTimeout(r, 200));
  st = await B.send({ type: "GET_STATE" });
  t("退出：已有 6 个订阅保留，但不能再加", !st.auth && B.store.subs.length === 6 && (await B.send({ type: "SAVE_SUB", sub: sub(6) })).reason === "limit");
  r = await B.send({ type: "AUTH_SIGN_IN", email: email.toUpperCase(), password: "correct-horse-9" });
  t("再次登录（邮箱大小写不敏感）", r.ok);
  return B;
}

(async () => {
  const m = mockServer();
  const B = await suite("模拟服务端：", m, "user@example.com");
  // 会话被服务端判失效 → 自动退出；连不上服务器 → 保持登录
  m.down = true;
  let r = await B.send({ type: "AUTH_VERIFY" });
  t("连不上服务器时保持登录", r.auth && B.store.auth);
  m.down = false;
  for (const k of Object.keys(m.sessions)) delete m.sessions[k];
  r = await B.send({ type: "AUTH_VERIFY" });
  t("服务端说会话失效（401）→ 自动退出", !r.auth && !B.store.auth);
  r = await B.send({ type: "SAVE_SUB", sub: sub(9) });
  t("自动退出后恢复 5 个上限", r.reason === "limit");

  // Google 登录
  console.log("Google 登录：");
  let G = boot(mockServer());
  let st = await G.send({ type: "GET_STATE" });
  t("没配 Client ID 时不显示 Google 登录", st.googleLogin === false);
  const m2 = mockServer();
  G = boot(m2, { clientId: "123-abc.apps.googleusercontent.com", google: (u) => {
    m2.google = { token: "IDTOKEN", nonce: u.searchParams.get("nonce"), email: "g@gmail.com" };
    return `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#state=${u.searchParams.get("state")}&id_token=IDTOKEN`;
  } });
  st = await G.send({ type: "GET_STATE" });
  t("配了 Client ID 后显示 Google 登录", st.googleLogin === true);
  r = await G.send({ type: "AUTH_GOOGLE" });
  const u = new URL(G.authUrls[0]);
  t("授权地址：只要 openid email profile，直接要 ID token，带 nonce 和 state", u.origin === "https://accounts.google.com" &&
    u.searchParams.get("scope") === "openid email profile" && u.searchParams.get("response_type") === "id_token" &&
    u.searchParams.get("nonce").length >= 32 && u.searchParams.get("state").length >= 32 &&
    u.searchParams.get("redirect_uri") === "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/");
  t("Google 登录成功：存好登录状态，不限订阅数", r.ok && G.store.auth.user.email === "g@gmail.com" && (await G.send({ type: "GET_STATE" })).subLimit === null, r);
  t("结果写进 grantResult 并重新打开弹窗（弹窗会被授权窗口关掉）", G.store.grantResult.res.ok && G.popups.length === 1);
  G = boot(m2, { clientId: "x", google: (u) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#state=WRONG&id_token=IDTOKEN` });
  r = await G.send({ type: "AUTH_GOOGLE" });
  t("state 对不上：拒绝（防止被塞进别人的凭证）", !r.ok && /校验失败/.test(r.error) && !G.store.auth);
  G = boot(m2, { clientId: "x", google: () => Promise.reject(new Error("The user did not approve access.")) });
  r = await G.send({ type: "AUTH_GOOGLE" });
  t("用户关掉授权窗口：当作取消，不报错", !r.ok && r.cancelled);
  G = boot(m2, { clientId: "x", google: (u) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#state=${u.searchParams.get("state")}&id_token=FORGED` });
  r = await G.send({ type: "AUTH_GOOGLE" });
  t("服务端验证失败：提示凭证无效", !r.ok && /凭证无效/.test(r.error), r);

  if (process.env.E2E) {
    const real = (url, o) => fetch(url.replace(/^https?:\/\/[^/]+/, process.env.E2E), Object.assign({}, o, { headers: Object.assign({ Origin: ORIGIN }, o.headers) }));
    await suite(`\n真实服务端（${process.env.E2E}）：`, real, `e2e${Date.now()}@example.com`);
  }
})();
