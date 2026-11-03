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

  // 侧边栏里 navigator.clipboard 常因「页面没有焦点」被拒（菜单按钮点下去时焦点还在别处），
  // 所以失败时退回到老办法：临时放一个文本框选中后 execCommand("copy")
  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand && document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return !!ok;
  }
  async function copyEmail(root) {
    const status = root.querySelector("#feedbackCopyStatus");
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(feedbackEmail); ok = true; }
    } catch (error) { ok = false; }
    if (!ok) ok = legacyCopy(feedbackEmail);
    status.textContent = ok ? "邮箱已复制" : "复制失败，请选中上方邮箱手动复制。";
    // 复制失败时把邮箱选中，按 Ctrl+C 就能复制
    if (!ok) { const addr = root.querySelector(".feedback-address"); try { const r = document.createRange(); r.selectNodeContents(addr); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (e) {} }
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
    // 焦点离开菜单才收起。注意：focusout 触发时新焦点还没落到点中的按钮上（activeElement 还是 body），
    // 以前用 queueMicrotask 检查，会在按下「复制邮箱地址」的一瞬间把菜单收起，click 就丢了。
    // 现在先看 relatedTarget（焦点要去的元素），再等焦点真正落下后检查
    root.addEventListener("focusout", (event) => {
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      setTimeout(() => {
        const a = document.activeElement;
        if (a && a !== document.body && !root.contains(a)) setOpen(root, false);
      }, 0);
    });
  }

  globalThis.PopupAccount = { render };
}
