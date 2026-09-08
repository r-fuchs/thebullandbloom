export const COOKIE = "bb_admin";
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function makeSession(secret: string, nowSec: number, ttlSec: number): Promise<string> {
  const exp = String(nowSec + ttlSec);
  return `${exp}.${await hmac(secret, exp)}`;
}

export async function verifySession(token: string | undefined, secret: string, nowSec: number): Promise<boolean> {
  if (!token) return false;
  const i = token.indexOf(".");
  if (i < 0) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) <= nowSec) return false;
  const expected = await hmac(secret, exp);
  return equal(await sha256(sig), await sha256(expected));
}

export async function passcodeMatches(given: string, expected: string): Promise<boolean> {
  if (!given || !expected) return false;
  return equal(await sha256(given), await sha256(expected));
}
