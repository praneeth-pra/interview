// Plain-Node checks for links.js (no Electron needed): node tests/links.test.cjs
const assert = require("node:assert/strict");
const { DEFAULT_URL, startUrl, isInternal, isSafeExternal } = require("../links");

assert.equal(startUrl({}), DEFAULT_URL);
assert.equal(startUrl({ HI_TECHIE_URL: "http://localhost:3000/admin" }), "http://localhost:3000/admin");

const s = DEFAULT_URL;
assert.ok(isInternal("https://hi-techie.dev/booking", s));
assert.ok(isInternal("https://www.hi-techie.dev/admin?view=payments", s));
assert.ok(!isInternal("http://hi-techie.dev/admin", s), "plain http is not the app");
assert.ok(!isInternal("https://hi-techie.dev.evil.com/", s));
assert.ok(!isInternal("https://www.linkedin.com/in/x", s));
assert.ok(!isInternal("not a url", s));
assert.ok(isInternal("http://localhost:3000/booking", "http://localhost:3000/admin"));

assert.ok(isSafeExternal("https://meet.google.com/abc"));
assert.ok(isSafeExternal("mailto:hr@example.com"));
assert.ok(!isSafeExternal("file:///etc/passwd"));
assert.ok(!isSafeExternal("javascript:alert(1)"));

console.log("links: all checks passed");
