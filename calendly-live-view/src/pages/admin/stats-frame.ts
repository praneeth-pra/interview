// The Contacts tab is /admin/analytics in a frame, loaded in the background soon after the admin opens (or on the first
// visit to the tab, if that comes first) and sized to the window.
export function setupStatsFrame() {
  const box = document.getElementById("viewStats")!;
  if (!box) {
    return;
  }
  let frame: HTMLIFrameElement | null = null;
  const body = document.body;
  function fit() {
    if (!frame || box.hidden) {
      return;
    }
    const top = frame.getBoundingClientRect().top;
    const nav = document.querySelector(".bnav");
    const navRect = nav && nav.getBoundingClientRect();
    const bottom = navRect && navRect.height ? navRect.top - 8 : innerHeight - 12;
    frame.style.height = Math.max(300, Math.round(bottom - top)) + "px";
  }
  function sync() {
    body.classList.toggle("la-on", !box.hidden);
    if (!box.hidden) {
      requestAnimationFrame(fit);
    }
  }
  new MutationObserver(sync).observe(box, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  addEventListener("resize", fit);
  function load() {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "la-frame";
      frame.title = "Contacts";
      frame.src = "/admin/analytics" + (window.__statsEvent ? "?event=" + encodeURIComponent(window.__statsEvent) : "");
      // a frame is white until its page has drawn; show it once it has
      frame.style.visibility = "hidden";
      frame.addEventListener("load", function () {
        frame!.style.visibility = "";
      });
      box.appendChild(frame);
    }
  }
  // Load it quietly once the admin has settled, so the first tap on Contacts shows it straight away.
  addEventListener("load", function () {
    setTimeout(function () {
      if (document.visibilityState === "visible" && !navigator.connection?.saveData) {
        load();
      }
    }, 2500);
  });
  window.__stats = function () {
    if (!frame) {
      load();
    } else if (window.__statsEvent) {
      frame.src = "/admin/analytics?event=" + encodeURIComponent(window.__statsEvent);
    }
    window.__statsEvent = "";
    sync();
  };
  sync();
}
