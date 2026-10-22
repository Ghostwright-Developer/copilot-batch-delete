(() => {
  "use strict";

  const VERSION = "1.1.0";

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
    failedKeys: new Set(),
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

  function getChats() {
    const found = new Set();
    for (const selector of CHAT_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        if (looksLikeChat(el)) found.add(el);
      });
    }
    // Microsoft 365 Copilot: each chat is a link to /chat/conversation/<id> inside a row that also
    // holds the hover "..." button. Use that row so the menu button is inside what we hover.
    document.querySelectorAll('a[href*="/chat/conversation/"]').forEach((link) => {
      if (isOurs(link) || !isVisible(link)) return;
      const row = link.parentElement && link.parentElement !== document.body && link.parentElement.querySelectorAll('a[href]').length === 1
        ? link.parentElement : link;
      if (row.getBoundingClientRect().height >= 18) found.add(row);
    });
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
    title.textContent = "Copilot Delete Helper";

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
    return state.failedKeys.size;
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
    const existing = chat.querySelector(`.${CHECKBOX_CLASS}`);
    if (existing && existing.dataset.cdhOwner === OWNER) return false;
    if (existing) existing.remove(); // left behind by an older copy of the extension

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = CHECKBOX_CLASS;
    box.dataset.cdhOwner = OWNER;
    box.title = "Select this Copilot chat";
    box.setAttribute("aria-label", "Select Copilot chat for deletion");

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

    const first = chat.firstElementChild;
    const insertionTarget = !first || first.matches("a[href]") ? chat : first;
    insertionTarget.prepend(box);
    return true;
  }

  function addCheckboxes(quiet = false) {
    state.boxesOn = true;
    startObserver();
    let added = 0;
    const chats = getChats();
    for (const chat of chats) {
      if (addBoxTo(chat)) added += 1;
    }
    if (!chats.length) {
      const message = "No chats found on this page. Open the chat list in Copilot's sidebar and try again. If you can see chats and this keeps happening, email owen@ghostwrightweb.com.";
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
        getChats().forEach((chat) => { if (addBoxTo(chat)) added += 1; });
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
  async function deleteOne(key, speed) {
    const row = findRowByKey(key);
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
      throw new Error(confirmBtn ? "Copilot still shows this chat after deleting." : "Copilot didn't show a delete confirmation.");
    }

    await delay(speed.settleDelay);
    return { alreadyGone: false };
  }

  async function runDeleteJob(keys, mode, sourceLabel) {
    const speed = SPEEDS[mode] || SPEEDS.balanced;
    const total = keys.length;

    state.running = true;
    state.cancelRequested = false;
    state.review.show = false;
    state.lastJob = { total, deleted: 0, failed: 0, skipped: 0, current: 0, finished: false, mode: speed.label, source: sourceLabel };
    push("job-start");

    let deleted = 0;
    let failed = 0;
    let skipped = 0;

    for (let index = 0; index < total; index += 1) {
      const key = keys[index];
      state.lastJob.current = index + 1;

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
          await deleteOne(key, speed);
          success = true;
          break;
        } catch (err) {
          lastError = err;
          console.warn("[Copilot Delete Helper] delete attempt failed:", err?.message || err);
        }
      }

      if (!success && state.cancelRequested && !lastError) {
        skipped = total - index;
        state.lastJob.skipped = skipped;
        break;
      }

      const row = findRowByKey(key);
      const box = row && row.querySelector(`.${CHECKBOX_CLASS}`);

      if (success) {
        deleted += 1;
        state.failedKeys.delete(key);
        if (row) {
          // Rarely Copilot keeps a stale copy of the row on screen; grey it out.
          row.classList.add(DELETED_CLASS);
          row.style.opacity = "0.35";
          row.style.pointerEvents = "none";
          if (box) { box.checked = false; box.disabled = true; }
        }
      } else {
        failed += 1;
        state.failedKeys.add(key);
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

    const keys = [...new Set(rows.filter((row) => row && row.isConnected).map((row) => freshKey(row)))];
    if (!keys.length) {
      const message = `No ${sourceLabel} chats found.`;
      setStatus(message, null, true);
      return { ok: true, message, stats: getStats() };
    }

    if (request.reviewUrl) state.review.url = String(request.reviewUrl);
    if (Number.isFinite(request.reviewMin)) state.review.minDeleted = request.reviewMin;

    // Runs in the background so the side panel can show progress and stop it at any time.
    runDeleteJob(keys, request.mode, sourceLabel).catch((err) => {
      console.error("[Copilot Delete Helper]", err);
      state.running = false;
      setStatus(`Stopped: ${err?.message || "unexpected error"}`, null, true);
      push("job-done", { message: "Stopped because of an unexpected error." });
    });

    return { ok: true, started: true, message: `Deleting ${keys.length} ${sourceLabel} chat(s)...`, stats: getStats() };
  }

  function failedRows() {
    return [...state.failedKeys].map((key) => findRowByKey(key)).filter(Boolean);
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
      const target = findScrollContainers()[0] || document.scrollingElement || document.documentElement;

      let lastCount = before;
      let stablePasses = 0;
      const maxPasses = 40;

      setStatus("Scrolling the chat list to load more chats...", 2, true);
      push("loading");

      for (let pass = 0; pass < maxPasses; pass += 1) {
        if (state.cancelRequested) break;

        target.scrollTop = target.scrollHeight;
        target.dispatchEvent(new Event("scroll", { bubbles: true }));
        const last = getChats().pop();
        if (last) last.scrollIntoView({ block: "end" });

        await delay(speed.loadDelay);
        if (state.boxesOn) getChats().forEach((chat) => addBoxTo(chat));

        const count = getChats().length;
        if (count > lastCount) {
          lastCount = count;
          stablePasses = 0;
        } else {
          stablePasses += 1;
        }

        setStatus(`Loading... ${count} chats loaded.`, Math.min(95, Math.round(((pass + 1) / maxPasses) * 100)), true);
        push("loading");

        // Give slow connections a few extra tries before deciding the list is complete.
        if (stablePasses >= 4) break;
      }

      const after = getChats().length;
      const added = Math.max(0, after - before);
      const message = added
        ? `Loaded ${added} more chat(s). ${after} chats loaded.`
        : `No more chats appeared. ${after} chats loaded.`;
      setStatus(message, 100, true);
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
        console.error("[Copilot Delete Helper]", err);
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
