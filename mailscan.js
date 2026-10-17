// 邮箱发现：从网页版 Gmail 的搜索结果里找出你可能在付费的订阅
//
// 做法和读 YouTube 历史页一样：在你已登录的网页里读页面，数据不出浏览器。
// 刻意设的边界：
//   · 只读搜索结果列表（发件人 / 主题 / 摘要 / 日期），不打开邮件正文；
//   · 扫出来的只是"候选"，你点「添加」核对后才会进订阅列表；
//   · 读不到就说读不到；看不出周期就不猜周期、不折算月费。
//
// 本文件被 background.js（importScripts）和 node 测试共同加载，不依赖 chrome API。
// 整个文件包在一个函数作用域里，避免和 lib.js / background.js 的顶层变量重名。
// 注意：gmailExtractPage 会被 chrome.scripting.executeScript 序列化后注入 Gmail 页面，
// 所以它必须完全自包含，不能引用本文件里的其它函数或变量。

(function () {
  const MAIL_DAY = 86400000;

  // Gmail 搜索语句：近一年、收据/续费类，排除「推广」「社交」分类里的营销邮件
  const DEFAULT_QUERY = [
    '(receipt OR invoice OR subscription OR renewal OR renewed OR billing OR "payment received"',
    'OR "your plan" OR membership OR 收据 OR 发票 OR 订阅 OR 续费 OR 续订 OR 扣款 OR 扣费',
    'OR 会员 OR 账单 OR 付款成功 OR 支付成功)',
    '-category:promotions -category:social newer_than:1y'
  ].join(" ");

  function gmailSearchUrl(account, query, page) {
    const a = Math.max(0, parseInt(account, 10) || 0);
    const q = encodeURIComponent(query || DEFAULT_QUERY);
    return `https://mail.google.com/mail/u/${a}/#search/${q}` + (page > 1 ? `/p${page}` : "");
  }

  // ---------- 发件域名 ----------
  // billing@email.netflix.com → netflix.com；x@mail.example.co.uk → example.co.uk
  const SECOND_LEVEL = { com: 1, co: 1, net: 1, org: 1, gov: 1, edu: 1, ac: 1 };
  function senderDomain(email) {
    const m = String(email || "").trim().toLowerCase().match(/@([a-z0-9.-]+)$/);
    if (!m) return "";
    const parts = m[1].split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const last = parts[parts.length - 1], second = parts[parts.length - 2];
    if (last.length === 2 && SECOND_LEVEL[second]) return parts.slice(-3).join(".");
    return parts.slice(-2).join(".");
  }

  // 代收款平台 / 应用商店：发件域名是平台而不是商家，要按"发件人显示名"区分商家
  const PROCESSORS = {
    "stripe.com": "Stripe", "paddle.com": "Paddle", "paypal.com": "PayPal",
    "fastspring.com": "FastSpring", "lemonsqueezy.com": "Lemon Squeezy",
    "chargebee.com": "Chargebee", "recurly.com": "Recurly", "gumroad.com": "Gumroad",
    "apple.com": "Apple", "google.com": "Google", "amazon.com": "Amazon",
    "alipay.com": "支付宝", "tenpay.com": "微信支付"
  };

  // ---------- 金额 ----------
  const NUM = "(\\d{1,3}(?:[,，]\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";
  const RE_AMT_PRE = new RegExp("(US\\$|CA\\$|A\\$|HK\\$|\\$|¥|￥|€|£|RMB|CNY|USD|EUR|GBP|HKD|JPY|CAD|AUD)\\s?" + NUM, "i");
  const RE_AMT_POST = new RegExp(NUM + "\\s?(元|USD|CNY|RMB|EUR|GBP|HKD|JPY|円)", "i");
  const CURRENCY = [
    [/^(?:US\$|USD|\$)$/i, "$"], [/^(?:¥|￥|RMB|CNY|元|JPY|円)$/i, "¥"], [/^(?:€|EUR)$/i, "€"],
    [/^(?:£|GBP)$/i, "£"], [/^(?:HK\$|HKD)$/i, "HK$"], [/^(?:CA\$|CAD)$/i, "CA$"], [/^(?:A\$|AUD)$/i, "A$"]
  ];
  function parseAmount(text) {
    const s = String(text || "");
    let m = s.match(RE_AMT_PRE), cur, num;
    if (m) { cur = m[1]; num = m[2]; }
    else if ((m = s.match(RE_AMT_POST))) { num = m[1]; cur = m[2]; }
    else return null;
    const value = parseFloat(num.replace(/[,，]/g, ""));
    if (!(value > 0) || value > 100000) return null; // $0.00 的试用收据不算价格
    let currency = cur;
    for (const [re, sym] of CURRENCY) if (re.test(cur)) { currency = sym; break; }
    return { currency, value };
  }

  // ---------- 是不是收据 / 续费邮件 ----------
  const RE_STRONG = /receipt|invoice|renewal|renewed|renews|subscription|billing|payment (?:received|confirmation|successful|processed)|your (?:plan|membership)|auto-?renew|free trial|trial (?:ends|ending|is ending)|been charged|收据|发票|续费|续订|自动续|扣款|扣费|订阅|会员|账单|付款成功|支付成功|已支付|购买凭证|交易凭证/i;
  const RE_NEG = /验证码|verification code|verify your|one-time (?:code|password)|password|密码|security alert|安全提醒|登录提醒|new sign-?in|newsletter|digest|webinar|\d+% off|促销|优惠券|限时|折扣|shipped|已发货|out for delivery|快递/i;
  const RE_CANCEL = /cancel(?:l)?ed|cancellation|has ended|will not renew|won['’]t renew|已取消|取消成功|已退订|退订成功|关闭自动续费|已到期|已过期/i;

  function classifyMail(row) {
    const subj = String(row.subject || "");
    const snip = String(row.snippet || "");
    const whole = subj ? subj + " " + snip : String(row.text || "");
    let score = 0;
    if (subj && RE_STRONG.test(subj)) score += 2;
    else if (RE_STRONG.test(whole)) score += 1;
    const amount = parseAmount(whole);
    if (amount) score += 1;
    if (RE_NEG.test(subj || whole)) score -= 3;
    const cancel = RE_CANCEL.test(subj || whole);
    return { billing: score >= 2, cancel: cancel && score >= 2, amount, score };
  }

  // ---------- 日期 ----------
  // Gmail 列表里日期单元格的 title 形如「2026年9月10日周四 上午10:23」或
  // 「Thu, Sep 10, 2026, 10:23 AM」；单元格文字是「9月10日」「10:23」这种简写。
  // 解析不出来返回 null —— 宁可不知道，也不瞎猜。
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function mkDate(y, mo, d) {
    const dt = new Date(y, mo, d);
    return (dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d) ? dt.getTime() : null;
  }
  function withYear(mo, d, now) { // 没写年份：先当今年；比现在还晚，说明是去年的
    const y = new Date(now).getFullYear();
    const t = mkDate(y, mo, d);
    return (t !== null && t > now + MAIL_DAY) ? mkDate(y - 1, mo, d) : t;
  }
  function parseMailDate(str, now) {
    const base = typeof now === "number" ? now : Date.now();
    const s = String(str || "").trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) return mkDate(+m[1], m[2] - 1, +m[3]);
    if ((m = s.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/))) return mkDate(+m[1], m[2] - 1, +m[3]);
    if ((m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) return withYear(m[1] - 1, +m[2], base);
    let re = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?!\d)(?:,?\s+(\d{4}))?/g;
    while ((m = re.exec(s))) {
      const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo !== undefined) return m[3] ? mkDate(+m[3], mo, +m[2]) : withYear(mo, +m[2], base);
    }
    re = /(?<!\d)(\d{1,2})\s+([A-Za-z]{3,9})\.?,?(?:\s+(\d{4}))?/g;
    while ((m = re.exec(s))) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo !== undefined) return m[3] ? mkDate(+m[3], mo, +m[1]) : withYear(mo, +m[1], base);
    }
    if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/))) {
      let y = +m[3]; if (y < 100) y += 2000;
      return mkDate(y, m[1] - 1, +m[2]);
    }
    if (/^(?:(?:上午|下午|凌晨|中午|晚上)\s*)?\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?$/.test(s)) { // 只有时间 = 今天
      const d = new Date(base); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    return null;
  }

  // ---------- 扣费周期 ----------
  // 3 天内的多封邮件（收据 + 发票）算同一次扣费
  function clusterEvents(tsList) {
    const s = (tsList || []).filter(t => typeof t === "number").sort((a, b) => a - b);
    const out = [];
    for (const t of s) if (!out.length || t - out[out.length - 1] > 3 * MAIL_DAY) out.push(t);
    return out;
  }
  const CADENCES = [
    { key: "weekly",    label: "每周",   unit: "周",   days: 7,      min: 5,   max: 9 },
    { key: "monthly",   label: "每月",   unit: "月",   days: 30.44,  min: 25,  max: 36 },
    { key: "quarterly", label: "每季度", unit: "季度", days: 91.31,  min: 80,  max: 100 },
    { key: "yearly",    label: "每年",   unit: "年",   days: 365.25, min: 340, max: 390 }
  ];
  // 至少 2 次扣费才谈得上周期；大多数间隔要落在该周期（或整数倍，允许偶尔漏一封收据）附近
  function inferCadence(events) {
    if (!events || events.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < events.length; i++) gaps.push((events[i] - events[i - 1]) / MAIL_DAY);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor((sorted.length - 1) / 2)];
    const c = CADENCES.find(x => med >= x.min && med <= x.max);
    if (!c) return null;
    const fits = gaps.filter(g => {
      const k = Math.max(1, Math.round(g / c.days));
      return g >= c.min * k && g <= c.max * k;
    }).length;
    if (fits / gaps.length < 0.6) return null;
    return { key: c.key, label: c.label, unit: c.unit, days: c.days };
  }
  // 折算成月费；周期不明就返回 null（不猜）
  function monthlyEquivalent(amount, cadence) {
    if (!amount || !cadence) return null;
    const f = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[cadence.key];
    if (!f) return null;
    return { currency: amount.currency, value: Math.round(amount.value * f * 100) / 100 };
  }

  // ---------- 归并成候选订阅 ----------
  function cleanName(name, domain) {
    let n = String(name || "").replace(/["“”]/g, "").trim();
    if (/@|no-?reply|do-?not-?reply/i.test(n)) n = "";
    if (!n && domain) {
      const root = domain.split(".")[0];
      n = root.charAt(0).toUpperCase() + root.slice(1);
    }
    return n;
  }
  function topKey(counts) {
    let best = "", n = 0;
    for (const k in counts) if (counts[k] > n) { best = k; n = counts[k]; }
    return best;
  }

  function aggregateMails(rows, now) {
    const base = typeof now === "number" ? now : Date.now();
    const groups = new Map();
    let billingRows = 0;

    for (const r of rows || []) {
      const domain = senderDomain(r.email);
      if (!domain) continue;
      const c = classifyMail(r);
      if (!c.billing) continue;
      billingRows++;

      const via = PROCESSORS[domain] ? domain : null;
      const key = via ? via + "|" + String(r.name || "").trim().toLowerCase() : domain;
      let g = groups.get(key);
      if (!g) {
        g = { key, domain: via ? "" : domain, via, names: {}, mails: 0, threadMax: 1,
              charges: [], cancels: [], amounts: [], samples: [], latest: null };
        groups.set(key, g);
      }
      g.mails += 1;
      g.threadMax = Math.max(g.threadMax, r.threadCount || 1);
      const nm = cleanName(r.name, "");
      if (nm) g.names[nm] = (g.names[nm] || 0) + 1;

      const ts = typeof r.ts === "number" ? r.ts : parseMailDate(r.date, base);
      if (c.cancel) {
        if (ts) g.cancels.push(ts);
      } else {
        if (ts) g.charges.push(ts);
        if (r.threadId && (!g.latest || (ts || 0) >= g.latest.ts)) g.latest = { ts: ts || 0, id: r.threadId };
        if (c.amount) g.amounts.push({ currency: c.amount.currency, value: c.amount.value, ts: ts || 0 });
      }
      const subj = String(r.subject || r.text || "").slice(0, 120);
      if (subj && g.samples.length < 3 && g.samples.indexOf(subj) < 0) g.samples.push(subj);
    }

    const out = [];
    for (const g of groups.values()) {
      const events = clusterEvents(g.charges);
      const cadence = inferCadence(events);
      const last = events.length ? events[events.length - 1] : null;
      const lastCancel = g.cancels.length ? Math.max.apply(null, g.cancels) : null;
      const latestAmt = g.amounts.slice().sort((a, b) => b.ts - a.ts)[0] || null; // 取最近一次（可能涨过价）
      const amount = latestAmt ? { currency: latestAmt.currency, value: latestAmt.value } : null;

      // active = 在扣费；cancelled = 最近一封是取消/到期通知；stale = 按周期该扣了却没见到收据
      let status = "active";
      if (lastCancel && (!last || lastCancel >= last)) status = "cancelled";
      else if (cadence && last && base - last > cadence.days * 1.5 * MAIL_DAY) status = "stale";

      let confidence = "low";
      if (cadence && events.length >= 2) confidence = "high";
      else if (events.length >= 2 || (events.length === 1 && (amount || g.threadMax >= 2))) confidence = "medium";

      out.push({
        key: g.key,
        name: topKey(g.names) || cleanName("", g.domain) || (g.via ? PROCESSORS[g.via] : g.key),
        domain: g.domain,
        via: g.via,
        viaName: g.via ? PROCESSORS[g.via] : null,
        mails: g.mails,
        charges: events.length,
        first: events.length ? events[0] : null,
        last,
        cadence,
        amount,
        monthly: monthlyEquivalent(amount, cadence),
        nextCharge: status === "active" && cadence && last ? Math.round(last + cadence.days * MAIL_DAY) : null,
        status,
        confidence,
        samples: g.samples,
        latestId: g.latest ? g.latest.id : null
      });
    }
    return { candidates: sortCandidates(out), billingRows };
  }

  function sortCandidates(list) {
    const rank = { high: 0, medium: 1, low: 2 };
    return list.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || ((b.last || 0) - (a.last || 0)));
  }

  // ---------- 注入 Gmail 页面执行：读当前搜索结果页 ----------
  // 必须自包含（会被序列化注入）。返回 Promise，executeScript 会等它结束。
  // opts.prevFp：上一页的指纹。翻页后要等列表真的换成新内容才读，避免把上一页读两遍。
  async function gmailExtractPage(opts) {
    const o = opts || {};
    const timeout = o.timeoutMs || 15000;
    const start = Date.now();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const T = (el) => (el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "");
    const out = { loggedOut: false, noResults: false, timedOut: false, rows: [], fp: "",
                  account: "", pageUrl: String(location.href), stats: null };

    // 没登录时 Gmail 会跳到 accounts.google.com 或产品介绍页
    if (!/(^|\.)mail\.google\.com$/i.test(location.hostname)) { out.loggedOut = true; return out; }

    // 有真实排版时按"是否显示在屏幕上"过滤（Gmail 会把其它视图的列表藏在 DOM 里）；
    // 没有排版引擎（测试环境）时退回看 hidden / display:none。
    const layout = !!(document.body && document.body.getClientRects().length);
    const hiddenByStyle = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden) return true;
        const st = n.getAttribute && n.getAttribute("style");
        if (st && /display\s*:\s*none/i.test(st)) return true;
      }
      return false;
    };
    const visible = (el) => layout ? el.getClientRects().length > 0 : !hiddenByStyle(el);

    function parseRow(tr) {
      const senders = Array.from(tr.querySelectorAll("[email]"));
      const s = senders.find(e => String(e.getAttribute("email") || "").toLowerCase() !== out.account) || senders[0] || null;
      const subject = T(tr.querySelector(".bog, .bqe"));
      const snippet = T(tr.querySelector(".y2")).replace(/^[\s\-–—]+/, "").slice(0, 300);
      let dateEl = tr.querySelector("td.xW [title], .xW [title], .apt [title]");
      if (!dateEl) {
        const titled = Array.from(tr.querySelectorAll("[title]")).filter(e => /\d/.test(e.getAttribute("title") || ""));
        dateEl = titled[titled.length - 1] || null;
      }
      const tid = tr.querySelector("[data-thread-id], [data-legacy-thread-id]");
      const cnt = parseInt(T(tr.querySelector(".bx0")), 10);
      const row = {
        email: s ? String(s.getAttribute("email") || "").trim() : "",
        name: s ? String(s.getAttribute("name") || T(s)) : "",
        subject,
        snippet,
        date: dateEl ? String(dateEl.getAttribute("title") || T(dateEl)) : "",
        threadId: tid ? String(tid.getAttribute("data-thread-id") || tid.getAttribute("data-legacy-thread-id") || "") : "",
        threadCount: cnt > 1 ? cnt : 1
      };
      if (!subject) row.text = T(tr).slice(0, 400); // 主题选择器失效时的兜底
      return row;
    }

    function noResultsShown() {
      const tc = Array.from(document.querySelectorAll("td.TC")).find(visible);
      if (tc && T(tc)) return true;
      const main = document.querySelector('div[role="main"]');
      return /没有符合搜索条件的邮件|沒有符合搜尋條件的郵件|No messages matched your search/i.test(T(main));
    }

    let lastFp = null;
    for (;;) {
      const tm = String(document.title || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
      out.account = tm ? tm[0].toLowerCase() : "";

      const trs = Array.from(new Set(document.querySelectorAll("tr.zA"))).filter(visible);
      const rows = trs.map(parseRow).filter(r => r.email || r.subject || r.text);
      const fp = rows.slice(0, 5).map(r => r.threadId || (r.email + "|" + r.subject + "|" + r.date)).join("~");
      out.stats = {
        rowEls: trs.length,
        withSender: rows.filter(r => r.email).length,
        withSubject: rows.filter(r => r.subject).length,
        withDate: rows.filter(r => r.date).length
      };
      const q = document.querySelector('input[name="q"]');
      const inSearch = !q || String(q.value || "").trim() !== ""; // 搜索框有字 = 已经是搜索结果视图

      // 连续两次读到同样的新内容才算加载完（防止读到渲染到一半的列表）
      if (rows.length && inSearch && fp !== (o.prevFp || "") && fp === lastFp) {
        out.rows = rows; out.fp = fp; break;
      }
      if (inSearch && noResultsShown() && (!rows.length || fp === o.prevFp)) { out.noResults = true; break; }
      if (Date.now() - start > timeout) { out.rows = rows; out.fp = fp; out.timedOut = true; break; }
      lastFp = fp;
      await sleep(400);
    }
    out.pageUrl = String(location.href);
    return out;
  }


  // ================= Gmail 接口模式（用户自带 Google Cloud 凭据） =================
  // 插件直接向 Google 请求数据，不经过任何第三方服务器。
  // 授权用 chrome.identity.launchWebAuthFlow + 隐式授权（response_type=token）：
  // 不需要 client secret，也不需要后端；令牌约 1 小时有效，只在内存里用完即弃。
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

  function isValidClientId(id) {
    return /^[\w-]+\.apps\.googleusercontent\.com$/.test(String(id || "").trim());
  }

  function buildAuthUrl(clientId, redirectUri, state) {
    const p = new URLSearchParams({
      client_id: String(clientId || "").trim(),
      redirect_uri: redirectUri,
      response_type: "token",
      scope: GMAIL_SCOPE,
      prompt: "select_account",
      include_granted_scopes: "true",
      state: state || ""
    });
    return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
  }

  // Google 把结果放在重定向地址的 # 后面（出错时也可能在 ? 后面），两处都看
  function parseAuthRedirect(url) {
    const u = String(url || "");
    const hash = u.indexOf("#") >= 0 ? u.slice(u.indexOf("#") + 1) : "";
    const qEnd = u.indexOf("#") >= 0 ? u.indexOf("#") : u.length;
    const query = u.indexOf("?") >= 0 && u.indexOf("?") < qEnd ? u.slice(u.indexOf("?") + 1, qEnd) : "";
    const h = new URLSearchParams(hash), q = new URLSearchParams(query);
    const get = (k) => h.get(k) || q.get(k);
    return {
      token: get("access_token"),
      expiresIn: parseInt(get("expires_in"), 10) || 0,
      error: get("error"),
      state: get("state"),
      scope: get("scope") || ""
    };
  }

  function bytesToUtf8(bin) {
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
    return new TextDecoder("utf-8").decode(bytes);
  }
  function b64urlToText(data) {
    try {
      let b = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      return bytesToUtf8(atob(b));
    } catch (e) { return ""; }
  }

  // 邮件头里的 =?UTF-8?B?...?= / =?UTF-8?Q?...?= 编码（中文发件人名常见）
  function decodeMimeWords(s) {
    return String(s || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (all, cs, enc, text) => {
      try {
        if (!/^utf-?8$/i.test(cs)) return all;
        if (enc.toUpperCase() === "B") return bytesToUtf8(atob(text));
        const bin = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
        return bytesToUtf8(bin);
      } catch (e) { return all; }
    });
  }

  function decodeEntities(s) {
    const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", yen: "¥", euro: "€", pound: "£" };
    return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return map[e.toLowerCase()] != null ? map[e.toLowerCase()] : m;
    });
  }

  // "Netflix" <info@account.netflix.com> → { name, email }
  function parseFromHeader(v) {
    const s = decodeMimeWords(v).trim();
    let m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), email: m[2].trim() };
    m = s.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    return { name: "", email: m ? m[0] : "" };
  }

  // Gmail 接口返回的一封邮件（format=metadata）→ 和网页模式同样格式的一行
  function apiMessageToRow(m) {
    const h = {};
    ((m && m.payload && m.payload.headers) || []).forEach(x => { h[String(x.name).toLowerCase()] = x.value; });
    const from = parseFromHeader(h.from);
    let ts = Number(m && m.internalDate);
    if (!(ts > 0) && h.date) ts = Date.parse(h.date);
    return {
      email: from.email,
      name: from.name,
      subject: decodeMimeWords(h.subject || "").trim(),
      snippet: decodeEntities((m && m.snippet) || "").slice(0, 300),
      ts: ts > 0 ? ts : null,
      date: h.date || "",
      threadId: (m && m.id) || "",
      threadCount: 1
    };
  }

  // 邮件正文（format=full）→ 纯文本：优先 text/plain，没有就把 text/html 去掉标签
  function messageBodyText(m) {
    let plain = "", html = "";
    (function walk(p) {
      if (!p) return;
      const mt = String(p.mimeType || "").toLowerCase();
      if (p.body && p.body.data) {
        if (mt === "text/plain" && !plain) plain = b64urlToText(p.body.data);
        else if (mt === "text/html" && !html) html = b64urlToText(p.body.data);
      }
      (p.parts || []).forEach(walk);
    })(m && m.payload);
    const text = plain || decodeEntities(html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "));
    return text.replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 20000);
  }

  // 从正文里找金额：优先找「合计 / 实付 / Total / Amount paid」后面的数字，
  // 找不到再退回正文里第一个金额（小计、税费常排在前面，所以关键词优先）
  const RE_TOTAL = /(total|amount (?:paid|charged|due)|you paid|charged|合计|总计|实付|实际支付|支付金额|扣款金额|付款金额|订单金额|应付)/ig;
  function extractBodyAmount(text) {
    const s = String(text || "");
    let m, best = null;
    RE_TOTAL.lastIndex = 0;
    while ((m = RE_TOTAL.exec(s))) {
      const a = parseAmount(s.slice(m.index, m.index + m[0].length + 60));
      if (a) best = a; // 取最后一个"合计"——多行明细时最后那个通常是总额
    }
    return best || parseAmount(s);
  }

  // 用正文里找到的金额补全候选，并按统一规则重算月费和可信度
  function applyBodyAmount(c, amount) {
    if (!c || !amount || c.amount) return c;
    c.amount = { currency: amount.currency, value: amount.value };
    c.amountFrom = "body";
    c.monthly = monthlyEquivalent(c.amount, c.cadence);
    if (c.confidence === "low" && c.charges === 1) c.confidence = "medium";
    return c;
  }

  globalThis.MailLib = {
    DEFAULT_QUERY, PROCESSORS,
    gmailSearchUrl, senderDomain, parseAmount, classifyMail, parseMailDate,
    clusterEvents, inferCadence, monthlyEquivalent, aggregateMails, sortCandidates, gmailExtractPage,
    GMAIL_SCOPE, isValidClientId, buildAuthUrl, parseAuthRedirect, decodeMimeWords, decodeEntities,
    parseFromHeader, apiMessageToRow, messageBodyText, extractBodyAmount, applyBodyAmount
  };
})();
