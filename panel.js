const C = window.CDH_CONFIG;
const STORE = window.CDH_storeLinks();

const $ = (id) => document.getElementById(id);

const els = {
  badge: $("connectionBadge"),
  loaded: $("loadedCount"),
  selected: $("selectedCount"),
  failed: $("failedCount"),
  status: $("status"),
  progress: $("progressBar"),
  speed: $("speedMode"),
  notCopilot: $("notCopilot"),
  accessCard: $("accessCard"),
  reconnect: $("reconnect"),
  reconnectText: $("reconnectText"),
  confirmBox: $("confirmBox"),
  confirmText: $("confirmText"),
  reviewCard: $("reviewCard"),
  reviewTitle: $("reviewTitle"),
  reviewText: $("reviewText"),
  dismissReview: $("dismissReview"),
  sharePanel: $("sharePanel"),
  shareLead: $("shareLead"),
  shareLink: $("shareLink"),
  lifetime: $("lifetime")
};

const ui = {
  tabId: null,
  site: null,             // the supported site on the active tab
  siteLabel: "chat",
  connected: false,
  busy: false,            // a short command is waiting for its answer
  stats: {},
  pendingAction: null,    // "deleteSelected" or "retryFailed" while the confirm box is open
  connectSeq: 0,
  prefs: { mode: "balanced", lifetimeDeleted: 0, reviewClicked: false, reviewDismissedAt: 0 }
};

const DISMISS_DAYS = 21;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function setBadge(text, type = "") {
  els.badge.textContent = text;
  els.badge.className = `badge ${type}`.trim();
}

function setStatus(message) {
  els.status.textContent = message || "Ready.";
}

function setProgress(percent = 0) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  els.progress.style.width = `${value}%`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function openTab(url) {
  chrome.tabs.create({ url });
}

async function loadPrefs() {
  try {
    const saved = await chrome.storage.local.get(Object.keys(ui.prefs));
    ui.prefs = { ...ui.prefs, ...saved };
  } catch (_) { /* storage unavailable; defaults are fine */ }
  els.speed.value = ["balanced", "safe", "fast"].includes(ui.prefs.mode) ? ui.prefs.mode : "balanced";
}

function savePrefs(patch) {
  ui.prefs = { ...ui.prefs, ...patch };
  try { chrome.storage.local.set(patch); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function isRunning() {
  return Boolean(ui.stats.running || ui.stats.loading);
}

function renderControls() {
  const idle = ui.connected && !isRunning() && !ui.busy;
  document.querySelectorAll("[data-needs]").forEach((el) => {
    const need = el.dataset.needs;
    if (need === "idle") el.disabled = !idle;
    else if (need === "connected") el.disabled = !ui.connected || ui.busy;
    else if (need === "busy") el.disabled = !(ui.connected && isRunning());
  });
  if (!idle && ui.pendingAction) closeConfirm();
}

function updateStats(stats = {}) {
  ui.stats = stats;
  els.loaded.textContent = fmt(stats.loaded);
  els.selected.textContent = fmt(stats.selected);
  els.failed.textContent = fmt(stats.failed);

  if (typeof stats.progressPercent === "number") setProgress(stats.progressPercent);

  if (stats.running) {
    const job = stats.job || {};
    setBadge("Deleting", "warn");
    setStatus(`Deleting ${fmt(job.current)} of ${fmt(job.total)}. Deleted ${fmt(job.deleted)}, failed ${fmt(job.failed)}. Leave this tab alone until it finishes.`);
  } else if (stats.loading) {
    setBadge("Loading", "warn");
    setStatus(`Loading chats... ${fmt(stats.loaded)} loaded so far.`);
  } else if (ui.connected) {
    setBadge("Connected", "ok");
  }
  renderControls();
}

function renderLifetime() {
  const n = Number(ui.prefs.lifetimeDeleted || 0);
  if (n > 0) {
    els.lifetime.hidden = false;
    els.lifetime.textContent = `You've cleared ${fmt(n)} chat${n === 1 ? "" : "s"} with Clearcut Chats.`;
  } else {
    els.lifetime.hidden = true;
  }
}

function shareText() {
  const n = Number(ui.prefs.lifetimeDeleted || 0);
  if (n >= 10) return `I just cleared ${fmt(n)} AI chats in a few clicks instead of deleting them one by one. Free extension:`;
  return C.shareText;
}

function renderShare() {
  const url = C.shareUrl;
  const text = shareText();
  els.shareLink.value = url;
  $("shareX").href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  $("shareReddit").href = `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent("Free extension to bulk delete Copilot, ChatGPT and Claude chats")}`;
  $("shareLinkedIn").href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
  $("shareEmail").href = `mailto:?subject=${encodeURIComponent("Bulk delete your AI chats")}&body=${encodeURIComponent(`${text}\n\n${url}`)}`;
}

function nudgeAllowed() {
  if (ui.prefs.reviewClicked) return false;
  const since = Date.now() - Number(ui.prefs.reviewDismissedAt || 0);
  return since > DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function showNudge(deleted) {
  els.reviewCard.classList.add("nudge");
  els.reviewTitle.textContent = `Nice. ${fmt(deleted)} chats gone.`;
  els.reviewText.textContent = `If Clearcut Chats saved you some clicks, a quick review on the ${STORE.store} helps other people find it.`;
  els.dismissReview.hidden = false;
  $("toggleShare").hidden = true;
}

function resetReviewCard() {
  els.reviewCard.classList.remove("nudge");
  els.reviewTitle.textContent = "Did this help you?";
  els.reviewText.textContent = "If it saved you time, a quick review helps other people find it.";
  els.dismissReview.hidden = true;
  $("toggleShare").hidden = false;
}

// ---------------------------------------------------------------------------
// Connecting to the active tab
// ---------------------------------------------------------------------------
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_) {
    return null;
  }
}

async function hasAccess(site) {
  try {
    return await chrome.permissions.contains({ origins: window.CDH_matchesFor(site) });
  } catch (_) {
    return false;
  }
}

const optionalSites = () => window.CDH_CONFIG.sites.filter((site) => !site.required);
const siteById = (id) => window.CDH_CONFIG.sites.find((site) => site.id === id);
const ACCESS_BUTTONS = { chatgpt: ["grantChatGPT", "revokeChatGPT"], claude: ["grantClaude", "revokeClaude"] };

// Shows "Turn on" for sites not allowed yet and "Turn off" for sites that are.
async function refreshAccess(onSupportedSite) {
  let anyOff = false;
  for (const site of optionalSites()) {
    const [grantId, revokeId] = ACCESS_BUTTONS[site.id];
    const granted = await hasAccess(site);
    $(grantId).hidden = granted;
    $(revokeId).hidden = !granted;
    if (!granted) anyOff = true;
  }
  els.accessCard.hidden = onSupportedSite || !anyOff;
}

// Must run straight from a click so the browser will show its permission prompt.
async function requestAccess(siteId) {
  const site = siteById(siteId);
  if (!site || site.required) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: window.CDH_matchesFor(site) });
  } catch (err) {
    console.warn("[Clearcut Chats] permission request failed", err?.message);
  }
  if (granted) {
    setStatus(`${site.label} is on. Open ${site.label} and this panel will connect.`);
    await connect();
    setStatus(`${site.label} is on. Open ${site.label} and this panel will connect.`);
  } else {
    setStatus(`Access to ${site.label} wasn't allowed, so nothing runs there. You can try again any time.`);
  }
}

async function revokeAccess(siteId) {
  const site = siteById(siteId);
  if (!site || site.required) return;
  try {
    await chrome.permissions.remove({ origins: window.CDH_matchesFor(site) });
  } catch (_) { /* nothing to remove */ }
  await connect();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

async function ping(tabId, ms) {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, { action: "ping" }), ms);
  } catch (_) {
    return null;
  }
}

async function inject(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["styles.css"] });
  } catch (_) { /* CSS may already be present */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (err) {
    console.warn("[Clearcut Chats] inject failed", err?.message);
    return false;
  }
}

// Finds the active Copilot tab and makes sure the helper is running in it.
// If the page script is missing (tab opened before install, extension updated,
// page restored from cache), it is injected on the spot: no refresh needed.
async function connect() {
  const seq = ++ui.connectSeq;
  const tab = await getActiveTab();
  if (seq !== ui.connectSeq) return false;

  ui.tabId = tab?.id ?? null;
  els.reconnect.hidden = true;

  // Without access to a site the browser hides that tab's address, so a tab we can read is a supported one
  // (or an ordinary site we can't use). Either way the access card below lets the user turn on ChatGPT or Claude.
  const site = tab && tab.url ? window.CDH_siteForUrl(tab.url) : null;
  ui.site = site;
  ui.siteLabel = site ? site.label : "chat";
  await refreshAccess(Boolean(site));
  if (seq !== ui.connectSeq) return false;

  if (!site) {
    ui.connected = false;
    els.notCopilot.hidden = false;
    setBadge("Open a chat site", "error");
    setStatus("Switch to a Copilot, ChatGPT or Claude tab, or open one with the buttons above.");
    updateStats({});
    return false;
  }
  els.notCopilot.hidden = true;

  setBadge("Connecting", "warn");
  let reply = await ping(tab.id, 600);

  if (!reply) {
    await inject(tab.id);
    if (seq !== ui.connectSeq) return false;
    reply = await ping(tab.id, 2000);
  }

  if (!reply && tab.status === "loading") {
    // Copilot is still loading. The page will announce itself when it is ready.
    if (seq !== ui.connectSeq) return false;
    setBadge("Waiting", "warn");
    setStatus("Waiting for the page to finish loading...");
    setTimeout(() => { if (!ui.connected && seq === ui.connectSeq) connect(); }, 2500);
    return false;
  }

  if (seq !== ui.connectSeq) return false;

  if (!reply?.ok) {
    ui.connected = false;
    els.reconnect.hidden = false;
    els.reconnectText.textContent = `Couldn't reach this ${ui.siteLabel} tab. Try again, or reload the tab if ${ui.siteLabel} itself looks stuck.`;
    setBadge("Not connected", "error");
    setStatus("The helper couldn't start in this tab.");
    updateStats({});
    return false;
  }

  ui.connected = true;
  updateStats(reply.stats || {});
  if (!isRunning()) {
    setStatus(reply.stats?.boxesOn
      ? "Ready. Select chats, then click Delete Selected."
      : "Ready. Click Add Checkboxes to start selecting chats.");
  }
  return true;
}

async function send(action, extra = {}) {
  if (!ui.connected || ui.tabId == null) {
    const ok = await connect();
    if (!ok) return null;
  }

  const message = { action, ...extra };
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(ui.tabId, message);
  } catch (_) {
    // The page script went away (reload, update). Put it back and try once more.
    const ok = await inject(ui.tabId) && await ping(ui.tabId, 2000);
    if (ok) {
      try { response = await chrome.tabs.sendMessage(ui.tabId, message); } catch (_) { response = null; }
    }
  }

  if (!response) {
    ui.connected = false;
    await connect();
    return null;
  }

  if (response.stats) updateStats(response.stats);
  setStatus(response.message || "Done.");
  if (!response.ok && !isRunning()) setBadge("Check status", "error");
  return response;
}

async function run(action, extra = {}) {
  ui.busy = true;
  renderControls();
  try {
    return await send(action, extra);
  } finally {
    ui.busy = false;
    renderControls();
  }
}

// ---------------------------------------------------------------------------
// Delete with an in-panel confirmation
// ---------------------------------------------------------------------------
function closeConfirm() {
  ui.pendingAction = null;
  els.confirmBox.hidden = true;
}

async function askToDelete(action) {
  const res = await run("stats");
  if (!res) return;
  const count = action === "retryFailed" ? res.stats.failed : res.stats.selected;
  if (!count) {
    setStatus(action === "retryFailed"
      ? "No failed chats to retry."
      : "Select at least one chat first. Click Add Checkboxes if you don't see any.");
    return;
  }
  ui.pendingAction = action;
  const what = action === "retryFailed" ? "failed chat" : "chat";
  els.confirmText.textContent = `Delete ${fmt(count)} ${what}${count === 1 ? "" : "s"}? This can't be undone. Leave this tab alone while it runs.`;
  els.confirmBox.hidden = false;
  $("confirmYes").focus();
}

async function confirmDelete() {
  const action = ui.pendingAction;
  closeConfirm();
  if (!action) return;
  resetReviewCard();
  await run(action, {
    mode: els.speed.value,
    reviewUrl: STORE.reviewUrl,
    reviewMin: nudgeAllowed() ? C.reviewNudgeMinDeleted : Number.MAX_SAFE_INTEGER
  });
}

function onJobDone(msg) {
  const deleted = Number(msg.deletedThisRun || 0);
  if (deleted > 0) {
    savePrefs({ lifetimeDeleted: Number(ui.prefs.lifetimeDeleted || 0) + deleted });
    renderLifetime();
    renderShare();
  }
  if (msg.message) setStatus(msg.message);
  const failed = Number(msg.stats?.job?.failed || 0);
  if (deleted >= C.reviewNudgeMinDeleted && failed === 0 && nudgeAllowed()) showNudge(deleted);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire(id, handler) {
  $(id).addEventListener("click", handler);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadPrefs();
  renderLifetime();
  renderShare();

  $("versionText").textContent = `v${chrome.runtime.getManifest().version}`;
  $("websiteLink").href = C.websiteUrl;
  $("supportLink").textContent = C.supportEmail;
  $("supportLink").href = `mailto:${C.supportEmail}?subject=${encodeURIComponent("Clearcut Chats")}`;

  wire("add", () => run("add"));
  wire("remove", () => run("remove"));
  wire("selectAll", () => run("selectAll"));
  wire("deselectAll", () => run("deselectAll"));
  wire("refresh", () => run("stats"));
  wire("loadMore", () => {
    // Load More reports progress live, so it doesn't hold the panel busy.
    send("loadMore", { mode: els.speed.value });
  });
  wire("cancelJob", () => send("cancel"));
  wire("deleteSelected", () => askToDelete("deleteSelected"));
  wire("retryFailed", () => askToDelete("retryFailed"));
  wire("confirmYes", confirmDelete);
  wire("confirmNo", () => { closeConfirm(); setStatus("Canceled. Nothing was deleted."); });

  wire("openCopilot", () => openTab(C.copilotUrl));
  wire("openM365", () => openTab(C.m365CopilotUrl));
  wire("openChatGPT", () => openTab(C.chatgptUrl));
  wire("openClaude", () => openTab(C.claudeUrl));
  wire("grantChatGPT", () => requestAccess("chatgpt"));
  wire("grantClaude", () => requestAccess("claude"));
  wire("revokeChatGPT", () => revokeAccess("chatgpt"));
  wire("revokeClaude", () => revokeAccess("claude"));
  wire("retryConnect", () => connect());
  wire("reloadTab", () => { if (ui.tabId != null) chrome.tabs.reload(ui.tabId); });

  wire("leaveReview", () => {
    savePrefs({ reviewClicked: true });
    openTab(STORE.reviewUrl);
    resetReviewCard();
    els.reviewText.textContent = "Thank you. It means a lot.";
  });
  wire("dismissReview", () => {
    savePrefs({ reviewDismissedAt: Date.now() });
    resetReviewCard();
  });
  wire("toggleShare", () => {
    const open = els.sharePanel.hidden;
    els.sharePanel.hidden = !open;
    $("toggleShare").setAttribute("aria-expanded", String(open));
  });
  wire("copyLink", async () => {
    const btn = $("copyLink");
    try {
      await navigator.clipboard.writeText(C.shareUrl);
      btn.textContent = "Copied";
    } catch (_) {
      els.shareLink.select();
      btn.textContent = "Press Ctrl+C";
    }
    setTimeout(() => { btn.textContent = "Copy"; }, 1800);
  });
  els.shareLink.addEventListener("focus", () => els.shareLink.select());

  // Mail links open through a tab so they work inside the side panel.
  for (const id of ["shareEmail", "supportLink"]) {
    $(id).addEventListener("click", (event) => {
      event.preventDefault();
      openTab($(id).href);
    });
  }

  els.speed.addEventListener("change", () => savePrefs({ mode: els.speed.value }));

  // Live updates pushed by the page while it works.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "cdh:update") return;
    if (!sender.tab || sender.tab.id !== ui.tabId) return;
    if (msg.event === "ready" && !ui.connected) { connect(); return; }
    ui.connected = true;
    els.reconnect.hidden = true;
    updateStats(msg.stats || {});
    if (msg.event === "job-done") onJobDone(msg);
    if (msg.event === "loaded" && !isRunning()) {
      setStatus(`Loading finished. ${fmt(msg.stats?.loaded)} chats loaded.`);
    }
  });

  // The side panel stays open across tabs, so follow the active tab.
  chrome.tabs.onActivated.addListener(() => { closeConfirm(); connect(); });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== ui.tabId) return;
    if (info.status === "complete" || info.url) connect();
  });
  if (chrome.windows && chrome.windows.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(() => { if (!isRunning()) connect(); });
  }

  renderControls();
  await connect();
});
