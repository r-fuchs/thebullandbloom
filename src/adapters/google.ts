// Google Calendar behind one interface (email moved to adapters/mailer.ts, D55). Core and jobs depend on this file only;
// the real implementation (google-api.ts) and the test fake both satisfy it.

export interface CalendarEvent {
  id: string;
  status?: string; // "confirmed" | "tentative" | "cancelled"
  summary?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
}
export interface NewAllDayEvent { id: string; date: string; summary: string; description: string }
/** Moved to adapters/mailer.ts; re-exported so existing imports keep working. */
export type { Mail } from "./mailer";
export interface Connection { refreshToken: string; account: string }

export class GoogleNotConnected extends Error {
  constructor() { super("google: not connected"); this.name = "GoogleNotConnected"; }
}

export interface Google {
  /** true when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set */
  configured(): boolean;
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<Connection>;
  listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  /** find a calendar by exact name in the connected account, else create it; returns its id */
  ensureCalendar(summary: string, timeZone: string): Promise<string>;
  /** returns the event id; an event that already exists with this id counts as success (D21) */
  insertAllDayEvent(calendarId: string, event: NewAllDayEvent): Promise<string>;
}
