// DOM helpers: el("button", { class, text, onclick, ... }, [children]), messages and the toast.
// In el(), attributes that are null/false are skipped, true means a bare attribute, on* keys add listeners.
export type Attrs = Record<string, any> | null;
export type Child = Node | string | null | undefined | false;
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: Child[]): HTMLElementTagNameMap[K] {
  var node = document.createElement(tag);
  if (attrs) {
    for (var key in attrs) {
      var value = attrs[key];
      if (value != null && value !== false) {
        if (key === "class") {
          node.className = value;
        } else if (key === "text") {
          node.textContent = value;
        } else if (key.slice(0, 2) === "on") {
          node.addEventListener(key.slice(2), value);
        } else {
          node.setAttribute(key, value === true ? "" : value);
        }
      }
    }
  }
  (children || []).forEach(function (child) {
    if (child != null && child !== false) {
      node.appendChild(typeof child == "string" ? document.createTextNode(child) : child);
    }
  });
  return node;
}
function onEnterOrSpace(action: () => void) {
  return function (event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
// Every toast confirms something just saved, so it also gives a short buzz on phones that support it (Android; iPhones ignore it).
function toast(text: string) {
  try {
    if (navigator.vibrate && matchMedia("(pointer: coarse)").matches) {
      navigator.vibrate(10);
    }
  } catch (e) {}
  var box = byId("toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    box.hidden = true;
  }, 3200);
}
function setMessage(box: HTMLElement, text: string, isError?: boolean) {
  box.textContent = text;
  box.className = "msg" + (isError ? " err" : "");
}

export { byId, el, onEnterOrSpace, toast, setMessage };
