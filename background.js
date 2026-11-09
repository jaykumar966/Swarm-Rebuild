// Swarm Rebuild — service worker.
// Toolbar click / Alt+Shift+S: if the swarm is running in this tab, stop it;
// otherwise take one screenshot (only when the page shows canvas/video/iframes,
// which the DOM can't hand back) and inject the swarm engine.

// ---- Rating / feedback links ------------------------------------------------
// STORE_REVIEW_URL: every star rating opens the store reviews page (no review gating).
//                   Built from the extension ID, so it is correct once published.
// FEEDBACK_URL:     opened only by the separate "Send feedback" button, e.g.
//                   "https://<your-subdomain>/support.html#contact"
const STORE_REVIEW_URL = "https://chromewebstore.google.com/detail/" + chrome.runtime.id + "/reviews";
const FEEDBACK_URL = "https://swarmrebuild.codinza.com/support.html#contact";
// -----------------------------------------------------------------------------

const TITLE = "Swarm Rebuild (Alt+Shift+S)";

async function flagError(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#F24822" });
    await chrome.action.setBadgeText({ tabId, text: "×" });
    await chrome.action.setTitle({ tabId, title: "Swarm Rebuild can't run on this page" });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      chrome.action.setTitle({ tabId, title: TITLE }).catch(() => {});
    }, 2500);
  } catch (_) {}
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const target = { tabId: tab.id };
  try {
    const [probe] = await chrome.scripting.executeScript({
      target,
      func: () => {
        if (window.__pageSwarm) return { running: true };
        let media = false;
        for (const el of document.querySelectorAll("canvas,video,iframe,embed,object")) {
          const r = el.getBoundingClientRect();
          if (r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
            media = true;
            break;
          }
        }
        return { running: false, media };
      },
    });
    const state = (probe && probe.result) || {};
    if (state.running) {
      await chrome.scripting.executeScript({
        target,
        func: () => window.__pageSwarm && window.__pageSwarm.destroy(),
      });
      return;
    }
    if (state.media) {
      try {
        const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 88 });
        await chrome.scripting.executeScript({
          target,
          func: (s) => { window.__pageSwarmShot = s; },
          args: [shot],
        });
      } catch (_) {
        // No screenshot: media regions become placeholders.
      }
    }
    await chrome.scripting.executeScript({ target, files: ["swarm.js"] });
  } catch (_) {
    // chrome://, the Web Store, PDFs etc. can't be scripted.
    flagError(tab.id);
  }
});

// Messages from the in-page swarm (rating prompt).
// Every rating, 1 to 5 stars, goes to the same store review page.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== "string") return;
  const url = msg.type === "swarm:rate" ? STORE_REVIEW_URL : msg.type === "swarm:feedback" ? FEEDBACK_URL : null;
  if (!url) return;
  chrome.tabs.create({ url, index: sender.tab ? sender.tab.index + 1 : undefined }).catch(() => {});
  reply(true);
});
