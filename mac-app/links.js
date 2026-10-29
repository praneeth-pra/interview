// Which links stay inside the app window and which open in the default browser.
// Kept free of Electron so it can be tested with plain Node.

const DEFAULT_URL = "https://hi-techie.dev/admin";

function startUrl(env) {
  return (env && env.HI_TECHIE_URL) || DEFAULT_URL;
}

// Pages on the app's own site (hi-techie.dev, www.hi-techie.dev, or the HI_TECHIE_URL host) stay in the window.
function isInternal(url, start) {
  let u, s;
  try {
    u = new URL(url);
    s = new URL(start);
  } catch {
    return false;
  }
  if (u.protocol !== s.protocol) return false;
  const bare = (h) => h.replace(/^www\./, "");
  return bare(u.host) === bare(s.host);
}

// Only web and mail links are handed to the system; anything else (file:, custom schemes) is dropped.
function isSafeExternal(url) {
  try {
    return ["https:", "http:", "mailto:", "tel:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_URL, startUrl, isInternal, isSafeExternal };
