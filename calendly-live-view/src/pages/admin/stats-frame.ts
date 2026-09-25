// The Analytics tab loads /admin/analytics in a frame the first time it is opened, sized to the window.
export function setupStatsFrame() {
  var box = document.getElementById("viewStats");
  if (!box) {
    return;
  }
  var frame = null;
  var body = document.body;
  function fit() {
    if (!frame || box.hidden) {
      return;
    }
    var top = frame.getBoundingClientRect().top;
    var nav = document.querySelector(".bnav");
    var navRect = nav && nav.getBoundingClientRect();
    var bottom = navRect && navRect.height ? navRect.top - 8 : innerHeight - 12;
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
  window.__stats = function () {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "la-frame";
      frame.title = "Person analytics";
      frame.src = "/admin/analytics";
      // a frame is white until its page has drawn; show it once it has
      frame.style.visibility = "hidden";
      frame.addEventListener("load", function () {
        frame.style.visibility = "";
      });
      box.appendChild(frame);
    }
    sync();
  };
  sync();
}
