// Outgoing email behind one interface (D55). The outbox drain depends on `Mailer` only;
// ResendMailer and the test fake both satisfy it.

export interface Mail { to: string; subject: string; text: string }

export class MailerNotConfigured extends Error {
  constructor() { super("mailer: not configured"); this.name = "MailerNotConfigured"; }
}

export interface Mailer {
  /** true when the provider key is present */
  configured(): boolean;
  /** resolves on success; throws on any failure so the outbox retries */
  send(mail: Mail): Promise<void>;
}

const RESEND_URL = "https://api.resend.com/emails";

export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string | undefined,
    private from: string,
    private replyTo: string,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  configured(): boolean { return typeof this.apiKey === "string" && this.apiKey !== ""; }

  async send(mail: Mail): Promise<void> {
    if (!this.configured()) throw new MailerNotConfigured();
    const r = await this.fetchFn(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [mail.to], reply_to: this.replyTo, subject: mail.subject, text: mail.text }),
    });
    if (r.ok) return;
    const text = await r.text();
    let detail: unknown = text;
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message;
      if (m !== undefined) detail = m;
    } catch { /* not JSON: use the raw body */ }
    throw new Error(`resend ${r.status}: ${String(detail).slice(0, 300)}`);
  }
}
