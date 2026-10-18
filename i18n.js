// 界面语言（中文 / 英文）。
// 默认跟浏览器语言：中文浏览器用中文，其它一律英文；用户也可以在右上角手动切换（存进设置，优先于浏览器语言）。
//
// 做法：界面里的中文原文就是「钥匙」。英文模式下，把页面上出现的中文文字（文本节点、title、placeholder 等）
// 按词典换成英文；带数字、名字的句子用正则模板换。新渲染出来的内容由 MutationObserver 接着翻。
// 词典在 i18n-en.js 里，这里只放机制。后台（通知文案）用 T()。
(function () {
  const CJK = /[㐀-鿿]/;
  let lang = null, dict = {}, patterns = [], phrases = [];
  const missing = new Set();   // 开发用：英文模式下没翻到的原文

  function detect(pref) {
    if (pref === "zh" || pref === "en") return pref;
    if (typeof navigator === "undefined") return "zh";   // 没有浏览器环境（单元测试）时按原文
    const nl = navigator.language || (navigator.languages || [])[0] || "";
    return /^zh/i.test(nl) ? "zh" : "en";
  }
  // 弹窗 / 侧边栏：同步读 localStorage（渲染前就要知道语言，避免先显示中文再闪成英文）
  function initFromLocal() {
    let pref = null;
    try { pref = localStorage.getItem("uiLang"); } catch (e) {}
    lang = detect(pref);
    return lang;
  }
  function getLang() { return lang || initFromLocal(); }
  // d：整句对照；p：[正则, 替换] 带数字 / 名字的句子；ph：[中文片段, 英文] 拼起来的句子按片段换（长的先换）
  function setDict(d, p, ph) {
    dict = d || {}; patterns = p || [];
    phrases = (ph || []).slice().sort((a, b) => b[0].length - a[0].length);
  }

  // 翻译一段文字：前后空白保留，中间按词典 / 正则换
  function tr(s) {
    if (getLang() !== "en" || !s || !CJK.test(s)) return s;
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
    if (Object.prototype.hasOwnProperty.call(dict, core)) return lead + dict[core] + trail;
    for (const [re, rep] of patterns) {
      if (re.test(core)) return lead + core.replace(re, rep) + trail;
    }
    // 片段替换：拼出来的句子（如「套餐 · 价格 · 续费日」「$9.99/月 · 下次续费 10/29」）
    let out = core;
    for (const [zh, en] of phrases) if (out.indexOf(zh) >= 0) out = out.split(zh).join(en);
    if (CJK.test(out)) missing.add(core);
    return out === core ? s : lead + out + trail;
  }
  // 代码里直接用：T("已添加 {name}", { name })。英文模式取词典里的英文模板。
  function T(zh, vars) {
    let out = getLang() === "en" && Object.prototype.hasOwnProperty.call(dict, zh) ? dict[zh] : zh;
    if (getLang() === "en" && out === zh && CJK.test(zh)) missing.add(zh);
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return out;
  }

  const ATTRS = ["title", "placeholder", "aria-label"];
  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { const v = tr(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (root.tagName === "SCRIPT" || root.tagName === "STYLE") return;
      for (const a of ATTRS) { const v = root.getAttribute(a); if (v && CJK.test(v)) { const t = tr(v); if (t !== v) root.setAttribute(a, t); } }
    }
    const walker = (root.ownerDocument || root).createTreeWalker(root, 1 | 4);   // 元素 + 文本
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) { if (CJK.test(n.nodeValue)) { const v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; } }
      else if (n.tagName !== "SCRIPT" && n.tagName !== "STYLE") {
        for (const a of ATTRS) { const v = n.getAttribute(a); if (v && CJK.test(v)) { const t = tr(v); if (t !== v) n.setAttribute(a, t); } }
      }
    }
  }
  // 英文模式：先翻一遍整页，之后新渲染的内容自动翻
  function start(doc) {
    doc = doc || document;
    doc.documentElement.lang = getLang() === "en" ? "en" : "zh-CN";
    if (getLang() !== "en") return;
    translateTree(doc.body);
    if (doc.title) doc.title = tr(doc.title);
    const obs = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") translateTree(m.target);
        else if (m.type === "attributes") translateTree(m.target);
        else m.addedNodes.forEach(translateTree);
      }
    });
    obs.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  // 手动切换：存起来（弹窗用 localStorage，后台通知用 chrome.storage），然后重新加载界面
  function setLang(l) {
    try { localStorage.setItem("uiLang", l); } catch (e) {}
    try { if (typeof chrome !== "undefined" && chrome.storage) chrome.storage.local.set({ uiLang: l }); } catch (e) {}
    lang = detect(l);
  }
  // 后台（service worker）：从 chrome.storage 读用户的选择
  async function initFromStorage() {
    try { const r = await chrome.storage.local.get(["uiLang"]); lang = detect(r && r.uiLang); }
    catch (e) { lang = detect(null); }
    return lang;
  }

  const api = { CJK, detect, getLang, initFromLocal, initFromStorage, setDict, tr, T, translateTree, start, setLang, missing };
  globalThis.I18N = api;
  globalThis.T = T;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
