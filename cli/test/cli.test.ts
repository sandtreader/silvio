// CLI integration tests: drive the real server over real HTTP through the
// CLI's run() entry. Sequential — later tests build on earlier state, like
// a scripted admin session would.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { run } from '../src/run.js';
import { buildApp } from '../../server/src/api/app.js';
import { register } from '../../server/src/services/auth.js';
import { apply, approve } from '../../server/src/services/membership.js';
import { SqliteStorage } from '../../server/src/storage/sqlite/index.js';

let storage: SqliteStorage;
let app: FastifyInstance;
let url: string;
let dir: string;

// one config dotfile per profile, like separate users' home dirs
let cfgOp: string;
let cfgAdmin: string;
let cfgAlice: string;
let cfgBob: string;

async function cli(args: string[], configPath: string) {
  return run(args, { configPath });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'silvio-cli-'));
  cfgOp = join(dir, 'op.json');
  cfgAdmin = join(dir, 'admin.json');
  cfgAlice = join(dir, 'alice.json');
  cfgBob = join(dir, 'bob.json');

  storage = new SqliteStorage(':memory:');
  const op = await register(storage, { email: 'op@example.com', password: 'operator-pass' });
  await storage.setOperator(op.id, true);
  app = await buildApp(storage);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('silvio CLI', () => {
  let aliceId: string;
  let aliceNo: number;
  let bobNo: number;
  let invoiceId: string;

  it('operator logs in and provisions a group', async () => {
    const login = await cli(
      ['op', 'login', '-s', url, '-e', 'op@example.com', '-p', 'operator-pass'],
      cfgOp,
    );
    expect(login.stderr).toBe('');
    expect(login.code).toBe(0);

    const create = await cli(
      [
        'op', 'groups', 'create',
        '--slug', 'cam', '--name', 'CamLETS',
        '--currency-code', 'CAM', '--currency-name', 'Cams', '--scale', '2',
      ],
      cfgOp,
    );
    expect(create.code).toBe(0);
    expect(create.stdout).toContain('cam');

    const list = await cli(['op', 'groups'], cfgOp);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('CamLETS');
  });

  it('a non-operator login fails with a non-zero exit', async () => {
    const res = await cli(
      ['op', 'login', '-s', url, '-e', 'nobody@example.com', '-p', 'wrong'],
      join(dir, 'scratch.json'),
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).not.toBe('');
  });

  it('someone applies via the CLI; the admin approves', async () => {
    // seed the admin directly (bootstrapping the first admin is a server todo)
    const group = (await storage.groupBySlug('cam'))!;
    const adminUser = await register(storage, {
      email: 'admin@example.com', password: 'admin-password',
    });
    const adminApplied = await apply(storage, {
      groupId: group.id, displayName: 'Admin', personName: 'Admin',
      email: 'admin@example.com', userId: adminUser.id,
    });
    await approve(storage, adminApplied.member.id);
    await storage.updateMember(adminApplied.member.id, { role: 'admin' });

    const applyRes = await cli(
      [
        'apply', '-s', url, '-g', 'cam',
        '--name', 'Alice', '--person', 'Alice Smith',
        '--email', 'alice@example.com', '-p', 'alice-password',
      ],
      join(dir, 'scratch2.json'),
    );
    expect(applyRes.code).toBe(0);

    const adminLogin = await cli(
      ['login', '-s', url, '-g', 'cam', '-e', 'admin@example.com', '-p', 'admin-password'],
      cfgAdmin,
    );
    expect(adminLogin.code).toBe(0);

    const queue = await cli(['admin', 'members', '--status', 'applied', '--json'], cfgAdmin);
    expect(queue.code).toBe(0);
    const members = JSON.parse(queue.stdout);
    expect(members).toHaveLength(1);
    expect(members[0].displayName).toBe('Alice');
    aliceId = members[0].id;

    const approveRes = await cli(['admin', 'approve', aliceId], cfgAdmin);
    expect(approveRes.code).toBe(0);
  });

  it('members log in; me shows profile and balances', async () => {
    const login = await cli(
      ['login', '-s', url, '-g', 'cam', '-e', 'alice@example.com', '-p', 'alice-password'],
      cfgAlice,
    );
    expect(login.code).toBe(0);

    const me = await cli(['me', '--json'], cfgAlice);
    expect(me.code).toBe(0);
    const parsed = JSON.parse(me.stdout);
    expect(parsed.member.displayName).toBe('Alice');
    expect(parsed.accounts[0].balance).toBe(0);
    aliceNo = parsed.member.memberNo;
  });

  it('pay by member number; statement shows the line', async () => {
    // bob joins via CLI end to end
    await cli(
      ['apply', '-s', url, '-g', 'cam', '--name', 'Bob', '--person', 'Bob',
        '--email', 'bob@example.com', '-p', 'bob-password-1'],
      join(dir, 'scratch3.json'),
    );
    const queue = await cli(['admin', 'members', '--status', 'applied', '--json'], cfgAdmin);
    const bobId = JSON.parse(queue.stdout)[0].id;
    await cli(['admin', 'approve', bobId], cfgAdmin);
    await cli(
      ['login', '-s', url, '-g', 'cam', '-e', 'bob@example.com', '-p', 'bob-password-1'],
      cfgBob,
    );
    const bobMe = await cli(['me', '--json'], cfgBob);
    bobNo = JSON.parse(bobMe.stdout).member.memberNo;

    const pay = await cli(['pay', `#${bobNo}`, '500', '-d', 'veg box'], cfgAlice);
    expect(pay.stderr).toBe('');
    expect(pay.code).toBe(0);

    const statement = await cli(['statement'], cfgAlice);
    expect(statement.code).toBe(0);
    expect(statement.stdout).toContain('-500');
    expect(statement.stdout).toContain('veg box');

    const me = await cli(['me', '--json'], cfgAlice);
    expect(JSON.parse(me.stdout).accounts[0].balance).toBe(-500);
  });

  it('invoice, pending, accept', async () => {
    const invoice = await cli(
      ['invoice', `#${aliceNo}`, '300', '-d', 'hedge trimming', '--json'],
      cfgBob,
    );
    expect(invoice.code).toBe(0);
    invoiceId = JSON.parse(invoice.stdout).transaction.id;

    const pending = await cli(['pending', '--json'], cfgAlice);
    expect(pending.code).toBe(0);
    const items = JSON.parse(pending.stdout);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(invoiceId);

    const accept = await cli(['tx', 'accept', invoiceId], cfgAlice);
    expect(accept.code).toBe(0);

    const me = await cli(['me', '--json'], cfgAlice);
    expect(JSON.parse(me.stdout).accounts[0].balance).toBe(-800);
  });

  it('admin sets a hard limit; a breaching payment exits non-zero', async () => {
    const policy = await cli(
      ['admin', 'policies', 'add', '--currency', 'CAM', '--type', 'hard_limit',
        '--min', '-1000'],
      cfgAdmin,
    );
    expect(policy.stderr).toBe('');
    expect(policy.code).toBe(0);

    const denied = await cli(['pay', `#${bobNo}`, '500'], cfgAlice); // would be -1300
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('-1000');

    const allowed = await cli(['pay', `#${bobNo}`, '100'], cfgAlice); // -900, inside
    expect(allowed.code).toBe(0);
  });

  it('members directory is listable and machine-readable', async () => {
    const human = await cli(['members'], cfgAlice);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Alice');
    expect(human.stdout).toContain('Bob');

    const json = await cli(['members', '--json'], cfgAlice);
    const members = JSON.parse(json.stdout);
    expect(members.length).toBeGreaterThanOrEqual(3); // alice, bob, admin
  });

  it('logout invalidates the stored session', async () => {
    const logout = await cli(['logout'], cfgAlice);
    expect(logout.code).toBe(0);
    const me = await cli(['me'], cfgAlice);
    expect(me.code).not.toBe(0);
  });

  it('commands without a session fail cleanly', async () => {
    const res = await cli(['statement'], join(dir, 'empty.json'));
    expect(res.code).not.toBe(0);
    expect(res.stderr).not.toBe('');
  });
});
