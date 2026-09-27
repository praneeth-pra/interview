// DOM helpers shared by the admin, booking and Contacts pages: byId() and el("button", { class, text, html, onclick, ... },
// [children]). In el(), attributes that are null/false are skipped, true means a bare attribute, on* keys add listeners,
// text sets textContent and html sets innerHTML (only ever with the pages' own markup, never with text people typed).
export type Attrs = Record<string, any> | null;
export type Child = Node | string | null | undefined | false;
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: Child[] | null): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key in attrs) {
      const value = attrs[key];
      if (value != null && value !== false) {
        if (key === "class") {
          node.className = value;
        } else if (key === "text") {
          node.textContent = value;
        } else if (key === "html") {
          node.innerHTML = value;
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
