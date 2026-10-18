// 顶部账号与反馈菜单；不读取账号 token，不自行执行登录或退出。
{
  const feedbackEmail = "jiago12345@gmail.com";
  const initializedRoots = new WeakSet();

  function menuMarkup() {
    return `<div id="accountMenuPanel" class="account-menu-panel" hidden aria-label="账号与反馈">
      <div class="account-menu-identity" hidden></div>
      <a id="feedbackEmailLink" class="account-menu-item" href="mailto:jiago12345@gmail.com?subject=IdleSubs%20建议与反馈">建议与反馈 <span aria-hidden="true">↗</span></a>
      <span class="feedback-address">jiago12345@gmail.com</span>
      <button type="button" id="copyFeedbackEmail" class="account-menu-item">复制邮箱地址</button>
      <span id="feedbackCopyStatus" class="feedback-copy-status" role="status"></span>
      <a href="#" id="signOut" class="account-menu-item account-signout" hidden>退出登录</a>
    </div>`;
  }

  function render(root, auth) {
    initialize(root);
    const user = auth && auth.user;
    const identity = JSON.stringify(user ? [user.name, user.email] : null);
    if (root.dataset.identity === identity) return;
    root.dataset.identity = identity;
    root.innerHTML = `${user ? "" : '<a href="#" data-login="1">登录</a>'}
      <button type="button" id="accountMenuButton" class="account-menu-trigger" aria-expanded="false" aria-controls="accountMenuPanel" aria-label="账号与反馈菜单" title="账号与反馈">
        <span class="${user ? "avatar" : "account-menu-more"}"></span><span class="account-menu-chevron" aria-hidden="true">⌄</span>
      </button>${menuMarkup()}`;
    root.querySelector(".avatar, .account-menu-more").textContent = user
      ? ((user.name || user.email || "?").trim()[0] || "?").toUpperCase() : "···";
    const label = root.querySelector(".account-menu-identity");
    label.hidden = !user;
    label.textContent = user ? user.email || user.name || "已登录" : "";
    root.querySelector("#signOut").hidden = !user;
  }

  function setOpen(root, open, restoreFocus = false) {
    const button = root.querySelector("#accountMenuButton"), panel = root.querySelector("#accountMenuPanel");
    if (!button || !panel) return;
    button.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    if (open) panel.querySelector("a").focus();
    else if (restoreFocus) button.focus();
  }

  async function copyEmail(root) {
    const status = root.querySelector("#feedbackCopyStatus");
    try {
      await navigator.clipboard.writeText(feedbackEmail);
      status.textContent = "邮箱已复制";
    } catch (error) {
      status.textContent = "复制失败，请选中上方邮箱手动复制。";
    }
  }

  function accountClick(root, event) {
    const target = event.target.closest("button,a");
    if (!target) return;
    if (target.id === "accountMenuButton") {
      setOpen(root, target.getAttribute("aria-expanded") !== "true");
    } else if (target.id === "copyFeedbackEmail") {
      copyEmail(root);
    } else if (target.id === "signOut" || target.id === "feedbackEmailLink" || target.dataset.login) {
      setOpen(root, false);
    }
  }

  function initialize(root) {
    if (initializedRoots.has(root)) return;
    initializedRoots.add(root);
    root.addEventListener("click", event => accountClick(root, event));
    document.addEventListener("click", event => { if (!root.contains(event.target)) setOpen(root, false); });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || root.querySelector("#accountMenuPanel")?.hidden !== false) return;
      event.preventDefault(); setOpen(root, false, true);
    });
    root.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" || event.target.id !== "accountMenuButton") return;
      event.preventDefault(); setOpen(root, true);
    });
    root.addEventListener("focusout", () => {
      queueMicrotask(() => { if (!root.contains(document.activeElement)) setOpen(root, false); });
    });
  }

  globalThis.PopupAccount = { render };
}
