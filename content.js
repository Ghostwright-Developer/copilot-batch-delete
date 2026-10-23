(() => {
  "use strict";

  const VERSION = "1.2.0";

  // ---------------------------------------------------------------------------
  // Load guard
  // The script can arrive twice: once from the manifest and again when the
  // background worker or side panel injects it into a tab that was already open.
  // A live copy wins. A copy left behind by an update or reload of the extension
  // can no longer talk to the extension, so the new copy replaces it.
  // ---------------------------------------------------------------------------
  const previous = window.__cdhInstance;
  if (previous) {
    let alive = false;
    try { alive = typeof previous.isAlive === "function" && previous.isAlive(); } catch (_) { alive = false; }
    if (alive) return;
    try { previous.teardown && previous.teardown(); } catch (_) { /* old copy is gone */ }
  }

  // After an extension update the old copy lives in a separate script world that this
  // copy can't see. Page DOM events cross that boundary, so announce the takeover and
  // the old copy removes its checkboxes and status card before this one adds its own.
  const OWNER = `cdh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  document.dispatchEvent(new CustomEvent("cdh-takeover", { detail: OWNER }));

  const CHECKBOX_CLASS = "cdh-checkbox";
  const ROW_CLASS = "cdh-row";
  const FAILED_CLASS = "cdh-failed";
  const DELETED_CLASS = "cdh-deleted";
  const STATUS_ID = "cdh-status";

  const CHAT_SELECTORS = [
    '[role="option"][aria-label]',
    '[data-testid*="chat" i]',
    '[data-testid*="conversation" i]',
    '[aria-label][role="listitem"]',
    'nav [aria-label][tabindex]',
    'aside [aria-label][tabindex]'
  ];

  const EXCLUDE_RE = /new chat|settings|upgrade|profile|account|sign in|sign out|copilot pro|apps|plugins|notebook|discover|recent activity|clear all/i;

  // ---------------------------------------------------------------------------
  // Which site are we on? Each site has its own small adapter further down;
  // everything else (checkboxes, the delete loop, progress, Stop) is shared.
  // ---------------------------------------------------------------------------
  const HOST = location.hostname;
  const SITE = /(^|\.)(chatgpt\.com|openai\.com)$/.test(HOST) ? "chatgpt"
    : /(^|\.)claude\.ai$/.test(HOST) ? "claude"
    : "copilot";
  const SITE_LABEL = { copilot: "Copilot", chatgpt: "ChatGPT", claude: "Claude" }[SITE];
  const MENU_BUTTON = 'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]';

  const SPEEDS = {
    fast: {
      label: "Fast",
      menuDelay: 70, deleteDelay: 110, settleDelay: 120, betweenDelay: 80,
      menuTimeout: 650, optionTimeout: 900, confirmTimeout: 1100, verifyTimeout: 1800,
      retries: 1, loadDelay: 250
    },
    balanced: {
      label: "Balanced",
      menuDelay: 120, deleteDelay: 180, settleDelay: 200, betweenDelay: 150,
      menuTimeout: 900, optionTimeout: 1200, confirmTimeout: 1600, verifyTimeout: 2800,
      retries: 2, loadDelay: 400
    },
    safe: {
      label: "Safe",
      menuDelay: 220, deleteDelay: 320, settleDelay: 350, betweenDelay: 260,
      menuTimeout: 1400, optionTimeout: 1800, confirmTimeout: 2400, verifyTimeout: 4500,
      retries: 3, loadDelay: 700
    }
  };

  const state = {
    running: false,
    loading: false,
    cancelRequested: false,
    boxesOn: false,
    lastBox: null,
    failedKeys: new Map(), // chat key -> how many chats with that title failed
    lastJob: { total: 0, deleted: 0, failed: 0, skipped: 0, current: 0, finished: false },
    review: { url: "", minDeleted: 5, show: false }
  };

  let alive = true;
  let observer = null;
  let pushTimer = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(fn, timeout = 1000, interval = 40) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = await fn();
      if (result) return result;
      await delay(interval);
    }
    return null;
  }

  function extensionAlive() {
    try { return alive && Boolean(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Finding chats
  // ---------------------------------------------------------------------------
  function isElement(value) {
    return value instanceof Element;
  }

  function isVisible(el) {
    if (!isElement(el) || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0.01
    );
  }

  function getText(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  // The chat's own title, ignoring buttons and icons that appear on hover.
  function labelText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, [role="button"], input, svg, [aria-hidden="true"]').forEach((n) => n.remove());
    let text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) text = getText(el).replace(/[⋯…•·]+/g, "").trim();
    return `${el.getAttribute("aria-label") || ""} ${text}`.replace(/\s+/g, " ").trim();
  }

  function combinedText(el) {
    return `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${getText(el)}`.trim();
  }

  function isOurs(el) {
    return Boolean(el.closest(`#${STATUS_ID}`));
  }

  function looksLikeChat(el) {
    if (!isVisible(el) || isOurs(el)) return false;

    const text = combinedText(el);
    if (!text || text.length < 2) return false;
    if (EXCLUDE_RE.test(text)) return false;

    const rect = el.getBoundingClientRect();
    if (rect.height < 18 || rect.height > 120) return false;
    if (rect.width < 90) return false;

    const interactive = el.matches('[role="option"], [role="listitem"], [tabindex], a, button') ||
      el.querySelector('button, a, [role="button"], [tabindex]');

    return Boolean(interactive);
  }

  function sortByTop(set) {
    return [...set].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  // Counts chat links inside an element, so a row can be told apart from a whole list.
  function countLinks(el, test) {
    let n = 0;
    el.querySelectorAll("a[href]").forEach((a) => { if (test(a.getAttribute("href") || "")) n += 1; });
    return n;
  }

  // Walks up from a chat link to the smallest block that holds only that chat and its menu button.
  function rowAroundLink(link, test) {
    let row = link;
    let best = null;
    for (let i = 0; i < 5 && row; i += 1) {
      if (row.querySelector(MENU_BUTTON)) { best = row; break; }
      const parent = row.parentElement;
      if (!parent || parent === document.body || countLinks(parent, test) !== 1) break;
      row = parent;
    }
    return best;
  }

  // ChatGPT: each chat is a row (role="group") in the sidebar with a link to /c/<id> and a "..." menu button.
  const CHATGPT_LINK = (href) => /\/c\/[^/?#]+/.test(href);
  function getChatGptChats() {
    const rows = new Set();
    document.querySelectorAll("a[href]").forEach((link) => {
      if (!CHATGPT_LINK(link.getAttribute("href") || "") || isOurs(link)) return;
      let row = link.closest('[role="group"]');
      if (!row || !row.querySelector(MENU_BUTTON)) row = rowAroundLink(link, CHATGPT_LINK);
      if (row && isVisible(row)) rows.add(row);
    });
    return sortByTop(rows);
  }

  // Claude: the Chats page (/recents) is a table with one row per chat; the sidebar lists
  // recent chats as rows too. On the Chats page the table is the list, so use it alone
  // (the sidebar shows the same chats and would count everything twice).
  const CLAUDE_LINK = (href) => /^\/chat\/[^/?#]+/.test(href);
  function getClaudeChats() {
    const tableRows = new Set();
    document.querySelectorAll("table a[href]").forEach((link) => {
      if (!CLAUDE_LINK(link.getAttribute("href") || "") || isOurs(link)) return;
      const tr = link.closest("tr");
      if (tr && isVisible(tr) && tr.querySelector(MENU_BUTTON)) tableRows.add(tr);
    });
    if (tableRows.size) return sortByTop(tableRows);

    const rows = new Set();
    document.querySelectorAll("a[href]").forEach((link) => {
      if (!CLAUDE_LINK(link.getAttribute("href") || "") || isOurs(link)) return;
      let row = link.closest(".hit-row");
      if (!row || !row.querySelector(MENU_BUTTON)) row = rowAroundLink(link, CLAUDE_LINK);
      if (row && isVisible(row)) rows.add(row);
    });
    return sortByTop(rows);
  }

  function getChats() {
    if (SITE === "chatgpt") return getChatGptChats();
    if (SITE === "claude") return getClaudeChats();
    return getCopilotChats();
  }

  function getCopilotChats() {
    const found = new Set();
    for (const selector of CHAT_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        if (looksLikeChat(el)) found.add(el);
      });
    }
    // Microsoft 365 Copilot: each chat is a link to /chat/conversation/<id> inside a row that also
    // holds the hover "..." button. Use that row so the menu button is inside what we hover.
    // When these links exist they ARE the chat list, so ignore the looser matches above (they
    // would also pick up the suggestion chips in the middle of the page).
    const linkRows = new Set();
    document.querySelectorAll('a[href*="/chat/conversation/"]').forEach((link) => {
      if (isOurs(link) || !isVisible(link)) return;
      const row = link.parentElement && link.parentElement !== document.body && link.parentElement.querySelectorAll('a[href]').length === 1
        ? link.parentElement : link;
      if (row.getBoundingClientRect().height >= 18) linkRows.add(row);
    });
    if (linkRows.size) {
      return [...linkRows].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    }
    // Keep the outermost match when one chat row contains another match.
    const list = [...found].filter((el) => ![...found].some((other) => other !== el && other.contains(el)));
    return list.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  // A stable identity for a chat: its link when it has one, otherwise its title.
  function chatKey(el) {
    if (el.dataset.cdhKey) return el.dataset.cdhKey;
    const link = el.matches("a[href]") ? el : el.querySelector("a[href]");
    const href = link ? link.getAttribute("href") : "";
    const testId = el.getAttribute("data-testid") || "";
    const id = el.getAttribute("id") || "";
    const key = href ? `href:${href}` : (id && !/^:r/.test(id) ? `id:${id}` : `text:${testId}|${labelText(el)}`);
    el.dataset.cdhKey = key;
    return key;
  }

  function freshKey(el) {
    delete el.dataset.cdhKey;
    return chatKey(el);
  }

  function countKey(key) {
    return getChats().filter((el) => freshKey(el) === key).length;
  }

  function findRowByKey(key) {
    return getChats().find((el) => freshKey(el) === key) || null;
  }

  function getBoxes() {
    return [...document.querySelectorAll(`.${CHECKBOX_CLASS}`)].filter(isVisible);
  }

  function rowOfBox(box) {
    return box.closest(`.${ROW_CLASS}`) || box.closest(CHAT_SELECTORS.join(","));
  }

  function getSelectedRows() {
    return getBoxes()
      .filter((box) => box.checked && !box.disabled)
      .map(rowOfBox)
      .filter(Boolean)
      .filter(isVisible)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  // ---------------------------------------------------------------------------
  // On-page status card
  // ---------------------------------------------------------------------------
  function ensureStatus() {
    let status = document.getElementById(STATUS_ID);
    if (status && status.dataset.cdhOwner === OWNER) return status;
    if (status) status.remove();

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.dataset.cdhOwner = OWNER;
    status.setAttribute("role", "status");

    const title = document.createElement("div");
    title.className = "cdh-status-title";
    title.textContent = "Clearcut Chats";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "cdh-status-close";
    close.setAttribute("aria-label", "Hide status");
    close.textContent = "×";
    close.addEventListener("click", () => { status.style.display = "none"; });

    const msg = document.createElement("div");
    msg.className = "cdh-status-message";
    msg.textContent = "Ready";

    const meter = document.createElement("div");
    meter.className = "cdh-status-meter";
    meter.appendChild(document.createElement("span"));

    const review = document.createElement("div");
    review.className = "cdh-status-review";
    review.hidden = true;
    const reviewText = document.createElement("span");
    reviewText.textContent = "Saved you some clicks? A quick review helps a lot.";
    const reviewLink = document.createElement("a");
    reviewLink.className = "cdh-status-review-link";
    reviewLink.target = "_blank";
    reviewLink.rel = "noopener noreferrer";
    reviewLink.textContent = "Leave a review";
    review.append(reviewText, reviewLink);

    status.append(close, title, msg, meter, review);
    document.documentElement.appendChild(status);
    return status;
  }

  function setStatus(message, progressPercent = null, show = true) {
    const status = ensureStatus();
    const msg = status.querySelector(".cdh-status-message");
    const bar = status.querySelector(".cdh-status-meter span");
    const review = status.querySelector(".cdh-status-review");

    if (msg) msg.textContent = message;
    if (bar && typeof progressPercent === "number") {
      bar.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
    }
    if (review) {
      const link = review.querySelector("a");
      if (state.review.show && state.review.url && /^https:\/\//.test(state.review.url)) {
        link.href = state.review.url;
        review.hidden = false;
      } else {
        review.hidden = true;
      }
    }
    status.style.display = show ? "block" : "none";
  }

  // ---------------------------------------------------------------------------
  // Stats and live updates to the side panel
  // ---------------------------------------------------------------------------
  function getFailedCount() {
    let n = 0;
    state.failedKeys.forEach((count) => { n += count; });
    return n;
  }

  function getStats(extra = {}) {
    const chats = getChats();
    const boxes = getBoxes();
    const selected = boxes.filter((box) => box.checked && !box.disabled).length;
    const job = state.lastJob;
    const progressPercent = job.total
      ? Math.round(((job.deleted + job.failed + job.skipped) / job.total) * 100)
      : 0;

    return {
      connected: true,
      version: VERSION,
      site: SITE,
      siteLabel: SITE_LABEL,
      loaded: chats.length,
      checkboxes: boxes.length,
      boxesOn: state.boxesOn,
      selected,
      failed: getFailedCount(),
      running: state.running,
      loading: state.loading,
      progressPercent,
      job: { ...job },
      ...extra
    };
  }

  function push(event, extra = {}) {
    if (!extensionAlive()) return;
    try {
      const p = chrome.runtime.sendMessage({ type: "cdh:update", event, stats: getStats(), ...extra });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {
      // Side panel is closed or the extension was reloaded.
    }
  }

  function pushSoon(event = "stats") {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(event), 150);
  }

  // ---------------------------------------------------------------------------
  // Checkboxes
  // ---------------------------------------------------------------------------
  function markRow(row) {
    row.classList.add(ROW_CLASS);
    row.dataset.cdhChatRow = "true";
    chatKey(row);
  }

  function addBoxTo(chat) {
    markRow(chat);
    const target = boxTarget(chat);
    const existing = chat.querySelector(`.${CHECKBOX_CLASS}`);
    if (existing && existing.dataset.cdhOwner === OWNER && existing.parentElement === target) return false;
    if (existing) existing.remove(); // left behind by an older copy, or in a cell that is not shown

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = CHECKBOX_CLASS;
    box.dataset.cdhOwner = OWNER;
    box.title = `Select this ${SITE_LABEL} chat`;
    box.setAttribute("aria-label", `Select ${SITE_LABEL} chat for deletion`);

    box.addEventListener("click", (event) => {
      event.stopPropagation();
      const boxes = getBoxes();

      if (event.shiftKey && state.lastBox) {
        const start = boxes.indexOf(state.lastBox);
        const end = boxes.indexOf(box);
        if (start !== -1 && end !== -1) {
          const [from, to] = start < end ? [start, end] : [end, start];
          for (let i = from; i <= to; i += 1) {
            if (!boxes[i].disabled) boxes[i].checked = box.checked;
          }
        }
      }

      state.lastBox = box;
      pushSoon("selection");
    });

    for (const eventName of ["mousedown", "pointerdown", "mouseup", "pointerup", "dblclick"]) {
      box.addEventListener(eventName, (event) => event.stopPropagation());
    }

    if (state.failedKeys.has(chatKey(chat))) chat.classList.add(FAILED_CLASS);

    target.prepend(box);
    return true;
  }

  // Where the checkbox goes inside a row. A table row puts it in its first column that has width
  // (Claude's Chats page keeps its first column empty and zero-wide, which would hide the box).
  function boxTarget(chat) {
    if (chat.tagName === "TR") {
      const cell = [...chat.children].find((td) => td.getBoundingClientRect().width > 0);
      return cell || chat.firstElementChild || chat;
    }
    const first = chat.firstElementChild;
    return !first || first.matches("a[href]") ? chat : first;
  }

  // Drops checkboxes from rows that are no longer part of the chat list, for example the sidebar
  // rows that were ticked before Claude's Chats page opened and became the list.
  function pruneStale(chats) {
    const keep = new Set(chats);
    document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((box) => {
      const row = rowOfBox(box);
      if (row && !keep.has(row)) {
        box.remove();
        row.classList.remove(ROW_CLASS, FAILED_CLASS, DELETED_CLASS);
        delete row.dataset.cdhChatRow;
      }
    });
  }

  function addCheckboxes(quiet = false) {
    state.boxesOn = true;
    startObserver();
    let added = 0;
    const chats = getChats();
    pruneStale(chats);
    for (const chat of chats) {
      if (addBoxTo(chat)) added += 1;
    }
    if (!chats.length) {
      const where = SITE === "claude" ? "Open the Chats page or the sidebar's chat list"
        : SITE === "chatgpt" ? "Open the sidebar's chat list"
        : "Open the chat list in Copilot's sidebar";
      const message = `No chats found on this page. ${where} and try again. If you can see chats and this keeps happening, email owen@ghostwrightweb.com.`;
      if (!quiet) setStatus(message, null, true);
      return { message, stats: getStats() };
    }
    if (!quiet) setStatus(`Added ${added} checkbox(es). Loaded chats: ${chats.length}.`, null, true);
    return { message: `Added ${added} checkbox(es). ${chats.length} chats loaded.`, stats: getStats() };
  }

  function clearMarks() {
    document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((box) => box.remove());
    document.querySelectorAll(`.${ROW_CLASS}`).forEach((row) => {
      row.classList.remove(ROW_CLASS, FAILED_CLASS, DELETED_CLASS);
      row.style.opacity = "";
      row.style.pointerEvents = "";
      delete row.dataset.cdhChatRow;
      delete row.dataset.cdhKey;
    });
  }

  function removeCheckboxes() {
    const count = document.querySelectorAll(`.${CHECKBOX_CLASS}`).length;
    state.boxesOn = false;
    stopObserver();
    clearMarks();
    state.lastBox = null;
    state.failedKeys.clear();
    setStatus("Checkboxes removed.", 0, false);
    return { message: `Removed ${count} checkbox(es).`, stats: getStats() };
  }

  function selectAll() {
    addCheckboxes(true);
    const boxes = getBoxes().filter((box) => !box.disabled);
    boxes.forEach((box) => { box.checked = true; });
    setStatus(`Selected ${boxes.length} visible chat(s).`, null, true);
    return { message: `Selected ${boxes.length} loaded chat(s).`, stats: getStats() };
  }

  function deselectAll() {
    getBoxes().forEach((box) => { box.checked = false; });
    setStatus("Deselected all chats.", null, true);
    return { message: "Deselected all chats.", stats: getStats() };
  }

  // New chats that Copilot renders later (scrolling, lazy loading) get checkboxes too.
  function startObserver() {
    if (observer) return;
    let timer = null;
    observer = new MutationObserver((mutations) => {
      if (!state.boxesOn) return;
      const relevant = mutations.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !(n.classList && n.classList.contains(CHECKBOX_CLASS)) && !isOurs(n)));
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!state.boxesOn || state.running) return;
        let added = 0;
        const chats = getChats();
        pruneStale(chats);
        chats.forEach((chat) => { if (addBoxTo(chat)) added += 1; });
        if (added) pushSoon("stats");
      }, 300);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
  }

  // ---------------------------------------------------------------------------
  // Driving Copilot's own UI
  // ---------------------------------------------------------------------------
  function hover(el) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  function clickElement(el) {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
    return true;
  }

  function pressEscape() {
    const opts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
  }

  function elementCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  async function getMenuButton(chat, speed) {
    hover(chat);
    await delay(speed.menuDelay);

    // ChatGPT and Claude: the row's "..." button opens a menu. It can be hidden until the
    // row is hovered, which a script click does not need, so no visibility check here.
    if (SITE !== "copilot") {
      const own = [...chat.querySelectorAll(MENU_BUTTON)].filter((btn) => !isOurs(btn) && !btn.classList.contains(CHECKBOX_CLASS));
      if (own.length) return own[own.length - 1];
    }

    const directSelectors = [
      'button[title*="Options" i]',
      'button[title*="More" i]',
      'button[aria-label*="options" i]',
      'button[aria-label*="more" i]',
      'button[aria-label*="menu" i]',
      'button[data-testid*="menu" i]',
      'button[data-testid*="option" i]',
      '[role="button"][aria-label*="options" i]',
      '[role="button"][aria-label*="more" i]'
    ];

    for (const selector of directSelectors) {
      const direct = chat.querySelector(selector);
      if (direct && isVisible(direct)) return direct;
    }

    const chatCenter = elementCenter(chat);
    const candidates = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter((btn) => !isOurs(btn))
      .filter((btn) => {
        const text = `${btn.title || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("data-testid") || ""} ${getText(btn)}`;
        if (!/view options|more|menu|options|ellipsis|⋯|…/i.test(text)) return false;
        const btnCenter = elementCenter(btn);
        return Math.abs(btnCenter.y - chatCenter.y) < 48 && Math.abs(btnCenter.x - chatCenter.x) < Math.max(360, chat.getBoundingClientRect().width + 80);
      })
      .sort((a, b) => Math.abs(elementCenter(a).y - chatCenter.y) - Math.abs(elementCenter(b).y - chatCenter.y));

    if (candidates[0]) return candidates[0];

    // Last resort: any visible button that lives inside the row itself (the hover "..." button).
    const own = [...chat.querySelectorAll("button, [role='button']")]
      .filter(isVisible)
      .filter((btn) => !isOurs(btn) && !btn.classList.contains(CHECKBOX_CLASS));
    return own[own.length - 1] || null;
  }

  function getOpenMenuRoot() {
    const selectors = [
      '[role="menu"]',
      '[role="dialog"]',
      '[role="listbox"]',
      '[data-testid*="menu" i]',
      '[data-testid*="popover" i]',
      '[class*="popover" i]',
      '[class*="menu" i]'
    ];

    for (const selector of selectors) {
      const roots = [...document.querySelectorAll(selector)]
        .filter(isVisible)
        .filter((el) => !isOurs(el))
        .filter((el) => /delete/i.test(getText(el)));
      if (roots.length) return roots[roots.length - 1];
    }
    return document;
  }

  function getDeleteOption() {
    if (SITE === "claude") {
      const direct = document.querySelector('[data-testid="delete-chat-trigger"]');
      if (direct && isVisible(direct)) return direct;
    }
    const root = getOpenMenuRoot();
    const candidates = [...root.querySelectorAll('button, [role="menuitem"], [role="button"], div, span')]
      .filter(isVisible)
      .filter((el) => !isOurs(el) && !el.closest(`.${ROW_CLASS}`))
      .filter((el) => {
        const text = getText(el);
        const aria = el.getAttribute("aria-label") || "";
        return /^delete$/i.test(text) || /^delete$/i.test(aria) || /^delete (chat|conversation)$/i.test(`${text}`) || /^delete (chat|conversation)$/i.test(aria);
      });

    // Prefer the real control (button or menu item) over a text span inside it.
    const control = candidates.find((el) => el.matches('button, [role="menuitem"], [role="button"]'));
    return control || candidates[0] || null;
  }

  function getConfirmButton() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')]
      .filter(isVisible)
      .filter((el) => !isOurs(el));
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;

    const candidates = [...scope.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter((el) => !isOurs(el) && !el.closest(`.${ROW_CLASS}`))
      .filter((el) => {
        const text = getText(el);
        const aria = el.getAttribute("aria-label") || "";
        return /^(delete|confirm|yes|remove)$/i.test(text) || /\bdelete\b/i.test(text) || /\bdelete\b/i.test(aria);
      });

    const destructive = candidates.find((el) => /delete/i.test(getText(el)) || /delete/i.test(el.getAttribute("aria-label") || ""));
    return destructive || candidates[0] || null;
  }

  // Deletes one chat and only reports success once the chat is gone from the list.
  async function deleteOne(key, speed, el) {
    // Use the very row that was ticked. Chats can share a title, so the key alone is not enough.
    const row = (el && el.isConnected && isVisible(el)) ? el : findRowByKey(key);
    if (!row) {
      // Already gone (for example deleted in another tab).
      return { alreadyGone: true };
    }

    const before = countKey(key);
    row.classList.remove(FAILED_CLASS);

    const menu = await waitFor(() => getMenuButton(row, speed), speed.menuTimeout, 50);
    if (!menu) throw new Error("Couldn't find the chat's menu button.");

    clickElement(menu);
    await delay(speed.deleteDelay);

    const del = await waitFor(() => getDeleteOption(), speed.optionTimeout, 50);
    if (!del) {
      pressEscape();
      throw new Error("Couldn't find Delete in the chat menu.");
    }

    clickElement(del);
    await delay(speed.deleteDelay);

    const confirmBtn = await waitFor(() => getConfirmButton(), speed.confirmTimeout, 50);
    if (confirmBtn) clickElement(confirmBtn);

    const gone = await waitFor(() => countKey(key) < before, speed.verifyTimeout, 80);
    if (!gone) {
      pressEscape();
      throw new Error(confirmBtn ? `${SITE_LABEL} still shows this chat after deleting.` : `${SITE_LABEL} didn't show a delete confirmation.`);
    }

    await delay(speed.settleDelay);
    return { alreadyGone: false };
  }

  async function runDeleteJob(items, mode, sourceLabel) {
    const speed = SPEEDS[mode] || SPEEDS.balanced;
    const total = items.length;

    state.running = true;
    state.cancelRequested = false;
    state.review.show = false;
    state.lastJob = { total, deleted: 0, failed: 0, skipped: 0, current: 0, finished: false, mode: speed.label, source: sourceLabel };
    push("job-start");

    let deleted = 0;
    let failed = 0;
    let skipped = 0;

    for (let index = 0; index < total; index += 1) {
      const { key, el, retry } = items[index];
      state.lastJob.current = index + 1;

      // A chat being retried leaves the failed list while it is tried again; it goes back on if it fails again.
      if (retry) {
        const prev = state.failedKeys.get(key) || 0;
        if (prev > 1) state.failedKeys.set(key, prev - 1); else state.failedKeys.delete(key);
      }

      if (state.cancelRequested || !extensionAlive()) {
        skipped = total - index;
        state.lastJob.skipped = skipped;
        break;
      }

      const progress = Math.round((index / total) * 100);
      setStatus(`Deleting ${index + 1}/${total} using ${speed.label} mode...`, progress, true);
      push("progress");

      let success = false;
      let lastError = null;

      for (let attempt = 0; attempt <= speed.retries; attempt += 1) {
        if (state.cancelRequested) break;
        try {
          if (attempt > 0) {
            setStatus(`Retrying ${index + 1}/${total} (attempt ${attempt + 1})...`, progress, true);
            await delay(speed.betweenDelay * (attempt + 1));
          }
          await deleteOne(key, speed, el);
          success = true;
          break;
        } catch (err) {
          lastError = err;
          console.warn("[Clearcut Chats] delete attempt failed:", err?.message || err);
        }
      }

      if (!success && state.cancelRequested && !lastError) {
        if (retry) state.failedKeys.set(key, (state.failedKeys.get(key) || 0) + 1);
        skipped = total - index;
        state.lastJob.skipped = skipped;
        break;
      }

      const row = el && el.isConnected ? el : (success ? null : findRowByKey(key));
      const box = row && row.querySelector(`.${CHECKBOX_CLASS}`);

      if (success) {
        deleted += 1;
        if (row) {
          // Rarely Copilot keeps a stale copy of the row on screen; grey it out.
          row.classList.add(DELETED_CLASS);
          row.style.opacity = "0.35";
          row.style.pointerEvents = "none";
          if (box) { box.checked = false; box.disabled = true; }
        }
      } else {
        failed += 1;
        state.failedKeys.set(key, (state.failedKeys.get(key) || 0) + 1);
        if (row) {
          row.classList.add(FAILED_CLASS);
          if (box) {
            box.checked = false;
            box.title = lastError?.message ? `Failed: ${lastError.message}` : "Delete failed";
          }
        }
      }

      state.lastJob.deleted = deleted;
      state.lastJob.failed = failed;
      state.lastJob.skipped = skipped;

      const completed = deleted + failed + skipped;
      setStatus(`Deleted ${deleted} | Failed ${failed} | Left ${total - completed}`, Math.round((completed / total) * 100), true);
      push("progress");
      await delay(speed.betweenDelay);
    }

    state.running = false;
    const stopped = state.cancelRequested;
    state.cancelRequested = false;
    state.lastJob.finished = true;
    state.lastJob.stopped = stopped;

    if (state.boxesOn) addCheckboxes(true);

    state.review.show = deleted >= state.review.minDeleted && failed === 0;
    const final = `${stopped ? "Stopped" : "Done"}. Deleted ${deleted} of ${total}` +
      (failed ? ` | Failed ${failed} (use Retry Failed)` : "") +
      (skipped ? ` | Skipped ${skipped}` : "");
    setStatus(final, 100, true);
    push("job-done", { message: final, deletedThisRun: deleted });
  }

  function startDelete(rows, request, sourceLabel) {
    if (state.running) {
      return { ok: false, message: "A deletion job is already running.", stats: getStats() };
    }
    if (state.loading) {
      return { ok: false, message: "Wait for Load More to finish first.", stats: getStats() };
    }

    // One entry per ticked row. Chats with the same title are separate chats, so keep them all.
    const items = [...new Set(rows.filter((row) => row && row.isConnected))].map((row) => ({ key: freshKey(row), el: row, retry: sourceLabel === "failed" }));
    if (!items.length) {
      const message = `No ${sourceLabel} chats found.`;
      setStatus(message, null, true);
      return { ok: true, message, stats: getStats() };
    }

    if (request.reviewUrl) state.review.url = String(request.reviewUrl);
    if (Number.isFinite(request.reviewMin)) state.review.minDeleted = request.reviewMin;

    // Runs in the background so the side panel can show progress and stop it at any time.
    runDeleteJob(items, request.mode, sourceLabel).catch((err) => {
      console.error("[Clearcut Chats]", err);
      state.running = false;
      setStatus(`Stopped: ${err?.message || "unexpected error"}`, null, true);
      push("job-done", { message: "Stopped because of an unexpected error." });
    });

    return { ok: true, started: true, message: `Deleting ${items.length} ${sourceLabel} chat(s)...`, stats: getStats() };
  }

  function failedRows() {
    const rows = [];
    state.failedKeys.forEach((count, key) => {
      rows.push(...getChats().filter((el) => freshKey(el) === key).slice(0, count));
    });
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Load More: scroll the chat list down until Copilot stops adding chats
  // ---------------------------------------------------------------------------
  function findScrollContainers() {
    const chats = getChats();
    const candidates = [...document.querySelectorAll("aside, nav, main, section, div, ul")]
      .filter(isVisible)
      .filter((el) => {
        const style = getComputedStyle(el);
        const canScroll = /(auto|scroll|overlay)/i.test(`${style.overflowY} ${style.overflow}`);
        return canScroll && el.scrollHeight > el.clientHeight + 20;
      })
      .map((el) => ({ el, chats: chats.filter((c) => el.contains(c)).length }))
      .filter((item) => item.chats > 0)
      .sort((a, b) => b.chats - a.chats || a.el.scrollHeight - b.el.scrollHeight);

    return candidates.map((item) => item.el);
  }

  async function loadMoreChats(mode) {
    if (state.running) return { ok: false, message: "Wait for the current deletion to finish.", stats: getStats() };
    if (state.loading) return { ok: false, message: "Already loading chats.", stats: getStats() };

    const speed = SPEEDS[mode] || SPEEDS.balanced;
    state.loading = true;
    state.cancelRequested = false;
    try {
      const before = getChats().length;
      const started = Date.now();
      const MAX_MS = 20 * 60 * 1000;                       // safety net only; Stop works at any time
      // How long the list may sit still before we decide it is complete. Slow connections and
      // very long histories (ChatGPT fetches older chats in batches) need real patience.
      const patience = Math.max(8000, speed.loadDelay * 14);
      const spinnerPatience = 45000;                       // keep waiting while the site shows a loading spinner

      let lastCount = before;
      let idleMs = 0;
      let spinnerMs = 0;
      let pass = 0;
      let endedBy = "end";

      const scrollers = () => {
        const list = findScrollContainers().slice(0, 3);
        return list.length ? list : [document.scrollingElement || document.documentElement];
      };
      const spinning = () => [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"], .animate-spin')]
        .some((el) => isVisible(el) && !isOurs(el));

      setStatus("Scrolling the chat list to load more chats...", 5, true);
      push("loading");

      while (true) {
        if (state.cancelRequested) { endedBy = "stopped"; break; }
        if (Date.now() - started > MAX_MS) { endedBy = "time"; break; }
        pass += 1;

        // Scroll every scrolling area that holds chats; a small step back first re-triggers lists
        // that only load when the bottom comes into view again.
        for (const target of scrollers()) {
          target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight - 160);
        }
        await delay(60);
        for (const target of scrollers()) {
          target.scrollTop = target.scrollHeight;
          target.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        const last = getChats().pop();
        if (last) last.scrollIntoView({ block: "end" });

        // Some lists end with a "Show more" style button instead of loading on scroll.
        const moreBtn = [...document.querySelectorAll("button, a[role='button']")]
          .filter(isVisible)
          .filter((btn) => !isOurs(btn) && /^(show|load|view|see) (more|all|older)( chats)?$/i.test(getText(btn)))[0];
        if (moreBtn) clickElement(moreBtn);

        // Wait for the list to actually grow instead of for a fixed moment.
        const waitStart = Date.now();
        const waitMax = Math.max(1500, speed.loadDelay * 5);
        while (Date.now() - waitStart < waitMax && !state.cancelRequested) {
          await delay(100);
          if (getChats().length > lastCount) break;
        }
        if (state.boxesOn) getChats().forEach((chat) => addBoxTo(chat));

        const count = getChats().length;
        if (count > lastCount) {
          lastCount = count;
          idleMs = 0;
          spinnerMs = 0;
        } else {
          const waited = Date.now() - waitStart;
          if (spinning() && spinnerMs < spinnerPatience) spinnerMs += waited; else idleMs += waited;
        }

        setStatus(`Loading... ${count} chats loaded. Press Stop in the panel to stop sooner.`, Math.min(95, 5 + pass), true);
        push("loading");

        if (idleMs >= patience) break;
      }
      const after = getChats().length;
      const added = Math.max(0, after - before);
      const why = endedBy === "stopped" ? " Stopped."
        : endedBy === "time" ? " Stopped after 20 minutes; run Load more again to continue."
        : "";
      const message = added
        ? `Loaded ${added} more chat(s). ${after} chats loaded.${why}`
        : `No more chats appeared. ${after} chats loaded.${why}`;
      setStatus(message, 100, true);
      // Clear the flags before building the reply, so the panel never sees a stale "loading".
      state.loading = false;
      state.cancelRequested = false;
      return { ok: true, message, stats: getStats() };
    } finally {
      state.loading = false;
      state.cancelRequested = false;
      push("loaded");
    }
  }

  // ---------------------------------------------------------------------------
  // Messages from the side panel
  // ---------------------------------------------------------------------------
  async function routeMessage(request) {
    switch (request.action) {
      case "ping":
      case "stats":
        return { ok: true, message: "Connected.", stats: getStats() };
      case "add":
        return { ok: true, ...addCheckboxes() };
      case "remove":
        return { ok: true, ...removeCheckboxes() };
      case "selectAll":
        return { ok: true, ...selectAll() };
      case "deselectAll":
        return { ok: true, ...deselectAll() };
      case "loadMore":
        return await loadMoreChats(request.mode);
      case "deleteSelected":
        return startDelete(getSelectedRows(), request, "selected");
      case "retryFailed":
        return startDelete(failedRows(), request, "failed");
      case "cancel":
        if (!state.running && !state.loading) return { ok: true, message: "Nothing is running.", stats: getStats() };
        state.cancelRequested = true;
        setStatus("Stopping after the current chat...", null, true);
        return { ok: true, message: "Stopping after the current chat.", stats: getStats() };
      default:
        return { ok: false, message: "Unknown action.", stats: getStats() };
    }
  }

  function onMessage(request, sender, sendResponse) {
    if (!request || typeof request.action !== "string") return false;
    routeMessage(request)
      .then(sendResponse)
      .catch((err) => {
        console.error("[Clearcut Chats]", err);
        sendResponse({ ok: false, message: err?.message || "Unexpected error.", stats: getStats() });
      });
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);

  function teardown() {
    alive = false;
    state.cancelRequested = true;
    stopObserver();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) { /* context gone */ }
    clearMarks();
    const status = document.getElementById(STATUS_ID);
    if (status && status.dataset.cdhOwner === OWNER) status.remove();
  }

  document.addEventListener("cdh-takeover", (event) => {
    if (event.detail !== OWNER && alive) teardown();
  });

  window.__cdhInstance = {
    version: VERSION,
    isAlive: extensionAlive,
    teardown
  };

  document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((box) => {
    if (box.dataset.cdhOwner !== OWNER) box.remove();
  });

  // Tell an open side panel that this tab is ready.
  push("ready");
})();
