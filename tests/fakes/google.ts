import type { CalendarEvent, Connection, Google, Mail, NewAllDayEvent } from "../../src/adapters/google";

export class FakeGoogle implements Google {
  isConfigured = true;
  /** calendar name -> id, as ensureCalendar would find them */
  calendars = new Map<string, string>();
  /** calendar id -> events returned by listEvents */
  events: Record<string, CalendarEvent[]> = {};
  inserted: Array<{ calendarId: string; event: NewAllDayEvent }> = [];
  sent: Mail[] = [];
  /** when set, the next API call throws this message once */
  failNext: string | null = null;

  configured() { return this.isConfigured; }
  authUrl(state: string, redirectUri: string) {
    return `https://accounts.google.test/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(code: string): Promise<Connection> {
    this.maybeFail();
    if (code !== "good-code") throw new Error("invalid_grant");
    return { refreshToken: "rt_fake", account: "thebullandbloom@gmail.com" };
  }
  async listEvents(calendarId: string) { this.maybeFail(); return this.events[calendarId] ?? []; }
  async ensureCalendar(summary: string) {
    this.maybeFail();
    let id = this.calendars.get(summary);
    if (!id) { id = `cal_${this.calendars.size + 1}`; this.calendars.set(summary, id); }
    return id;
  }
  async insertAllDayEvent(calendarId: string, event: NewAllDayEvent) {
    this.maybeFail();
    this.inserted.push({ calendarId, event });
    return event.id;
  }
  async sendMail(mail: Mail) { this.maybeFail(); this.sent.push(mail); }

  private maybeFail() {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
  }
}
