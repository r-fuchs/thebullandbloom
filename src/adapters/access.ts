/**
 * Cloudflare Access identity for the admin (Plan 6, D42–D45). Access guards /admin at the edge and
 * stamps every request it passes with an RS256 JWT (`Cf-Access-Jwt-Assertion` header, `CF_Authorization`
 * cookie). Verifying it here means the workers.dev address, which Access does not cover, is closed too.
 */
export interface AdminIdentity { email: string }

export interface Access {
  /** the signed-in admin for a Cloudflare Access JWT, or null when missing, malformed, expired, for another app, or badly signed */
  verify(token: string | undefined, nowSec: number): Promise<AdminIdentity | null>;
}

const CERTS_TTL_SEC = 3600;
const dec = new TextDecoder();
const enc = new TextEncoder();

function unb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Jwk extends JsonWebKey { kid?: string }

export class CloudflareAccess implements Access {
  private certs: { at: number; keys: Jwk[] } | null = null;

  constructor(
    private teamDomain: string,
    private aud: string,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async verify(token: string | undefined, nowSec: number): Promise<AdminIdentity | null> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header: { alg?: string; kid?: string }, payload: Record<string, unknown>;
    try {
      header = JSON.parse(dec.decode(unb64url(parts[0])));
      payload = JSON.parse(dec.decode(unb64url(parts[1])));
    } catch { return null; }
    if (header?.alg !== "RS256" || typeof header.kid !== "string") return null;
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.aud) : aud === this.aud;
    if (!audOk) return null;
    if (payload.iss !== `https://${this.teamDomain}`) return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > nowSec)) return null;
    if (typeof payload.email !== "string" || payload.email === "") return null;

    let jwk = await this.keyFor(header.kid, nowSec, false);
    if (!jwk) jwk = await this.keyFor(header.kid, nowSec, true);
    if (!jwk) return null;
    try {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
      return ok ? { email: payload.email } : null;
    } catch {
      return null;
    }
  }

  private async keyFor(kid: string, nowSec: number, force: boolean): Promise<Jwk | null> {
    if (force || !this.certs || nowSec - this.certs.at > CERTS_TTL_SEC) {
      try {
        const res = await this.fetchFn(`https://${this.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const body = await res.json() as { keys?: Jwk[] };
        this.certs = { at: nowSec, keys: Array.isArray(body.keys) ? body.keys : [] };
      } catch (err) {
        console.error("access: could not fetch team certs", err);
        return null;
      }
    }
    return this.certs.keys.find((k) => k.kid === kid) ?? null;
  }
}
