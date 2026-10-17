// 常见订阅服务目录 + 从「账户 / 会员页」文字里读套餐、价格、续费日、空间用量
//
// 做法：在你已登录的浏览器里后台打开该服务的账户页，取页面上的文字（innerText），
// 用每个服务的套餐关键词去匹配。读页面文字而不是页面结构，网站改版时更不容易失效。
// 只保存解析出来的几个字段（套餐、价格、续费日、空间用量），页面文字本身不保存。
//
// 诚实标注：这里每个服务的账户页地址和套餐名称都来自公开信息，没有逐个登录实测（verified: false）。
// 每个订阅都可以点「诊断」看实际读到了什么；认不出来时不会瞎猜，只显示"没认出套餐"。
//
// 本文件被 background.js（importScripts）、popup.html 和 node 测试共同加载。
// pageTextExtract 会被注入网页执行，必须自包含。

(function () {
  const DAY = 86400000;

  const CATEGORIES = [
    { key: "ai", name: "AI 工具" },
    { key: "video", name: "海外影音" },
    { key: "cn", name: "国内影音会员" },
    { key: "work", name: "效率与云服务" }
  ];

  // plans：按从具体到宽泛排列，[正则, 显示名, 是否付费]
  // activity：有网页版观看/收听记录的服务，对应 background.js 里 CATALOG 的读取方式
  const P = [
    // ---------------- AI 工具 ----------------
    { id: "claude", name: "Claude", cat: "ai", domains: ["claude.ai"], special: "llm" },
    { id: "chatgpt", name: "ChatGPT", cat: "ai", domains: ["chatgpt.com"], special: "llm" },
    { id: "google-one", name: "Gemini / Google One", cat: "ai", domains: ["gemini.google.com", "one.google.com"],
      accountUrl: "https://one.google.com/storage", currency: "$", storage: true,
      plans: [[/Google AI Ultra/i, "Google AI Ultra", true], [/Google AI Pro|AI Premium|Gemini Advanced/i, "Google AI Pro", true],
              [/Google AI Plus/i, "Google AI Plus", true], [/(\d+)\s*TB\s*(plan|方案|套餐)|Premium\s*\(?\s*2\s*TB/i, "Google One 大容量", true],
              [/(100|200)\s*GB\s*(plan|方案|套餐)|Google One\s*(Basic|Standard)/i, "Google One", true]],
      free: /15\s*GB|免费存储空间|free storage/i },
    { id: "perplexity", name: "Perplexity", cat: "ai", domains: ["perplexity.ai"], accountUrl: "https://www.perplexity.ai/settings/account", currency: "$",
      plans: [[/Perplexity Max|\bMax\b plan/i, "Max", true], [/Perplexity Pro|\bPro\b (plan|subscription)|Pro 订阅/i, "Pro", true], [/Enterprise Pro/i, "Enterprise Pro", true]],
      free: /\bFree\b plan|Upgrade to Pro|升级到 Pro/i },
    { id: "cursor", name: "Cursor", cat: "ai", domains: ["cursor.com"], accountUrl: "https://cursor.com/dashboard", currency: "$",
      plans: [[/\bUltra\b/, "Ultra", true], [/Pro\s*\+|Pro Plus/i, "Pro+", true], [/\b(Teams|Business)\b/, "Teams", true], [/\bPro\b( plan| trial)?/, "Pro", true]],
      free: /\bHobby\b|\bFree\b plan/i },
    { id: "copilot", name: "GitHub Copilot", cat: "ai", domains: ["github.com"], accountUrl: "https://github.com/settings/copilot", currency: "$",
      activityDomain: "github.com",
      plans: [[/Copilot Pro\+/i, "Copilot Pro+", true], [/Copilot Pro\b/i, "Copilot Pro", true], [/Copilot (Business|Enterprise)/i, "Copilot Business", true]],
      free: /Copilot Free|free version of Copilot/i },
    { id: "midjourney", name: "Midjourney", cat: "ai", domains: ["midjourney.com"], accountUrl: "https://www.midjourney.com/account", currency: "$",
      plans: [[/Mega Plan/i, "Mega", true], [/Pro Plan/i, "Pro", true], [/Standard Plan/i, "Standard", true], [/Basic Plan/i, "Basic", true]],
      free: /no active subscription|Subscribe to get started|Purchase a plan/i },
    { id: "poe", name: "Poe", cat: "ai", domains: ["poe.com"], accountUrl: "https://poe.com/settings", currency: "$",
      plans: [[/Poe subscriber|Subscription active|订阅已激活|Manage subscription|管理订阅/i, "订阅", true]],
      free: /Subscribe to Poe|订阅 Poe|Get Poe subscription/i },

    // ---------------- 海外影音 ----------------
    { id: "netflix", name: "Netflix", cat: "video", domains: ["netflix.com"], accountUrl: "https://www.netflix.com/account/membership", currency: "$",
      activity: "netflix",
      plans: [[/Standard with ads|含广告标准|廣告/i, "Standard with ads", true], [/\bPremium\b|高级/i, "Premium", true],
              [/\bStandard\b|标准/i, "Standard", true], [/\bBasic\b plan|基本套餐|\bBasic\b\s*\n/i, "Basic", true], [/\bMobile\b plan|手机套餐/i, "Mobile", true]] },
    { id: "spotify", name: "Spotify", cat: "video", domains: ["spotify.com"], accountUrl: "https://www.spotify.com/account/overview/", currency: "$",
      activityDomain: "open.spotify.com",
      plans: [[/Premium Family|家庭/i, "Premium Family", true], [/Premium Duo|双人/i, "Premium Duo", true], [/Premium Student|学生/i, "Premium Student", true],
              [/Premium Individual|个人/i, "Premium Individual", true], [/Spotify Premium/i, "Premium", true]],
      free: /Spotify Free|免费版/i },
    { id: "disney", name: "Disney+", cat: "video", domains: ["disneyplus.com"], accountUrl: "https://www.disneyplus.com/account/subscription", currency: "$",
      plans: [[/Disney\+?\s*Premium/i, "Premium", true], [/Disney\+?\s*Standard/i, "Standard", true], [/Basic|with Ads/i, "Basic", true], [/Disney Bundle|Bundle/i, "Bundle", true]] },
    { id: "prime", name: "Amazon Prime / Prime Video", cat: "video", domains: ["primevideo.com", "amazon.com"], accountUrl: "https://www.amazon.com/gp/primecentral", currency: "$",
      activity: "primevideo", activityDomain: "primevideo.com",
      plans: [[/Prime Video (Channels|Ad-free)/i, "Prime（含附加）", true], [/Prime Student/i, "Prime Student", true], [/Prime membership|Prime 会员|Your Prime/i, "Prime", true]],
      free: /Try Prime|Start your free trial|Join Prime/i },
    { id: "youtube", name: "YouTube Premium", cat: "video", domains: ["youtube.com"], accountUrl: "https://www.youtube.com/paid_memberships", currency: "$",
      activity: "youtube",
      plans: [[/YouTube Premium Lite|Premium Lite/i, "Premium Lite", true], [/YouTube Music Premium/i, "Music Premium", true],
              [/(Family|家庭).{0,20}Premium|Premium.{0,20}(Family|家庭)/i, "Premium Family", true], [/(?<!(Get|Try|获取|试用)\s*)YouTube Premium/i, "Premium", true]],
      free: /no memberships|没有任何会员|Get YouTube Premium|获取 YouTube Premium/i },
    { id: "max", name: "HBO Max", cat: "video", domains: ["hbomax.com", "max.com"], accountUrl: "https://www.hbomax.com/settings/subscription", currency: "$",
      plans: [[/Ultimate/i, "Ultimate", true], [/Standard/i, "Standard", true], [/Basic|with Ads/i, "Basic with Ads", true]] },

    // ---------------- 国内影音会员 ----------------
    { id: "iqiyi", name: "爱奇艺", cat: "cn", domains: ["iqiyi.com"], accountUrl: "https://vip.iqiyi.com/", currency: "¥",
      plans: [[/星钻\s*VIP|星钻会员/, "星钻VIP", true], [/白金\s*VIP|白金会员/, "白金VIP", true], [/黄金\s*VIP|黄金会员/, "黄金VIP", true], [/学生\s*VIP|学生会员/, "学生VIP", true]],
      free: /开通会员|立即开通|您还不是/ },
    { id: "tencent-video", name: "腾讯视频", cat: "cn", domains: ["v.qq.com", "film.qq.com"], accountUrl: "https://film.qq.com/vip/my/", currency: "¥",
      plans: [[/超级影视\s*VIP|SVIP/i, "超级影视VIP", true], [/VIP会员|腾讯视频VIP|好莱坞会员/i, "VIP", true]],
      free: /开通VIP|立即开通|您还不是/ },
    { id: "youku", name: "优酷", cat: "cn", domains: ["youku.com"], accountUrl: "https://vip.youku.com/", currency: "¥",
      plans: [[/酷喵\s*VIP|酷喵会员/, "酷喵VIP", true], [/优酷\s*VIP|VIP会员/i, "优酷VIP", true]],
      free: /开通会员|立即开通|您还不是/ },
    { id: "mgtv", name: "芒果TV", cat: "cn", domains: ["mgtv.com"], accountUrl: "https://www.mgtv.com/vip/", currency: "¥",
      plans: [[/全屏影视会员|全屏会员/, "全屏影视会员", true], [/PC.*移动影视会员|移动影视会员/, "移动影视会员", true], [/芒果\s*TV\s*会员|会员有效期/i, "会员", true]],
      free: /开通会员|立即开通/ },
    { id: "bilibili", name: "B站大会员", cat: "cn", domains: ["bilibili.com"], accountUrl: "https://account.bilibili.com/account/big", currency: "¥",
      activity: "bilibili",
      plans: [[/年度大会员/, "年度大会员", true], [/大会员/, "大会员", true]],
      free: /开通大会员|成为大会员|您还不是大会员/ },
    { id: "qqmusic", name: "QQ音乐", cat: "cn", domains: ["y.qq.com"], accountUrl: "https://y.qq.com/portal/vipportal/", currency: "¥",
      plans: [[/超级会员|SVIP/i, "超级会员", true], [/豪华绿钻|绿钻/, "豪华绿钻", true]],
      free: /开通绿钻|立即开通/ },
    { id: "netease-music", name: "网易云音乐", cat: "cn", domains: ["music.163.com"], accountUrl: "https://music.163.com/store/vip", currency: "¥",
      plans: [[/黑胶\s*SVIP/i, "黑胶SVIP", true], [/黑胶\s*VIP/i, "黑胶VIP", true]],
      free: /开通黑胶|立即开通/ },
    { id: "baidu-pan", name: "百度网盘", cat: "work", domains: ["pan.baidu.com"], accountUrl: "https://pan.baidu.com/disk/main", currency: "¥", storage: true,
      // 空间用量那块不在页面文字里（innerText 读不到），改用网盘网页版自己调用的接口（同一个网站、带登录状态，只读用量）
      quotaApi: "/api/quota?checkexpire=1&checkfree=1",
      plans: [[/超级会员|SVIP/i, "超级会员", true], [/普通会员/, "普通会员", true]],
      free: /开通会员|立即开通/ },

    // ---------------- 效率与云服务 ----------------
    { id: "notion", name: "Notion", cat: "work", domains: ["notion.so", "notion.com"], accountUrl: "https://www.notion.so/", currency: "$",
      plans: [[/\bEnterprise\b/, "Enterprise", true], [/\bBusiness\b plan|\bBusiness\b/, "Business", true], [/\bPlus\b plan|\bPlus\b/, "Plus", true]],
      free: /\bFree\b plan|免费版/i, note: "Notion 的套餐只在应用内设置里显示，账户页可能读不出来，主要按访问判断是否在用。" },
    { id: "figma", name: "Figma", cat: "work", domains: ["figma.com"], accountUrl: "https://www.figma.com/files", currency: "$",
      plans: [[/\bOrganization\b/, "Organization", true], [/\bEnterprise\b/, "Enterprise", true], [/\bProfessional\b/, "Professional", true]],
      free: /\bStarter\b|免费/i },
    { id: "canva", name: "Canva", cat: "work", domains: ["canva.com"], accountUrl: "https://www.canva.com/settings/billing-and-plans", currency: "$",
      plans: [[/Canva Teams|Canva 团队版/i, "Canva Teams", true], [/Canva Pro|Canva 可画专业版|专业版/i, "Canva Pro", true]],
      free: /Canva Free|免费版|Try Canva Pro/i },
    { id: "m365", name: "Microsoft 365", cat: "work", domains: ["account.microsoft.com", "office.com", "microsoft365.com"],
      accountUrl: "https://account.microsoft.com/services", currency: "$", storage: true,
      plans: [[/Microsoft 365 (Family|家庭版)/i, "Microsoft 365 家庭版", true], [/Microsoft 365 (Personal|个人版)/i, "Microsoft 365 个人版", true],
              [/Copilot Pro/i, "Copilot Pro", true], [/Microsoft 365 Basic|基础版/i, "Microsoft 365 基础版", true]],
      free: /no subscriptions|没有任何订阅|Get Microsoft 365/i },
    { id: "icloud", name: "iCloud+", cat: "work", domains: ["icloud.com"], accountUrl: "https://www.icloud.com/settings/", currency: "$", storage: true,
      plans: [[/iCloud\+?\s*(with\s*)?12\s*TB/i, "iCloud+ 12TB", true], [/iCloud\+?\s*(with\s*)?6\s*TB/i, "iCloud+ 6TB", true],
              [/iCloud\+?\s*(with\s*)?2\s*TB/i, "iCloud+ 2TB", true], [/iCloud\+?\s*(with\s*)?200\s*GB/i, "iCloud+ 200GB", true],
              [/iCloud\+?\s*(with\s*)?50\s*GB/i, "iCloud+ 50GB", true], [/Apple One/i, "Apple One", true]],
      free: /5\s*GB\b(?!.*iCloud\+)/i, note: "经 App Store 付费，退订要在 iPhone 的订阅管理里操作。" },
    { id: "dropbox", name: "Dropbox", cat: "work", domains: ["dropbox.com"], accountUrl: "https://www.dropbox.com/account/plan", currency: "$", storage: true,
      plans: [[/Dropbox (Business|Advanced|Standard)/i, "Business", true], [/Essentials|Professional/i, "Essentials", true],
              [/\bFamily\b/, "Family", true], [/\bPlus\b/, "Plus", true]],
      free: /Dropbox Basic|\bBasic\b plan|免费/i },
    { id: "adobe", name: "Adobe Creative Cloud", cat: "work", domains: ["adobe.com"], accountUrl: "https://account.adobe.com/plans", currency: "$",
      plans: [[/Creative Cloud (All Apps|Pro)|全部应用程序/i, "Creative Cloud 全部应用", true], [/Photography|摄影/i, "摄影计划", true],
              [/Acrobat (Pro|Standard)/i, "Acrobat", true], [/Photoshop|Illustrator|Premiere|Lightroom/i, "单个应用", true]],
      free: /no plans|没有计划|Free membership|免费会员/i }
  ];

  const BY_ID = {};
  P.forEach((p) => { BY_ID[p.id] = p; });

  // ---------- 注入网页：取页面文字（等单页应用把数据渲染出来） ----------
  async function pageTextExtract(opts) {
    const o = opts || {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    let waitRe = null, needRe = null;
    try { if (o.waitRe) waitRe = new RegExp(o.waitRe, "i"); } catch (e) { waitRe = null; }
    // needRe：还要等的内容（比如网盘的「已用/总空间」常常比套餐信息晚加载）
    try { if (o.needRe) needRe = new RegExp(o.needRe, "i"); } catch (e) { needRe = null; }
    let text = "", last = -1, stable = 0;
    while (Date.now() - start < (o.timeoutMs || 9000)) {
      text = (document.body && document.body.innerText) || "";
      if (waitRe && waitRe.test(text) && text.length > 200 && (!needRe || needRe.test(text))) break;
      if (text.length === last && text.length > 0) { if (++stable >= (needRe ? 8 : 3)) break; } else { stable = 0; last = text.length; }
      await sleep(500);
    }
    return {
      url: String(location.href), title: String(document.title || ""),
      text: text.replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").slice(0, o.maxChars || 30000)
    };
  }

  // ---------- 解析 ----------
  const RE_LOGIN_URL = /\/(login|signin|sign-in|log-in|auth|ap\/signin|ServiceLogin)\b|passport\.|accounts\.google\.com\/(v3\/)?signin|login\.live\.com|idmsa\.apple\.com|appleid\.apple\.com\/auth/i;
  const RE_LOGIN_TEXT = /^(?=[\s\S]{0,3000}$)[\s\S]*(登录|登入|Sign in|Log in|扫码登录|密码登录)/i;
  const RE_RENEW = /(下次扣[款费]|下次续费|续费日期|下次付款|下一次付款|自动续费|到期时间|到期日|有效期至|有效期|会员到期|到期|next billing|next payment|next bill|renews?\s*(on)?|renewal date|billing date|expires?\s*(on)?|valid until|ends on|will end)/ig;
  const RE_PER = /(\/\s*(月|mo|month)|每月|per month|a month|\/\s*(年|yr|year)|每年|per year|a year|年费|monthly|annually)/i;
  const UNIT = { K: 1 / (1024 * 1024), KB: 1 / (1024 * 1024), M: 1 / 1024, MB: 1 / 1024, G: 1, GB: 1, T: 1024, TB: 1024 };
  const RE_STORAGE = /(\d[\d.,]*)\s*(KB|MB|GB|TB|K|M|G|T)\b\s*(?:used\s*)?(?:of|\/|out of|，\s*共|,\s*共|共|／)\s*(\d[\d.,]*)\s*(KB|MB|GB|TB|K|M|G|T)\b/i;

  function num(s) { return parseFloat(String(s).replace(/,/g, "")); }

  // 接口给的是字节数
  function storageFromBytes(used, total) {
    used = Number(used); total = Number(total);
    if (!(total > 0) || !(used >= 0) || used > total * 1.1) return null;
    const G = 1024 * 1024 * 1024, u = used / G, t = total / G;
    const fmt = (gb) => gb >= 1024 ? (Math.round(gb / 1024 * 10) / 10) + " TB" : gb >= 1 ? (Math.round(gb * 10) / 10) + " GB" : Math.round(gb * 1024) + " MB";
    return { usedGB: Math.round(u * 100) / 100, totalGB: Math.round(t * 100) / 100, pct: Math.round(used / total * 100), label: `${fmt(u)} / ${fmt(t)}` };
  }
  function parseStorage(text) {
    const m = String(text || "").match(RE_STORAGE);
    if (!m) return null;
    const used = num(m[1]) * UNIT[m[2].toUpperCase()], total = num(m[3]) * UNIT[m[4].toUpperCase()];
    if (!(total > 0) || used < 0 || used > total * 1.1) return null;
    const fmt = (gb) => gb >= 1024 ? (Math.round(gb / 1024 * 10) / 10) + " TB" : gb >= 1 ? (Math.round(gb * 10) / 10) + " GB" : Math.round(gb * 1024) + " MB";
    return { usedGB: Math.round(used * 100) / 100, totalGB: Math.round(total * 100) / 100, pct: Math.round(used / total * 100), label: `${fmt(used)} / ${fmt(total)}` };
  }

  // 价格：在"每月/每年"字样附近找金额；找不到就不填（让用户自己填）
  function parsePrice(text, parseAmount, currency) {
    const s = String(text || "");
    const re = new RegExp(RE_PER.source, "ig");
    let m;
    while ((m = re.exec(s))) {
      const win = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 5);
      const a = parseAmount(win);
      if (a) {
        const yearly = /(年|yr|year|annual)/i.test(m[0]);
        const cur = a.currency === "$" && currency === "¥" && /元|¥|￥/.test(win) ? "¥" : a.currency;
        return { currency: cur, value: a.value, period: yearly ? "year" : "month",
                 monthly: Math.round((yearly ? a.value / 12 : a.value) * 100) / 100 };
      }
    }
    return null;
  }

  // 续费 / 到期日：在关键词前后找日期
  function parseRenew(text, parseDate, now) {
    const s = String(text || "");
    const re = new RegExp(RE_RENEW.source, "ig");
    let m;
    while ((m = re.exec(s))) {
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const before = s.slice(Math.max(0, m.index - 30), m.index);
      for (const win of [after, before]) {
        const t = parseDate(win, now);
        if (t && t > now - 2 * DAY && t < now + 800 * DAY) return t;
      }
    }
    return null;
  }

  // 把账户页解析成 { status, plan, price, renewAt, storage }
  // status：ok / logged_out / unknown（读到页面但没认出套餐）
  function parseAccountPage(p, page, helpers, now) {
    const h = helpers || {};
    const text = String((page && page.text) || "");
    const url = String((page && page.url) || "");
    const out = { status: "unknown", plan: null, price: null, renewAt: null, storage: null, url: url.split("?")[0] };
    // 被跳到登录页：直接判为未登录（登录页上的字可能碰巧像套餐名）
    if (RE_LOGIN_URL.test(url)) { out.status = "logged_out"; return out; }
    let plan = null;
    for (const [re, label, paid] of p.plans || []) if (re.test(text)) { plan = { label, paid: paid !== false }; break; }
    if (!plan && p.free && p.free.test(text)) plan = { label: "免费版", paid: false };

    if (!plan && (RE_LOGIN_URL.test(url) || RE_LOGIN_TEXT.test(text))) { out.status = "logged_out"; return out; }
    if (p.storage) out.storage = (page && page.quota && storageFromBytes(page.quota.used, page.quota.total)) || parseStorage(text);
    if (!plan) return out;
    out.status = "ok";
    out.plan = plan;
    if (plan.paid) {
      if (h.parseAmount) out.price = parsePrice(text, h.parseAmount, p.currency);
      if (h.parseDate) out.renewAt = parseRenew(text, h.parseDate, now || Date.now());
    }
    return out;
  }

  // 建议（账户页类服务）。idle：{ state, days } 来自 computeStatus。
  function accountAdvice(p, account, idle) {
    if (!account) return null;
    if (account.status === "logged_out") return { level: "wait", text: `本浏览器没有登录 ${p.name}，读不到套餐。登录后点「检查」。` };
    if (!account.plan) return { level: "wait", text: `打开了账户页，但没认出套餐。可以点「诊断」看看读到了什么。` };
    if (!account.plan.paid) return { level: "none", text: "当前没有付费订阅。" };
    const st = account.storage;
    if (idle && idle.state === "idle") return { level: "cancel", text: `已经 ${idle.days} 天没用过了，还需要 ${account.plan.label} 吗？` };
    if (st && st.pct < 25 && st.totalGB >= 100) return { level: "downgrade", text: `空间只用了 ${st.pct}%（${st.label}），可以考虑换小一档的容量。` };
    if (account.renewAt) {
      const d = Math.ceil((account.renewAt - Date.now()) / DAY);
      if (d >= 0 && d <= 3) return { level: "keep", text: `${account.plan.label}，${d <= 0 ? "今天" : d + " 天后"}续费。` };
    }
    return { level: "keep", text: `${account.plan.label}，在用。` };
  }

  // 给页面文字等待用：任一套餐关键词出现就可以停止等待
  // 读账户页时除了套餐还要等到的内容：有空间信息的服务要等「已用 / 总量」出来
  function needPattern(p) { return p && p.storage && !p.quotaApi ? RE_STORAGE.source : ""; }
  function waitPattern(p) {
    return (p.plans || []).map((x) => x[0].source).concat(p.free ? [p.free.source] : []).join("|");
  }

  // 访问记录里出现过、但还没加入的服务（「发现的订阅」）
  function discover(records, trackedIds, now, days) {
    const since = (now || Date.now()) - (days || 30) * DAY;
    const hits = {};
    for (const r of records || []) {
      if (!r || !r.hostname || r.time < since) continue;
      const h = String(r.hostname).toLowerCase().replace(/^www\./, "");
      for (const p of P) {
        if (trackedIds.indexOf(p.id) >= 0) continue;
        const doms = [p.activityDomain].concat(p.domains).filter(Boolean);
        if (doms.some((d) => h === d || h.endsWith("." + d))) { hits[p.id] = (hits[p.id] || 0) + 1; break; }
      }
    }
    return Object.keys(hits).sort((a, b) => hits[b] - hits[a]);
  }

  // 申请权限要用的来源（账户页和各个域名）
  function originsOf(p) {
    const set = {};
    (p.domains || []).forEach((d) => { set["https://" + d + "/*"] = 1; set["https://*." + d + "/*"] = 1; });
    if (p.accountUrl) { try { set[new URL(p.accountUrl).origin + "/*"] = 1; } catch (e) {} }
    return Object.keys(set);
  }

  const api = { CATEGORIES, PROVIDERS: P, BY_ID, pageTextExtract, parseAccountPage, parseStorage, parsePrice, parseRenew,
                accountAdvice, waitPattern, needPattern, storageFromBytes, discover, originsOf };
  globalThis.SubCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
