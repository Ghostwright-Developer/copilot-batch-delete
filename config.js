// Shared settings for the side panel and the background worker.
// Edit links and the support email here; nothing else needs to change.
(function (root) {
  const CHROME_ID = "ndhlafbieanmkgipgihhpgoelgnhmide";
  const EDGE_ID = "kjkcbijhicofiliemdhioojahfmdhnhk";
  const SITE = "https://clearcutchats.ghostwrightweb.com";

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
    shareText: "I got tired of deleting AI chats one by one, so I use this free extension to bulk delete Copilot, ChatGPT and Claude chats.",

    // Show the review nudge after a cleanup run that deleted at least this many chats.
    reviewNudgeMinDeleted: 5,

    productName: "Clearcut Chats",

    copilotUrl: "https://copilot.microsoft.com/",
    chatgptUrl: "https://chatgpt.com/",
    claudeUrl: "https://claude.ai/new",
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

  // Supported sites. Copilot's hosts are granted at install. ChatGPT and Claude are optional:
  // the user turns each one on from the side panel, and Chrome asks for that site only.
  root.CDH_CONFIG.sites = [
    { id: "copilot", label: "Copilot", required: true, entries: root.CDH_CONFIG.copilotSites },
    { id: "chatgpt", label: "ChatGPT", required: false, openUrl: root.CDH_CONFIG.chatgptUrl,
      entries: [{ host: "chatgpt.com", path: "" }, { host: "chat.openai.com", path: "" }] },
    { id: "claude", label: "Claude", required: false, openUrl: root.CDH_CONFIG.claudeUrl,
      entries: [{ host: "claude.ai", path: "" }] }
  ];

  root.CDH_matchesFor = function (site) {
    return site.entries.map((s) => `https://${s.host}${s.path}/*`.replace("/chat/*", "/chat*"));
  };

  root.CDH_siteForUrl = function (url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return null;
      return root.CDH_CONFIG.sites.find((site) => site.entries.some((e) => u.hostname === e.host && u.pathname.startsWith(e.path))) || null;
    } catch (_) {
      return null;
    }
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
