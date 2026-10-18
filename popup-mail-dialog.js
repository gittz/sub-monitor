// 邮箱候选缺少商家网址时，在当前视图补全，不猜测支付平台背后的商家。
{
function merchantDomain(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : "https://" + input);
    const host = url.hostname.replace(/^www\./, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    if (!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(host)) return "";
    return host;
  } catch (error) {
    if (error instanceof TypeError) return "";
    throw error;
  }
}
function dialogMarkup() {
  return `<form id="mailCandidateForm" class="dlg" role="dialog" aria-modal="true" aria-labelledby="mailCandidateTitle" novalidate>
    <b class="dlg-title" id="mailCandidateTitle">补充订阅网址</b>
    <p class="dlg-text">收据未提供商家网址。请填写实际订阅的产品，插件靠网址统计使用情况。</p>
    <label>产品名称<input id="mailCandidateName" required autocomplete="off"></label>
    <label>产品网址<input id="mailCandidateUrl" required placeholder="例如 example.com" inputmode="url" autocomplete="off"></label>
    <p id="mailCandidateError" class="err" role="alert" hidden></p>
    <div class="dlg-btns"><button type="button" id="mailCandidateCancel" class="dlg-btn">取消</button>
    <button type="submit" class="dlg-btn primary">添加订阅</button></div>
  </form>`;
}
function candidateFromForm(form, candidate) {
  const name = form.querySelector("#mailCandidateName").value.trim();
  const domain = merchantDomain(form.querySelector("#mailCandidateUrl").value);
  const error = form.querySelector("#mailCandidateError");
  error.textContent = !name ? "请填写产品名称。" : !domain ? "请填写有效的产品网址，例如 example.com。" : "";
  error.hidden = !error.textContent;
  return error.hidden ? { ...candidate, name, domain } : null;
}
function dialogKeyboard(event, form, finish) {
  if (event.key === "Escape") { event.preventDefault(); finish(null); return; }
  if (event.key !== "Tab") return;
  const controls = [...form.querySelectorAll("input, button")];
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function bindDialog(mask, candidate, resolve) {
  const form = mask.querySelector("form");
  const previousFocus = document.activeElement;
  const finish = value => { mask.remove(); previousFocus?.focus(); resolve(value); };
  form.querySelector("#mailCandidateName").value = candidate.name || "";
  form.addEventListener("submit", event => {
    event.preventDefault();
    const completed = candidateFromForm(form, candidate);
    if (completed) finish(completed);
  });
  form.querySelector("#mailCandidateCancel").addEventListener("click", () => finish(null));
  mask.addEventListener("click", event => { if (event.target === mask) finish(null); });
  mask.addEventListener("keydown", event => dialogKeyboard(event, form, finish));
  document.body.appendChild(mask);
  form.querySelector("#mailCandidateUrl").focus();
}
function askWebsite(candidate) {
  return new Promise(resolve => {
    const mask = document.createElement("div");
    mask.className = "dlg-mask mail-candidate-dialog";
    mask.innerHTML = dialogMarkup();
    bindDialog(mask, candidate, resolve);
  });
}
globalThis.MailCandidateDialog = { askWebsite, merchantDomain };
}
