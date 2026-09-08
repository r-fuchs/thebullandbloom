import { GoogleNotConnected, type Google } from "./google";
import type { ConnectionSource } from "../store/google";
export class GoogleApi implements Google {
  constructor(private clientId: string | undefined, private clientSecret: string | undefined, private source: ConnectionSource) {}
  configured() { return Boolean(this.clientId && this.clientSecret); }
  authUrl(): string { throw new GoogleNotConnected(); }
  async exchangeCode(): Promise<never> { throw new GoogleNotConnected(); }
  async listEvents(): Promise<never> { throw new GoogleNotConnected(); }
  async ensureCalendar(): Promise<never> { throw new GoogleNotConnected(); }
  async insertAllDayEvent(): Promise<never> { throw new GoogleNotConnected(); }
  async sendMail(): Promise<never> { throw new GoogleNotConnected(); }
}
