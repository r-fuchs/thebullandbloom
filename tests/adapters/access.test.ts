import { describe, it, expect } from "vitest";
import { CloudflareAccess } from "../../src/adapters/access";

const enc = new TextEncoder();
function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair(kid: string) {
  // workers-types widens these to CryptoKey | CryptoKeyPair and ArrayBuffer | JsonWebKey; RSASSA with "jwk" gives both.
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey) as JsonWebKey;
  return { priv: kp.privateKey, jwk: { ...jwk, kid, use: "sig", alg: "RS256" } };
}
async function sign(priv: CryptoKey, kid: string, payload: Record<string, unknown>, alg = "RS256") {
  const h = b64url(JSON.stringify({ alg, kid, typ: "JWT" })), p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
function jwksFetch(keys: JsonWebKey[]) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ keys, public_cert: {}, public_certs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}
/** A certs endpoint that answers each call from `bodies` in turn (the last one repeats). */
function scriptedFetch(bodies: Array<{ status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const b = bodies[Math.min(calls.length, bodies.length - 1)];
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify(b.body), { status: b.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const TEAM = "foxnacre.cloudflareaccess.com", AUD = "aud-1", NOW = 1_800_000_000;
const good = { aud: [AUD], iss: `https://${TEAM}`, email: "anthony@example.com", exp: NOW + 600, nbf: NOW - 60, iat: NOW - 60, sub: "u1" };

describe("CloudflareAccess.verify", () => {
  it("accepts a token signed by a key from the team's certs endpoint and returns the email", async () => {
    const k = await keypair("k1"); const { fn, calls } = jwksFetch([k.jwk]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    expect(await a.verify(await sign(k.priv, "k1", good), NOW)).toEqual({ email: "anthony@example.com" });
    expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });
  it("caches the certs: a second token does not refetch", async () => {
    const k = await keypair("k1"); const { fn, calls } = jwksFetch([k.jwk]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    await a.verify(await sign(k.priv, "k1", good), NOW);
    await a.verify(await sign(k.priv, "k1", good), NOW + 10);
    expect(calls).toHaveLength(1);
  });
  it("refetches once for an unknown kid, then rejects", async () => {
    const k = await keypair("k2"); const { fn, calls } = jwksFetch([]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    expect(await a.verify(await sign(k.priv, "k2", good), NOW)).toBeNull();
    expect(calls).toHaveLength(2);
  });
  it("rejects a tampered payload, a foreign audience, a foreign issuer, an expired token, a not-yet-valid token, and a non-RS256 header", async () => {
    const k = await keypair("k1"); const a = new CloudflareAccess(TEAM, AUD, jwksFetch([k.jwk]).fn);
    const t = await sign(k.priv, "k1", good);
    const [h, , s] = t.split(".");
    expect(await a.verify(`${h}.${b64url(JSON.stringify({ ...good, email: "evil@example.com" }))}.${s}`, NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, aud: ["other"] }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, iss: "https://other.cloudflareaccess.com" }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, exp: NOW - 1 }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", { ...good, nbf: NOW + 60 }), NOW)).toBeNull();
    expect(await a.verify(await sign(k.priv, "k1", good, "HS256"), NOW)).toBeNull();
  });
  it("accepts a string aud and rejects a token with no email, garbage, or nothing", async () => {
    const k = await keypair("k1"); const a = new CloudflareAccess(TEAM, AUD, jwksFetch([k.jwk]).fn);
    expect(await a.verify(await sign(k.priv, "k1", { ...good, aud: AUD }), NOW)).toEqual({ email: "anthony@example.com" });
    expect(await a.verify(await sign(k.priv, "k1", { ...good, email: undefined }), NOW)).toBeNull();
    expect(await a.verify("not.a.jwt", NOW)).toBeNull();
    expect(await a.verify("", NOW)).toBeNull();
    expect(await a.verify(undefined, NOW)).toBeNull();
  });
  it("throttles the forced refetch, so unknown kids cannot drive traffic at the certs endpoint", async () => {
    const k = await keypair("k9"); const { fn, calls } = jwksFetch([]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    expect(await a.verify(await sign(k.priv, "k9", good), NOW)).toBeNull();
    expect(calls).toHaveLength(2); // the first load, then one forced refetch
    expect(await a.verify(await sign(k.priv, "k9", { ...good, exp: NOW + 600 }), NOW + 10)).toBeNull();
    expect(calls).toHaveLength(2); // within the minute: no second forced refetch
    expect(await a.verify(await sign(k.priv, "k9", { ...good, exp: NOW + 600 }), NOW + 61)).toBeNull();
    expect(calls).toHaveLength(3); // a minute on, one more is allowed
  });
  it("keeps a good cache when the certs endpoint answers 200 without keys, and survives a 503", async () => {
    const k = await keypair("k1");
    const { fn, calls } = scriptedFetch([{ body: { keys: [k.jwk] } }, { body: {} }, { status: 503, body: { error: "down" } }]);
    const a = new CloudflareAccess(TEAM, AUD, fn);
    expect(await a.verify(await sign(k.priv, "k1", good), NOW)).toEqual({ email: "anthony@example.com" });
    // an unknown kid forces a refetch; the keyless 200 must not wipe the cached key
    expect(await a.verify(await sign(k.priv, "kX", { ...good, exp: NOW + 600 }), NOW + 120)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await a.verify(await sign(k.priv, "k1", { ...good, exp: NOW + 600 }), NOW + 130)).toEqual({ email: "anthony@example.com" });
    // and a 503 on the next forced refetch is just a null, never a throw
    expect(await a.verify(await sign(k.priv, "kX", { ...good, exp: NOW + 600 }), NOW + 200)).toBeNull();
    expect(calls).toHaveLength(3);
  });
  it("never throws when the certs endpoint is down", async () => {
    const k = await keypair("k1");
    const down = (async () => { throw new Error("dns"); }) as unknown as typeof fetch;
    const a = new CloudflareAccess(TEAM, AUD, down);
    expect(await a.verify(await sign(k.priv, "k1", good), NOW)).toBeNull();
  });
});
