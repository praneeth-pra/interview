// The Alerts button in the top bar: turns booking push notifications on or off for this device.
export function setupAlerts() {
  var topRight = document.querySelector(".top .tr");
  if (!topRight) {
    return;
  }
  var supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  var ua = navigator.userAgent;
  var ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  var reg = null;
  var mine = null;
  var info = {
    key: "",
    endpoints: [],
  };
  var busy = false;
  var ready;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.id = "pushBtn";
  btn.className = "chip";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", "Booking alerts");
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.3H2.8z" stroke-linejoin="round"/><path d="M6.6 14h2.8" stroke-linecap="round"/></svg><span>Alerts</span>';
  topRight.insertBefore(btn, document.getElementById("qbtn"));
  var pop = document.createElement("div");
  pop.className = "pushpop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Booking notifications");
  document.body.appendChild(pop);
  function api(url: string, body?: unknown): Promise<any> {
    return fetch(
      url,
      body
        ? {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }
        : {},
    ).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (result) {
          if (!response.ok) {
            throw new Error(result.error || "Something went wrong. Try again.");
          }
          return result;
        });
    });
  }
  // A VAPID key (base64url) as bytes, for pushManager.subscribe().
  function keyBytes(base64: string) {
    var binary = atob((base64 + "===".slice((base64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  function label() {
    if (/iphone/i.test(ua)) {
      return "iPhone";
    } else if (/ipad/i.test(ua)) {
      return "iPad";
    } else if (/android/i.test(ua)) {
      return "Android phone";
    } else if (/mac os/i.test(ua)) {
      return "Mac";
    } else if (/windows/i.test(ua)) {
      return "Windows PC";
    } else {
      return "browser";
    }
  }
  function isOn() {
    return !!mine && !!(info.endpoints.indexOf(mine.endpoint) >= 0);
  }
  function paint() {
    btn.classList.toggle("on", isOn());
    btn.lastChild.textContent = isOn() ? "Alerts on" : "Alerts";
  }
  function render(msg?: string) {
    var html = "<h3>Booking notifications</h3>";
    if (!supported) {
      html +=
        ios && !standalone
          ? "<p>On iPhone, alerts work from the home-screen app:</p><ol><li>Tap <b>Share</b> in Safari.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open <b>Hi-Techie</b> from your home screen and tap <b>Alerts</b> again.</li></ol>"
          : "<p>This browser can’t show notifications. Try Chrome, Edge or Safari.</p>";
    } else if (Notification.permission === "denied") {
      html += "<p>Notifications are blocked for this site. Allow them in your browser or phone settings, then reopen this page.</p>";
    } else if (isOn()) {
      html +=
        '<p class="pp-ok">On for this device.</p><p>You’ll get a banner whenever a candidate books, reschedules or cancels.</p><div class="pp-row"><button type="button" class="pp-btn" data-a="test">Send test</button><button type="button" class="pp-btn" data-a="off">Turn off</button></div>';
    } else {
      html +=
        '<p>Get a banner on this device whenever a candidate books, reschedules or cancels, with their name, company, round and time.</p><div class="pp-row"><button type="button" class="pp-btn primary" data-a="on">Turn on for this device</button></div>';
    }
    var count = info.endpoints.length;
    html += '<p class="pp-n">' + (count ? count + (count > 1 ? " devices get" : " device gets") + " alerts." : "No devices get alerts yet.") + "</p>";
    if (msg) {
      html += '<p class="pp-msg" role="status"></p>';
    }
    pop.innerHTML = html;
    if (msg) {
      pop.querySelector(".pp-msg").textContent = msg;
    }
    pop.querySelectorAll("button").forEach(function (button) {
      button.disabled = busy;
    });
    paint();
  }
  ready = Promise.all([
    api("/admin/api/push").then(function (result) {
      info = result;
    }),
    supported
      ? navigator.serviceWorker
          .register("/sw.js")
          .then(function (registration) {
            reg = registration;
            return registration.pushManager.getSubscription();
          })
          .then(function (subscription) {
            mine = subscription;
            if (subscription && info.key && Notification.permission === "granted" && info.endpoints.indexOf(subscription.endpoint) < 0) {
              var json: PushSubscriptionJSON & { label?: string } = subscription.toJSON();
              json.label = label();
              return api("/admin/api/push/subscribe", json).then(function (result) {
                info = result;
              });
            }
          })
      : null,
  ])
    .catch(function () {})
    .then(function () {
      paint();
      if (!pop.hidden) {
        render();
      }
    });
  function place() {
    var rect = btn.getBoundingClientRect();
    pop.style.top = Math.round(rect.bottom + 8) + "px";
  }
  function openPop(open: boolean) {
    pop.hidden = !open;
    document.body.classList.toggle("pp-open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      place();
      render();
      var first = pop.querySelector("button");
      if (first) {
        first.focus();
      }
    }
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    openPop(pop.hidden);
  });
  document.addEventListener("click", function (e) {
    if (!pop.hidden && !pop.contains(e.target as Node)) {
      openPop(false);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !pop.hidden) {
      openPop(false);
      btn.focus();
    }
  });
  // Shows a busy state while an action runs, then its result or a readable error.
  function run(promise: Promise<string>) {
    busy = true;
    render();
    promise.then(
      function (message) {
        busy = false;
        render(message);
      },
      function (error) {
        busy = false;
        var message = error && error.message ? error.message : "";
        if (error && (error.name === "NotAllowedError" || /permission|incognito|private/i.test(message))) {
          message =
            "This browser isn’t allowing alerts here. If this is a private or incognito window, open the page in a normal window and try again.";
        } else if (error && (error.name === "AbortError" || /push service|registration failed/i.test(message))) {
          message = "Couldn’t reach the notification service. Check your connection and try again.";
        }
        render(message || "Something went wrong. Try again.");
      },
    );
  }
  pop.addEventListener("click", function (e) {
    var button = (e.target as Element).closest("button[data-a]");
    if (!button || busy) {
      return;
    }
    var action = button.getAttribute("data-a");
    if (action === "on") {
      var perm = Notification.requestPermission();
      run(
        Promise.resolve(perm)
          .then(function (permission) {
            if (permission !== "granted") {
              throw new Error(
                permission === "denied"
                  ? "Notifications were blocked. Allow them in your settings to turn alerts on."
                  : "Tap Allow when your browser asks, to turn alerts on.",
              );
            }
            return ready;
          })
          .then(function () {
            if (!reg) {
              throw new Error("Couldn’t set up alerts on this device. Reload and try again.");
            }
            return reg.pushManager.getSubscription().then(function (subscription) {
              return (
                subscription ||
                reg.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: keyBytes(info.key),
                })
              );
            });
          })
          .then(function (subscription) {
            mine = subscription;
            var json: PushSubscriptionJSON & { label?: string } = subscription.toJSON();
            json.label = label();
            return api("/admin/api/push/subscribe", json);
          })
          .then(function (result) {
            info = result;
            return "Alerts are on. Tap Send test to check.";
          }),
      );
    } else if (action === "test") {
      run(
        api("/admin/api/push/test", {
          endpoint: mine.endpoint,
        }).then(function (result) {
          info = result;
          return "Test sent. It should appear in a few seconds.";
        }),
      );
    } else if (action === "off") {
      var endpoint = mine.endpoint;
      run(
        mine
          .unsubscribe()
          .catch(function () {})
          .then(function () {
            mine = null;
            return api("/admin/api/push/unsubscribe", {
              endpoint: endpoint,
            });
          })
          .then(function (result) {
            info = result;
            return "Alerts are off for this device.";
          }),
      );
    }
  });
}
