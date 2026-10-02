import type { Mail, Mailer } from "../../src/adapters/mailer";

export class FakeMailer implements Mailer {
  isConfigured = true;
  sent: Mail[] = [];
  /** when set, the next send throws this message once */
  failNext: string | null = null;

  configured() { return this.isConfigured; }
  async send(mail: Mail) { this.maybeFail(); this.sent.push(mail); }

  private maybeFail() {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
  }
}
