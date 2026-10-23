// 用真实界面脚本运行交互测试，只替换 Chrome API 和剪贴板边界。
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function replyToMessage(message, store, options) {
  if (message.type === "GET_STATE") return { ok: true, ...store };
  if (message.type === "SAVE_SUB") {
    if (options.saveReply) return options.saveReply;
    store.subs.push({ ...message.sub });
  }
  if (message.type === "CATALOG_ADD") {
    const sub = { id: "catalog-test", catalogId: message.id, name: "YouTube Premium", urlPattern: "youtube.com", mode: "activity" };
    store.subs.push(sub);
    return { ok: true, sub };
  }
  if (message.type === "AUTH_SIGN_OUT") store.auth = null;
  return { ok: true };
}

function chromeFixture(store, messages, options) {
  return {
    runtime: { sendMessage(message, callback) {
      messages.push(message);
      setTimeout(() => callback(replyToMessage(message, store, options)), 10);
    } },
    storage: { onChanged: { addListener() {} } },
    permissions: { contains: async () => true, request: async () => true },
    tabs: { create: async details => messages.push({ type: "TAB", ...details }) },
    identity: { getRedirectURL: () => "https://test.chromiumapp.org/" }
  };
}

async function createPopup(test, overrides = {}, options = {}) {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  const dom = new JSDOM(html.replace(/<script src=.*?<\/script>/g, ""),
    { runScripts: "outside-only", url: "chrome-extension://test/popup.html?panel=1" });
  const window = dom.window, messages = [], copied = [];
  const store = { subs: [], records: [], providers: [], mailIgnored: [], mailPrefs: {},
    subLimit: 5, guestLimit: 5, auth: null, googleLogin: true, ...overrides };
  window.chrome = chromeFixture(store, messages, options);
  window.Element.prototype.scrollIntoView = function () {};
  // 用例按中文界面写（浏览器语言非中文时界面默认英文）
  Object.defineProperty(window.navigator, "language", { value: options.language || "zh-CN" });
  Object.defineProperty(window.navigator, "clipboard", { value: {
    writeText: async text => { if (options.clipboardError) throw new Error("Clipboard denied"); copied.push(text); }
  } });
  test.after(() => window.close());
  scripts.forEach(file => window.eval(fs.readFileSync(path.join(root, file), "utf8")));
  await delay();
  return { window, store, messages, copied, $: selector => window.document.querySelector(selector) };
}

function mailScan(candidates) {
  return { status: "done", finishedAt: Date.now(), rowsRead: candidates.length, pagesRead: 1,
    billingRows: candidates.length, candidates };
}

function candidate(overrides = {}) {
  return { key: "cloudflare.com", name: "Cloudflare", domain: "cloudflare.com", mails: 3,
    status: "active", confidence: "high", samples: [], amount: { currency: "$", value: 120 },
    cadence: { key: "yearly", label: "每年", unit: "年" }, monthly: { currency: "$", value: 10 }, ...overrides };
}
module.exports = { createPopup, delay, mailScan, candidate };
