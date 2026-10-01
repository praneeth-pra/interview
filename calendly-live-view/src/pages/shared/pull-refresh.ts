// Pull to refresh on phones, as in native apps: drag down from the very top of the page and a small round spinner
// follows the finger out from under the header, its orange arc filling as it goes. Let go past the mark and it spins
// while refresh() fetches the tab's data again in place, then shrinks away; let go before it and it slides back.
// The iPhone home-screen app has no pull-to-refresh of its own; in a browser this replaces the browser's (a full reload).
// Used by the admin page and by Contacts in its frame. Styles are set here so both pages share it without CSS.
export type PullRefresh = {
  refresh: () => Promise<unknown>;
  // where the spinner comes out from: the bottom of the header (0 in the Contacts frame)
  top: () => number;
  // a sheet or menu is open, or the touch began on something with its own drag
  blocked: (target: Element) => boolean;
  surface: string; // the spinner's disc
  color: string; // its arc
};

const SIZE = 36;
const HIDE = -SIZE - 8; // tucked under the header
const MARK = 64; // how far the spinner must come down to refresh
const REST = 52; // where it sits while refreshing
const MAX = 96;
const ARC = 2 * Math.PI * 9;

// how far the spinner travels for a finger that has moved by `pull`: one to one at first, then heavier, like a rubber band
function pullDistance(pull: number) {
  if (pull <= 0) {
    return 0;
  }
  return Math.min(MAX, MAX * (1 - Math.exp(-pull / 130)) * 1.25);
}

export function setupPullRefresh(options: PullRefresh) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const svgNs = "http://www.w3.org/2000/svg";
  const disc = document.createElement("div");
  disc.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  const arc = document.createElementNS(svgNs, "circle");
  arc.setAttribute("cx", "12");
  arc.setAttribute("cy", "12");
  arc.setAttribute("r", "9");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke-width", "2.6");
  arc.setAttribute("stroke-linecap", "round");
  arc.style.stroke = options.color;
  arc.style.strokeDasharray = String(ARC);
  svg.appendChild(arc);
  disc.appendChild(svg);
  const look = disc.style;
  look.position = "fixed";
  look.left = "50%";
  look.width = look.height = SIZE + "px";
  look.marginLeft = -SIZE / 2 + "px";
  look.borderRadius = "50%";
  look.background = options.surface;
  look.boxShadow = "0 2px 10px rgba(0, 0, 0, 0.16)";
  look.display = "flex";
  look.alignItems = "center";
  look.justifyContent = "center";
  look.zIndex = "19"; // under the sticky header (20), over the page
  look.pointerEvents = "none";
  look.willChange = "transform, opacity";

  let phase = 0; // 0 idle, 1 touch at the top not decided yet, 2 pulling, 3 refreshing
  let startX = 0;
  let startY = 0;
  let shown = 0; // px the spinner has come down
  let spin: Animation | null = null;

  function place(y: number, scale: number, opacity: number) {
    look.transform = "translateY(" + y + "px) scale(" + scale + ")";
    look.opacity = String(opacity);
  }
  function draw() {
    const part = Math.min(1, shown / MARK);
    arc.style.strokeDashoffset = String(ARC * (1 - 0.78 * part));
    svg.style.transform = "rotate(" + Math.round(-90 + part * 270 + Math.max(0, shown - MARK) * 2) + "deg)";
    place(HIDE + shown, 0.7 + 0.3 * part, Math.min(1, part * 1.6));
  }
  function show() {
    if (!disc.parentNode) {
      document.body.appendChild(disc);
    }
    look.top = Math.max(0, options.top()) + "px";
    look.transition = "none";
  }
  function slide(ms: number, then?: () => void) {
    look.transition = "transform " + ms + "ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity " + ms + "ms ease";
    if (then) {
      setTimeout(then, ms);
    }
  }
  function remove() {
    if (spin) {
      spin.cancel();
      spin = null;
    }
    disc.remove();
    phase = 0;
    shown = 0;
  }
  function scrolled() {
    return (document.scrollingElement || document.documentElement).scrollTop > 0;
  }
  // a list or sheet with its own scroll that isn't at its top takes the drag
  function insideScrolled(target: Element | null) {
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if (node.scrollTop > 0) {
        return true;
      }
    }
    return false;
  }

  document.addEventListener(
    "touchstart",
    function (event: TouchEvent) {
      if (phase === 3) {
        return;
      }
      const target = event.target as Element;
      phase =
        event.touches.length === 1 &&
        !scrolled() &&
        !options.blocked(target) &&
        !target.closest("input, textarea, select, [contenteditable]") &&
        !insideScrolled(target)
          ? 1
          : 0;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      if (phase) {
        // heard on the element touched too: if a redraw removes it mid-pull, the end no longer reaches the document
        target.addEventListener("touchend", end, { once: true });
        target.addEventListener("touchcancel", end, { once: true });
      }
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    function (event: TouchEvent) {
      if (phase !== 1 && phase !== 2) {
        return;
      }
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (phase === 1) {
        if (dx === 0 && dy === 0) {
          return;
        }
        // Down and not sideways: ours. Anything else is a scroll or a sideways swipe (the Agenda's days).
        if (dy <= 0 || Math.abs(dx) >= dy || scrolled()) {
          phase = 0;
          return;
        }
        phase = 2;
        show();
      }
      // turned sideways early, or came back up past where it started: hand the touch back
      if (dy <= 0 || (shown < 24 && Math.abs(dx) > dy * 1.3)) {
        shown = 0;
        slide(150, function () {
          if (phase === 0) {
            remove();
          }
        });
        draw();
        phase = 0;
        return;
      }
      // the page itself stays put, so it doesn't rubber-band down at the same time
      if (event.cancelable) {
        event.preventDefault();
      }
      shown = pullDistance(dy);
      draw();
    },
    { passive: false },
  );
  function end() {
    if (phase === 1) {
      phase = 0;
    }
    if (phase !== 2) {
      return;
    }
    if (shown < MARK) {
      shown = 0;
      slide(200, remove);
      draw();
      phase = 0;
      return;
    }
    phase = 3;
    shown = REST;
    slide(220);
    draw();
    arc.style.strokeDashoffset = String(ARC * 0.25);
    svg.style.transform = "";
    if (!reduced.matches && svg.animate) {
      spin = svg.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: 750,
        iterations: Infinity,
      });
    }
    // long enough to see it spin; given up after 15 seconds so a dead connection never leaves it spinning
    const minimum = new Promise(function (done) {
      setTimeout(done, 550);
    });
    const limit = new Promise(function (done) {
      setTimeout(done, 15000);
    });
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(options.refresh());
    } catch (e) {
      work = Promise.resolve();
    }
    Promise.race([Promise.all([work.catch(function () {}), minimum]), limit]).then(function () {
      slide(200, remove);
      place(HIDE + REST, 0.3, 0);
    });
  }
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
}
