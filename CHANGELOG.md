# Changelog

## 1.2.0 (2026-10-22)

**New name: Clearcut Chats**
- Same extension, same ID, same settings. Renamed because it now covers more than one site, and given a new icon.

**New: ChatGPT and Claude**
- Bulk delete now works on ChatGPT (chatgpt.com) and Claude (claude.ai), as well as Microsoft Copilot. Same checkboxes, same Stop button, same verified deletes.
- On Claude it works both on the Chats page (claude.ai/chats) and in the sidebar.
- ChatGPT and Claude are optional. They stay off until you turn each one on in the side panel, and your browser asks permission for just that site. You can turn a site off again from the same panel.
- Updating from 1.1.0 does not ask for new permissions or switch the extension off.

**Fixes**
- Retry Failed no longer counts the same stubborn chat twice in the Failed total.
- The checkboxes sit above sites that make the whole chat row clickable.
- Deleting works on Microsoft 365 Copilot layouts where a chat's menu button only appears when you hover it (before, the wrong button could be clicked and every delete failed).
- Checkboxes and ticks no longer flicker or disappear when Copilot redraws the chat list while you scroll.
- If no chats are found, the message now reminds you to expand the Chats section in the sidebar.
- The suggestion buttons under the message box (such as Draft Content) can no longer be mistaken for chats and given checkboxes.

## 1.1.0 (2026-10-21)

**Reliability**
- Works the moment it's installed or updated. Open Copilot tabs no longer need a refresh. The background worker injects the helper into open tabs on install, update and browser start, and the side panel injects it on demand if a tab isn't ready.
- An old copy left on the page after an update is replaced cleanly, so you never get duplicate checkboxes or two status cards.
- Works on every Copilot site: copilot.microsoft.com, copilot.com, copilot.cloud.microsoft, and the chat page of Microsoft 365 Copilot (m365.cloud.microsoft/chat, microsoft365.com/chat, office.com/chat). On shared Microsoft 365 sites it runs only on /chat pages.
- Follows you when Copilot navigates inside the page without reloading.

**Fixes found in real-world testing**
- Microsoft 365 Copilot: chats in the sidebar are now recognised, and nothing else on the page gets a checkbox.
- Chats that share a title are all deleted in one run (before, only one per title was handled).
- Load More now finishes cleanly and returns the panel to ready.
- Redesigned side panel: status and progress at the top, numbered steps, cleaner buttons.

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
