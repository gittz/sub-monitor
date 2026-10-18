// 邮箱发现视图与交互。主界面通过 initialize 注入公开依赖。
{
let integration;
const pendingAdds = new Set();
const resolvedCandidates = new Map();
const $ = id => document.getElementById(id);
function initialize(api) {
  integration = api;
  $("m-scan").addEventListener("click", startScan);
  $("m-list").addEventListener("click", candidateClick);
  $("m-hidden").addEventListener("click", restoreIgnored);
}
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
  c = resolvedCandidates.get(c.key) || c;
  const name = String(c.name || "").trim().toLowerCase();
  return integration.getState().subs.some(s =>
    (c.domain && s.urlPattern && SubLib.hostMatches(c.domain, s.urlPattern)) ||
    (name && String(s.name || "").trim().toLowerCase() === name));
}

function statsHtml(st) {
  if (!st) return "";
  return `<br><span style="opacity:.8">读取情况：页面上找到 ${st.rowEls} 行邮件，
    其中 ${st.withSender} 行读到发件人、${st.withSubject} 行读到主题、${st.withDate} 行读到日期。</span>`;
}

function renderScanOptions(ms) {
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

}

function scanSummary(ms) {
  const running = !!(ms && ms.status === "running" && Date.now() - (ms.startedAt || 0) < 10 * 60000);
  let summary = "";
  if (ms && ms.status === "running" && !running) {
    summary = '<div class="diag bad">上次扫描中途中断了，请重新扫描。</div>';
  } else if (ms && ms.status === "error") {
    summary = `<div class="diag bad">${integration.esc(MAIL_ERR[ms.error] || MAIL_ERR.read_failed)}${statsHtml(ms.stats)}
      ${(ms.candidates || []).length ? "<br>下面是上一次扫描成功的结果。" : ""}</div>`;
  } else if (ms && ms.status === "done") {
    const n = (ms.candidates || []).length;
    summary = `<div class="diag ${n ? "good" : ""}">
      ${ms.email ? T("账号 {e}：", { e: "<b>" + integration.esc(ms.email) + "</b>" }) : ""}${T("读了 {p} 页、{r} 封搜索结果，其中 {b} 封像收据或续费通知，归并出 {n} 个候选订阅。", { p: ms.pagesRead || 0, r: ms.rowsRead, b: ms.billingRows, n: "<b>" + n + "</b>" })}
      ${ms.warn === "timeout" ? "<br>⚠ 有页面加载超时，结果可能不全。" : ""}
      ${ms.warn === "limit" ? "<br>⚠ 达到了读取上限，更早的邮件没读到。可以调大「最多读取」再扫。" : ""}
      ${ms.failedReads ? `<br>⚠ 有 ${ms.failedReads} 封读取失败，已跳过。` : ""}
      ${!ms.rowsRead ? "<br>没有搜到收据类邮件。如果你确定有，检查一下账号序号对不对。" : ""}
      <br><span style="opacity:.8">扫描于 ${integration.esc(integration.fmtDate(ms.finishedAt))} · 结果只存在本机</span></div>`;
  }
  return summary;

}

function candidateTags(c, tracked) {
    const tags = [];
    if (tracked) tags.push('<span class="tagv">已在订阅中</span>');
    if (c.status === "cancelled") tags.push('<span class="tagx">可能已取消</span>');
    if (c.status === "stale") tags.push('<span class="tagu">近期没见到扣费</span>');

    return tags;
}

function candidateMeta(c) {
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

    return bits;
}

function candidateHtml(c) {
    const tracked = isTracked(c);
    const tags = candidateTags(c, tracked);
    const bits = candidateMeta(c);
    const storeNote = (c.via === "apple.com" || c.via === "google.com")
      ? '<div class="samples">这是应用商店的收据，可能包含多个 App 的订阅，具体是哪个要打开收据看。</div>' : "";

    return `<div class="sub">
      <div class="info">
        <div class="name">${integration.esc(c.name)}<span class="conf ${c.confidence}">${CONF_LABEL[c.confidence]}</span>${tags.join("")}</div>
        <div class="meta">${integration.esc(bits.join(" · "))}</div>
        ${c.samples && c.samples.length ? `<div class="samples">${c.samples.map(x => "“" + integration.esc(x) + "”").join("<br>")}</div>` : ""}
        ${storeNote}
      </div>
      <div class="acts">
        ${tracked ? "" : `<button data-madd="${integration.esc(c.key)}" ${pendingAdds.has(c.key) ? "disabled" : ""} title="${integration.catalogFor(c.domain) ? "我们收录了这个服务，会读取套餐" : "加入我的订阅，统计浏览器访问"}">${pendingAdds.has(c.key) ? "添加中…" : "添加订阅"}</button>`}
        <button data-mign="${integration.esc(c.key)}">忽略</button>
      </div>
    </div>`;
}

function renderMail() {
  const ms = integration.getState().mailScan;
  const ignored = new Set(integration.getState().mailIgnored || []);
  renderScanOptions(ms);
  $("m-summary").innerHTML = scanSummary(ms);
  const cands = (ms && ms.candidates) || [];
  const shown = cands.filter(c => !ignored.has(c.key));
  const hiddenN = cands.length - shown.length;
  $("m-list").innerHTML = shown.map(candidateHtml).join("") || emptyCandidates(ms, cands);
  const nNew = shown.filter(c => !isTracked(c)).length;
  $("badgeMail").hidden = !nNew; $("badgeMail").textContent = nNew;
  $("m-hidden").innerHTML = hiddenN ? `已忽略 ${hiddenN} 项 · <a href="#" id="m-unhide">全部恢复</a>` : "";
}
function emptyCandidates(ms, candidates) {
  if (ms && ms.status === "done" && !candidates.length) return '<div class="ad-empty">没有发现候选订阅。</div>';
  return !ms ? '<div class="ad-empty">还没扫描过。点「扫描邮箱」开始，第一次会请你授权读取 mail.google.com。</div>' : "";
}

function addStatus(message, isHtml = false) {
  const status = $("m-add-status");
  if (isHtml) status.innerHTML = message;
  else status.textContent = message;
  status.hidden = !message;
}
function candidateSubscription(candidate) {
  const monthly = candidate.cadence && candidate.monthly;
  return {
    id: crypto.randomUUID(), name: candidate.name.trim(), urlPattern: candidate.domain,
    price: monthly && Number.isFinite(monthly.value) && monthly.value >= 0 ? monthly.value : 0,
    currency: (monthly || candidate.amount || {}).currency || "$",
    mode: "browser", idleDays: 30, priceEstimated: false
  };
}
async function saveCandidate(candidate) {
  await integration.refresh();
  if (isTracked(candidate)) { addStatus("这个产品已在订阅中。"); return; }
  if (integration.atLimit()) { addStatus(integration.limitText(), true); return; }
  const result = await integration.send({ type: "SAVE_SUB", sub: candidateSubscription(candidate) });
  if (!result?.ok) {
    addStatus(result?.reason === "limit" ? integration.limitText() : "添加失败，请稍后重试。", result?.reason === "limit");
    return;
  }
  await integration.refresh();
  addStatus(`已将「${candidate.name}」添加到我的订阅。${!candidate.cadence ? "扣费周期不明，月费暂记为 0，可在订阅中编辑。" : ""}`);
}
function restoreCandidateFocus(key) {
  if ($("sec-mail").hidden || (document.activeElement !== document.body && !$("m-list").contains(document.activeElement))) return;
  const button = [...$("m-list").querySelectorAll("[data-madd]")].find(item => item.dataset.madd === key);
  const target = button || ($("m-add-status").hidden ? $("m-list") : $("m-add-status"));
  if (!button) target.tabIndex = -1;
  target.focus();
}
async function addCandidate(candidate) {
  if (pendingAdds.has(candidate.key) || isTracked(candidate)) return;
  if (integration.atLimit()) { addStatus(integration.limitText(), true); return; }
  pendingAdds.add(candidate.key);
  addStatus("");
  renderMail();
  const domain = MailCandidateDialog.merchantDomain(candidate.domain);
  const needsWebsite = !domain || !candidate.name?.trim();
  try {
    const completed = needsWebsite ? await MailCandidateDialog.askWebsite(candidate) : { ...candidate, domain };
    if (!completed) return;
    resolvedCandidates.set(candidate.key, completed);
    const catalog = integration.catalogFor(completed.domain);
    if (catalog) await integration.addFromCatalog(catalog.id);
    else await saveCandidate(completed);
  } catch (error) {
    console.error("邮箱候选添加失败", error);
    addStatus("添加失败，请稍后重试。");
  } finally {
    pendingAdds.delete(candidate.key);
    renderMail();
    restoreCandidateFocus(candidate.key);
  }
}

async function startScan() {
  // 权限只在这里、由你点击时申请（必须是点击后的第一个异步调用）
  const params = { account: $("m-acct").value, pages: $("m-pages").value, showTab: $("m-show").checked };
  const granted = await integration.requestOrigins([GMAIL_ORIGIN], "mail", "mail", params);
  if (!granted) { $("m-status").textContent = MAIL_ERR.no_permission; return; }
  const r = await integration.send(Object.assign({ type: "MAIL_SCAN_START" }, params));
  if (!r || !r.ok) { $("m-status").textContent = MAIL_ERR[r && r.reason] || "启动扫描失败。"; return; }
  await integration.refresh();
}

async function candidateClick(e) {
  const add = e.target.dataset.madd, ign = e.target.dataset.mign;
  const key = add || ign;
  if (!key) return;
  const c = ((integration.getState().mailScan && integration.getState().mailScan.candidates) || []).find(x => x.key === key);
  if (!c) return;
  if (ign) {
    await integration.send({ type: "MAIL_IGNORE", key, ignore: true });
    await integration.refresh();
  } else {
    await addCandidate(c);
  }
}

async function restoreIgnored(e) {
  if (e.target.id !== "m-unhide") return;
  e.preventDefault();
  await integration.send({ type: "MAIL_IGNORE", all: true, ignore: false });
  await integration.refresh();
}


globalThis.PopupMail = { initialize, render: renderMail };
}
