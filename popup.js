// popup.html 先加载 lib.js，与本文件共享全局作用域，
// computeStatus / wastedPerMonth / normalizeDomain 可直接用（同样不要再解构声明一遍）。
const $ = (id) => document.getElementById(id);
// 界面语言：英文模式下自动把界面上的中文换成英文（i18n.js）
if (typeof I18N !== "undefined") {
  I18N.start(document);
  // 右上角「中 / EN」：显示的是另一种语言，点一下切过去（记住选择，优先于浏览器语言）
  const lt = document.getElementById("langToggle");
  if (lt) {
    const en = I18N.getLang() === "en";
    lt.textContent = en ? "中" : "EN";
    lt.title = en ? "切换到中文" : "切换到英文";
    lt.addEventListener("click", () => { I18N.setLang(en ? "zh" : "en"); location.reload(); });
  }
}

let state = { subs: [], records: [], lastCheck: null, paused: false, providers: [], mailScan: null, mailIgnored: [], mailPrefs: {} };


function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function fmtDate(ts) {
  if (!ts) return "从未";
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前（${d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}）`;
}

// 检查时间：当天显示「今天 14:05」，昨天显示「昨天 14:05」，更早的同 fmtDate
function fmtCheck(ts) {
  if (!ts) return "从未";
  const d = new Date(ts), now = new Date();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(d)) / 86400000);
  if (diff <= 0) return "今天 " + hm;
  if (diff === 1) return "昨天 " + hm;
  return fmtDate(ts);
}

// 弹窗内的确认框。插件弹窗里用浏览器自带的 confirm() 会卡住（按钮点不动、文字不显示），所以自己画一个。
// buttons: [{ label, value, kind: "danger" | "primary" | "" }]，点遮罩或按 Esc = null
function askDialog(title, text, buttons) {
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.className = "dlg-mask";
    wrap.innerHTML = `<div class="dlg" role="dialog" aria-modal="true"><b class="dlg-title"></b><p class="dlg-text"></p><div class="dlg-btns"></div></div>`;
    wrap.querySelector(".dlg-title").textContent = title;
    const tx = wrap.querySelector(".dlg-text");
    if (text) tx.textContent = text; else tx.remove();
    const box = wrap.querySelector(".dlg-btns");
    const done = (v) => { document.removeEventListener("keydown", onKey, true); wrap.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } };
    buttons.forEach(b => {
      const el = document.createElement("button");
      el.type = "button"; el.textContent = b.label; el.className = "dlg-btn " + (b.kind || "");
      el.addEventListener("click", (e) => { e.stopPropagation(); done(b.value); });
      box.appendChild(el);
    });
    wrap.addEventListener("click", (e) => { if (e.target === wrap) done(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(wrap);
    const last = box.lastElementChild; if (last) last.focus();
  });
}
async function askConfirm(title, text, okLabel, danger) {
  return (await askDialog(title, text, [{ label: "取消", value: false }, { label: okLabel || "确定", value: true, kind: danger ? "danger" : "primary" }])) === true;
}

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// 申请权限。
// 工具栏弹窗里：Chrome 弹出授权框时会把弹窗收起来，所以已经有权限就直接继续；没有的话，
//   先把「授权后要做的事」登记给后台，再打开一个独立小窗口，在小窗口里点「继续授权」（小窗口不会被收起），结果也显示在小窗口里。
// 独立小窗口里：直接申请（同样先登记，万一用户中途关掉窗口，后台也能接着做完）。
// 侧边栏（?panel=1）和独立窗口（?win=1）都不会被授权框收起，直接在里面申请
const IN_PANEL = /[?&]panel=1/.test(location.search);
const IN_WINDOW = IN_PANEL || /[?&]win=1/.test(location.search);
if (IN_PANEL) document.documentElement.classList.add("in-panel");
const GRANT_WINDOW = IN_WINDOW && /[?&]grant=1/.test(location.search);
if (IN_WINDOW) document.documentElement.classList.add("in-window");
async function requestAccess(q, action, id, params) {
  if (!IN_WINDOW) {
    let has = false;
    try { has = await chrome.permissions.contains(q); } catch (e) { has = false; }
    if (has) return true;
    await send({ type: "PENDING_GRANT", action, id, origins: q.origins || [], permissions: q.permissions || [], params });
    await send({ type: "OPEN_GRANT_WINDOW" });
    window.close();
    return new Promise(() => {});   // 弹窗马上关掉，后面的代码不用再跑
  }
  send({ type: "PENDING_GRANT", action, id, origins: q.origins || [], permissions: q.permissions || [], params, inWindow: true });
  return chrome.permissions.request(q).catch(() => false);
}
function requestOrigins(origins, action, id, params) { return requestAccess({ origins }, action, id, params); }
function requestPermission(perm, action, id) { return requestAccess({ permissions: [perm] }, action, id); }

// 授权小窗口：说明要授权什么，点「继续授权」后弹出 Chrome 的授权框；授权后后台接着做，结果显示在这个窗口里
function grantLabel(pg) {
  const name = pg.action === "llm" ? (LLM_NAMES[pg.id] || pg.id)
    : (SubCatalog.BY_ID[pg.id] || {}).name || ((state.subs.find(x => x.id === pg.id) || {}).name) || "";
  if (pg.action === "mail") return { title: "授权读取 Gmail", text: "插件会在后台打开 Gmail 搜索结果列表，找出可能在付费的订阅。只读列表，不打开邮件正文。" };
  if (pg.action === "history") return { title: "授权读取浏览历史", text: "读取最近 90 天浏览历史，只按网站域名统计访问时间，不保存网址和标题。" };
  if (pg.action === "llm") return { title: `授权读取 ${name}`, text: `读取 ${name} 的套餐、对话时间和额度，不读对话内容。` };
  if (pg.action === "diag") return { title: `授权读取 ${name} 的账户页`, text: "诊断需要读一次账户页，看看能读到什么。" };
  return { title: `授权读取 ${name}`, text: `插件需要读取 ${name} 的账户页，获取套餐、价格和续费日。` };
}
function grantView(pg) {
  if (pg.action === "catalog" || pg.action === "llm") { show("add"); showPane("manual"); }
  else if (pg.action === "mail") { show("add"); showPane("mail"); }
  else if (pg.action === "history") { show("add"); showPane("history"); }
  else show("subs");
}
async function runGrantWindow() {
  const pg = state.pendingGrant;
  if (!pg) return;
  grantView(pg);
  const lb = grantLabel(pg);
  const go = await askDialog(lb.title, lb.text + "点「继续授权」后 Chrome 会弹出授权框，点「允许」就行，这个窗口不会关。",
    [{ label: "取消", value: false }, { label: "继续授权", value: true, kind: "primary" }]);
  if (!go) { window.close(); return; }
  send({ type: "PENDING_GRANT", action: pg.action, id: pg.id, origins: pg.origins || [], permissions: pg.permissions || [], params: pg.params, inWindow: true });
  const ok = await chrome.permissions.request({ origins: pg.origins || [], permissions: pg.permissions || [] }).catch(() => false);
  if (!ok) {
    await askDialog("没有获得授权", "可以关掉这个窗口，之后需要时再授权。", [{ label: "关闭窗口", value: true, kind: "primary" }]);
    window.close();
    return;
  }
  await send({ type: "RESUME_PENDING" });
  await refresh();
}

// ---------- 渲染订阅列表 ----------
const SV_ICON = {
  check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/></svg>',
  grip: '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14M12 20V9M7 13l5-5 5 5"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
};
// 列表排序：闲置的、读不到的排前面，最需要你处理的先看到
const SV_ORDER = { idle: 0, signal_lost: 1, baseline: 2, active: 3, unmonitored: 4 };
const SV_STATUS = { idle: "一段时间未用", active: "最近用过", baseline: "观察中", signal_lost: "暂时读不到", unmonitored: "不参与判断" };
const SV_CAT = { ai: "AI 工具", video: "影音娱乐", cn: "影音会员", work: "效率与云服务" };
const openRows = new Set();
let svFilterIdle = false;
// 每月支出：按币种分别相加（$60.49 / $40 + ¥30）
function spendHtml(subs) {
  const by = {};
  subs.forEach(s => { if (s.price && s.mode !== "none") by[s.currency || "$"] = (by[s.currency || "$"] || 0) + Number(s.price); });
  const keys = Object.keys(by);
  if (!keys.length) return "—";
  return keys.map(c => { const [a, b] = by[c].toFixed(2).split("."); return `${esc(c)}${a}<span class="cents">.${b}</span>`; }).join(" + ");
}
// 列表里名称下面那行：有读到的关键信息就直接显示（不用展开），没有就显示分类
function subCaption(s) {
  const p = s.catalogId && SubCatalog.BY_ID[s.catalogId];
  const md = (t) => new Date(t).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  // 大模型：套餐 + 额度（读得到的话），否则套餐 + 近 7 天对话数
  const L = s.llm;
  if (L && L.plan) {
    const u = L.usage || {};
    // 列表里位置有限：优先显示本周额度（更能说明这个月值不值），没有再显示 5 小时额度；两项都在展开后的详情里
    if (u.week != null) return `${L.plan.label} · 本周额度 ${Math.round(u.week)}%`;
    if (u.fiveHour != null) return `${L.plan.label} · 5 小时额度 ${Math.round(u.fiveHour)}%`;
    return `${L.plan.label} · 近 7 天 ${(L.stats && L.stats.convs7) || 0} 个对话`;
  }
  const a = s.account;
  // 网盘：空间用量
  if (p && p.storage && a && a.storage) return `空间 ${a.storage.label} · ${a.storage.pct}%`;
  // 其它收录服务：套餐 + 续费日
  if (p && a && a.plan && (a.status === "ok" || !a.status)) return a.plan.label + (a.renewAt ? ` · ${md(a.renewAt)} 续费` : "");
  if (p) return SV_CAT[p.cat] || "";
  if (s.provider === "claude" || s.provider === "chatgpt") return "AI 助手";
  return s.urlPattern || (s.mode === "none" ? "电视 / 手机" : "");
}
function renderSubs() {
  const now = Date.now();
  const subs = state.subs;
  const rowsAll = subs.map(s => ({ s, st: computeStatus(s, now) }));
  const idle = rowsAll.filter(r => r.st.state === "idle");
  $("cnt").textContent = state.subLimit != null ? `${subs.length}/${state.subLimit}` : subs.length;
  $("idleCnt").textContent = idle.length;
  $("spend").innerHTML = spendHtml(subs);
  const save = wastedPerMonth(subs, now);
  $("waste").textContent = save ? `其中闲置的约 ${(idle[0] && idle[0].s.currency) || "$"}${save}/月` : "";
  $("lastCheck").textContent = state.lastCheck ? "上次检查 " + fmtDate(state.lastCheck) : "";
  if (!$("checkStatus").dataset.busy) $("checkStatus").textContent = state.lastCheck ? "上次全部检查：" + fmtCheck(state.lastCheck) : "";
  $("idleBanner").hidden = !idle.length;
  $("idleBannerText").textContent = svFilterIdle ? `正在看 ${idle.length} 项最近较少使用的订阅，点这里看全部。` : `有 ${idle.length} 项订阅最近较少使用，看看是否还需要。`;
  $("idleBanner").classList.toggle("on", svFilterIdle);
  if (!idle.length) svFilterIdle = false;
  $("svFilter").hidden = !svFilterIdle;
  document.querySelector(".sv-thead").hidden = !subs.length;

  if (!subs.length) {
    $("subList").innerHTML = `<div class="sv-empty"><b>还没有订阅</b>把你在付费的服务加进来：常见服务一键添加，没收录的网址也能统计访问。
      <div><button type="button" class="ad-btn primary" data-goadd="1">添加订阅</button></div></div>`;
    return;
  }

  // 信号中断时给出具体该怎么处理
  const FIX = {
    logged_out: "这个浏览器没登录，或登录已过期，所以读不到活动记录。<b>这不代表你没在用</b>，恢复前不会给出退订建议。",
    history_off: "该服务的历史记录处于关闭 / 暂停状态，无法据此判断使用情况。可以去打开历史记录，或把这条订阅改成其它判断方式。",
    read_failed: "读取活动记录失败（可能是网络问题或页面结构变化）。恢复前不会给出退订建议。",
    no_permission: "还没授权插件读取这个网站。点「去处理」授权后会立即重新读取。"
  };

  // 排序模式：列出全部订阅（不受「只看闲置」影响），每行只有拖动手柄、名称和上移 / 下移 / 置顶
  document.querySelector(".sv-table").classList.toggle("sorting", sortMode);
  $("sortBar").hidden = !sortMode;
  $("sortReset").hidden = !hasManualOrder();
  if (sortMode) {
    $("svFilter").hidden = true;
    const all = sortRows(rowsAll), n = all.length;
    $("subList").innerHTML = all.map(({ s }, i) => `<div class="sv-srow" data-id="${esc(s.id)}">
      <span class="sv-grip" data-grip="${esc(s.id)}" tabindex="0" role="button" title="按住拖动（选中后也可以按 ↑ ↓）" aria-label="拖动调整「${esc(s.name)}」的位置">${SV_ICON.grip}</span>
      <div class="sv-prod">${avatarHtml(s.catalogId || s.provider || s.id)}<div><b>${esc(s.name)}</b><small>${esc(subCaption(s))}</small></div></div>
      <button class="sv-mv" data-mv="top" data-id="${esc(s.id)}" title="置顶" ${i === 0 ? "disabled" : ""}>${SV_ICON.top}</button>
      <button class="sv-mv" data-mv="up" data-id="${esc(s.id)}" title="上移" ${i === 0 ? "disabled" : ""}>${SV_ICON.up}</button>
      <button class="sv-mv" data-mv="down" data-id="${esc(s.id)}" title="下移" ${i === n - 1 ? "disabled" : ""}>${SV_ICON.down}</button>
    </div>`).join("");
    return;
  }
  const rows = sortRows(svFilterIdle ? idle : rowsAll);
  $("subList").innerHTML = rows.map(({ s, st }) => {
    const isLlm = !!(s.llm || s.provider === "claude" || s.provider === "chatgpt");
    const known = !!(s.catalogId || isLlm || s.mode === "activity");
    const fee = s.price ? `${esc(s.currency || "$")}${Number(s.price).toFixed(2)}${s.priceEstimated ? "<small>按公开价估</small>" : ""}` : `<span style="color:var(--muted)">—</span>`;
    let used;
    if (st.state === "idle") used = `${st.days} 天未使用`;
    else if (s.lastUsedFloor) used = "90 天+未使用";
    else used = s.lastUsed ? fmtShort(s.lastUsed) : "—";
    const vs = visitStats(s.visitLog, now);

    let fix = "";
    if (st.state === "signal_lost") {
      const since = st.days > 0 ? `已 ${st.days} 天读不到。` : "";
      fix = `<div class="fixit">${since}${FIX[st.reason] || FIX.read_failed}
        <div><button data-fix="${esc(s.id)}">去处理</button></div></div>`;
    }
    const busy = checking.has(s.id), open = openRows.has(s.id);
    return `<div class="sv-row st-${st.state}${open ? " open" : ""}" data-id="${esc(s.id)}">
      <div class="sv-main" data-toggle="${esc(s.id)}" title="点开看详情">
        <div class="sv-prod">${avatarHtml(s.catalogId || s.provider || s.id)}<div><b>${esc(s.name)}</b><small>${esc(subCaption(s))}${s.price ? `<span class="sv-fee-in"> · ${esc(s.currency || "$")}${Number(s.price).toFixed(2)}/月</span>` : ""}</small></div></div>
        <span class="sv-fee">${fee}</span>
        <span class="sv-used${st.state === "idle" ? " warm" : ""}">${esc(used)}</span>
        <span class="sv-status ${st.state}">${esc(SV_STATUS[st.state])}</span>
      </div>
      <div class="sv-detail">
        <div class="sv-metrics">
          ${usageCells(s, vs, isLlm)}
        </div>
        ${s.llm && st.state !== "signal_lost" ? llmHtml(s) : ""}
        ${s.catalogId && SubCatalog.BY_ID[s.catalogId] && !SubCatalog.BY_ID[s.catalogId].special ? acctHtml(s, st) : ""}
        ${fix}
        <div class="sv-foot">
          <span class="sv-muted">${known ? "最近检查 " + esc((s.lastChecked || (s.account && s.account.checkedAt)) ? fmtCheck(s.lastChecked || s.account.checkedAt) : "还没检查") : "只统计浏览器访问"}</span>
          <button class="sv-icon${busy ? " spinning" : ""}" data-chk="${esc(s.id)}" title="${busy ? "检查中…" : "检查"}" ${busy ? "disabled" : ""}>${SV_ICON.check}</button>
          <button class="sv-icon" data-edit="${esc(s.id)}" title="编辑">${SV_ICON.edit}</button>
          <button class="sv-icon danger" data-del="${esc(s.id)}" title="删除">${SV_ICON.del}</button>
        </div>
      </div>
    </div>`;
  }).join("");
}
$("idleBanner").addEventListener("click", () => { svFilterIdle = !svFilterIdle; renderSubs(); });

// ---------- 手动排序 ----------
// 用户拖动过就按他排的顺序（存在 subOrder，随云端同步）；没排过按使用状态自动排（闲置的在前）。
// 新加的、顺序里还没有的订阅排在最前面，方便看到。
function hasManualOrder() { return !!(state.order && state.order.length); }
function autoCmp(a, b) { return (SV_ORDER[a.st.state] - SV_ORDER[b.st.state]) || ((b.st.days || 0) - (a.st.days || 0)); }
function sortRows(rows) {
  if (!hasManualOrder()) return rows.slice().sort(autoCmp);
  const pos = {};
  state.order.forEach((id, i) => { pos[id] = i; });
  return rows.slice().sort((a, b) => {
    const pa = a.s.id in pos ? pos[a.s.id] : -1, pb = b.s.id in pos ? pos[b.s.id] : -1;
    if (pa === -1 && pb === -1) return (b.s.createdAt || 0) - (a.s.createdAt || 0);
    return pa - pb;
  });
}
// 当前全部订阅的显示顺序（不受「只看闲置」筛选影响）
function fullOrder() { return sortRows(state.subs.map(s => ({ s, st: computeStatus(s, Date.now()) }))).map(r => r.s.id); }
let sortMode = false;
$("sortToggle").addEventListener("click", (e) => { e.preventDefault(); sortMode = true; renderSubs(); });
$("sortDone").addEventListener("click", (e) => { e.preventDefault(); sortMode = false; renderSubs(); });
// 排序模式下列出的是全部订阅，新顺序直接存
async function saveOrder(ids) {
  state.order = ids;
  renderSubs();
  await send({ type: "SET_ORDER", ids });
}
$("sortReset").addEventListener("click", async (e) => {
  e.preventDefault();
  state.order = null;
  renderSubs();
  await send({ type: "SET_ORDER", ids: null });
});
const listIds = () => [...$("subList").querySelectorAll(".sv-srow")].map(r => r.dataset.id);
// 上移 / 下移 / 置顶
$("subList").addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest("[data-mv]");
  if (!b || !sortMode) return;
  e.stopPropagation();
  const ids = listIds(), i = ids.indexOf(b.dataset.id);
  if (i < 0) return;
  if (b.dataset.mv === "top" && i > 0) { ids.splice(i, 1); ids.unshift(b.dataset.id); }
  else if (b.dataset.mv === "up" && i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
  else if (b.dataset.mv === "down" && i < ids.length - 1) [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
  else return;
  await saveOrder(ids);
}, true);

// 拖动：按住左侧的点点拖到想要的位置（用 pointer 事件，鼠标和触控板都能用）
let drag = null;
$("subList").addEventListener("pointerdown", (e) => {
  const grip = e.target.closest && e.target.closest("[data-grip]");
  if (!grip || e.button !== 0) return;
  e.preventDefault();
  const row = grip.closest(".sv-srow");
  drag = { row, id: row.dataset.id, startY: e.clientY, before: listIds().join(","), lastY: e.clientY };
  grip.setPointerCapture && grip.setPointerCapture(e.pointerId);
  row.classList.add("dragging");
  document.body.classList.add("sv-sorting");
});
document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.lastY = e.clientY;
  const rows = [...$("subList").querySelectorAll(".sv-srow")].filter(r => r !== drag.row);
  // 鼠标在哪一行的上半部分，就插到那一行前面
  let target = null;
  for (const r of rows) { const b = r.getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { target = r; break; } }
  if (target) { if (drag.row.nextElementSibling !== target) $("subList").insertBefore(drag.row, target); }
  else if (drag.row !== $("subList").lastElementChild) $("subList").appendChild(drag.row);
  // 靠近窗口上下边缘时自动滚动
  const se = document.scrollingElement || document.documentElement, H = window.innerHeight;
  if (e.clientY < 40) se.scrollTop -= 12; else if (e.clientY > H - 40) se.scrollTop += 12;
});
async function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  d.row.classList.remove("dragging");
  document.body.classList.remove("sv-sorting");
  const now = listIds();
  if (now.join(",") !== d.before) await saveOrder(now);
}
// 拖动时行会被挪动位置，指针捕获可能丢失，所以抬起 / 取消在整个页面上监听
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);
window.addEventListener("blur", endDrag);
// 键盘：选中左侧的点点后按 ↑ ↓ 移动
$("subList").addEventListener("keydown", async (e) => {
  const grip = e.target.closest && e.target.closest("[data-grip]");
  if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  const ids = listIds(), i = ids.indexOf(grip.dataset.grip), j = e.key === "ArrowUp" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await saveOrder(ids);
  const g = [...$("subList").querySelectorAll("[data-grip]")].find(x => x.dataset.grip === grip.dataset.grip);
  if (g) g.focus();
});
$("svFilterClear").addEventListener("click", (e) => { e.preventDefault(); svFilterIdle = false; renderSubs(); });
// 详情里的四格，把两件事分开：
//   最近使用 = 判断闲不闲置的依据（视频看观看记录、大模型看对话记录、其它看浏览器访问），列表里「最近使用」那一列就是它；
//   最近访问 / 近 7 天 / 近 30 天 = 在这个浏览器里打开网站的时间和次数，只是参考，打开网站不一定等于在用。
function usageBasis(s, isLlm) {
  if (isLlm) return { text: "按对话记录", tip: "最近一次发起对话的时间（手机上的对话也算），只打开页面不算" };
  if (s.mode === "activity") {
    return s.sig && s.signal && s.signal.ok !== false
      ? { text: "按观看记录", tip: "观看记录里最近一次观看的日期（电视、手机上用同一账号看的也算）" }
      : { text: "按浏览器访问", tip: "观看记录暂时读不到，先按在本浏览器打开网站的时间判断" };
  }
  if (s.mode === "browser") return { text: "按浏览器访问", tip: "在本浏览器打开这个网站的时间" };
  return { text: "不参与判断", tip: "" };
}
function usageCells(s, vs, isLlm) {
  const b = usageBasis(s, isLlm);
  const used = s.lastUsedFloor ? "90 天+" : s.lastUsed ? fmtShort(s.lastUsed) : "—";
  return `<div title="${esc(b.tip)}"><span>最近使用</span><b>${esc(used)}</b><small>${esc(b.text)}</small></div>
    <div title="在本浏览器里打开这个网站的最近一次时间（打开不一定等于在用）"><span>最近访问</span><b>${esc(vs.last ? fmtShort(vs.last) : "无记录")}</b><small>打开网站</small></div>
    <div><span>近 7 天访问</span><b>${vs.d7} 次</b></div><div><span>近 30 天访问</span><b>${vs.d30} 次</b></div>`;
}
// 卡片里的短日期：今天 / 昨天 / N 天前
function fmtShort(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// 常见服务：账户页读到的套餐、价格、续费日、空间 + 建议
const ACCT_ERR = {
  logged_out: (n) => `本浏览器没有登录 ${n}，读不到套餐。<b>这不代表你没在用。</b>`,
  no_permission: (n) => `还没授权读取 ${n} 的账户页。`,
  read_failed: (n) => `打开了 ${n} 的账户页但没读到内容（可能被安全验证拦住，或页面改版了）。`
};
const cdiagOut = {};   // 诊断结果只放在内存里，关掉弹窗就没了
const cdiagBusy = new Set();   // 正在诊断的订阅
function diagText(d) {
  if (!d || !d.ok) return "诊断失败。";
  if (!d.error && !d.result) return "诊断失败：没有拿到结果。";
  if (d.error) return "读取失败：" + esc(d.error);
  const a = d.result;
  return esc([
    `状态：${a.status}　最终地址：${a.url || "?"}`,
    `套餐：${a.plan ? a.plan.label + (a.plan.paid ? "（付费）" : "（免费）") : "未认出"}`,
    `价格：${a.price ? a.price.currency + a.price.monthly + "/月" : "未读到"}　续费日：${a.renewAt ? new Date(a.renewAt).toLocaleDateString("zh-CN") : "未读到"}`,
    a.storage ? `空间：${a.storage.label}（${a.storage.pct}%）` : d.quotaError ? `空间：没读到（用量接口：${d.quotaError}）` : "",
    d.injectError ? `注入失败：${d.injectError}` : "",
    d.activity ? (d.activity.error ? "观看记录：读取失败" : d.activity.loggedOut ? "观看记录：没登录"
      : `观看记录：抓到 ${d.activity.count} 条${d.activity.topLabel ? `，第一组「${d.activity.topLabel}」` : ""}${d.activity.count ? "（" + d.activity.ids.join("、") + "）" : "，没认出条目"}`) : "",
    `页面文字 ${d.textLength} 字，开头：`,
    d.excerpt || "（空）"
  ].filter(Boolean).join("\n"));
}
function acctHtml(s, st) {
  const p = SubCatalog.BY_ID[s.catalogId], a = s.account || {};
  const btns = [];
  let body = "";
  if (ACCT_ERR[a.status]) {
    body = `<div>${ACCT_ERR[a.status](esc(p.name))}${a.plan ? `（上次读到：${esc(a.plan.label)}）` : ""}</div>`;
    if (a.status === "no_permission") btns.push(`<button class="mini" data-cperm="${esc(s.id)}">授权并读取</button>`);
    else btns.push(`<button class="mini" data-copen="${esc(s.id)}">打开账户页</button>`);
  } else if (a.plan) {
    const bits = [`套餐 <b>${esc(a.plan.label)}</b>`];
    if (a.price) bits.push(`${esc(a.price.currency)}${esc(a.price.monthly)}/月${a.price.period === "year" ? "（年付折算）" : ""}`);
    if (a.renewAt) bits.push("下次续费 " + new Date(a.renewAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }));
    body = `<div>${bits.join(" · ")}</div>`;
    if (a.storage) body += `<div>空间：${meter(a.storage.pct)}（${esc(a.storage.label)}）</div>`;
  } else if (a.status === "unknown") {
    body = `<div>打开了账户页，但没认出套餐。</div>`;
  } else {
    body = `<div>还没读过账户页，点「检查」读一次。</div>`;
  }
  // 诊断不再给用户看：按住 Alt 点「检查」才会诊断（开发排查用），诊断结果展开时给一个收起按钮
  const diagOpen = !!cdiagOut[s.id] && !cdiagBusy.has(s.id);
  if (diagOpen) btns.push(`<button class="mini" data-cdiag="${esc(s.id)}">收起诊断</button>`);
  const adv = a.status === "ok" ? SubCatalog.accountAdvice(p, a, st) : null;
  const advHtml = adv && adv.level !== "keep" ? `<div class="advice ${esc(adv.level)}">${esc(adv.text)}</div>` : "";
  const diag = cdiagOut[s.id] ? `<div class="cdiag">${cdiagOut[s.id]}</div>` : "";
  return `<div class="llm acct">${body}<div>${btns.join("")}</div>${diag}</div>${advHtml}`;
}

// 大模型订阅的详情：套餐、使用频次、额度、续费、建议
function meter(v) {
  if (v == null) return "—";
  const w = Math.max(0, Math.min(100, v));
  return `<span class="meter"><i style="width:${w}%"></i></span>${v}%`;
}
function llmHtml(s) {
  const L = s.llm, st = L.stats || {};
  const ORIGIN = { apple: "经 App Store 付费，要在 iPhone 的订阅管理里退", google: "经 Google Play 付费，要在 Play 商店里退" };
  const line1 = [`套餐 <b>${esc(L.plan ? L.plan.label : "未知")}</b>`,
    T("近 30 天用了 {n} 天", { n: `<b>${st.activeDays30 || 0}</b>` }),
    T("近 7 天 {n} 个对话", { n: `<b>${st.convs7 || 0}</b>` })].join(" · ");
  let line2 = "";
  if (L.usage && (L.usage.fiveHour != null || L.usage.week != null)) {
    line2 = `<div>额度：5 小时 ${meter(L.usage.fiveHour)} · 本周 ${meter(L.usage.week)}${L.usage.weekOpus != null ? ` · 本周高阶模型 ${meter(L.usage.weekOpus)}` : ""}</div>`;
  }
  const extra = [];
  if (L.renewAt) extra.push("下次续费 " + new Date(L.renewAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }));
  if (L.willRenew === false) extra.push("已关闭自动续费");
  if (L.origin && ORIGIN[L.origin]) extra.push(ORIGIN[L.origin]);
  const adv = L.advice && L.advice.text ? `<div class="advice ${esc(L.advice.level)}">${esc(L.advice.text)}</div>` : "";
  const cross = L.cross ? `<div class="advice cross">${esc(L.cross)}</div>` : "";
  return `<div class="llm"><div>${line1}</div>${line2}${extra.length ? `<div>${esc(extra.join(" · "))}</div>` : ""}</div>${cross}${adv}`;
}

const LLM_ORIGINS = { claude: "https://claude.ai/*", chatgpt: "https://chatgpt.com/*" };
const LLM_NAMES = { claude: "Claude", chatgpt: "ChatGPT" };
// ---------- 账号 / 订阅数上限 ----------
const limitText = () => `未登录最多添加 ${state.guestLimit || AuthLib.GUEST_SUB_LIMIT} 个订阅，已经满了。<a href="#" data-login="1">登录 / 注册</a>后不限数量。`;
function atLimit() { return state.subLimit != null && state.subs.length >= state.subLimit; }
function renderAccount() {
  const a = state.auth;
  $("acct").innerHTML = a && a.user
    ? `<span class="avatar" title="${esc(a.user.email)}">${esc(((a.user.name || a.user.email || "?").trim()[0] || "?").toUpperCase())}</span><span class="acct-mail" title="${esc(a.user.email)}">${esc(a.user.email)}</span><a href="#" id="signOut">退出</a>`
    : `<a href="#" data-login="1">登录</a>`;
  const lim = state.subLimit;
  $("cnt").textContent = lim != null ? `${state.subs.length}/${lim}` : state.subs.length;
  $("limitBar").hidden = !atLimit();
  if (atLimit()) $("limitBar").innerHTML = limitText();
  document.querySelectorAll(".guestLimit").forEach(el => { el.textContent = state.guestLimit || AuthLib.GUEST_SUB_LIMIT; });
}
// 登录卡片（仿 Better Auth UI 的 AuthCard：登录 / 注册 / 忘记密码 三个视图）
const AUTH_VIEWS = {
  in:     { title: "登录", desc: "输入邮箱和密码登录你的账号", submit: "登录",
            footer: '还没有账号？<a href="#" class="ba-link" data-amode="up">注册</a>' },
  up:     { title: "注册", desc: "创建一个账号，解除 5 个订阅的上限", submit: "创建账号",
            footer: '已经有账号了？<a href="#" class="ba-link" data-amode="in">登录</a>' },
  forgot: { title: "忘记密码", desc: "通过邮箱重置你的密码", submit: "",
            footer: '想起来了？<a href="#" class="ba-link" data-amode="in">返回登录</a>' }
};
let authMode = "in";
let authBack = "subs";
function openAuth(mode) {
  authBack = ["subs", "add", "log"].find(v => !$("view-" + v).hidden) || "subs";
  setAuthMode(mode || "in");
  show("auth");
  $("a-email").focus();
}
function setAuthErr(msg, field) {
  ["a-email", "a-pass", "a-pass2"].forEach(id => $(id).removeAttribute("aria-invalid"));
  if (!msg) { $("authErr").hidden = true; return; }
  $("authErrText").textContent = msg;
  $("authErr").hidden = false;
  if (field) { $(field).setAttribute("aria-invalid", "true"); $(field).focus(); }
}
function setAuthMode(m) {
  authMode = m;
  const v = AUTH_VIEWS[m];
  $("authTitle").textContent = v.title;
  $("authDesc").textContent = v.desc;
  $("authFooter").innerHTML = v.footer;
  $("authSubmitText").textContent = v.submit;
  $("authSubmit").hidden = m === "forgot";
  $("a-name-wrap").hidden = m !== "up";
  $("a-pass-wrap").hidden = m === "forgot";
  $("a-pass2-wrap").hidden = m !== "up";
  $("authForgot").hidden = m !== "in";
  $("authSocial").hidden = m === "forgot" || !state.googleLogin;
  $("forgotInfo").hidden = m !== "forgot";
  $("authWhy").hidden = m === "forgot";
  $("a-pass").autocomplete = m === "up" ? "new-password" : "current-password";
  setAuthErr(null);
}
function setAuthLoading(on, google) {
  $("authSubmit").disabled = on;
  $("authGoogle").disabled = on;
  (google ? $("authGoogle") : $("authSubmit")).classList.toggle("loading", on);
  if (!on) { $("authGoogle").classList.remove("loading"); $("authSubmit").classList.remove("loading"); }
  ["a-name", "a-email", "a-pass", "a-pass2"].forEach(id => { $(id).disabled = on; });
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest ? e.target.closest("[data-login],#signOut,[data-amode],[data-eye],#authForgot") : e.target;
  if (!t) return;
  if (t.dataset.login) { e.preventDefault(); openAuth("in"); }
  else if (t.dataset.amode) { e.preventDefault(); setAuthMode(t.dataset.amode); }
  else if (t.id === "authForgot") { e.preventDefault(); setAuthMode("forgot"); }
  else if (t.dataset.eye) {
    const inp = $(t.dataset.eye), show = inp.type === "password";
    inp.type = show ? "text" : "password";
    t.classList.toggle("on", show);
    t.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
  }
  else if (t.id === "signOut") {
    e.preventDefault();
    if (!(await askConfirm("退出登录？", "已经添加的订阅会保留，但未登录时最多只能有 " + (state.guestLimit || 5) + " 个，超出的部分不能再新增。", "退出"))) return;
    await send({ type: "AUTH_SIGN_OUT" });
    await refresh();
  }
});
$("authCancel").addEventListener("click", () => show(authBack));
$("authGoogle").addEventListener("click", async () => {
  setAuthErr(null);
  setAuthLoading(true, true);
  // 授权窗口一弹出来，这个弹窗通常会被关掉；后台会接着完成登录，并重新打开弹窗显示结果
  const r = await send({ type: "AUTH_GOOGLE" });
  setAuthLoading(false, true);
  if (r && r.ok) { await refresh(); show(authBack === "auth" ? "subs" : authBack); }
  else if (r && !r.cancelled) setAuthErr(r.error || AuthLib.ERR.UNKNOWN);
  send({ type: "CLEAR_RESULT" });
});
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (authMode === "forgot") return;
  const email = $("a-email").value.trim(), password = $("a-pass").value;
  if (!AuthLib.validEmail(email)) return setAuthErr(AuthLib.ERR.INVALID_EMAIL, "a-email");
  if (password.length < 8) return setAuthErr(AuthLib.ERR.PASSWORD_TOO_SHORT, "a-pass");
  if (authMode === "up" && password !== $("a-pass2").value) return setAuthErr("两次输入的密码不一样。", "a-pass2");
  setAuthErr(null);
  setAuthLoading(true);
  const r = await send({ type: authMode === "up" ? "AUTH_SIGN_UP" : "AUTH_SIGN_IN", email, password, name: $("a-name").value.trim() });
  setAuthLoading(false);
  if (!r || !r.ok) return setAuthErr((r && r.error) || AuthLib.ERR.UNKNOWN);
  $("a-pass").value = ""; $("a-pass2").value = "";
  await refresh();
  show(authBack === "auth" ? "subs" : authBack);
});

const LLM_ERR = {
  logged_out: (n) => `本浏览器没有登录 ${n}（或登录已过期）。先打开网站登录，再点一次。`,
  no_permission: (n) => `没有获得读取 ${n} 的授权。`,
  read_failed: (n) => `读不到 ${n} 的数据，可能是网站接口变了或被安全验证拦住。先在本浏览器打开 ${n} 确认能正常使用；还不行的话，稍后再点「检查」试试。`
};
// 大模型（Claude / ChatGPT）：读套餐、对话频次和额度，不读对话内容
async function addLlm(kind) {
  const name = LLM_NAMES[kind], stEl = $("catStatus");
  // 已经满了就别先弹授权框
  if (atLimit()) { stEl.className = "secstatus bad"; stEl.innerHTML = limitText(); return; }
  const granted = await requestOrigins([LLM_ORIGINS[kind]], "llm", kind);
  if (!granted) { stEl.className = "secstatus bad"; stEl.textContent = LLM_ERR.no_permission(name); return; }
  if (adding.has(kind)) return;
  stEl.className = "secstatus";
  stEl.textContent = `正在读取 ${name}…（如果没开着，会在后台短暂打开网站）`;
  const r = await withAdding(kind, `正在添加 ${name}：读取套餐和对话记录…`, () => send({ type: "LLM_QUICK_ADD", kind }));
  await showLlmResult(kind, r);
}
async function showLlmResult(kind, r) {
  const name = LLM_NAMES[kind], stEl = $("catStatus");
  if (!r || !r.ok) {
    stEl.className = "secstatus bad";
    if (r && r.reason === "limit") { stEl.innerHTML = limitText(); busyToast(""); return; }
    stEl.textContent = (LLM_ERR[r && r.reason] || LLM_ERR.read_failed)(name);
    busyToast(`${name} 没添加成功`, "bad");
    return;
  }
  await refresh();
  busyToast(`已添加 ${name}`, "ok");
  stEl.className = "secstatus";
  stEl.textContent = `已添加 ${name}：${r.sub.llm.plan.label}${r.sub.priceEstimated ? `，月费按公开价估为 $${r.sub.price}，不对可以点「编辑」改` : ""}。`;

}

// ---------- 云端同步 ----------
const SYNC_ERR = {
  server: "服务器出错，稍后会自动重试",
  too_large: "订阅数据太大，超过了 256KB 的同步上限",
  unauthorized: "登录已失效，请重新登录",
  conflict: "其它设备同时在改，稍后会自动重试"
};
function renderSyncBar() {
  const el = $("syncBar");
  if (el.dataset.busy) return;
  el.hidden = !(state.auth && state.auth.user);
  if (el.hidden) return;
  const sy = state.sync || {};
  if (!sy.enabled) {
    el.innerHTML = `<span>云端同步：关</span><button id="syncOn">开启</button>
      <div class="sub-hint">换电脑、重装插件后订阅不丢；多台电脑之间自动同步。上传订阅清单、价格、套餐、续费日、最近使用日期和访问次数（只有访问时间，不含网址）；浏览的网址、邮件内容不上传。</div>`;
  } else {
    const when = sy.lastSyncAt ? fmtAgo(sy.lastSyncAt) : "还没同步过";
    el.innerHTML = `<span>云端同步：已开启 · ${esc(when)}</span><a href="#" id="syncRun">立即同步</a> <a href="#" id="syncOff">关闭</a>` +
      (sy.lastError ? `<div class="sub-hint bad">上次同步没成功：${esc(SYNC_ERR[sy.lastError] || sy.lastError)}</div>` : "");
  }
}
function fmtAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚同步";
  if (m < 60) return `${m} 分钟前同步`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时前同步`;
  return `${Math.floor(m / 1440)} 天前同步`;
}
async function syncAction(msg, busyText) {
  const el = $("syncBar");
  el.dataset.busy = "1";
  el.innerHTML = `<span>${busyText}</span>`;
  const r = await send(msg);
  delete el.dataset.busy;
  await refresh();
  if (r && !r.ok && r.reason && r.reason !== "disabled")
    $("syncBar").insertAdjacentHTML("beforeend", `<div class="sub-hint bad">同步没成功：${esc(SYNC_ERR[r.reason] || r.reason)}</div>`);
  return r;
}
$("syncBar").addEventListener("click", async (e) => {
  const id = e.target.id;
  if (!id) return;
  e.preventDefault();
  if (id === "syncOn") {
    const r = await syncAction({ type: "SYNC_SET", enabled: true }, "正在开启云端同步…");
    if (r && r.ok) $("syncBar").insertAdjacentHTML("beforeend", `<div class="sub-hint">已开启，云端现在有 ${r.count} 个订阅。</div>`);
  } else if (id === "syncRun") {
    await syncAction({ type: "SYNC_NOW" }, "正在同步…");
  } else if (id === "syncOff") {
    const choice = await askDialog("关闭云端同步？", "本机的订阅会保留。云端保存的数据可以留着（以后再开同步能接上），也可以一起删掉（其它设备上的本机数据不受影响）。",
      [{ label: "取消", value: null }, { label: "关闭并删除云端数据", value: "del", kind: "danger" }, { label: "只关闭同步", value: "keep", kind: "primary" }]);
    if (!choice) return;
    const del = choice === "del";
    await syncAction({ type: "SYNC_SET", enabled: false, deleteCloud: del }, "正在关闭…");
  }
});

// ---------- 浏览历史 ----------
function renderHistBar() {
  const el = $("histBar");
  if (el.dataset.busy) return;
  if (state.historyPermission) {
    const at = state.history && state.history.scannedAt;
    el.innerHTML = `<span>✓ 已结合最近 90 天浏览历史${at ? "（" + fmtDate(at) + "更新）" : ""}</span>
      <a href="#" id="histRescan">重新读取</a><a href="#" id="histOff">停用</a>`;
  } else {
    el.innerHTML = `<div style="flex:1;min-width:0"><b>想找到装插件之前就在用的？</b><div class="sub-hint">读取最近 90 天浏览历史。只按网站域名统计访问时间，不保存网址和标题。</div></div>
      <button id="histOn" class="ad-btn sm">读取浏览历史</button>`;
  }
}
async function histScan(msgBusy) {
  const el = $("histBar");
  el.dataset.busy = "1";
  el.innerHTML = `<span>${msgBusy}</span>`;
  const r = await send({ type: "HISTORY_SCAN" });
  delete el.dataset.busy;
  await refresh();
  if (r && r.ok) $("histBar").insertAdjacentHTML("beforeend", `<div class="sub-hint">读完了：${r.domains} 个订阅网站在最近 90 天有访问记录，更新了 ${r.updated} 个订阅。</div>`);
}
$("histBar").addEventListener("click", async (e) => {
  const id = e.target.id;
  if (!id) return;
  e.preventDefault();
  if (id === "histOn") {
    const ok = await requestPermission("history", "history", "history");
    if (!ok) { $("histBar").insertAdjacentHTML("beforeend", `<div class="sub-hint bad">没有获得读取浏览历史的权限。</div>`); return; }
    await histScan("正在读取浏览历史…");
  } else if (id === "histRescan") {
    await histScan("正在重新读取浏览历史…");
  } else if (id === "histOff") {
    await send({ type: "HISTORY_OFF" });
    try { await chrome.permissions.remove({ permissions: ["history"] }); } catch (err) {}
    await refresh();
  }
});

// ---------- 授权框把弹窗关掉之后：显示后台接着做完的结果 ----------
let grantShownAt = 0;
function showGrantResult() {
  const g = state.grantResult;
  if (!g || Date.now() - g.at > 10 * 60000 || g.at === grantShownAt && !g.running) return;
  if (g.action === "google") {
    // Google 登录在后台跑（授权窗口会把弹窗关掉），这里显示结果
    if (g.running) { if (!$("view-auth").hidden) setAuthLoading(true, true); return; }
    grantShownAt = g.at;
    setAuthLoading(false, true);
    const r = g.res;
    if (r && r.ok) { if (!$("view-auth").hidden) show(authBack === "auth" ? "subs" : authBack); }
    else if (r && !r.cancelled) { if ($("view-auth").hidden) openAuth("in"); setAuthErr(r.error || AuthLib.ERR.UNKNOWN); }
    send({ type: "CLEAR_RESULT" });
    return;
  }
  if (g.running) {
    const name = g.action === "llm" ? LLM_NAMES[g.id] : ((SubCatalog.BY_ID[g.id] || {}).name || (state.subs.find(x => x.id === g.id) || {}).name || "");
    const el = $("catStatus");
    if (g.action === "history") { $("histBar").innerHTML = "<span>已授权，正在读取浏览历史…</span>"; $("histBar").dataset.busy = "1"; return; }
    if (g.action === "diag" || g.action === "recheck") {
      const s0 = state.subs.find(x => x.id === g.id || x.catalogId === g.id);
      if (s0 && g.action === "diag") { cdiagOut[s0.id] = "已授权，正在读取账户页…"; renderSubs(); }
      return;
    }
    el.className = "secstatus";
    el.textContent = `已授权，正在读取 ${name}…`;
    if (g.action === "catalog" || g.action === "llm") busyToast(`正在添加 ${name}，后台读取中（通常 5~15 秒）…`, "busy");
    return;
  }
  grantShownAt = g.at;
  delete $("histBar").dataset.busy;
  renderHistBar();
  const r = g.res;
  if (g.action === "llm") showLlmResult(g.id, r);
  else if (g.action === "catalog" && SubCatalog.BY_ID[g.id]) showCatalogResult(SubCatalog.BY_ID[g.id], r);
  else if (g.action === "history") {
    if (r && r.ok) $("histBar").insertAdjacentHTML("beforeend", `<div class="sub-hint">读完了：${r.domains} 个订阅网站在最近 90 天有访问记录，更新了 ${r.updated} 个订阅。</div>`);
  }
  else if (g.action === "diag") {
    const s0 = state.subs.find(x => x.catalogId === g.id);
    if (s0) { cdiagOut[s0.id] = diagText(r); renderSubs(); }
  }
  send({ type: "CLEAR_RESULT" });
}

// ---------- 常见服务目录 ----------
let catCat = "all";
function trackedCatalogIds() {
  const ids = state.subs.map(s => s.catalogId).filter(Boolean);
  state.subs.forEach(s => { if (s.provider === "claude" || s.provider === "chatgpt") ids.push(s.provider); });
  return ids;
}
// 服务图标：按类型用线条图标 + 柔和底色（不用各家 logo）
const TILE_ICON = {
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M2 14h2M20 14h2"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  pen: '<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.59 7.59"/><circle cx="11" cy="11" r="2"/>',
  notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4M3 7h2M3 12h2M3 17h2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M12 3a14 14 0 0 0 0 18 14 14 0 0 0 0-18M3 12h18"/>'
};
const TILE_COLOR = { bot: ["#e6f4ec", "#15803d"], play: ["#fdecec", "#dc2626"], music: ["#fce8f1", "#be185d"], cloud: ["#e8effd", "#2563eb"],
                     pen: ["#efe9fd", "#7c3aed"], notebook: ["#eef0f3", "#475569"], globe: ["#e3f4f3", "#0f766e"] };
function tileKind(key) {
  const p = SubCatalog.BY_ID[key];
  if (key === "claude" || key === "chatgpt") return "bot";
  if (/^(spotify|qqmusic|netease-music)$/.test(key)) return "music";
  if (/^(baidu-pan|icloud|dropbox|google-one)$/.test(key)) return "cloud";
  if (/^(figma|canva|adobe|midjourney)$/.test(key)) return "pen";
  if (/^(notion|m365)$/.test(key)) return "notebook";
  if (p && p.cat === "ai") return "bot";
  if (p && (p.cat === "video" || p.cat === "cn")) return "play";
  if (key === "youtube" || key === "netflix" || key === "primevideo" || key === "bilibili") return "play";
  return "globe";
}
function avatarHtml(key) {
  const k = tileKind(String(key || "")), c = TILE_COLOR[k];
  return `<span class="sv-tile" style="--tb:${c[0]};--tf:${c[1]}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TILE_ICON[k]}</svg></span>`;
}
const CAT_CAPTION = (p) => p.special === "llm" ? "套餐 · 对话频次 · 额度" : p.storage ? "套餐 · 续费日 · 空间" : p.activity ? "套餐 · 续费日 · 观看记录" : "套餐 · 价格 · 续费日";
const ICON_OK = '<svg class="ok" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_PLUS = '<svg class="plus" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
function renderCatalog() {
  const tracked = trackedCatalogIds();
  $("knownCount").textContent = `${SubCatalog.PROVIDERS.length} 个服务`;
  $("catCats").innerHTML = [{ key: "all", name: "全部" }].concat(SubCatalog.CATEGORIES)
    .map(c => `<span data-ccat="${esc(c.key)}" class="${c.key === catCat ? "on" : ""}">${esc(c.name)}</span>`).join("");
  const q = $("catSearch").value.trim().toLowerCase();
  const list = SubCatalog.PROVIDERS.filter(p => (catCat === "all" || p.cat === catCat) &&
    (!q || p.name.toLowerCase().indexOf(q) >= 0 || p.id.indexOf(q) >= 0 || (p.domains || []).some(d => d.indexOf(q) >= 0) ||
      ((SubCatalog.CATEGORIES.find(c => c.key === p.cat) || {}).name || "").indexOf(q) >= 0));
  $("catGrid").innerHTML = list.length
    ? list.map(p => tracked.indexOf(p.id) >= 0
        ? `<div class="ad-card added" title="已添加">${avatarHtml(p.id, p.name)}<span><span class="nm">${esc(p.name)}</span><span class="cp">已添加</span></span>${ICON_OK}</div>`
        : adding.has(p.id)
        ? `<button type="button" class="ad-card busy" disabled aria-busy="true">${avatarHtml(p.id, p.name)}<span><span class="nm">${esc(p.name)}</span><span class="cp">正在读取…</span></span>${SPIN}</button>`
        : `<button type="button" class="ad-card" data-cat="${esc(p.id)}" title="${esc(p.note || p.name)}">${avatarHtml(p.id, p.name)}<span><span class="nm">${esc(p.name)}</span><span class="cp">${esc(CAT_CAPTION(p))}</span></span>${ICON_PLUS}</button>`).join("")
    : `<div class="ad-empty">没收录「${esc($("catSearch").value.trim())}」。<br><a href="#" data-goto="manual">手动添加这个网址</a>，统计访问次数和最近访问时间。</div>`;
  renderDiscover();
}
// 「浏览发现」：访问记录 + 浏览历史里出现过、我们收录了、但还没添加的服务
function renderDiscover() {
  const tracked = trackedCatalogIds();
  const hist = (state.history && state.history.hits) || [];
  const days = hist.length ? 90 : 30;
  const recs = (state.records || []).concat(hist);
  const ids = SubCatalog.discover(recs, tracked, Date.now(), days).slice(0, 8);
  const daysOf = (p) => {
    const doms = [p.activityDomain].concat(p.domains).filter(Boolean);
    const set = new Set();
    for (const r of recs) {
      if (!r || !r.hostname || Date.now() - r.time > days * 86400000) continue;
      const h = String(r.hostname).toLowerCase().replace(/^www\./, "");
      if (doms.some(d => h === d || h.endsWith("." + d))) set.add(new Date(r.time).toDateString());
    }
    return set.size;
  };
  const rows = ids.map(id => ({ p: SubCatalog.BY_ID[id], n: daysOf(SubCatalog.BY_ID[id]) }));
  const max = Math.max(1, ...rows.map(r => r.n));
  $("discList").innerHTML = rows.length
    ? rows.map(({ p, n }) => `<div class="ad-row">${avatarHtml(p.id, p.name)}
        <div class="meta"><div class="nm">${esc(p.name)}</div><div class="cp">近 ${days} 天有 ${n} 天访问过 · ${esc(CAT_CAPTION(p))}</div>
          <span class="ad-bar"><i style="width:${Math.round(n / max * 100)}%"></i></span></div>
        ${adding.has(p.id) ? `<button type="button" class="ad-btn sm busy" disabled>${SPIN}读取中</button>` : `<button type="button" class="ad-btn sm" data-cat="${esc(p.id)}">添加</button>`}</div>`).join("")
    : `<div class="ad-empty">${recs.length ? `近 ${days} 天没有访问过、还没添加的收录服务。` : "还没有访问记录。插件装好后会记下你访问过哪些订阅网站。"}</div>`;
  const b = $("badgeHistory");
  b.hidden = !rows.length; b.textContent = rows.length;
}
$("catSearch").addEventListener("input", renderCatalog);
$("catCats").addEventListener("click", (e) => {
  const c = e.target.dataset && e.target.dataset.ccat;
  if (c) { catCat = c; renderCatalog(); }
});
const CAT_ERR = {
  no_permission: (n) => `没有获得读取 ${n} 的授权。`,
  unknown: () => `不认识这个服务。`
};
// ---------- 添加时的加载提示 ----------
// 添加收录服务要在后台打开网站读取，常常要 5~15 秒：卡片上转圈，底部再给一条提示，免得以为没反应
const adding = new Set();
const SPIN = '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
let toastTimer = null;
function busyToast(text, kind) {
  let el = $("busyToast");
  if (!el) { el = document.createElement("div"); el.id = "busyToast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = kind || "busy";
  el.innerHTML = (kind === "busy" || !kind ? SPIN : kind === "ok" ? ICON_OK : "") + `<span>${esc(text)}</span>`;
  if (kind === "ok" || kind === "bad") toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}
async function withAdding(id, text, fn) {
  adding.add(id);
  renderCatalog();
  busyToast(text, "busy");
  try { return await fn(); }
  finally { adding.delete(id); renderCatalog(); }
}

async function addFromCatalog(id) {
  const p = SubCatalog.BY_ID[id];
  if (!p) return;
  // 大模型走专门的读取（对话频次 + 额度）
  if (p.special === "llm") return addLlm(p.id);
  const stEl = $("catStatus");
  if (atLimit()) { stEl.className = "secstatus bad"; stEl.innerHTML = limitText(); return; }
  const granted = await requestOrigins(SubCatalog.originsOf(p), "catalog", id);
  if (!granted) { stEl.className = "secstatus bad"; stEl.textContent = CAT_ERR.no_permission(p.name); return; }
  if (adding.has(id)) return;
  stEl.className = "secstatus";
  stEl.textContent = `正在读取 ${p.name} 的账户页…（会在后台短暂打开，通常 5~15 秒）`;
  const r = await withAdding(id, `正在添加 ${p.name}，后台读取中（通常 5~15 秒）…`, () => send({ type: "CATALOG_ADD", id }));
  await refresh();
  showCatalogResult(p, r);
}
function showCatalogResult(p, r) {
  const stEl = $("catStatus");
  if (r && r.reason === "limit") { stEl.className = "secstatus bad"; stEl.innerHTML = limitText(); busyToast(""); return; }
  if (!r || !r.ok) { stEl.className = "secstatus bad"; stEl.textContent = (CAT_ERR[r && r.reason] || CAT_ERR.unknown)(p.name); busyToast(`${p.name} 没添加成功`, "bad"); return; }
  const a = (r.sub && r.sub.account) || {};
  const MSG = {
    ok: () => `已添加 ${p.name}：${a.plan.label}${a.price ? `，${a.price.currency}${a.price.monthly}/月` : ""}${a.renewAt ? `，${new Date(a.renewAt).toLocaleDateString("zh-CN")} 续费` : ""}。`,
    logged_out: () => `已添加 ${p.name}，但本浏览器没登录，读不到套餐。登录后在列表里点「检查」。`,
    unknown: () => `已添加 ${p.name}，但没认出套餐。可以先在本浏览器打开 ${p.name} 确认已登录，再在列表里点「检查」。`,
    read_failed: () => `已添加 ${p.name}，但账户页没读到内容。先在本浏览器打开确认能正常访问，再点「检查」。`
  };
  stEl.className = a.status === "ok" ? "secstatus" : "secstatus bad";
  stEl.textContent = (MSG[a.status] || MSG.unknown)();
  busyToast(a.status === "ok" ? `已添加 ${p.name}` : `已添加 ${p.name}，套餐没读到`, a.status === "ok" ? "ok" : "bad");
  if (p.activity) stEl.textContent += " 另外会读取它的观看/播放记录来判断是否在用。";
}
// 卡片里点到的可能是头像 / 文字，往上找带 data-cat 的元素
function catClick(e) {
  const el = e.target.closest && e.target.closest("[data-cat]");
  if (el) { e.preventDefault(); addFromCatalog(el.dataset.cat); return; }
  const go = e.target.closest && e.target.closest("[data-goto]");
  if (go) { e.preventDefault(); showPane(go.dataset.goto); $("f-url").value = $("catSearch").value.trim(); syncCatalogHint(); $("f-url").focus(); }
}
$("catGrid").addEventListener("click", catClick);
$("discList").addEventListener("click", catClick);

// ---------- 添加页的分段导航 ----------
let addPane = "manual";
try { addPane = localStorage.getItem("addPane") || "manual"; } catch (e) {}
if (addPane === "known") addPane = "manual";
function showPane(name) {
  if (name === "known") name = "manual";   // 「手动添加」页 = 常见服务 + 手动填网址
  addPane = name;
  try { localStorage.setItem("addPane", name); } catch (e) {}
  document.querySelectorAll("#view-add .ad-pane").forEach(p => {
    p.hidden = !(p.dataset.pane === name || (name === "manual" && p.dataset.pane === "known"));
  });
  $("catStatus").textContent = ""; $("catStatus").className = "secstatus";
  if (name === "manual") renderCatalog();
  if (!$("view-add").hidden) syncTabs("add");
}

function renderLog() {
  $("pause").textContent = state.paused ? "已暂停 ▶" : "暂停记录";
  const rec = state.records.slice().reverse().slice(0, 300);
  $("logList").innerHTML = rec.length
    ? rec.map(r => `<div class="item">
        <div class="u">${esc(r.url)}</div>
        <div class="t">${esc(r.hostname)} · ${new Date(r.time).toLocaleString("zh-CN")}</div>
      </div>`).join("")
    : '<div class="empty">还没有访问记录</div>';
}

async function refresh() {
  const r = await send({ type: "GET_STATE" });
  if (r && r.ok) {
    state = r;
    renderSubs();
    renderCatalog();
    renderHistBar();
    renderAccount();
    if (!$("view-add").hidden) renderAddLimit();
    renderSyncBar();
    renderLog();
    showGrantResult();
    renderMail();
  }
}

// ---------- 视图切换 ----------
function show(view) {
  ["subs", "add", "log", "auth"].forEach(v => { $("view-" + v).hidden = (v !== view); });
  syncTabs(view);
}
// 顶部四个标签：我的订阅 / 邮箱发现 / 历史发现 / 手动添加（后三个都是「添加订阅」页的不同分页）
function syncTabs(view) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on",
    view === "add" ? (t.dataset.view === "add" && t.dataset.pane === addPane && !(editingSub)) : t.dataset.view === view));
}
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    if (t.dataset.view === "add") { resetForm(); show("add"); showPane(t.dataset.pane); }
    else show(t.dataset.view);
  });
});
// 「访问记录」页不再给用户看（只是插件内部统计访问用的），入口按钮已去掉

// ---------- 表单：手动添加网址 / 编辑订阅 ----------
let editingSub = null;
// 网址是不是我们收录的服务：是的话建议用「常见服务」添加，能读到套餐
function catalogFor(domain) {
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (!d) return null;
  return SubCatalog.PROVIDERS.find(p => [p.activityDomain].concat(p.domains).filter(Boolean).some(x => d === x || d.endsWith("." + x))) || null;
}
function syncCatalogHint() {
  const p = editingSub ? null : catalogFor(normalizeDomain($("f-url").value));
  $("catalogHint").hidden = !p;
  if (p) $("catalogHint").innerHTML = `<span>这是我们收录的「${esc(p.name)}」。</span><a href="#" data-cat="${esc(p.id)}">改用常见服务添加 →</a>能读到套餐、续费日${p.activity ? "和观看记录" : ""}；也可以继续手动添加（只统计访问）。`;
}
$("f-url").addEventListener("input", syncCatalogHint);
$("f-url").addEventListener("blur", () => {
  syncCatalogHint();
  // 没填名称时用域名主体当名称
  if (!$("f-name").value.trim()) {
    const d = normalizeDomain($("f-url").value);
    const parts = d ? d.split(".") : [];
    if (parts.length >= 2) $("f-name").value = parts[parts.length - 2].replace(/^./, c => c.toUpperCase());
  }
});
$("catalogHint").addEventListener("click", (e) => {
  const id = e.target.dataset && e.target.dataset.cat;
  if (!id) return;
  e.preventDefault();
  showPane("known");
  addFromCatalog(id);
});

// 编辑活动记录型订阅时保留「诊断」
function currentProvider() {
  return editingSub && editingSub.mode === "activity" ? (state.providers || []).find(p => p.key === editingSub.provider) || null : null;
}
$("diagBtn").addEventListener("click", async () => {
  const p = currentProvider();
  if (!p) return;
  $("diagBtn").disabled = true;
  $("diagOut").innerHTML = '<div class="diag">正在读取…（会在后台短暂打开该页面）</div>';
  const r = await send({ type: "DIAGNOSE", sub: { provider: p.key, activityUrl: editingSub.activityUrl || undefined,
    idPattern: editingSub.idPattern || undefined, containerSelector: editingSub.containerSelector || undefined } });
  $("diagBtn").disabled = false;
  if (!r || !r.ok) { $("diagOut").innerHTML = '<div class="diag bad">诊断失败。</div>'; return; }
  if (r.llm) { $("diagOut").innerHTML = llmDiagHtml(p, r.result); return; }
  const d = r.result;
  if (!d) { $("diagOut").innerHTML = `<div class="diag bad">打不开或读不到页面：<code>${esc(r.url)}</code></div>`; return; }
  if (d.loggedOut === true) { $("diagOut").innerHTML = `<div class="diag bad">检测到<b>未登录</b>。请先在本浏览器登录该服务，再诊断一次。</div>`; return; }
  if (!d.count) {
    $("diagOut").innerHTML = `<div class="diag bad">没抓到任何条目${d.historyOff ? "（该服务的历史记录似乎已关闭）" : ""}。<br>落地页：<code>${esc(d.pageUrl || r.url)}</code></div>`;
    return;
  }
  $("diagOut").innerHTML = `<div class="diag good">✓ 读到 <b>${d.count}</b> 个条目，可以用。
    ${d.topLabel ? `<br>最近分组：<b>${esc(d.topLabel)}</b>` : ""}<br>样例 ID：<code>${esc(d.sample.join(", "))}</code></div>`;
});

function llmDiagHtml(p, d) {
  const shapes = `<details class="shapes"><summary>接口返回的字段结构（只有字段名和类型，不含内容；发给开发者用）</summary>
    <pre>${esc(JSON.stringify(d.shapes, null, 1))}</pre></details>`;
  if (d.error === "no_permission") return `<div class="diag bad">还没授权读取 ${esc(p.name)}。请在「常见服务」里点 ${esc(p.name)} 完成授权。</div>`;
  if (d.loggedOut === true) return `<div class="diag bad">检测到<b>未登录</b>。请先在本浏览器登录 ${esc(p.name)}，再诊断一次。${shapes}</div>`;
  if (!d.ok) return `<div class="diag bad">读不到账户信息。${shapes}</div>`;
  const st = d.stats || {}, u = d.usage || {};
  return `<div class="diag good">✓ 已登录，套餐：<b>${esc(d.plan ? d.plan.label : "未知")}</b>${d.origin ? `（付费渠道：${esc(d.origin)}）` : ""}
    <br>对话列表读到 ${d.convCount} 条，最近一次 ${esc(fmtDate(st.lastUsed))}，近 30 天活跃 ${st.activeDays30 || 0} 天
    ${u.fiveHour != null || u.week != null ? `<br>额度：5 小时 ${u.fiveHour ?? "—"}% · 本周 ${u.week ?? "—"}%` : ""}
    ${d.renewAt ? `<br>下次续费：${esc(new Date(d.renewAt).toLocaleDateString("zh-CN"))}` : ""}
    ${shapes}</div>`;
}

// sub 为空 = 新增（手动添加网址，可带邮箱扫描的预填 prefill）；有值 = 编辑已有订阅（只显示表单）
function resetForm(sub, prefill) {
  editingSub = sub || null;
  const s = sub || prefill || null;
  $("view-add").classList.toggle("editing", !!sub);
  $("formTitle").hidden = !sub;
  $("formTitle").textContent = sub ? `编辑「${sub.name}」` : "";
  $("formSubmit").textContent = sub ? "保存" : "添加订阅";
  if (sub) document.querySelectorAll("#view-add .ad-pane").forEach(p => { p.hidden = p.dataset.pane !== "manual"; });
  else if (!prefill) showPane(addPane);
  $("cancel").hidden = !sub && !prefill;
  $("prefillNote").hidden = true;
  $("formErr").hidden = true;
  $("f-id").value = (sub && sub.id) || "";
  // 币种：订阅原来的 > 收录服务的默认币种 > 按浏览器语言（中文默认人民币）
  const cp0 = s && s.catalogId && SubCatalog.BY_ID[s.catalogId];
  setCurrency((s && s.currency) || (cp0 && cp0.currency) || (/^zh/i.test(navigator.language || "") ? "¥" : "$"));
  $("f-name").value = s ? s.name || "" : "";
  $("f-url").value = s ? s.urlPattern || "" : "";
  // 收录的服务（常见服务 / 大模型）：网址固定，不让改——套餐和使用情况从官方页面读取，访问次数也按官方域名统计
  const known = knownOf(sub);
  $("f-url").readOnly = !!known;
  $("urlLock").hidden = !known;
  if (known) {
    $("f-url").value = known.domains.join("、");
    $("urlLock").textContent = `「${known.name}」是收录的服务，网址固定，不能改。套餐和使用情况从官方页面读取，访问次数按这些域名统计。`;
  }
  $("f-price").value = s && s.price ? s.price : "";
  $("f-days").value = s && s.idleDays ? s.idleDays : 30;
  $("diagWrap").hidden = true;   // 诊断不再给用户看（开发排查用 Alt+检查）
  $("diagOut").innerHTML = "";
  syncCatalogHint();
  renderAddLimit();
}
function knownOf(sub) {
  if (!sub) return null;
  const cp = sub.catalogId && SubCatalog.BY_ID[sub.catalogId];
  if (cp) return { name: cp.name, domains: [cp.activityDomain].concat(cp.domains).filter((d, i, a) => d && a.indexOf(d) === i) };
  if (sub.provider) {
    const p = SubCatalog.BY_ID[sub.provider];
    return { name: (p && p.name) || sub.name, domains: (p && p.domains) || [sub.urlPattern].filter(Boolean) };
  }
  return null;
}
// 设置月费币种；读到的币种不在列表里就临时加一项
function setCurrency(c) {
  const sel = $("f-currency");
  if (![...sel.options].some(o => o.value === c)) { const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o); }
  sel.value = c;
}
function renderAddLimit() {
  const full = !editingSub && atLimit();
  $("addLimit").hidden = !full;
  if (full) $("addLimit").innerHTML = limitText();
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const old = editingSub;
  // 判断方式：保留原来的方式（收录服务是活动记录 / 账户页），新增的未收录网址看浏览器访问；
  // 以前设成「电视 / 手机，不参与判断」的，保存时恢复成正常判断（这个选项已去掉）
  const mode = old ? (old.mode === "none" ? (old.provider ? "activity" : "browser") : old.mode) : "browser";
  const sub = {
    id: (old && old.id) || String(Date.now()),
    name: $("f-name").value.trim(),
    urlPattern: knownOf(old) ? old.urlPattern : normalizeDomain($("f-url").value),
    price: parseFloat($("f-price").value) || 0,
    currency: $("f-currency").value || "$",
    idleDays: parseInt($("f-days").value, 10) || 30,
    priceEstimated: false,
    mode
  };
  if (!sub.name) return;
  if (!sub.urlPattern && !(old && (old.provider || old.catalogId))) {
    $("formErr").textContent = "请填网址，插件靠它统计访问次数和最近访问时间。"; $("formErr").hidden = false; return;
  }
  // 手动改过月费：以后不再用账户页读到的价格覆盖
  if (old && old.priceSource === "page" && sub.price !== old.price) sub.priceSource = "user";
  const btn = $("formSubmit"), label = btn.textContent;
  btn.disabled = true; btn.innerHTML = SPIN + (old ? "保存中…" : "添加中…");
  let r;
  try { r = await send({ type: "SAVE_SUB", sub }); } finally { btn.disabled = false; btn.textContent = label; }
  if (r && r.reason === "limit") { $("formErr").innerHTML = limitText(); $("formErr").hidden = false; return; }
  busyToast(old ? `已保存「${sub.name}」` : `已添加「${sub.name}」`, "ok");
  await refresh();
  resetForm();
  show("subs");
});

$("cancel").addEventListener("click", () => { const back = editingSub; resetForm(); show(back ? "subs" : "add"); });

// ---------- 列表操作 ----------
// 正在检查的订阅（用来把对应的「检查」按钮置灰）
const checking = new Set();

async function checkSubs(ids) {
  ids.forEach(id => checking.add(id));
  renderSubs();
  try { await send({ type: "RUN_CHECK", ids }); }
  finally { ids.forEach(id => checking.delete(id)); }
  await refresh();
}

$("subList").addEventListener("click", async (e) => {
  const el = (e.target.closest && e.target.closest("button,a")) || e.target;
  const ds = el.dataset || {};
  if (ds.goadd) { resetForm(); show("add"); showPane("manual"); return; }
  if (!el.closest || !el.closest("button,a")) {
    const row = e.target.closest && e.target.closest("[data-toggle]");
    if (row) { const id = row.dataset.toggle; openRows.has(id) ? openRows.delete(id) : openRows.add(id); renderSubs(); }
    return;
  }
  const edit = ds.edit, del = ds.del, fix = ds.fix;
  let chk = ds.chk, cdiagAlt = null;
  // 开发排查：按住 Alt 点「检查」= 诊断（显示读取明细），只对收录服务有效
  if (chk && e.altKey) {
    const sa = state.subs.find(x => x.id === chk), pa = sa && SubCatalog.BY_ID[sa.catalogId];
    if (pa && !pa.special) { cdiagAlt = chk; chk = null; }
  }
  if (chk) {
    // 单独检查这一个订阅
    await checkSubs([chk]);
    return;
  }
  const cperm = ds.cperm, copen = ds.copen, cdiag = ds.cdiag || cdiagAlt;
  if (cperm || copen || cdiag) {
    const s0 = state.subs.find(x => x.id === (cperm || copen || cdiag));
    const p = s0 && SubCatalog.BY_ID[s0.catalogId];
    if (!p) return;
    if (copen) { send({ type: "OPEN_TAB", url: p.accountUrl }); return; }
    if (cperm) {
      const ok = await requestOrigins(SubCatalog.originsOf(p), "recheck", s0.id);
      if (ok) await checkSubs([s0.id]);
      return;
    }
    // 诊断结果已经展开：再点一下收起
    if (cdiagOut[s0.id] && !cdiagBusy.has(s0.id)) { delete cdiagOut[s0.id]; renderSubs(); return; }
    if (cdiagBusy.has(s0.id)) return;
    // 诊断：读一次账户页，显示解析结果和页面开头的文字（读成功会顺便更新订阅）
    const ok = await requestOrigins(SubCatalog.originsOf(p), "diag", p.id);
    if (!ok) { cdiagOut[s0.id] = "没有获得授权。"; renderSubs(); return; }
    cdiagBusy.add(s0.id);
    cdiagOut[s0.id] = "正在读取账户页…";
    renderSubs();
    let d = null;
    try { d = await send({ type: "CATALOG_DIAGNOSE", id: p.id }); } finally { cdiagBusy.delete(s0.id); }
    cdiagOut[s0.id] = diagText(d);
    renderSubs();
    return;
  }
  if (fix) {
    const s0 = state.subs.find(x => x.id === fix);
    if (s0 && LLM_ORIGINS[s0.provider] && s0.signal && s0.signal.reason === "no_permission") {
      const ok = await requestOrigins([LLM_ORIGINS[s0.provider]], "recheck", s0.id);
      if (ok) { await checkSubs([s0.id]); }
      return;
    }
    // 打开该服务的活动页：登录后下一次检查就会自动恢复
    const s = state.subs.find(x => x.id === fix);
    const p = s && state.providers.find(x => x.key === s.provider);
    const url = p ? p.url : (s && s.urlPattern ? "https://" + normalizeDomain(s.urlPattern) : null);
    if (url) send({ type: "OPEN_TAB", url });
  } else if (edit) {
    const s = state.subs.find(x => x.id === edit);
    if (s) { resetForm(s); show("add"); }
  } else if (del) {
    const s = state.subs.find(x => x.id === del);
    if (s && await askConfirm(`删除「${s.name}」？`, "访问记录和读取到的套餐信息会一起删除。", "删除", true)) {
      await send({ type: "DELETE_SUB", id: del });
      await refresh();
    }
  }
});

$("check").addEventListener("click", async () => {
  $("check").disabled = true;
  $("check").classList.add("spinning");
  $("checkStatus").dataset.busy = "1";
  const ids = state.subs.map(s => s.id);
  const n = state.subs.filter(s => s.mode === "activity" && s.provider).length;
  $("checkStatus").textContent = n ? `同时检查 ${n} 个订阅…` : "检查中…";
  const t0 = Date.now();
  ids.forEach(id => checking.add(id));
  renderSubs();
  try { await send({ type: "RUN_CHECK" }); }
  finally { ids.forEach(id => checking.delete(id)); }
  await refresh();
  $("check").disabled = false;
  $("check").classList.remove("spinning");
  $("checkStatus").textContent = `检查完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
  setTimeout(() => { delete $("checkStatus").dataset.busy; renderSubs(); }, 2500);
});

$("pause").addEventListener("click", async () => {
  await send({ type: "TOGGLE_PAUSE" });
  await refresh();
});

$("clearLog").addEventListener("click", async () => {
  if (await askConfirm("清空所有访问记录？", "", "清空", true)) {
    await send({ type: "CLEAR_RECORDS" });
    await refresh();
  }
});

resetForm();
refresh().then(() => { if (GRANT_WINDOW) runGrantWindow(); });

// ---------- 邮箱发现 ----------
const GMAIL_ORIGIN = "https://mail.google.com/*";
const CONF_LABEL = { high: "高可信", medium: "中可信", low: "低可信" };
const MAIL_ERR = {
  logged_out: "这个浏览器没有登录 Gmail，或账号序号不对。请先在本浏览器登录 Gmail 再扫描。",
  read_failed: "打开了 Gmail，但没读到邮件列表。可能是网络慢，或 Gmail 页面结构变了。可以勾选「扫描时显示 Gmail 标签页」再扫一次，看看页面上显示的是什么。",
  no_permission: "没有获得读取 mail.google.com 的权限，无法扫描。",
  busy: "已经在扫描中了。",
  network: "连不上 Gmail 接口，请检查网络后重试。",
};
let mailOptsLoaded = false;

function fmtDay(ts) {
  return ts ? new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—";
}
function fmtMoney(a) { return a ? `${a.currency}${a.value}` : ""; }

// 候选是否已经在订阅列表里（按域名或名称）
function isTracked(c) {
  const name = String(c.name || "").trim().toLowerCase();
  return state.subs.some(s =>
    (c.domain && s.urlPattern && hostMatches(c.domain, s.urlPattern)) ||
    (name && String(s.name || "").trim().toLowerCase() === name));
}

function statsHtml(st) {
  if (!st) return "";
  return `<br><span style="opacity:.8">读取情况：页面上找到 ${st.rowEls} 行邮件，
    其中 ${st.withSender} 行读到发件人、${st.withSubject} 行读到主题、${st.withDate} 行读到日期。</span>`;
}

function renderMail() {
  const ms = state.mailScan;
  const ignored = new Set(state.mailIgnored || []);
  if (!mailOptsLoaded) {
    if (ms && ms.account != null) $("m-acct").value = ms.account;
    if (ms && ms.pages) $("m-pages").value = String(ms.pages);
    mailOptsLoaded = true;
  }

  // 扫描超过 10 分钟还是 running，说明后台被中断了（比如浏览器关了）
  const running = !!(ms && ms.status === "running" && Date.now() - (ms.startedAt || 0) < 10 * 60000);
  $("m-scan").disabled = running;
  let runTxt = "";
  if (running) {
    runTxt = `扫描中… 第 ${ms.progress || 0}/${ms.pages} 页，已读 ${ms.rowsRead || 0} 封（可以关掉弹窗）`;
  }
  $("m-status").textContent = runTxt;

  let summary = "";
  if (ms && ms.status === "running" && !running) {
    summary = '<div class="diag bad">上次扫描中途中断了，请重新扫描。</div>';
  } else if (ms && ms.status === "error") {
    summary = `<div class="diag bad">${esc(MAIL_ERR[ms.error] || MAIL_ERR.read_failed)}${statsHtml(ms.stats)}
      ${(ms.candidates || []).length ? "<br>下面是上一次扫描成功的结果。" : ""}</div>`;
  } else if (ms && ms.status === "done") {
    const n = (ms.candidates || []).length;
    summary = `<div class="diag ${n ? "good" : ""}">
      ${ms.email ? T("账号 {e}：", { e: "<b>" + esc(ms.email) + "</b>" }) : ""}${T("读了 {p} 页、{r} 封搜索结果，其中 {b} 封像收据或续费通知，归并出 {n} 个候选订阅。", { p: ms.pagesRead || 0, r: ms.rowsRead, b: ms.billingRows, n: "<b>" + n + "</b>" })}
      ${ms.warn === "timeout" ? "<br>⚠ 有页面加载超时，结果可能不全。" : ""}
      ${ms.warn === "limit" ? "<br>⚠ 达到了读取上限，更早的邮件没读到。可以调大「最多读取」再扫。" : ""}
      ${ms.failedReads ? `<br>⚠ 有 ${ms.failedReads} 封读取失败，已跳过。` : ""}
      ${!ms.rowsRead ? "<br>没有搜到收据类邮件。如果你确定有，检查一下账号序号对不对。" : ""}
      <br><span style="opacity:.8">扫描于 ${esc(fmtDate(ms.finishedAt))} · 结果只存在本机</span></div>`;
  }
  $("m-summary").innerHTML = summary;

  const cands = (ms && ms.candidates) || [];
  const shown = cands.filter(c => !ignored.has(c.key));
  const hiddenN = cands.length - shown.length;

  $("m-list").innerHTML = shown.map(c => {
    const tracked = isTracked(c);
    const tags = [];
    if (tracked) tags.push('<span class="tagv">已在订阅中</span>');
    if (c.status === "cancelled") tags.push('<span class="tagx">可能已取消</span>');
    if (c.status === "stale") tags.push('<span class="tagu">近期没见到扣费</span>');

    let price = "";
    if (c.amount) {
      price = fmtMoney(c.amount) + (c.cadence ? " / " + c.cadence.unit : "");
      if (c.monthly && c.cadence && c.cadence.key !== "monthly") price += `（约 ${fmtMoney(c.monthly)}/月）`;
    }
    const bits = [
      c.via ? `经 ${c.viaName} 扣费` : c.domain,
      c.cadence ? c.cadence.label : (c.charges >= 2 ? "周期不规律" : c.charges === 1 ? "只见到 1 次" : ""),
      price,
      c.last ? "最近 " + fmtDay(c.last) : "",
      c.nextCharge ? "预计下次 " + fmtDay(c.nextCharge) : "",
      `${c.mails} 封`
    ].filter(Boolean);

    const storeNote = (c.via === "apple.com" || c.via === "google.com")
      ? '<div class="samples">这是应用商店的收据，可能包含多个 App 的订阅，具体是哪个要打开收据看。</div>' : "";

    return `<div class="sub">
      <div class="info">
        <div class="name">${esc(c.name)}<span class="conf ${c.confidence}">${CONF_LABEL[c.confidence]}</span>${tags.join("")}</div>
        <div class="meta">${esc(bits.join(" · "))}</div>
        ${c.samples && c.samples.length ? `<div class="samples">${c.samples.map(x => "“" + esc(x) + "”").join("<br>")}</div>` : ""}
        ${storeNote}
      </div>
      <div class="acts">
        ${tracked ? "" : `<button data-madd="${esc(c.key)}" title="${catalogFor(c.domain) ? "我们收录了这个服务，会读取套餐" : "没收录：填进「手动添加网址」，只统计访问次数"}">${catalogFor(c.domain) ? "添加" : "添加网址"}</button>`}
        <button data-mign="${esc(c.key)}">忽略</button>
      </div>
    </div>`;
  }).join("") || (ms && ms.status === "done" && !cands.length
      ? '<div class="ad-empty">没有发现候选订阅。</div>'
      : (!ms ? '<div class="ad-empty">还没扫描过。点「扫描邮箱」开始，第一次会请你授权读取 mail.google.com。</div>' : ""));
  const nNew = shown.filter(c => !isTracked(c)).length;
  $("badgeMail").hidden = !nNew; $("badgeMail").textContent = nNew;

  $("m-hidden").innerHTML = hiddenN ? `已忽略 ${hiddenN} 项 · <a href="#" id="m-unhide">全部恢复</a>` : "";
}

// 把候选填进「添加订阅」表单，让用户核对后再保存
function prefillFromCandidate(c) {
  // 收录了的服务直接走常见服务添加（能读到套餐）
  const p = catalogFor(c.domain);
  if (p) { addFromCatalog(p.id); return; }
  resetForm(null, {
    name: c.name,
    urlPattern: c.domain || "",
    price: c.monthly ? c.monthly.value : "",   // 看不出周期就不折算，留空让用户填
    currency: (c.monthly || c.amount || {}).currency || "$",
    idleDays: 30,
    mode: "browser"
  });
  let note = "来自邮箱扫描。";
  if (c.amount && c.cadence && c.cadence.key !== "monthly") {
    note += `收据金额 ${fmtMoney(c.amount)}（${c.cadence.label}），已折算成月费。`;
  } else if (c.amount && !c.cadence) {
    note += `收据里的金额是 ${fmtMoney(c.amount)}，但看不出扣费周期，月费请自己填。`;
  }
  if (!c.domain) note += `它是经 ${c.viaName} 扣费的，请自己填上这个服务的网址。`;
  if (c.status === "cancelled") note += "最近一封邮件像是取消或到期通知，确认还在付费再添加。";
  note += "请核对后保存。";
  $("prefillNote").textContent = note;
  $("prefillNote").hidden = false;
  show("add");
  showPane("manual");
}

$("m-scan").addEventListener("click", async () => {
  // 权限只在这里、由你点击时申请（必须是点击后的第一个异步调用）
  const params = { account: $("m-acct").value, pages: $("m-pages").value, showTab: $("m-show").checked };
  const granted = await requestOrigins([GMAIL_ORIGIN], "mail", "mail", params);
  if (!granted) { $("m-status").textContent = MAIL_ERR.no_permission; return; }
  const r = await send(Object.assign({ type: "MAIL_SCAN_START" }, params));
  if (!r || !r.ok) { $("m-status").textContent = MAIL_ERR[r && r.reason] || "启动扫描失败。"; return; }
  await refresh();
});

$("m-list").addEventListener("click", async (e) => {
  const add = e.target.dataset.madd, ign = e.target.dataset.mign;
  const key = add || ign;
  if (!key) return;
  const c = ((state.mailScan && state.mailScan.candidates) || []).find(x => x.key === key);
  if (!c) return;
  if (ign) {
    await send({ type: "MAIL_IGNORE", key, ignore: true });
    await refresh();
  } else {
    prefillFromCandidate(c);
  }
});

$("m-hidden").addEventListener("click", async (e) => {
  if (e.target.id !== "m-unhide") return;
  e.preventDefault();
  await send({ type: "MAIL_IGNORE", all: true, ignore: false });
  await refresh();
});

// 扫描在后台进行，进度写进 storage；弹窗开着时实时刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.mailScan || changes.mailIgnored || changes.subs || changes.grantResult || changes.sync || changes.auth)) refresh();
});
