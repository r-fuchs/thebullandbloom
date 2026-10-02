// Owner alerts on a channel that shares nothing with the mailer (D56). Lane B adds the
// Email Routing implementation; until then `NoAlerts` keeps the D58 hook wired.

export interface Alerts {
  configured(): boolean;
  /** never throws; logs and returns */
  notify(subject: string, text: string): Promise<void>;
}

export class NoAlerts implements Alerts {
  configured() { return false; }
  async notify() {}
}
