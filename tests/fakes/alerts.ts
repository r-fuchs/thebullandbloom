import type { Alerts } from "../../src/adapters/alerts";

export class FakeAlerts implements Alerts {
  isConfigured = true;
  sent: Array<{ subject: string; text: string }> = [];
  configured() { return this.isConfigured; }
  async notify(subject: string, text: string) { this.sent.push({ subject, text }); }
}
