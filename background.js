importScripts("config.js");

const C = self.CDH_CONFIG;

// Clicking the toolbar icon opens the side panel, which stays open until the user closes it.
function setupPanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn("[Copilot Delete Helper] side panel setup failed", err);
      chrome.action.setPopup({ popup: "panel.html" });
    });
  } else {
    // Older browsers without the side panel API fall back to the classic popup.
    chrome.action.setPopup({ popup: "panel.html" });
  }
}

// Chrome and Edge do not run declared content scripts in tabs that were already
// open when the extension was installed, updated or re-enabled. Inject them now so
// the extension works right away, without the user refreshing Copilot.
async function injectIntoOpenCopilotTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: C.copilotMatches });
  } catch (err) {
    console.warn("[Copilot Delete Helper] tab query failed", err);
    return;
  }

  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || tab.discarded) return;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (err) {
      // A tab that is still loading or showing an error page gets the declared script instead.
      console.debug("[Copilot Delete Helper] could not inject into tab", tab.id, err?.message);
    }
  }));
}

function versionKey(version) {
  const [major = "0", minor = "0"] = String(version || "").split(".");
  return `${major}.${minor}`;
}

function withParams(url, params) {
  try {
    const u = new URL(url);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  } catch (_) {
    return url;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  setupPanel();
  await injectIntoOpenCopilotTabs();

  const version = chrome.runtime.getManifest().version;

  if (details.reason === "install" && C.openWelcomeOnInstall) {
    chrome.tabs.create({ url: withParams(C.welcomeUrl, { v: version, src: "install" }) });
  }

  if (details.reason === "update" && C.openWhatsNewOnMajorUpdate) {
    const before = details.previousVersion || "";
    if (before && versionKey(before) !== versionKey(version)) {
      chrome.tabs.create({ url: withParams(C.whatsNewUrl, { v: version, from: before, src: "update" }) });
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  setupPanel();
  injectIntoOpenCopilotTabs();
});

// Re-enabling the extension from the extensions page does not fire onInstalled,
// but it does start this worker. Running here covers that case too; the
// content script ignores a second injection when a live copy is already present.
setupPanel();
injectIntoOpenCopilotTabs();
