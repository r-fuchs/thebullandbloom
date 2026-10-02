// Owner alerts on a channel that shares nothing with the mailer (D56): Cloudflare Email Routing's
// `send_email` binding, to destination addresses verified on the zone.

export interface Alerts {
  configured(): boolean;
  /** never throws; logs and returns */
  notify(subject: string, text: string): Promise<void>;
}

const CRLF = "\r\n";
// Header values must be one ASCII line: strip line breaks, and encode anything else (RFC 2047) so a customer's name never breaks the message.
function headerValue(s: string): string {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(one)) return one;
  const bytes = new TextEncoder().encode(one);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

/** A minimal RFC 5322 text/plain message. Exported for tests. */
export function buildRaw(from: string, to: string, subject: string, text: string, now: Date = new Date()): string {
  const domain = from.split("@")[1] ?? "localhost";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${headerValue(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text.replace(/\r?\n/g, CRLF),
    "",
  ].join(CRLF);
}

export class EmailRoutingAlerts implements Alerts {
  constructor(private binding: SendEmail | undefined, private from: string, private to: string[]) {}
  configured() { return !!this.binding && this.to.length > 0; }
  async notify(subject: string, text: string): Promise<void> {
    if (!this.binding) return;
    try {
      // Lazy: only the deployed Worker has this module; test files that import this adapter never load it.
      const { EmailMessage } = await import("cloudflare:email");
      // One message per recipient: a rejected address must not stop the others.
      for (const to of this.to) {
        try {
          await this.binding.send(new EmailMessage(this.from, to, buildRaw(this.from, to, subject, text)));
        } catch (e) {
          console.error(`alerts: send to ${to} failed`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error("alerts: notify failed", e instanceof Error ? e.message : e);
    }
  }
}

export class NoAlerts implements Alerts {
  configured() { return false; }
  async notify() {}
}
