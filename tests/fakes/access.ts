import type { Access, AdminIdentity } from "../../src/adapters/access";

export class FakeAccess implements Access {
  /** every token the fake was asked about, newest last */
  seen: Array<string | undefined> = [];
  denyAll = false;
  async verify(token: string | undefined): Promise<AdminIdentity | null> {
    this.seen.push(token);
    if (this.denyAll || !token || !token.startsWith("test:")) return null;
    return { email: token.slice(5) };
  }
}
