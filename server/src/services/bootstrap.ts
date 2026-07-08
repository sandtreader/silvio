// First-boot operator bootstrap: idempotent — does nothing once any
// operator exists, so leaving env vars set (or re-running) is harmless.

import type { Storage } from '../storage/interface.js';
import { register } from './auth.js';

export interface BootstrapResult {
  created: boolean;
}

export async function bootstrapOperator(
  storage: Storage,
  input: { email: string; password: string },
): Promise<BootstrapResult> {
  if (await storage.operatorExists()) return { created: false };
  const existing = await storage.credentialsForEmail(input.email);
  const user = existing?.user ?? (await register(storage, input));
  await storage.setOperator(user.id, true);
  return { created: true };
}
