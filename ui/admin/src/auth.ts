// Custom Rafiki AuthenticationProvider over the Silvio cookie-session API
// (decision #11): POST /auth/login sets the session cookie, GET /me supplies
// the display name and role, and the role maps to Rafiki capability globs.
// Known accepted limitation: a page reload loses the Rafiki session (the
// cookie survives, Rafiki has no restore hook yet) — do not fight it here.

import type { ApiClient } from '@silvio/ui-shared';
import type { AuthenticationProvider, SessionState } from '@sandtreader/rafiki';

/** Map a member role to Rafiki capability patterns. */
function capabilitiesFor(role: string): string[] {
  if (role === 'admin') return ['admin.*'];
  if (role === 'committee') return ['committee.*'];
  return [];
}

/** SessionState is a class in Rafiki but used purely as a type here, so we
 *  return a structurally-compatible object (including hasCapability). */
function makeSession(fields: {
  loggedIn: boolean;
  userId?: string;
  userName?: string;
  capabilities?: string[];
  error?: string;
}): SessionState {
  return {
    ...fields,
    hasCapability(requirement: string): boolean {
      for (const capability of fields.capabilities ?? []) {
        const pattern =
          '^' +
          capability
            .replace(/([.+?^=!:${}()|[\]/\\])/g, '\\$1')
            .replace(/\*/g, '.*') +
          '$';
        if (new RegExp(pattern).test(requirement)) return true;
      }
      return false;
    },
  };
}

export class SilvioAuthenticationProvider implements AuthenticationProvider {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  /** Rafiki's "user name" field is the member's login email. */
  async login(userId: string, password: string): Promise<SessionState> {
    try {
      await this.client.login(userId, password);
      const me = await this.client.me();
      return makeSession({
        loggedIn: true,
        userId,
        userName: me.member.displayName,
        capabilities: capabilitiesFor(me.member.role),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return makeSession({ loggedIn: false, error });
    }
  }

  async logout(_session: SessionState): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Best effort: the UI session is gone either way.
    }
  }
}
