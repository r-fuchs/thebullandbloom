/**
 * A delivery fee the browser cannot edit (D31). `/api/quote` signs what it priced; `/api/checkout`
 * verifies the signature, that the token still lives, and that it covers the address and date being
 * bought. Without this, checkout would have to either trust a number posted by the browser or make
 * a second Uber call whose answer could differ from the one the customer just agreed to.
 */
export interface QuoteClaim {
  feeCents: number;
  /** Uber's quote id, or null for a config fallback quote */
  quoteId: string | null;
  kind: "uber" | "fallback";
  /** the order date the quote was priced for */
  date: string;
  /** addressKey() of the address it was priced for */
  addr: string;
  /** unix seconds */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function mac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`quote:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function signQuote(secret: string, claim: QuoteClaim): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claim)));
  return `${payload}.${await mac(secret, payload)}`;
}

/** The claim if the token is authentic and unexpired, else null. Never throws. */
export async function verifyQuote(secret: string, token: string, nowSec: number): Promise<QuoteClaim | null> {
  const i = token.indexOf(".");
  if (i <= 0) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  let expected: string;
  try { expected = await mac(secret, payload); } catch { return null; }
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let k = 0; k < sig.length; k++) diff |= sig.charCodeAt(k) ^ expected.charCodeAt(k);
  if (diff !== 0) return null;
  try {
    const claim = JSON.parse(dec.decode(unb64url(payload))) as QuoteClaim;
    if (typeof claim?.feeCents !== "number" || typeof claim?.exp !== "number") return null;
    if (claim.exp <= nowSec) return null;
    return claim;
  } catch {
    return null;
  }
}
