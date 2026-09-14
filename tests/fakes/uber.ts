import type {
  DeliveryRequest, QuoteRequest, Uber, UberDelivery, UberFailureCode, UberQuote,
} from "../../src/adapters/uber";
import { UberError } from "../../src/adapters/uber";

export class FakeUber implements Uber {
  isConfigured = true;
  /** every quote request seen, newest last */
  quoted: QuoteRequest[] = [];
  /** every delivery request seen, newest last */
  created: DeliveryRequest[] = [];
  /** what the next quote() returns; the id gains a counter suffix so ids stay unique */
  quoteFee = 1200;
  quoteExpiresAt = 2_000_000_000;
  /** what the next createDelivery() reports as the delivery's status; a real Uber value can be
   * anything, including one we do not model — tests use this to exercise that path. */
  nextStatus = "pending";
  /** when set, the next call throws this once */
  failNext: { code: UberFailureCode; message: string } | null = null;
  private n = 0;

  configured() { return this.isConfigured; }

  async quote(req: QuoteRequest): Promise<UberQuote> {
    this.maybeFail();
    this.quoted.push(req);
    this.n += 1;
    return {
      id: `dqt_fake_${this.n}`, feeCents: this.quoteFee, currency: "usd",
      expiresAt: this.quoteExpiresAt, dropoffEtaAt: this.quoteExpiresAt + 1800,
    };
  }

  async createDelivery(req: DeliveryRequest): Promise<UberDelivery> {
    this.maybeFail();
    this.created.push(req);
    this.n += 1;
    return {
      id: `del_fake_${this.n}`, status: this.nextStatus,
      trackingUrl: `https://track.uber.test/del_fake_${this.n}`, feeCents: this.quoteFee,
    };
  }

  /** convenience for tests that want the failure path */
  failWith(code: UberFailureCode, message: string = code) { this.failNext = { code, message }; }

  private maybeFail() {
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      throw new UberError(f.code, f.message);
    }
  }
}
