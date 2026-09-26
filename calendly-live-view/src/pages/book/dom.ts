// Builds DOM elements: el("button", { class, id, onclick, html, ... }, [children]).
// Attributes that are null/false are skipped, true means a bare attribute, on* keys add listeners, html sets innerHTML.
export type Attrs = Record<string, any> | null;
export type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child[],
): HTMLElementTagNameMap[K] {
  var node = document.createElement(tag);
  if (attrs) {
    for (var key in attrs) {
      var value = attrs[key];
      if (value != null && value !== false) {
        if (key === "class") {
          node.className = value;
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

export { el };
