// Custom Rafiki AuthenticationProvider over the Silvio operator login
// (decision #21): POST /operator/login sets the session cookie. Operators
// are a different principal from members — there is no /me or capability
// model, so a successful login grants the static 'operator.*' capability
// that every menu entry requires. Known accepted limitation (as in the
// admin app): a page reload loses the Rafiki session.

import type { ApiClient } from '@silvio/ui-shared';
import type { AuthenticationProvider, SessionState } from '@sandtreader/rafiki';

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

export class OperatorAuthenticationProvider implements AuthenticationProvider {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  /** Rafiki's "user name" field is the operator's login email. */
  async login(userId: string, password: string): Promise<SessionState> {
    try {
      await this.client.operatorLogin(userId, password);
      return makeSession({
        loggedIn: true,
        userId,
        userName: userId, // no operator profile endpoint; the email will do
        capabilities: ['operator.*'],
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
