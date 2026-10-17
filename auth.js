// 账号登录（Better Auth 服务端，见 auth-server/）。后台和测试共用。
// 插件里拿不到网站 cookie，用 Bearer token：登录响应头 set-auth-token 里拿到，存在 chrome.storage.local。
(function () {
  // 服务端地址：部署后改成你的 Worker 地址（例如 https://auth.你的域名）
  const AUTH_BASE_URL = "https://subwatch-auth.towangchuan.workers.dev";
  // Google 登录：Google Cloud「Web 应用」类型客户端的 Client ID（和服务端 GOOGLE_CLIENT_ID 填同一个）。留空则不显示 Google 登录按钮。
  // 这个客户端的「已获授权的重定向 URI」里要有 https://<插件ID>.chromiumapp.org/
  const GOOGLE_CLIENT_ID = "509736395294-1qu14covrdph4hal4m7cguf4tldq4qb1.apps.googleusercontent.com";
  // 未登录最多添加几个订阅；登录后的上限由服务端 /api/me 的 subLimit 决定（null = 不限）
  const GUEST_SUB_LIMIT = 5;
  const VERIFY_EVERY = 12 * 3600 * 1000;   // 多久向服务端确认一次登录状态

  const ERR = {
    INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不对。",
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "这个邮箱已经注册过了，直接登录就行。",
    USER_ALREADY_EXISTS: "这个邮箱已经注册过了，直接登录就行。",
    PASSWORD_TOO_SHORT: "密码至少 8 位。",
    PASSWORD_TOO_LONG: "密码太长了（最多 128 位）。",
    INVALID_EMAIL: "邮箱格式不对。",
    VALIDATION_ERROR: "邮箱格式不对。",
    RATE_LIMITED: "尝试太频繁了，请过一分钟再试。",
    GOOGLE_CANCELLED: "已取消 Google 登录。",
    GOOGLE_FAILED: "Google 登录没有完成。如果在中国大陆，需要能访问 Google 的网络；也可以改用邮箱密码登录。",
    GOOGLE_STATE: "Google 登录校验失败，请重试。",
    INVALID_TOKEN: "Google 登录凭证无效或已过期，请重试。",
    OAUTH_LINK_ERROR: "这个 Google 账号没能关联到已有账号，请用邮箱密码登录。",
    EMAIL_NOT_VERIFIED: "这个 Google 账号的邮箱还没验证，没法用来登录。",
    PROVIDER_NOT_FOUND: "登录服务还没开启 Google 登录（服务端没配 GOOGLE_CLIENT_ID）。",
    NETWORK: "连不上登录服务器，请检查网络后重试。",
    NETWORK_LOCAL: "本地登录服务没有启动（" + AUTH_BASE_URL + "）。双击 auth-server 文件夹里的「启动登录服务.cmd」，窗口里出现 Ready 后再试。",
    FORBIDDEN: "登录服务拒绝了这个插件：插件 ID 不在服务端 TRUSTED_ORIGINS 里（本地开发看 auth-server/.dev.vars）。",
    UNKNOWN: "登录服务出错了，请稍后再试。"
  };
  function errorText(code, status) {
    if (status === 429) return ERR.RATE_LIMITED;
    if (code === "NETWORK" && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(AUTH_BASE_URL)) return ERR.NETWORK_LOCAL;
    if (code && ERR[code] && code !== "UNKNOWN") return ERR[code];
    if (status === 403) return ERR.FORBIDDEN;
    return ERR[code] || ERR.UNKNOWN;
  }

  // 订阅数上限：auth 为存储里的登录信息（未登录为 null）
  function subLimit(auth) {
    if (auth && auth.user) return auth.subLimit == null ? null : auth.subLimit;
    return GUEST_SUB_LIMIT;
  }
  function canAdd(count, auth) {
    const lim = subLimit(auth);
    return lim == null || count < lim;
  }

  function randomString(n) {
    const a = new Uint8Array(n || 16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Google 授权地址：只要 openid/email/profile，直接要 ID token（implicit），带 nonce 防重放、state 防串改
  function googleAuthUrl(clientId, redirectUri, nonce, state) {
    const q = new URLSearchParams({ client_id: clientId, response_type: "id_token", redirect_uri: redirectUri,
      scope: "openid email profile", nonce, state, prompt: "select_account" });
    return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
  }
  // 解析 Google 跳回来的地址（参数在 # 后面）
  function parseGoogleRedirect(url, state) {
    let frag = "";
    try { const u = new URL(url); frag = u.hash ? u.hash.slice(1) : u.search.slice(1); } catch (e) { return { error: "GOOGLE_FAILED" }; }
    const p = new URLSearchParams(frag);
    if (p.get("error")) return { error: p.get("error") === "access_denied" ? "GOOGLE_CANCELLED" : "GOOGLE_FAILED" };
    if (p.get("state") !== state) return { error: "GOOGLE_STATE" };
    const idToken = p.get("id_token");
    return idToken ? { idToken } : { error: "GOOGLE_FAILED" };
  }

  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim()); }

  // 调用服务端；返回 { ok, status, body, token, code }
  async function call(base, path, opts, fetchImpl) {
    const f = fetchImpl || fetch;
    const headers = { "Content-Type": "application/json" };
    if (opts && opts.token) headers.Authorization = "Bearer " + opts.token;
    let r;
    try {
      r = await f(base + path, { method: (opts && opts.method) || (opts && opts.body ? "POST" : "GET"), headers,
                                 body: opts && opts.body ? JSON.stringify(opts.body) : undefined });
    } catch (e) { return { ok: false, status: 0, code: "NETWORK" }; }
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { ok: r.ok, status: r.status, body, token: r.headers.get("set-auth-token"),
             code: r.ok ? null : (body && body.code) || (r.status === 401 ? "UNAUTHORIZED" : "UNKNOWN") };
  }

  const api = { AUTH_BASE_URL, GOOGLE_CLIENT_ID, randomString, googleAuthUrl, parseGoogleRedirect, GUEST_SUB_LIMIT, VERIFY_EVERY, ERR, errorText, subLimit, canAdd, validEmail, call };
  globalThis.AuthLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
