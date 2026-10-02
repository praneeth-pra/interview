// ---- Browser notifications (Web Push) for admins -----------------------------------------
import { TZ } from "./config";
import { type Fields, asFields } from "./util";
import { type Booking, type PushSub, isOwner, pushStore } from "./data";
import { json, saveOrUndo } from "./http";
import { saveStore } from "./store";
import { dayShort } from "./time";
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign as cryptoSign } from "node:crypto";

const PUSH_HOSTS =
  /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chrome\.google\.com)$/i;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export function pushEndpointOk(u: string) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && PUSH_HOSTS.test(x.hostname) && u.length < 1000;
  } catch {
    return false;
  }
}
function vapidJwt(aud: string) {
  const pub = Buffer.from(pushStore.data.pub, "base64url");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: pushStore.data.priv, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(
    Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:alerts@hi-techie.dev" })),
  );
  return head + "." + body + "." + b64u(cryptoSign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" }));
}
// RFC 8291 message encryption (aes128gcm), one record.
function encryptPush(sub: PushSub, text: string) {
  const uaPub = Buffer.from(sub.p256dh, "base64url");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      ecdh.computeSecret(uaPub),
      Buffer.from(sub.auth, "base64url"),
      Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]),
      32,
    ),
  );
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const data = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPub.length;
  return Buffer.concat([head, asPub, data]);
}
export async function pushTo(sub: PushSub, msg: object) {
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: "vapid t=" + vapidJwt(new URL(sub.endpoint).origin) + ", k=" + pushStore.data.pub,
      },
      body: encryptPush(sub, JSON.stringify(msg)),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.log("push failed (" + r.status + ") for " + sub.label + ": " + (await r.text()).slice(0, 200));
    return r.status;
  } catch (e) {
    console.log("push failed for " + sub.label + ": " + String(e));
    return 0;
  }
}
// ownersOnly: enquiries and payments go only to devices an owner turned alerts on for
export async function pushAll(msg: object, ownersOnly = false) {
  const subs = pushStore.data.subs.filter((x) => !ownersOnly || isOwner(x.email ?? ""));
  if (!subs.length) return;
  const codes = await Promise.all(subs.map((x) => pushTo(x, msg)));
  const gone = new Set(subs.filter((_, i) => codes[i] === 404 || codes[i] === 410).map((x) => x.endpoint));
  if (gone.size) {
    pushStore.data.subs = pushStore.data.subs.filter((x) => !gone.has(x.endpoint));
    await saveStore(pushStore).catch(() => {});
  }
  console.log(
    "push: sent to " +
      codes.filter((c) => c >= 200 && c < 300).length +
      " of " +
      subs.length +
      " device(s)" +
      (gone.size ? ", removed " + gone.size + " expired" : ""),
  );
}
export function alertAdmins(kind: "booked" | "moved" | "cancelled", b: Booking) {
  if (!pushStore.data.subs.length) return;
  const who = [b.name, b.company, b.round]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" \u00B7 ");
  void pushAll({
    title: kind === "booked" ? "New booking" : kind === "moved" ? "Booking rescheduled" : "Booking cancelled",
    body: who + "\n" + (kind === "moved" ? "Now " : "") + dayShort(b.start) + " (" + b.duration + " min)",
    tag: b.id + ":" + kind,
    url: "/admin?date=" + new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(b.start)),
  });
}
// Only this admin's own devices are listed (a device's address is all it takes to turn its alerts off), with how many
// devices get alerts in all. A device turned on before its admin was recorded (or by someone else) signs up again, so
// enquiry and payment alerts reach only the owners' devices.
export function pushView(email: string) {
  const yours = pushStore.data.subs.filter((x) => x.email === email).map((x) => x.endpoint);
  return { key: pushStore.data.pub, endpoints: yours, yours, devices: pushStore.data.subs.length };
}
// The server's own key pair for signing notifications, made once and kept in push.json.
export async function ensurePushKeys() {
  if (pushStore.data.pub && pushStore.data.priv) return;
  const kp = createECDH("prime256v1");
  kp.generateKeys();
  pushStore.data.pub = b64u(kp.getPublicKey());
  pushStore.data.priv = b64u(kp.getPrivateKey());
  await saveStore(pushStore).catch(() => {});
}
// POST /admin/api/push/<act> from an admin's device: turn alerts on (subscribe) or off (unsubscribe), or send a test.
// Turning off and testing work only on the admin's own devices.
export async function changePush(act: string, body: Fields, email: string): Promise<Response> {
  const endpoint = String(body?.endpoint ?? "");
  const before = pushStore.data.subs;
  if (act === "subscribe") {
    const p256dh = String(asFields(body.keys).p256dh ?? "");
    const auth = String(asFields(body.keys).auth ?? "");
    if (!pushEndpointOk(endpoint) || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth))
      return json({ error: "This browser sent an unexpected subscription. Try again." }, 400);
    const subs = before.filter((x) => x.endpoint !== endpoint);
    if (subs.length >= 50) return json({ error: "Too many devices. Turn alerts off on an old one first." }, 400);
    subs.push({ endpoint, p256dh, auth, label: String(body?.label ?? "Browser").slice(0, 40), addedAt: new Date().toISOString(), email });
    pushStore.data.subs = subs;
  } else if (act === "unsubscribe") {
    pushStore.data.subs = before.filter((x) => x.endpoint !== endpoint || x.email !== email);
  } else if (act === "test") {
    const sub = before.find((x) => x.endpoint === endpoint && x.email === email);
    if (!sub) return json({ error: "Alerts aren't on for this device. Turn them on first." }, 404);
    const code = await pushTo(sub, {
      title: "Test notification",
      body: "Alerts are working on this " + sub.label + ".",
      tag: "test",
      url: "/admin",
    });
    return code >= 200 && code < 300
      ? json(pushView(email))
      : json({ error: "The notification service didn't accept it (" + code + "). Turn alerts off and on again." }, 502);
  } else return json({ error: "Not found." }, 404);
  const failed = await saveOrUndo(pushStore, () => (pushStore.data.subs = before));
  if (failed) return failed;
  console.log("browser alerts: " + pushStore.data.subs.length + " device(s)");
  return json(pushView(email));
}
