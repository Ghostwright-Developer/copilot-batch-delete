# Changelog

## 1.1.0 (2026-10-21)

**Reliability**
- Works the moment it's installed or updated. Open Copilot tabs no longer need a refresh. The background worker injects the helper into open tabs on install, update and browser start, and the side panel injects it on demand if a tab isn't ready.
- An old copy left on the page after an update is replaced cleanly, so you never get duplicate checkboxes or two status cards.
- Works on every Copilot site: copilot.microsoft.com, copilot.com, copilot.cloud.microsoft, and the chat page of Microsoft 365 Copilot (m365.cloud.microsoft/chat, microsoft365.com/chat, office.com/chat). On shared Microsoft 365 sites it runs only on /chat pages.
- Follows you when Copilot navigates inside the page without reloading.

**Interface**
- The popup is now a side panel. It stays open until you close it, even when you click elsewhere or switch tabs.
- Live progress, with a Stop button that works at any time during a run.
- Delete confirmation is shown inside the panel.
- Speed mode is remembered.
- New checkboxes appear automatically as Copilot loads more chats.

**Fixes**
- Load More now scrolls the chat list down until no new chats appear.
- A chat only counts as deleted once it has actually left the list. Anything Copilot refuses to delete is reported as Failed so Retry Failed can pick it up.
- Removed the `tabs` permission (no more "read your browsing history" warning). Removed `activeTab`.

**New**
- Review and share section, plus a one-time review reminder after a cleanup run.
- Support contact in the panel: owen@ghostwrightweb.com.
- Welcome page on first install, and a what's-new page on feature updates (never on small patch updates).

## 1.0.0 (2026-05-08)

- Initial release: checkboxes, shift-click ranges, Fast / Balanced / Safe modes, retries, Retry Failed, Stop, Load More, progress overlay.
