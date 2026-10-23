importScripts("config.js");

const C = self.CDH_CONFIG;
const LOG = "[Clearcut Chats]";

// Clicking the toolbar icon opens the side panel, which stays open until the user closes it.
function setupPanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn(LOG, "side panel setup failed", err);
      chrome.action.setPopup({ popup: "panel.html" });
    });
  } else {
    // Older browsers without the side panel API fall back to the classic popup.
    chrome.action.setPopup({ popup: "panel.html" });
  }
}

// ---------------------------------------------------------------------------
// Optional sites (ChatGPT, Claude)
// The user turns each one on from the side panel and the browser asks for just
// that site. Once access is granted, the page script is registered for it. The
// registration is redone on install, update and startup because browsers clear
// registered scripts when an extension updates.
// ---------------------------------------------------------------------------
const scriptId = (site) => `cdh-${site.id}`;

async function hasAccess(site) {
  try {
    return await chrome.permissions.contains({ origins: self.CDH_matchesFor(site) });
  } catch (_) {
    return false;
  }
}

async function syncOptionalScripts() {
  const optional = C.sites.filter((site) => !site.required);
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch (err) {
    console.warn(LOG, "could not read registered scripts", err);
    return;
  }
  const have = new Set(registered.map((s) => s.id));

  for (const site of optional) {
    const granted = await hasAccess(site);
    try {
      if (granted && !have.has(scriptId(site))) {
        await chrome.scripting.registerContentScripts([{
          id: scriptId(site),
          matches: self.CDH_matchesFor(site),
          js: ["content.js"],
          css: ["styles.css"],
          runAt: "document_idle",
          persistAcrossSessions: true
        }]);
      } else if (!granted && have.has(scriptId(site))) {
        await chrome.scripting.unregisterContentScripts({ ids: [scriptId(site)] });
      }
    } catch (err) {
      console.warn(LOG, `could not update script for ${site.label}`, err?.message || err);
    }
  }
}

// Chrome and Edge do not run declared content scripts in tabs that were already
// open when the extension was installed, updated or re-enabled. Inject them now so
// the extension works right away, without the user refreshing the page.
async function injectIntoOpenTabs() {
  const patterns = [];
  for (const site of C.sites) {
    if (site.required || (await hasAccess(site))) patterns.push(...self.CDH_matchesFor(site));
  }
  if (!patterns.length) return;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch (err) {
    console.warn(LOG, "tab query failed", err);
    return;
  }

  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || tab.discarded) return;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (err) {
      // A tab that is still loading or showing an error page gets the declared script instead.
      console.debug(LOG, "could not inject into tab", tab.id, err?.message);
    }
  }));
}

async function refreshEverything() {
  await syncOptionalScripts();
  await injectIntoOpenTabs();
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
  await refreshEverything();

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
  refreshEverything();
});

// Access granted or taken away from the side panel (or from the extension's page in the browser).
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => refreshEverything());
  chrome.permissions.onRemoved.addListener(() => syncOptionalScripts());
}

// Re-enabling the extension from the extensions page does not fire onInstalled,
// but it does start this worker. Running here covers that case too; the
// content script ignores a second injection when a live copy is already present.
setupPanel();
refreshEverything();
