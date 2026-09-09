import { describe, it, expect } from "vitest";
import { UberApi, encodeAddress } from "../../src/adapters/uber-api";
import { UberError, verifyUberSignature, type DeliveryWindow, type Party } from "../../src/adapters/uber";
import type { CachedToken, TokenCache } from "../../src/store/uber";

type Canned = { status: number; body: unknown };
function fakeFetch(script: Canned[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    const next = script.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function memoryCache(initial: CachedToken | null = null): TokenCache & { value: CachedToken | null } {
  const c = {
    value: initial,
    async load() { return c.value; },
    async save(t: CachedToken) { c.value = t; },
    async clear() { c.value = null; },
  };
  return c;
}

const TOKEN = { status: 200, body: { access_token: "at_1", expires_in: 2592000, token_type: "Bearer", scope: "eats.deliveries" } };

const STUDIO: Party = {
  name: "Anthony Demonia", phone: "+15183340517", businessName: "The Bull and Bloom",
  address: { street: "1 Warren Street", unit: "", city: "Hudson", state: "NY", zip: "12534" },
  notes: "Ring the studio bell",
};
const CUSTOMER: Party = {
  name: "Pat Smith", phone: "+15185550100",
  address: { street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" },
  notes: "Leave on the porch",
};
const WINDOW: DeliveryWindow = {
  pickupReadyAt: new Date("2026-09-16T13:00:00.000Z"),
  pickupDeadlineAt: new Date("2026-09-16T14:00:00.000Z"),
  dropoffReadyAt: new Date("2026-09-16T14:00:00.000Z"),
  dropoffDeadlineAt: new Date("2026-09-16T15:30:00.000Z"),
};
const QUOTE_REQ = { pickup: STUDIO, dropoff: CUSTOMER, window: WINDOW, valueCents: 8500 };
const DELIVERY_REQ = {
  quoteId: "dqt_1", pickup: STUDIO, dropoff: CUSTOMER, window: WINDOW, valueCents: 8500,
  itemName: "Bouquet — hand-tied flowers", reference: "a1b2c3d4", idempotencyKey: "a1b2c3d4-order",
};

const api = (script: Canned[], cache = memoryCache(), robocourier = false) => {
  const { fn, calls } = fakeFetch(script);
  return { uber: new UberApi("cid", "csec", "cus_1", cache, robocourier, fn), calls, cache };
};

describe("encodeAddress", () => {
  it("emits Uber's JSON-encoded address string with street_address as an array", () => {
    expect(JSON.parse(encodeAddress({ street: "5 Elm Street", unit: "", city: "Hudson", state: "NY", zip: "12534" }))).toEqual({
      street_address: ["5 Elm Street"], city: "Hudson", state: "NY", zip_code: "12534", country: "US",
    });
  });
  it("puts a unit on the second street line", () => {
    expect(JSON.parse(encodeAddress({ street: "5 Elm Street", unit: "Apt 2", city: "Hudson", state: "NY", zip: "12534" })).street_address)
      .toEqual(["5 Elm Street", "Apt 2"]);
  });
});

describe("UberApi", () => {
  it("reports configured only with all three client values", () => {
    const c = memoryCache();
    expect(new UberApi("id", "sec", "cus", c).configured()).toBe(true);
    expect(new UberApi(undefined, "sec", "cus", c).configured()).toBe(false);
    expect(new UberApi("id", "", "cus", c).configured()).toBe(false);
    expect(new UberApi("id", "sec", undefined, c).configured()).toBe(false);
  });

  it("throws unconfigured before any network call when secrets are absent", async () => {
    const { fn, calls } = fakeFetch([]);
    const u = new UberApi(undefined, undefined, undefined, memoryCache(), false, fn);
    await expect(u.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "unconfigured" });
    expect(calls).toHaveLength(0);
  });

  it("fetches a client-credentials token form-encoded and caches it", async () => {
    const { uber, calls, cache } = api([TOKEN, { status: 200, body: {
      kind: "delivery_quote", id: "dqt_9", created: "2026-09-09T19:00:37.887Z", expires: "2026-09-09T19:15:37.887Z",
      fee: 600, currency: "usd", currency_type: "USD", dropoff_eta: "2026-09-16T14:34:22.000Z",
      duration: 33, pickup_duration: 24,
    } }]);
    const q = await uber.quote(QUOTE_REQ);
    expect(calls[0].url).toBe("https://auth.uber.com/oauth/v2/token");
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(calls[0].body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("eats.deliveries");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csec");
    expect(q).toEqual({
      id: "dqt_9", feeCents: 600, currency: "usd",
      expiresAt: Math.floor(Date.parse("2026-09-09T19:15:37.887Z") / 1000),
      dropoffEtaAt: Math.floor(Date.parse("2026-09-16T14:34:22.000Z") / 1000),
    });
    expect(cache.value!.token).toBe("at_1");
  });

  it("reuses a cached token that is still fresh and never calls the auth endpoint", async () => {
    const cache = memoryCache({ token: "at_cached", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    const { uber, calls } = api([{ status: 200, body: { id: "dqt_1", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }], cache);
    await uber.quote(QUOTE_REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.uber.com/v1/customers/cus_1/delivery_quotes");
    expect(calls[0].headers.authorization).toBe("Bearer at_cached");
  });

  it("re-authenticates once after a 401 and retries the call", async () => {
    const cache = memoryCache({ token: "at_stale", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    const { uber, calls } = api([
      { status: 401, body: { code: "unauthorized", message: "no", kind: "error" } },
      TOKEN,
      { status: 200, body: { id: "dqt_2", expires: "2026-09-09T19:15:37.887Z", fee: 700, currency: "usd" } },
    ], cache);
    expect((await uber.quote(QUOTE_REQ)).feeCents).toBe(700);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.uber.com/v1/customers/cus_1/delivery_quotes",
      "https://auth.uber.com/oauth/v2/token",
      "https://api.uber.com/v1/customers/cus_1/delivery_quotes",
    ]);
    expect(cache.value!.token).toBe("at_1");
  });

  it("sends the documented quote body: encoded addresses, RFC 3339 window, value in cents", async () => {
    const { uber, calls } = api([TOKEN, { status: 200, body: { id: "dqt_3", expires: "2026-09-09T19:15:37.887Z", fee: 600, currency: "usd" } }]);
    await uber.quote(QUOTE_REQ);
    const body = JSON.parse(calls[1].body!);
    expect(body.pickup_address).toBe(encodeAddress(STUDIO.address));
    expect(body.dropoff_address).toBe(encodeAddress(CUSTOMER.address));
    expect(body.pickup_phone_number).toBe("+15183340517");
    expect(body.dropoff_phone_number).toBe("+15185550100");
    expect(body.pickup_ready_dt).toBe("2026-09-16T13:00:00.000Z");
    expect(body.pickup_deadline_dt).toBe("2026-09-16T14:00:00.000Z");
    expect(body.dropoff_ready_dt).toBe("2026-09-16T14:00:00.000Z");
    expect(body.dropoff_deadline_dt).toBe("2026-09-16T15:30:00.000Z");
    expect(body.manifest_total_value).toBe(8500);
  });

  it("maps Uber's undeliverable codes to code 'undeliverable' and everything else to 'unavailable'", async () => {
    for (const code of ["address_undeliverable", "unknown_location", "address_undeliverable_limited_couriers"]) {
      const { uber } = api([TOKEN, { status: 400, body: { code, message: "The specified location is not in a deliverable area.", kind: "error" } }]);
      await expect(uber.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "undeliverable" });
    }
    const { uber: u2 } = api([TOKEN, { status: 400, body: { code: "invalid_params", message: "bad", kind: "error" } }]);
    await expect(u2.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "unavailable" });
    const { uber: u3 } = api([TOKEN, { status: 500, body: { code: "internal_server_error", message: "boom", kind: "error" } }]);
    await expect(u3.quote(QUOTE_REQ)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("creates a delivery with the quote id, manifest, idempotency key, and safe fallback actions", async () => {
    const { uber, calls } = api([TOKEN, { status: 200, body: {
      kind: "delivery", id: "del_7", quote_id: "dqt_1", status: "pending", fee: 1099, currency: "usd",
      tracking_url: "https://direct.uber.com/track/del_7", uuid: "abc", complete: false, live_mode: true,
    } }]);
    const d = await uber.createDelivery(DELIVERY_REQ);
    expect(d).toEqual({ id: "del_7", status: "pending", trackingUrl: "https://direct.uber.com/track/del_7", feeCents: 1099 });
    expect(calls[1].url).toBe("https://api.uber.com/v1/customers/cus_1/deliveries");
    const body = JSON.parse(calls[1].body!);
    expect(body.quote_id).toBe("dqt_1");
    expect(body.pickup_name).toBe("Anthony Demonia");
    expect(body.pickup_business_name).toBe("The Bull and Bloom");
    expect(body.pickup_notes).toBe("Ring the studio bell");
    expect(body.dropoff_name).toBe("Pat Smith");
    expect(body.dropoff_notes).toBe("Leave on the porch");
    expect(body.manifest_items).toEqual([{ name: "Bouquet — hand-tied flowers", quantity: 1, size: "small", price: 8500 }]);
    expect(body.manifest_reference).toBe("a1b2c3d4");
    expect(body.deliverable_action).toBe("deliverable_action_meet_at_door");
    expect(body.undeliverable_action).toBe("return");
    expect(body.idempotency_key).toBe("a1b2c3d4-order");
    expect(body.test_specifications).toBeUndefined();
  });

  it("adds the Robocourier block only in sandbox mode", async () => {
    const { uber, calls } = api([TOKEN, { status: 200, body: { id: "del_8", status: "pending", fee: 1099, tracking_url: "https://t.test/8" } }], memoryCache(), true);
    await uber.createDelivery(DELIVERY_REQ);
    expect(JSON.parse(calls[1].body!).test_specifications).toEqual({ robo_courier_specification: { mode: "auto" } });
  });

  it("surfaces a duplicate delivery as unavailable with Uber's message", async () => {
    const { uber } = api([TOKEN, { status: 409, body: { code: "duplicate_delivery", message: "already exists", kind: "error" } }]);
    await expect(uber.createDelivery(DELIVERY_REQ)).rejects.toThrow(/duplicate_delivery/);
  });

  it("rejects a response missing the fields we depend on rather than storing nonsense", async () => {
    const { uber } = api([TOKEN, { status: 200, body: { id: "del_9", status: "pending" } }]);
    await expect(uber.createDelivery(DELIVERY_REQ)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("verifyUberSignature", () => {
  // The docs' own worked example: this key over this payload yields this digest.
  const KEY = "c5c26d5a-70d6-46c7-a652-d7c09825ad29";
  const PAYLOAD = '{"kind": "event.courier_update", "location": {"lat": 37.7974109, "lng": -122.424145}}';
  const SIG = "cdff8133fb065f8d37a2c1c94c3331b6a82766d14e7ea4faacc4886558cedd65";

  it("accepts the signature from Uber's documented example", async () => {
    expect(await verifyUberSignature(KEY, PAYLOAD, SIG)).toBe(true);
  });
  it("accepts an uppercase or padded header", async () => {
    expect(await verifyUberSignature(KEY, PAYLOAD, ` ${SIG.toUpperCase()} `)).toBe(true);
  });
  it("rejects a tampered body, a wrong key, and a missing header", async () => {
    expect(await verifyUberSignature(KEY, `${PAYLOAD} `, SIG)).toBe(false);
    expect(await verifyUberSignature("other-key", PAYLOAD, SIG)).toBe(false);
    expect(await verifyUberSignature(KEY, PAYLOAD, undefined)).toBe(false);
    expect(await verifyUberSignature("", PAYLOAD, SIG)).toBe(false);
  });
});
