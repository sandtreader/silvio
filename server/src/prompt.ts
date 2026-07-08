// Minimal interactive prompts for first-boot setup. Only ever called when
// stdin is a TTY; passwords are read with echo suppressed.

import { createInterface } from 'node:readline';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u007f';

export function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const { stdin } = process;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = '';
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\n' || char === '\r' || char === CTRL_D) {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === CTRL_C) {
          // Ctrl-C during setup: bail out entirely
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === BACKSPACE || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** Ask for operator credentials, confirming the password until it matches. */
export async function promptOperatorCredentials(): Promise<{ email: string; password: string }> {
  console.log('No operator exists yet — setting up the platform operator.');
  const email = await promptLine('Operator email: ');
  for (;;) {
    const password = await promptHidden('Operator password (min 8 chars): ');
    const confirm = await promptHidden('Confirm password: ');
    if (password === confirm && password.length >= 8) return { email, password };
    console.log(
      password === confirm ? 'Password too short, try again.' : 'Passwords differ, try again.',
    );
  }
}
