# Copilot Chat Batch Delete Helper 1.1.0

Chrome / Edge extension for bulk deleting Microsoft Copilot chats. Privacy-first: no servers, no telemetry.

## Folder map
- `Extension/` the runtime files. This is what gets zipped and submitted.
- `Package/` the submission zip.
- `Docs/` changelog, privacy policy, store listing text, release note, testing checklist.
- `Website Pages/` welcome.html and whats-new.html for ghostwrightweb.com.
- `Tests/` the automated browser tests (mock Copilot page).

## How it works
- `manifest.json` Manifest V3. Permissions: scripting, sidePanel, storage. Site access: Copilot hosts only (shared Microsoft 365 hosts only on /chat).
- `background.js` service worker. Opens the side panel on icon click, injects the helper into already-open Copilot tabs on install / update / browser start, opens the welcome page (install) and what's-new page (major update only).
- `content.js` runs in the Copilot page. Finds chats, adds checkboxes, drives Copilot's own menu and confirm button, verifies each chat disappears, reports live progress to the panel. A takeover handshake replaces an orphaned copy after an update.
- `panel.html / panel.css / panel.js` the side panel. Connects to the active Copilot tab, injects on demand if needed, shows live stats, confirmation, review and share.
- `config.js` the one place for links, support email and the host list.
- `styles.css` checkbox, row and status-card styles injected in the page.

## Things you may change later (all in config.js)
- `supportEmail`, `websiteUrl`, `welcomeUrl`, `whatsNewUrl`
- `edge.listingLive` and `edge.listingUrl` / `edge.reviewUrl`: set to true and paste the real Edge Add-ons URL once the Edge listing is live. Until then, Edge users are sent to the Chrome Web Store link.
- `reviewNudgeMinDeleted`: how many deleted chats trigger the review reminder (default 5).
- `openWelcomeOnInstall`, `openWhatsNewOnMajorUpdate`: switch the website pages on or off.

If you add a host, add it in BOTH config.js (`copilotSites`) and manifest.json (`host_permissions` and `content_scripts.matches`).

## Which updates open the what's-new page
Only when the first or second number changes (1.1.x to 1.2.0 or 2.0.0). 1.1.0 to 1.1.1 opens nothing.

## Run the tests
```
cd Tests
python3 run_test.py ../Extension                  # delete flow, stop, retry, load more
python3 run_inject_test.py ../Extension HOST /chat # install/update with Copilot already open
python3 run_scope_test.py ../Extension             # shared M365 hosts: /chat only
```
Needs Python Playwright with Chromium.

## Install locally
chrome://extensions or edge://extensions, turn on Developer mode, Load unpacked, pick the `Extension` folder.

Not affiliated with Microsoft. MIT license.
