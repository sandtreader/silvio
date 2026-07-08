// CLI entry: parse argv (command + options), talk to the Silvio REST API.
// run() is the testable unit; bin/index.ts wires it to process argv/stdio.

import { Command, CommanderError } from 'commander';
import { ApiError, Client } from './client.js';
import { readConfig, writeConfig, type Config } from './config.js';

export interface RunResult {
  code: number; // process exit code: 0 success, 1 API/user error, 2 usage
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  configPath: string; // dotfile holding {server, group, cookie} (env-overridable)
}

interface Account {
  id: string;
  currencyId: string;
  currencyCode: string;
  balance: number;
}

interface MeBody {
  member: { id: string; memberNo: number; displayName: string };
  accounts: Account[];
}

interface DirectoryMember {
  id: string;
  memberNo: number;
  displayName: string;
  status: string;
}

interface TransactionBody {
  transaction: { id: string; state: string };
}

interface PendingItem {
  id: string;
  type: string;
  flow?: string;
  amount: number;
  direction: string;
  description?: string;
  actions: string[];
}

interface StatementLine {
  amount: number;
  runningBalance: number;
  description?: string;
  committedAt: string;
}

function parseAmount(raw: string, label: string): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new ApiError(`${label} must be an integer, got '${raw}'`);
  return value;
}

export async function run(argv: string[], opts: RunOptions): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const print = (line: string): void => {
    stdout += `${line}\n`;
  };

  const { configPath } = opts;

  function memberClient(): Client {
    const config = readConfig(configPath);
    if (config.server === undefined || config.group === undefined || config.cookie === undefined) {
      throw new ApiError('not logged in — run: silvio login');
    }
    return new Client({ server: config.server, group: config.group, cookie: config.cookie });
  }

  function operatorClient(): Client {
    const config = readConfig(configPath);
    if (config.server === undefined || config.cookie === undefined) {
      throw new ApiError('not logged in — run: silvio op login');
    }
    return new Client({ server: config.server, cookie: config.cookie });
  }

  async function getMe(client: Client): Promise<MeBody> {
    const res = await client.request('GET', client.groupUrl('/me'));
    return res.body as MeBody;
  }

  /** A payee/payer argument is a raw member id or '#<memberNo>'. */
  async function resolveMemberId(client: Client, arg: string): Promise<string> {
    if (!arg.startsWith('#')) return arg;
    const no = Number.parseInt(arg.slice(1), 10);
    if (Number.isNaN(no)) throw new ApiError(`invalid member number '${arg}'`);
    const res = await client.request('GET', client.groupUrl('/members'));
    const { members } = res.body as { members: DirectoryMember[] };
    const member = members.find((candidate) => candidate.memberNo === no);
    if (!member) throw new ApiError(`no member ${arg} in the directory`);
    return member.id;
  }

  /** -c code -> currencyId via the caller's accounts; default when unambiguous. */
  async function resolveCurrencyId(client: Client, code: string | undefined): Promise<string> {
    const me = await getMe(client);
    if (code !== undefined) {
      const account = me.accounts.find((candidate) => candidate.currencyCode === code);
      if (!account) throw new ApiError(`you have no account in currency ${code}`);
      return account.currencyId;
    }
    const only = me.accounts.length === 1 ? me.accounts[0] : undefined;
    if (only === undefined) {
      throw new ApiError('you hold accounts in several currencies — specify one with -c <code>');
    }
    return only.currencyId;
  }

  const program = new Command('silvio');
  program.description('Silvio LETS command-line client');
  // Capture everything: no direct process stdio writes, exits become throws.
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => {
      stdout += str;
    },
    writeErr: (str) => {
      stderr += str;
    },
  });

  /** Option value, else the remembered dotfile value, else a clear error. */
  function remembered(given: string | undefined, key: 'server' | 'group' | 'email'): string {
    if (given !== undefined) return given;
    const value = readConfig(configPath)[key];
    if (value !== undefined) return value;
    throw new ApiError(`no ${key} known — pass it on the command line (see --help)`);
  }

  program
    .command('login')
    .description('log in to a group as a member (server/group/email remembered from last time)')
    .option('-s, --server <url>', 'server base URL')
    .option('-g, --group <slug>', 'group slug')
    .option('-e, --email <email>', 'account email')
    .requiredOption('-p, --password <password>', 'account password')
    .action(
      async (options: { server?: string; group?: string; email?: string; password: string }) => {
        const server = remembered(options.server, 'server');
        const group = remembered(options.group, 'group');
        const email = remembered(options.email, 'email');
        const client = new Client({ server, group });
        const res = await client.request('POST', client.groupUrl('/auth/login'), {
          email,
          password: options.password,
        });
        if (res.cookie === undefined) {
          throw new ApiError('login succeeded but set no session cookie');
        }
        writeConfig(configPath, { server, group, email, cookie: res.cookie });
        print(`logged in to ${group} as ${email}`);
      },
    );

  program
    .command('logout')
    .description('end the session and clear the stored cookie')
    .action(async () => {
      const config = readConfig(configPath);
      if (config.server !== undefined && config.group !== undefined && config.cookie !== undefined) {
        const client = new Client({
          server: config.server,
          group: config.group,
          cookie: config.cookie,
        });
        await client.request('POST', client.groupUrl('/auth/logout'));
      }
      const next: Config = {};
      if (config.server !== undefined) next.server = config.server;
      if (config.group !== undefined) next.group = config.group;
      if (config.email !== undefined) next.email = config.email;
      writeConfig(configPath, next);
      print('logged out');
    });

  program
    .command('apply')
    .description('apply to join a group (no login required)')
    .requiredOption('-s, --server <url>', 'server base URL')
    .requiredOption('-g, --group <slug>', 'group slug')
    .requiredOption('--name <displayName>', 'display name in the directory')
    .requiredOption('--person <personName>', 'your legal/personal name')
    .requiredOption('-e, --email <email>', 'account email')
    .requiredOption('-p, --password <password>', 'account password')
    .action(
      async (options: {
        server: string;
        group: string;
        name: string;
        person: string;
        email: string;
        password: string;
      }) => {
        const client = new Client({ server: options.server, group: options.group });
        await client.request('POST', client.groupUrl('/applications'), {
          displayName: options.name,
          personName: options.person,
          email: options.email,
          password: options.password,
        });
        print(`application submitted to ${options.group} for ${options.name} — awaiting approval`);
      },
    );

  program
    .command('me')
    .description('show your profile and balances')
    .option('--json', 'raw JSON output')
    .action(async (options: { json?: true }) => {
      const client = memberClient();
      const res = await client.request('GET', client.groupUrl('/me'));
      if (options.json === true) {
        print(JSON.stringify(res.body));
        return;
      }
      const body = res.body as MeBody;
      print(body.member.displayName);
      print(`member #${body.member.memberNo}`);
      for (const account of body.accounts) {
        print(`${account.currencyCode}  ${account.balance}`);
      }
    });

  program
    .command('members')
    .description('list the member directory')
    .option('--json', 'raw JSON output')
    .action(async (options: { json?: true }) => {
      const client = memberClient();
      const res = await client.request('GET', client.groupUrl('/members'));
      const { members } = res.body as { members: DirectoryMember[] };
      if (options.json === true) {
        print(JSON.stringify(members));
        return;
      }
      for (const member of members) {
        print(`#${member.memberNo}  ${member.displayName}  (${member.status})`);
      }
    });

  program
    .command('pay')
    .description('pay another member')
    .argument('<member>', "payee: member id or '#<no>'")
    .argument('<amount>', 'amount in minor units')
    .option('-c, --currency <code>', 'currency code (default: your only account)')
    .option('-d, --description <text>', 'what the payment is for')
    .action(
      async (member: string, amount: string, options: { currency?: string; description?: string }) => {
        const client = memberClient();
        const payeeMemberId = await resolveMemberId(client, member);
        const currencyId = await resolveCurrencyId(client, options.currency);
        const body: {
          payeeMemberId: string;
          currencyId: string;
          amount: number;
          description?: string;
        } = { payeeMemberId, currencyId, amount: parseAmount(amount, 'amount') };
        if (options.description !== undefined) body.description = options.description;
        const res = await client.request('POST', client.groupUrl('/payments'), body);
        const { transaction } = res.body as TransactionBody;
        print(`payment ${transaction.state}  ${transaction.id}`);
      },
    );

  program
    .command('invoice')
    .description('request payment from another member')
    .argument('<member>', "payer: member id or '#<no>'")
    .argument('<amount>', 'amount in minor units')
    .option('-c, --currency <code>', 'currency code (default: your only account)')
    .option('-d, --description <text>', 'what the invoice is for')
    .option('--json', 'raw JSON output')
    .action(
      async (
        member: string,
        amount: string,
        options: { currency?: string; description?: string; json?: true },
      ) => {
        const client = memberClient();
        const payerMemberId = await resolveMemberId(client, member);
        const currencyId = await resolveCurrencyId(client, options.currency);
        const body: {
          payerMemberId: string;
          currencyId: string;
          amount: number;
          description?: string;
        } = { payerMemberId, currencyId, amount: parseAmount(amount, 'amount') };
        if (options.description !== undefined) body.description = options.description;
        const res = await client.request('POST', client.groupUrl('/invoices'), body);
        if (options.json === true) {
          print(JSON.stringify(res.body));
          return;
        }
        const { transaction } = res.body as TransactionBody;
        print(`invoice ${transaction.state}  ${transaction.id}`);
      },
    );

  program
    .command('pending')
    .description('list transactions awaiting action')
    .option('--json', 'raw JSON output')
    .action(async (options: { json?: true }) => {
      const client = memberClient();
      const res = await client.request('GET', client.groupUrl('/me/pending'));
      const { pending } = res.body as { pending: PendingItem[] };
      if (options.json === true) {
        print(JSON.stringify(pending));
        return;
      }
      for (const item of pending) {
        print(
          `${item.id}  ${item.flow ?? item.type}  ${item.direction}  ${item.amount}  ` +
            `[${item.actions.join(', ')}]`,
        );
      }
    });

  const tx = program.command('tx').description('act on a pending transaction');
  for (const action of ['accept', 'decline', 'cancel'] as const) {
    tx.command(action)
      .description(`${action} a pending transaction`)
      .argument('<id>', 'transaction id')
      .action(async (id: string) => {
        const client = memberClient();
        const res = await client.request('POST', client.groupUrl(`/transactions/${id}/${action}`));
        const { transaction } = res.body as TransactionBody;
        print(`transaction ${transaction.id} is now ${transaction.state}`);
      });
  }

  program
    .command('statement')
    .description('show your account statement')
    .option('-c, --currency <code>', 'currency code (default: your only account)')
    .option('--json', 'raw JSON output')
    .action(async (options: { currency?: string; json?: true }) => {
      const client = memberClient();
      const currencyId = await resolveCurrencyId(client, options.currency);
      const res = await client.request(
        'GET',
        client.groupUrl(`/me/statement?currencyId=${encodeURIComponent(currencyId)}`),
      );
      const { lines } = res.body as { lines: StatementLine[] };
      if (options.json === true) {
        print(JSON.stringify(lines));
        return;
      }
      for (const line of lines) {
        print(
          `${line.committedAt}  ${line.amount}  ${line.runningBalance}  ` +
            `${line.description ?? ''}`.trimEnd(),
        );
      }
    });

  // --- admin: group management, requires the admin role ---------------------

  const admin = program.command('admin').description('group administration');

  admin
    .command('members')
    .description('list members, optionally by status')
    .option('--status <status>', 'applied|active|away|suspended|closed')
    .option('--json', 'raw JSON output')
    .action(async (options: { status?: string; json?: true }) => {
      const client = memberClient();
      const query =
        options.status === undefined ? '' : `?status=${encodeURIComponent(options.status)}`;
      const res = await client.request('GET', client.groupUrl(`/admin/members${query}`));
      const { members } = res.body as { members: DirectoryMember[] };
      if (options.json === true) {
        print(JSON.stringify(members));
        return;
      }
      for (const member of members) {
        print(`#${member.memberNo}  ${member.displayName}  (${member.status})`);
      }
    });

  /**
   * Admin variant of member resolution: '#<no>' looked up via the admin
   * members list, which — unlike the public directory — includes applicants
   * and suspended/closed members.
   */
  async function resolveAdminMemberId(client: Client, arg: string): Promise<string> {
    if (!arg.startsWith('#')) return arg;
    const no = Number.parseInt(arg.slice(1), 10);
    if (Number.isNaN(no)) throw new ApiError(`invalid member number '${arg}'`);
    const res = await client.request('GET', client.groupUrl('/admin/members'));
    const { members } = res.body as { members: DirectoryMember[] };
    const member = members.find((candidate) => candidate.memberNo === no);
    if (!member) throw new ApiError(`no member ${arg} in this group`);
    return member.id;
  }

  admin
    .command('role')
    .description("set a member's role")
    .argument('<member>', "member id or '#<no>'")
    .argument('<role>', 'member|committee|admin')
    .action(async (member: string, role: string) => {
      const client = memberClient();
      const memberId = await resolveAdminMemberId(client, member);
      const res = await client.request(
        'POST',
        client.groupUrl(`/admin/members/${memberId}/role`),
        { role },
      );
      const { member: updated } = res.body as { member: { displayName: string; role: string } };
      print(`${updated.displayName} is now ${updated.role}`);
    });

  for (const action of ['approve', 'suspend', 'reinstate', 'remove'] as const) {
    admin
      .command(action)
      .description(`${action} a member`)
      .argument('<member>', "member id or '#<no>'")
      .action(async (member: string) => {
        const client = memberClient();
        const memberId = await resolveAdminMemberId(client, member);
        const res = await client.request(
          'POST',
          client.groupUrl(`/admin/members/${memberId}/${action}`),
        );
        const { member: updated } = res.body as { member: { displayName: string; status: string } };
        print(`${updated.displayName} is now ${updated.status}`);
      });
  }

  const policies = admin
    .command('policies')
    .description('list credit policies')
    .option('--json', 'raw JSON output')
    .action(async (options: { json?: true }) => {
      const client = memberClient();
      const res = await client.request('GET', client.groupUrl('/admin/policies'));
      if (options.json === true) {
        print(JSON.stringify(res.body));
        return;
      }
      const body = res.body as {
        policies: { id: string; type: string; enabled: boolean; config: unknown }[];
      };
      for (const policy of body.policies) {
        print(
          `${policy.id}  ${policy.type}  ${policy.enabled ? 'enabled' : 'disabled'}  ` +
            JSON.stringify(policy.config),
        );
      }
    });

  policies
    .command('add')
    .description('add a credit policy for a currency')
    .requiredOption('--currency <code>', 'currency code')
    .requiredOption('--type <type>', 'soft_threshold|hard_limit')
    .option('--min <n>', 'minimum balance (max debit)')
    .option('--max <n>', 'maximum balance (max credit)')
    .action(async (options: { currency: string; type: string; min?: string; max?: string }) => {
      const client = memberClient();
      const currencyId = await resolveCurrencyId(client, options.currency);
      const config: { minBalance?: number; maxBalance?: number } = {};
      if (options.min !== undefined) config.minBalance = parseAmount(options.min, '--min');
      if (options.max !== undefined) config.maxBalance = parseAmount(options.max, '--max');
      const res = await client.request('POST', client.groupUrl('/admin/policies'), {
        currencyId,
        type: options.type,
        config,
      });
      const { policy } = res.body as { policy: { id: string; type: string } };
      print(`policy ${policy.id} (${policy.type}) added for ${options.currency}`);
    });

  // --- op: platform operator, outside any tenant -----------------------------

  const op = program.command('op').description('platform operator commands');

  op.command('login')
    .description('log in as a platform operator (server/email remembered from last time)')
    .option('-s, --server <url>', 'server base URL')
    .option('-e, --email <email>', 'operator email')
    .requiredOption('-p, --password <password>', 'operator password')
    .action(async (options: { server?: string; email?: string; password: string }) => {
      const server = remembered(options.server, 'server');
      const email = remembered(options.email, 'email');
      const client = new Client({ server });
      const res = await client.request('POST', client.operatorUrl('/login'), {
        email,
        password: options.password,
      });
      if (res.cookie === undefined) throw new ApiError('login succeeded but set no session cookie');
      writeConfig(configPath, { server, email, cookie: res.cookie });
      print(`logged in as operator ${email}`);
    });

  const opGroups = op
    .command('groups')
    .description('list groups on the platform')
    .option('--json', 'raw JSON output')
    .action(async (options: { json?: true }) => {
      const client = operatorClient();
      const res = await client.request('GET', client.operatorUrl('/groups'));
      if (options.json === true) {
        print(JSON.stringify(res.body));
        return;
      }
      const { groups } = res.body as { groups: { slug: string; name: string }[] };
      for (const group of groups) {
        print(`${group.slug}  ${group.name}`);
      }
    });

  opGroups
    .command('create')
    .description('provision a new group with its currency')
    .requiredOption('--slug <slug>', 'group slug')
    .requiredOption('--name <name>', 'group name')
    .requiredOption('--currency-code <code>', 'currency code')
    .requiredOption('--currency-name <name>', 'currency name')
    .option('--scale <n>', 'decimal places')
    .option('--demurrage-day <n>', 'day of month demurrage runs')
    .option('--hostname <hostname>', 'custom domain for the group')
    .option('--admin-name <displayName>', "initial admin's display name")
    .option('--admin-person <personName>', "initial admin's legal/personal name")
    .option('--admin-email <email>', "initial admin's account email")
    .option('--admin-password <password>', "initial admin's password (new users only)")
    .action(
      async (options: {
        slug: string;
        name: string;
        currencyCode: string;
        currencyName: string;
        scale?: string;
        demurrageDay?: string;
        hostname?: string;
        adminName?: string;
        adminPerson?: string;
        adminEmail?: string;
        adminPassword?: string;
      }) => {
        const client = operatorClient();
        const currency: { code: string; name: string; scale?: number; demurrageDay?: number } = {
          code: options.currencyCode,
          name: options.currencyName,
        };
        if (options.scale !== undefined) currency.scale = parseAmount(options.scale, '--scale');
        if (options.demurrageDay !== undefined) {
          currency.demurrageDay = parseAmount(options.demurrageDay, '--demurrage-day');
        }
        const body: {
          slug: string;
          name: string;
          hostname?: string;
          currency: typeof currency;
          admin?: { displayName?: string; personName?: string; email: string; password?: string };
        } = { slug: options.slug, name: options.name, currency };
        if (options.hostname !== undefined) body.hostname = options.hostname;
        if (options.adminEmail !== undefined) {
          const admin: NonNullable<typeof body.admin> = { email: options.adminEmail };
          if (options.adminName !== undefined) admin.displayName = options.adminName;
          if (options.adminPerson !== undefined) admin.personName = options.adminPerson;
          if (options.adminPassword !== undefined) admin.password = options.adminPassword;
          body.admin = admin;
        }
        const res = await client.request('POST', client.operatorUrl('/groups'), body);
        const payload = res.body as { group: { slug: string }; currency: { code: string } };
        print(`created group ${payload.group.slug} with currency ${payload.currency.code}`);
      },
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error instanceof CommanderError) {
      // help/version display exits 0; genuine usage errors exit 2
      if (error.exitCode === 0) return { code: 0, stdout, stderr };
      return { code: 2, stdout, stderr };
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr += `${message}\n`;
    return { code: 1, stdout, stderr };
  }
}
