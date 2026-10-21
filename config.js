// Shared settings for the side panel and the background worker.
// Edit links and the support email here; nothing else needs to change.
(function (root) {
  const CHROME_ID = "ndhlafbieanmkgipgihhpgoelgnhmide";
  const EDGE_ID = "kjkcbijhicofiliemdhioojahfmdhnhk";
  const SITE = "https://copilot.ghostwrightweb.com";

  root.CDH_CONFIG = {
    supportEmail: "owen@ghostwrightweb.com",
    websiteUrl: SITE,

    // Opened once on first install, and on updates that change the
    // first or second version number (1.0.x -> 1.1.0). Patch updates open nothing.
    welcomeUrl: `${SITE}/welcome`,
    whatsNewUrl: `${SITE}/whats-new`,
    openWelcomeOnInstall: true,
    openWhatsNewOnMajorUpdate: true,

    chrome: {
      listingUrl: `https://chromewebstore.google.com/detail/${CHROME_ID}`,
      reviewUrl: `https://chromewebstore.google.com/detail/${CHROME_ID}/reviews`
    },
    edge: {
      // Flip to true once the Edge Add-ons listing is live.
      listingLive: false,
      listingUrl: `https://microsoftedge.microsoft.com/addons/detail/${EDGE_ID}`,
      reviewUrl: `https://microsoftedge.microsoft.com/addons/detail/${EDGE_ID}`
    },

    // The share link works for Chrome and Edge users (Edge can install from the Chrome Web Store).
    shareUrl: `https://chromewebstore.google.com/detail/${CHROME_ID}?utm_source=item-share-cb`,
    shareText: "I got tired of deleting Copilot chats one by one, so I use this free extension to bulk delete them.",

    // Show the review nudge after a cleanup run that deleted at least this many chats.
    reviewNudgeMinDeleted: 5,

    copilotUrl: "https://copilot.microsoft.com/",
    m365CopilotUrl: "https://m365.cloud.microsoft/chat",
    // Where the helper is allowed to run. Keep in sync with manifest.json.
    // Dedicated Copilot hosts run on every page. Shared Microsoft 365 hosts
    // (which also serve Outlook, Word, etc.) run only on their /chat pages.
    copilotSites: [
      { host: "copilot.microsoft.com", path: "" },
      { host: "copilot.com", path: "" },
      { host: "www.copilot.com", path: "" },
      { host: "copilot.cloud.microsoft", path: "" },
      { host: "m365.cloud.microsoft", path: "/chat" },
      { host: "microsoft365.com", path: "/chat" },
      { host: "www.microsoft365.com", path: "/chat" },
      { host: "www.office.com", path: "/chat" }
    ]
  };

  root.CDH_CONFIG.copilotMatches = root.CDH_CONFIG.copilotSites.map((s) => `https://${s.host}${s.path}/*`.replace("/chat/*", "/chat*"));

  root.CDH_isEdge = function () {
    const ua = (root.navigator && root.navigator.userAgent) || "";
    return /\bEdg\//.test(ua);
  };

  root.CDH_storeLinks = function () {
    const c = root.CDH_CONFIG;
    if (root.CDH_isEdge() && c.edge.listingLive) {
      return { listingUrl: c.edge.listingUrl, reviewUrl: c.edge.reviewUrl, store: "Edge Add-ons" };
    }
    return { listingUrl: c.chrome.listingUrl, reviewUrl: c.chrome.reviewUrl, store: "Chrome Web Store" };
  };

  root.CDH_isCopilotUrl = function (url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return false;
      return root.CDH_CONFIG.copilotSites.some((site) => u.hostname === site.host && u.pathname.startsWith(site.path));
    } catch (_) {
      return false;
    }
  };
})(typeof self !== "undefined" ? self : window);
