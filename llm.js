// 大模型订阅（ChatGPT / Claude）：读取套餐、对话时间、用量，并给出建议
//
// 读的是你在自己浏览器里、已登录状态下网站本来就会给你看的数据：
//   · 套餐：网站前端显示套餐用的账户信息
//   · 使用频次：对话列表里每个对话的「最后更新时间」—— 只取时间，不读标题、不读内容
//   · 额度（仅 Claude）：「设置 → 用量」里各额度窗口的百分比
// 这些都是网站未公开的内部接口，随时可能变。所以读取尽量宽松，读不到就明确报「读不到」，
// 并提供「诊断」：只返回字段结构（字段名 + 类型），方便对照修正，不带任何内容。
//
// 本文件被 background.js（importScripts）和 node 测试共同加载，不依赖 chrome API。
// llmReadPage 会被序列化注入网页执行，必须完全自包含。

(function () {
  const DAY = 86400000;

  const LLM_SITES = {
    claude:  { name: "Claude",  domain: "claude.ai",   home: "https://claude.ai/",
               billingUrl: "https://claude.ai/settings/billing", usageUrl: "https://claude.ai/settings/usage" },
    chatgpt: { name: "ChatGPT", domain: "chatgpt.com", home: "https://chatgpt.com/",
               billingUrl: "https://chatgpt.com/#settings/Account", usageUrl: null }
  };

  // 公开价（美元/月）。只作「估算」和提示，价格变动频繁：有收据金额或用户手填时以它们为准。
  // ChatGPT Pro 的现价各方说法不一，不给估算，让用户自己填。
  const PRICE_HINTS = {
    claude:  { pro: 20, max5x: 100, max20x: 200 },
    chatgpt: { go: 8, plus: 20 }
  };

  // ---------- 注入网页执行：读取套餐 / 对话时间 / 用量 ----------
  async function llmReadPage(opts) {
    const o = opts || {};
    // base：在插件后台直接请求时传网站地址（如 https://claude.ai）；在网页里运行时留空，用相对地址
    const base = o.base || "";
    const out = { kind: o.kind, ok: false, loggedOut: null, error: null, plan: null, timestamps: [],
                  convCount: 0, usage: null, renew: null, shapes: {}, via: base ? "direct" : "page",
                  pageUrl: base || (typeof location !== "undefined" ? String(location.href) : "") };

    // 只保留结构：字段名和类型。少数「套餐类」字段保留取值，方便诊断，其余一律不带值。
    const KEEP = /^(plan_type|planType|rate_limit_tier|capabilities|billing_type|subscription_plan|purchase_origin_platform|structure|has_active_subscription|will_renew|raven_type|utilization)$/;
    function shape(v, depth, key) {
      if (depth > 5) return "…";
      // 短数组（如组织列表）逐个展示，长数组（如对话列表）只展示第一个
      if (Array.isArray(v)) {
        if (!v.length) return [];
        if (v.length <= 5) return v.map(x => shape(x, depth + 1, key));
        return [shape(v[0], depth + 1, key), "×" + v.length];
      }
      if (v && typeof v === "object") {
        const r = {}; let n = 0;
        for (const k in v) { if (n++ > 40) { r["…"] = "more"; break; } r[k] = shape(v[k], depth + 1, k); }
        return r;
      }
      if (key && KEEP.test(key)) return v;
      return v === null ? "null" : typeof v;
    }

    async function getJson(label, url, headers) {
      let res;
      try {
        res = await fetch(base + url, { credentials: "include", headers: Object.assign({ accept: "application/json" }, headers || {}) });
      } catch (e) { out.shapes[label] = "network error"; return null; }
      const ct = String(res.headers.get("content-type") || "");
      if (res.status === 401) { out.shapes[label] = "HTTP 401"; out.loggedOut = true; return null; }
      if (!res.ok || ct.indexOf("json") < 0) { out.shapes[label] = "HTTP " + res.status + (ct.indexOf("json") < 0 ? " (" + ct.split(";")[0] + ")" : ""); return null; }
      const j = await res.json().catch(() => null);
      out.shapes[label] = shape(j, 0, "");
      return j;
    }

    // 从任意 JSON 里收集「更新时间」字段（接口结构变了也尽量能用）
    function collectTimes(j) {
      const ts = [];
      (function walk(n, d) {
        if (!n || d > 6) return;
        if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return; }
        if (typeof n === "object") {
          for (const k in n) {
            if (/^(update_time|updated_at|updatedAt|update_at)$/.test(k)) ts.push(n[k]);
            else if (typeof n[k] === "object") walk(n[k], d + 1);
          }
        }
      })(j, 0);
      return ts;
    }

    try {
      if (o.kind === "claude") {
        const orgs = await getJson("organizations", "/api/organizations");
        if (!Array.isArray(orgs) || !orgs.length) {
          if (out.loggedOut === null && orgs === null) out.error = "read_failed";
          return out;
        }
        out.loggedOut = false;
        // 优先个人账号里的付费组织；团队/企业组织（raven）是公司付费
        const caps = (g) => (Array.isArray(g.capabilities) ? g.capabilities : []);
        const isBiz = (g) => caps(g).some(c => /raven|enterprise|team/i.test(c)) || /raven|enterprise|team/i.test(String(g.raven_type || g.billing_type || ""));
        const isPaid = (g) => caps(g).some(c => /claude_(pro|max)/i.test(c)) || /max|pro/i.test(String(g.rate_limit_tier || ""));
        const org = orgs.find(g => isPaid(g) && !isBiz(g)) || orgs.find(g => !isBiz(g)) || orgs[0];
        out.plan = { capabilities: caps(org), rate_limit_tier: org.rate_limit_tier || null,
                     billing_type: org.billing_type || null, business: isBiz(org) };
        const id = org.uuid || org.id;

        const convs = await getJson("chat_conversations", `/api/organizations/${id}/chat_conversations?limit=100`);
        if (convs) {
          const list = Array.isArray(convs) ? convs : (convs.data || convs.items || convs.conversations || []);
          out.convCount = Array.isArray(list) ? list.length : 0;
          out.timestamps = collectTimes(list).slice(0, 500);
        }

        const usage = await getJson("usage", `/api/organizations/${id}/usage`);
        if (usage && typeof usage === "object") {
          out.usage = {};
          for (const k in usage) {
            const w = usage[k];
            if (w && typeof w === "object" && typeof w.utilization === "number") {
              out.usage[k] = { utilization: w.utilization, resetsAt: w.resets_at || w.resetsAt || null };
            }
          }
        }

        const sub = await getJson("subscription_details", `/api/organizations/${id}/subscription_details`);
        if (sub && typeof sub === "object") {
          const flat = {};
          (function walk(n, p) { for (const k in n) { const v = n[k]; if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p + k + "."); else flat[p + k] = v; } })(sub, "");
          for (const k in flat) {
            if (!out.renew && /(next_(charge|billing|payment|renewal)|current_period_end|renews?_at|renewal_date)/i.test(k) && flat[k]) out.renew = flat[k];
            if (/platform|payment_(method|source)|store/i.test(k) && typeof flat[k] === "string") out.plan.origin = flat[k];
          }
        }
      } else if (o.kind === "chatgpt") {
        const session = await getJson("auth_session", "/api/auth/session");
        const token = session && session.accessToken;
        if (!token) { out.loggedOut = session ? true : out.loggedOut; if (!session && out.loggedOut === null) out.error = "read_failed"; return out; }
        out.loggedOut = false;
        const auth = { authorization: "Bearer " + token };
        out.plan = { plan_type: (session.account && (session.account.planType || session.account.plan_type)) || null };

        const check = await getJson("accounts_check", "/backend-api/accounts/check/v4-2023-04-27", auth);
        if (check && check.accounts) {
          const accs = check.accounts;
          const keys = Object.keys(accs);
          const personal = keys.map(k => accs[k]).find(a => a && a.account && a.account.structure === "personal");
          const acc = accs.default || personal || accs[keys[0]];
          if (acc) {
            const a = acc.account || {}, e = acc.entitlement || {}, s = acc.last_active_subscription || {};
            out.plan.plan_type = a.plan_type || out.plan.plan_type;
            out.plan.structure = a.structure || null;
            out.plan.subscription_plan = e.subscription_plan || null;
            out.plan.has_active_subscription = e.has_active_subscription;
            out.plan.origin = s.purchase_origin_platform || null;
            out.plan.will_renew = s.will_renew;
            out.plan.business = /workspace|team|enterprise|business|edu/i.test(String(a.structure || "") + " " + String(a.plan_type || ""));
            out.renew = e.renews_at || e.expires_at || null;
          }
        }

        const convs = await getJson("conversations", "/backend-api/conversations?offset=0&limit=100&order=updated", auth);
        if (convs) {
          const list = convs.items || convs.data || (Array.isArray(convs) ? convs : []);
          out.convCount = Array.isArray(list) ? list.length : 0;
          out.timestamps = collectTimes(list).slice(0, 500);
        }
      } else {
        out.error = "unknown_kind";
        return out;
      }
      out.ok = !!out.plan;
    } catch (e) {
      out.error = "read_failed";
      out.shapes.exception = String(e && e.message || e).slice(0, 200);
    }
    return out;
  }

  // ---------- 纯函数：解析 ----------
  // 时间：ISO 字符串，或秒/毫秒时间戳
  function parseTs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v < 1e12 ? Math.round(v * 1000) : v;
    const n = Number(v);
    if (isFinite(n) && /^\d+(\.\d+)?$/.test(String(v))) return n < 1e12 ? Math.round(n * 1000) : n;
    const t = Date.parse(v);
    return isFinite(t) ? t : null;
  }

  // 统一套餐：{ key, label, paid, business }
  function normalizePlan(kind, raw) {
    const r = raw || {};
    if (kind === "claude") {
      const tier = String(r.rate_limit_tier || "").toLowerCase();
      const caps = (r.capabilities || []).map(c => String(c).toLowerCase());
      if (r.business) return { key: "business", label: "Team / Enterprise", paid: true, business: true };
      if (/max.*20x|20x/.test(tier)) return { key: "max20x", label: "Max 20x", paid: true, business: false };
      if (/max.*5x|5x/.test(tier)) return { key: "max5x", label: "Max 5x", paid: true, business: false };
      if (caps.indexOf("claude_max") >= 0 || /max/.test(tier)) return { key: "max", label: "Max", paid: true, business: false };
      if (caps.indexOf("claude_pro") >= 0 || /pro/.test(tier)) return { key: "pro", label: "Pro", paid: true, business: false };
      return { key: "free", label: "Free", paid: false, business: false };
    }
    if (kind === "chatgpt") {
      const p = String(r.plan_type || "").toLowerCase();
      if (r.business || /team|enterprise|business|edu/.test(p)) return { key: "business", label: "Business / Team", paid: true, business: true };
      if (p === "pro") return { key: "pro", label: "Pro", paid: true, business: false };
      if (p === "plus") return { key: "plus", label: "Plus", paid: true, business: false };
      if (p === "go") return { key: "go", label: "Go", paid: true, business: false };
      if (p === "free" || !p) return { key: "free", label: "Free", paid: false, business: false };
      return { key: p, label: p.charAt(0).toUpperCase() + p.slice(1), paid: true, business: false };
    }
    return { key: "unknown", label: "未知", paid: false, business: false };
  }

  // 付费渠道：网页直付 / Apple / Google Play
  function normalizeOrigin(v) {
    const s = String(v || "").toLowerCase();
    if (!s) return null;
    if (/ios|apple|app_?store|itunes/.test(s)) return "apple";
    if (/android|google_?play|play_?store/.test(s)) return "google";
    return "web";
  }

  // 使用频次统计
  function llmStats(timestamps, now) {
    const base = typeof now === "number" ? now : Date.now();
    const ts = (timestamps || []).map(parseTs).filter(t => t && t <= base + DAY).sort((a, b) => b - a);
    const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
    const within = (days) => ts.filter(t => base - t <= days * DAY);
    const t30 = within(30), t7 = within(7);
    return {
      lastUsed: ts.length ? ts[0] : null,
      activeDays30: new Set(t30.map(dayKey)).size,
      activeDays7: new Set(t7.map(dayKey)).size,
      convs30: t30.length,
      convs7: t7.length,
      // 对话列表最多取 100 条；如果 100 条全在 30 天内，说明实际更多，这里标出来
      capped: ts.length >= 100 && t30.length >= 100
    };
  }

  // Claude 用量：把接口里的窗口名映射成通用字段
  function pickUsage(usage) {
    if (!usage) return null;
    const g = (re) => { for (const k in usage) if (re.test(k)) return usage[k]; return null; };
    const fh = g(/^five_hour$|5_?hour|session/i);
    const sd = g(/^seven_day$|^weekly$|week(?!.*(opus|sonnet))/i);
    const so = g(/seven_day_opus|opus/i);
    const v = (w) => (w && typeof w.utilization === "number" ? Math.round(w.utilization) : null);
    return { fiveHour: v(fh), fiveHourReset: fh && fh.resetsAt || null,
             week: v(sd), weekReset: sd && sd.resetsAt || null, weekOpus: v(so) };
  }

  // 采样：每次检查存一个点，保留 90 天
  function addSample(samples, usage, now) {
    const base = typeof now === "number" ? now : Date.now();
    const list = (samples || []).filter(s => base - s.t <= 90 * DAY);
    if (usage && (usage.fiveHour != null || usage.week != null)) {
      list.push({ t: base, fh: usage.fiveHour, wk: usage.week, op: usage.weekOpus });
    }
    return list.slice(-400);
  }

  // 近 N 周（按 7 天窗口往回切）每周的峰值
  function weeklyPeaks(samples, now, weeks) {
    const base = typeof now === "number" ? now : Date.now();
    const out = [];
    for (let i = 0; i < (weeks || 4); i++) {
      const from = base - (i + 1) * 7 * DAY, to = base - i * 7 * DAY;
      const inW = (samples || []).filter(s => s.t > from && s.t <= to);
      if (!inW.length) { out.push(null); continue; }
      const mx = (f) => { const v = inW.map(s => s[f]).filter(x => typeof x === "number"); return v.length ? Math.max.apply(null, v) : null; };
      out.push({ week: mx("wk"), fiveHour: mx("fh"), n: inW.length });
    }
    return out; // [本周, 上周, …]
  }

  // ---------- 建议 ----------
  // level: cancel（考虑退订）/ downgrade（考虑降档）/ keep（花得值）/ wait（数据不够）/ none
  // 措辞一律用问句 + 数据；阈值保守，宁可不提醒。
  function llmAdvice(kind, llm, now) {
    const base = typeof now === "number" ? now : Date.now();
    const plan = llm && llm.plan;
    const st = llm && llm.stats;
    if (!plan || !st) return { level: "none", text: "" };
    if (plan.business) return { level: "none", text: "公司/团队付费的账号，不给退订建议。" };
    if (!plan.paid) return { level: "none", text: "当前是免费版，没有订阅费用。" };

    if (st.activeDays30 === 0) {
      return { level: "cancel", text: `近 30 天一次都没用过${st.lastUsed ? `（最近一次是 ${Math.floor((base - st.lastUsed) / DAY)} 天前）` : ""}，还需要 ${plan.label} 吗？` };
    }

    if (kind === "claude") {
      const peaks = weeklyPeaks(llm.samples, base, 4).filter(Boolean);
      const hitCap = (llm.samples || []).filter(s => base - s.t <= 28 * DAY && ((s.wk != null && s.wk >= 95) || (s.fh != null && s.fh >= 95))).length;
      if (hitCap >= 2) return { level: "keep", text: `近 4 周有 ${hitCap} 次接近或用满额度，${plan.label} 这个钱花得值。` };
      const rule = plan.key === "max5x" ? { to: "Pro", wk: 15, fh: 20, save: 80 }
                 : plan.key === "max20x" ? { to: "Max 5x", wk: 20, fh: 25, save: 100 } : null;
      if (rule) {
        if (peaks.length < 3) return { level: "wait", text: `额度数据还在积累（已有 ${peaks.length} 周），满 3 周后判断 ${plan.label} 是否买高了。` };
        const wkMax = Math.max.apply(null, peaks.map(p => p.week == null ? 0 : p.week));
        const fhMax = Math.max.apply(null, peaks.map(p => p.fiveHour == null ? 0 : p.fiveHour));
        if (wkMax < rule.wk && fhMax < rule.fh) {
          return { level: "downgrade", text: `近 ${peaks.length} 周每周额度最高只用到 ${wkMax}%，5 小时额度最高 ${fhMax}%。换成 ${rule.to} 大概也够用，每月约省 $${rule.save}。要考虑降档吗？` };
        }
        return { level: "keep", text: `近 ${peaks.length} 周每周额度最高用到 ${wkMax}%，${plan.label} 的档位基本合适。` };
      }
    }

    if (kind === "chatgpt") {
      if (plan.key === "pro" && st.activeDays30 <= 10) {
        return { level: "downgrade", text: `近 30 天只在 ${st.activeDays30} 天用过，Pro 可能买高了，换成 Plus 够不够用？` };
      }
      if ((plan.key === "plus" || plan.key === "go") && st.activeDays30 <= 4) {
        return { level: "downgrade", text: `近 30 天只在 ${st.activeDays30} 天用过，还需要 ${plan.label} 吗？免费版可能就够了。` };
      }
    }
    if (kind === "claude" && plan.key === "pro" && st.activeDays30 <= 4) {
      return { level: "downgrade", text: `近 30 天只在 ${st.activeDays30} 天用过，还需要 Pro 吗？免费版可能就够了。` };
    }
    return { level: "keep", text: `近 30 天用了 ${st.activeDays30} 天${st.convs30 ? `、${st.convs30}${st.capped ? "+" : ""} 个对话` : ""}，在正常使用。` };
  }

  // 两家都付费、其中一家用得少很多 → 考虑只留一个
  function crossAdvice(items) {
    const paid = (items || []).filter(x => x.llm && x.llm.plan && x.llm.plan.paid && !x.llm.plan.business && x.llm.stats);
    if (paid.length < 2) return null;
    const sorted = paid.slice().sort((a, b) => b.llm.stats.activeDays30 - a.llm.stats.activeDays30);
    const hi = sorted[0], lo = sorted[sorted.length - 1];
    const h = hi.llm.stats.activeDays30, l = lo.llm.stats.activeDays30;
    if (h >= 8 && l * 4 <= h) {
      return { keep: hi.id, drop: lo.id,
               text: `你同时在为 ${hi.name} 和 ${lo.name} 付费。近 30 天 ${hi.name} 用了 ${h} 天，${lo.name} 只用了 ${l} 天，考虑只留 ${hi.name}？` };
    }
    return null;
  }

  function priceHint(kind, planKey) {
    const t = PRICE_HINTS[kind] || {};
    return typeof t[planKey] === "number" ? t[planKey] : null;
  }

  globalThis.LlmLib = {
    LLM_SITES, PRICE_HINTS, llmReadPage,
    parseTs, normalizePlan, normalizeOrigin, llmStats, pickUsage, addSample, weeklyPeaks,
    llmAdvice, crossAdvice, priceHint
  };
})();
