#!/usr/bin/env node
// Demo dataset seeder: builds a lived-in Silvio database at scale — a
// provisioned group, dozens of members across neighbourhoods, a stocked
// marketplace with photos, months of backdated trading history with monthly
// demurrage, pending trades, and CMS content — by driving the built server
// code directly. Build first: (cd server && npm run build).
//
// Usage: node scripts/seed.mjs [--db path] [--members 50] [--months 12] [--seed 42]
// Deterministic for a given seed (timestamps derive from the run date).

import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { SqliteStorage } from '../server/dist/src/storage/sqlite/index.js';
import { provisionGroup } from '../server/dist/src/services/provisioning.js';
import { apply, approve } from '../server/dist/src/services/membership.js';
import { addPerson } from '../server/dist/src/services/persons.js';
import { postListing } from '../server/dist/src/services/marketplace.js';
import { sendPayment, requestPayment, accept } from '../server/dist/src/services/trading.js';
import { setMemberPhoto, setBrandImage, addListingPhoto } from '../server/dist/src/services/images.js';
import { runDemurrage } from '../server/dist/src/ledger/demurrage.js';
import { bootstrapOperator } from '../server/dist/src/services/bootstrap.js';

// ---------- pools ----------

const FIRST_NAMES = [
  'Alice', 'Bob', 'Carol', 'David', 'Eleanor', 'Farid', 'Gemma', 'Harry',
  'Isla', 'Jack', 'Kavita', 'Liam', 'Maureen', 'Nigel', 'Olu', 'Priya',
  'Quentin', 'Rosie', 'Sam', 'Tessa', 'Umar', 'Vera', 'Will', 'Xanthe',
  'Yusuf', 'Zoe', 'Angus', 'Bridget', 'Callum', 'Deirdre', 'Ewan', 'Fiona',
];
const LAST_NAMES = [
  'Smith', 'Jones', 'Taylor', 'Brown', 'Wilson', 'Evans', 'Thomas', 'Khan',
  'Roberts', 'Walker', 'Wright', 'Robinson', 'Wood', 'Patel', 'Clarke',
  'Hall', 'Green', 'Baker', 'Hill', 'Adeyemi', 'Morris', 'Cooper', 'Ward',
  'MacLeod', 'Osei', 'Begum', 'Fletcher', 'Dunn', 'Hobbs', 'Trewin',
];
const NEIGHBOURHOODS = [
  'Mill Road', 'Riverside', 'Castle Hill', 'Orchard Park',
  'Newnham', 'Abbeyfields', 'Chesterton', 'Fen End',
];
const CATEGORIES = [
  'Food & Garden', 'Home & DIY', 'Care & Wellbeing', 'Transport & Repairs',
  'Skills & Learning', 'Crafts & Mending', 'Tools & Equipment',
  'Computing & Admin', 'Events & Music', 'Odd Jobs',
];
// [categoryIndex, title, description, price minor units | rateText string]
const OFFERS = [
  [0, 'Weekly veg box', 'Seasonal organic veg from the allotment; collect Friday evenings.', 500],
  [0, 'Jam and chutney', 'Plum jam and green tomato chutney from my own kitchen.', 200],
  [0, 'Sourdough starter and lesson', 'Take home a live starter and learn the weekly routine.', 250],
  [0, 'Surplus apples and pears', 'Windfalls by the bagful in autumn; bring your own bags.', 100],
  [0, 'Hedge and lawn tidy', 'Small gardens only; clippings composted or removed.', '6.00 DEM per hour'],
  [1, 'Shelf and flatpack assembly', 'Your kit, my tools and patience.', '5.00 DEM per hour'],
  [1, 'Painting and decorating', 'Interior walls and woodwork; you buy the paint.', '7.00 DEM per hour'],
  [1, 'Small plumbing jobs', 'Dripping taps, ball valves, leaky joints — nothing gas.', '8.00 DEM per job'],
  [2, 'Childcare after school', 'Experienced with ages 4 to 11, weekday afternoons.', '4.00 DEM per hour'],
  [2, 'Companionable dog walking', 'Daily rounds on the common, rain or shine.', 300],
  [2, 'Yoga in the park', 'Gentle hatha, Saturday mornings, mats provided.', 250],
  [3, 'Bike repair and servicing', 'Punctures, brakes, gears — most jobs turned round in a week.', '5.00 DEM per job plus parts'],
  [3, 'Lifts to town on Thursdays', 'Market run, roughly 9am to noon; happy to share the errands.', 150],
  [3, 'Airport runs with notice', 'Early starts fine with a week’s warning.', 1200],
  [4, 'Conversational Spanish', 'One-to-one practice over coffee, all levels welcome.', '4.50 DEM per hour'],
  [4, 'Maths tuition, GCSE level', 'Patient help with the scary bits; past papers a speciality.', '6.00 DEM per hour'],
  [4, 'Beginner ukulele lessons', 'Three chords and the truth; instruments to borrow.', 400],
  [5, 'Mending and alterations', 'Hems, zips, patches — clothes worth keeping, kept.', '3.00 DEM per item'],
  [5, 'Hand-knitted socks to order', 'Pick your wool and your size; two weeks a pair.', 800],
  [6, 'Tool loan: pressure washer', 'Weekend loans; returned clean and dry, please.', 350],
  [6, 'Tool loan: hedge trimmer', 'Long-reach trimmer, charged and ready.', 300],
  [7, 'Computer help at home', 'Slow laptops, printers, backups and the dreaded cloud.', '5.00 DEM per visit'],
  [7, 'Simple websites for members', 'A tidy page or two for your offer or club.', 2000],
  [8, 'PA and speakers for parties', 'Small hall-sized rig, delivered and set up.', 900],
  [9, 'Log splitting and stacking', 'Your logs, my maul; satisfying for at least one of us.', '5.00 DEM per hour'],
  [9, 'House and pet sitting', 'Plants watered, cats indulged, post stacked.', 400],
];
const WANTS = [
  [0, 'Allotment help wanted', 'An hour or two of digging in exchange for produce and tea.', null],
  [1, 'Loan of a long ladder', 'Gutter clearing, one weekend, careful borrower.', null],
  [2, 'Occasional babysitting', 'One evening a month, two well-behaved children (mostly).', null],
  [3, 'Lift to the recycling centre', 'One car boot of garden waste, any weekday.', null],
  [4, 'Piano accompanist wanted', 'Grade 5-ish, for a term of choir practice.', null],
  [6, 'Borrow a sewing machine', 'A fortnight’s loan for curtain making.', null],
  [7, 'Help moving to a new phone', 'Contacts, photos and the banking app, over biscuits.', null],
  [9, 'Firewood offcuts wanted', 'Untreated timber only; will collect.', null],
];
const TRADE_NOTES = [
  'veg box', 'bike service', 'jam, two jars', 'lift to town', 'childcare',
  'hedge trimming', 'spanish lesson', 'tool loan, weekend', 'sock order',
  'dog walking, one week', 'flatpack assembly', 'computer help',
  'log splitting', 'maths tuition', 'mending, three items', 'airport run',
  'house sitting', 'ukulele lesson', 'painting, hallway', 'apple pressing',
];

// ---------- tiny deterministic PRNG (mulberry32) ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;

// ---------- minimal PNG encoder (8-bit RGB, zlib deflate) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Solid or two-tone (split at half, horizontally or vertically) PNG. */
function makePng(width, height, colourA, colourB, vertical) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colour type 2 (truecolour RGB)
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3); // leading filter byte 0
    for (let x = 0; x < width; x++) {
      const second = vertical ? x >= width / 2 : y >= height / 2;
      const [r, g, b] = second ? colourB : colourA;
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const randColour = () => [randint(30, 225), randint(30, 225), randint(30, 225)];
const randPng = (w = 64, h = 64) => makePng(w, h, randColour(), randColour(), chance(0.5));

// ---------- arguments ----------

function parseArgs(argv) {
  const opts = { db: './demo-seed.sqlite', members: 50, months: 12, seed: 42 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts) || argv[i + 1] === undefined) {
      console.error('usage: node scripts/seed.mjs [--db path] [--members 50] [--months 12] [--seed 42]');
      process.exit(1);
    }
    opts[key] = key === 'db' ? argv[i + 1] : Number(argv[i + 1]);
  }
  return opts;
}

// ---------- seeding steps ----------

const monthStart = (offsetFromNow) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offsetFromNow, 1));
};
const daysInMonth = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

async function makeMembers(storage, group, currency, count) {
  const members = [];
  const usedNames = new Set();
  for (let i = 0; i < count; i++) {
    let first, last;
    do { first = pick(FIRST_NAMES); last = pick(LAST_NAMES); }
    while (usedNames.has(`${first} ${last}`));
    usedNames.add(`${first} ${last}`);
    const email = `${first}.${last}.${i}@demo.example.org`.toLowerCase();
    const { member, person } = await apply(storage, {
      groupId: group.id, displayName: `${first} ${last}`,
      personName: `${first} ${last}`, email,
    });
    await approve(storage, member.id);
    await storage.updateMember(member.id, {
      neighbourhood: pick(NEIGHBOURHOODS),
      digestFrequency: pick(['none', 'weekly', 'weekly', 'monthly', 'monthly']),
      ...(chance(0.08) ? { confirmIncoming: true } : {}),
    });
    members.push({ member, person, account: await storage.ensureMemberAccount(member.id, currency.id) });
  }
  // A few joint households: a second person on the membership.
  for (const entry of members.filter(() => chance(0.1)).slice(0, 5)) {
    const first = pick(FIRST_NAMES);
    await addPerson(storage, entry.member.id, {
      name: `${first} ${entry.member.displayName.split(' ')[1]}`,
      email: `${first}.${entry.member.id.slice(-6)}@demo.example.org`.toLowerCase(),
    }, 'http://localhost');
  }
  return members;
}

async function makeListings(storage, currency, members, categoryIds) {
  const listings = [];
  for (const { member } of members) {
    const n = randint(1, 4);
    for (let i = 0; i < n; i++) {
      const want = chance(0.25);
      const [cat, title, description, price] = pick(want ? WANTS : OFFERS);
      const input = {
        type: want ? 'want' : 'offer', title, description,
        categoryId: categoryIds[cat],
      };
      if (typeof price === 'number') {
        input.priceAmount = price;
        input.priceCurrencyId = currency.id;
      } else if (typeof price === 'string') {
        input.rateText = price;
      }
      if (chance(0.05)) { // expiring soon, so the warning sweep has work
        input.expiresAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
      }
      const listing = await postListing(storage, member.id, input);
      listings.push({ listing, memberId: member.id });
      if (listings.length % 12 === 0) {
        await storage.setListingBadges(listing.id, [pick(['professional', 'qualified'])]);
      }
    }
  }
  return listings;
}

/** Long-tail activity weights: a few heavy traders, ~12% who never trade. */
function activityWeights(members) {
  return members.map(() => (chance(0.12) ? 0 : 0.05 + rand() ** 2));
}
function weightedPick(members, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let at = rand() * total;
  for (let i = 0; i < members.length; i++) {
    at -= weights[i];
    if (at <= 0) return members[i];
  }
  return members[members.length - 1];
}

/** Backdated committed trades via storage.post's atIso override — the
 *  services stamp 'now' immovably, which is exactly right for live trading
 *  and exactly wrong for history. */
async function postHistory(storage, group, currency, members, months) {
  const weights = activityWeights(members);
  let trades = 0;
  for (let offset = months; offset >= 1; offset--) {
    const start = monthStart(offset);
    const ramp = 0.35 + 0.65 * ((months - offset + 1) / months);
    const wobble = 1 + 0.25 * Math.sin((start.getUTCMonth() / 12) * 2 * Math.PI);
    const n = Math.max(2, Math.round(members.length * 0.8 * ramp * wobble));
    const stamps = Array.from({ length: n }, () =>
      new Date(start.getTime() +
        ((randint(0, daysInMonth(start) - 1) * 24 + randint(8, 21)) * 60 + randint(0, 59)) * 60_000,
      ).toISOString()).sort();
    for (const atIso of stamps) {
      const payer = weightedPick(members, weights);
      const payee = weightedPick(members, weights);
      if (payer === payee) continue;
      const amount = randint(4, 240) * 25;
      await storage.post({
        groupId: group.id, type: 'trade', flow: 'payment', state: 'committed',
        createdBy: payer.person.id, channel: 'web', description: pick(TRADE_NOTES),
        entries: [
          { accountId: payer.account.id, amount: -amount },
          { accountId: payee.account.id, amount },
        ],
      }, undefined, atIso);
      trades++;
    }
    // Backdated demurrage on the 1st of the following month, as the
    // scheduler would have run it (period = the run date's month).
    const runDate = monthStart(offset - 1);
    await runDemurrage(storage, group.id, currency.id,
      runDate.toISOString().slice(0, 7), runDate.toISOString());
  }
  return trades;
}

async function main() {
  const opts = parseArgs(process.argv);
  rand = mulberry32(opts.seed);
  if (existsSync(opts.db)) {
    console.error(`refusing to overwrite existing database ${opts.db}`);
    process.exit(1);
  }
  const storage = new SqliteStorage(opts.db);
  console.log('seeding...');
  await bootstrapOperator(storage, { email: 'op@demo.org', password: 'operator-pass' });
  const { group, currency } = await provisionGroup(storage, {
    slug: 'demo', name: 'Demo LETS', hostname: 'localhost',
    currency: { code: 'DEM', name: 'Demos', scale: 2, demurrageDay: 1 },
    admin: {
      displayName: 'Grace', personName: 'Grace Founder',
      email: 'grace@demo.org', password: 'password-grace',
    },
  });
  await storage.setDemurrageBands(currency.id, [
    { fromAmount: 0, ratePpmPerMonth: 0 },
    { fromAmount: 10000, ratePpmPerMonth: 10000 }, // 1%/mo above 100.00
  ]);
  await storage.updateGroup(group.id, { settings: { transparency: 'balances' } });

  const members = await makeMembers(storage, group, currency, opts.members);
  const categoryIds = [];
  for (const name of CATEGORIES) {
    categoryIds.push((await storage.createCategory({ groupId: group.id, name })).id);
  }

  console.log('images, listings...');
  let photos = 0;
  for (const { member } of members.filter(() => chance(0.4))) {
    await setMemberPhoto(storage, member.id, 'image/png', randPng());
    photos++;
  }
  await setBrandImage(storage, group.id, 'logo', 'image/png', randPng(), 'seed');
  await setBrandImage(storage, group.id, 'header', 'image/png', randPng(256, 96), 'seed');
  photos += 2;
  const listings = await makeListings(storage, currency, members, categoryIds);
  for (const { listing, memberId } of listings.filter(() => chance(0.25)).slice(0, 30)) {
    await addListingPhoto(storage, listing.id, memberId, 'image/png', randPng());
    photos++;
  }

  console.log('trading history...');
  const trades = await postHistory(storage, group, currency, members, opts.months);
  console.log('current month, via the live services...');
  // Trades in the open month use the real services so notifications,
  // holds and invoice expiries all exist as they would in production.
  let current = 0;
  const active = members.filter((m) => m.person);
  for (let i = 0; i < Math.max(4, Math.round(opts.members / 4)); i++) {
    const payer = pick(active);
    const payee = pick(active);
    if (payer === payee) continue;
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: payer.member.id, payeeMemberId: payee.member.id,
      currencyId: currency.id, amount: randint(4, 200) * 25,
      description: pick(TRADE_NOTES), actorPersonId: payer.person.id, channel: 'web',
    });
    current++;
  }
  // A couple of held payments: flip the payee to confirm-incoming first
  // so sendPayment leaves the trade pending with an auto-accept deadline.
  for (let i = 0; i < 2; i++) {
    const payee = active[i];
    const payer = active[active.length - 1 - i];
    await storage.updateMember(payee.member.id, { confirmIncoming: true });
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: payer.member.id, payeeMemberId: payee.member.id,
      currencyId: currency.id, amount: randint(4, 120) * 25,
      description: pick(TRADE_NOTES), actorPersonId: payer.person.id, channel: 'web',
    });
  }
  // A few open invoices; accept some so both paths are exercised.
  for (let i = 0; i < 5; i++) {
    const payee = pick(active);
    const payer = pick(active);
    if (payer === payee) continue;
    const invoice = await requestPayment(storage, {
      groupId: group.id, payeeMemberId: payee.member.id, payerMemberId: payer.member.id,
      currencyId: currency.id, amount: randint(4, 120) * 25,
      description: pick(TRADE_NOTES), actorPersonId: payee.person.id, channel: 'web',
    });
    if (i < 2) { await accept(storage, invoice.id, payer.member.id); current++; }
  }

  console.log('cms...');
  await storage.createPage({
    groupId: group.id, slug: 'home', title: 'Welcome to Demo LETS',
    body: 'Trade skills, produce and tool loans without sterling changing hands. '
      + 'One Demo is roughly a pound of ordinary effort.\n\n'
      + 'Browse the [marketplace](/app) or read [how it works](/p/how-it-works).',
    visibility: 'public',
  });
  await storage.createPage({
    groupId: group.id, slug: 'about', title: 'About Demo LETS',
    body: 'We are a friendly local exchange trading system serving eight '
      + 'neighbourhoods. Founded by Grace and a kitchen table of optimists.',
    visibility: 'public', position: 1,
  });
  await storage.createPage({
    groupId: group.id, slug: 'how-it-works', title: 'How it works',
    body: 'Every member starts at zero. Pay for what you receive, earn for what '
      + 'you provide; balances above 100.00 DEM attract 1% monthly demurrage, '
      + 'which funds the community pot.',
    visibility: 'public', position: 2,
  });
  await storage.createPage({
    groupId: group.id, slug: 'members-handbook', title: 'Members’ handbook',
    body: 'Etiquette, insurance notes and who to call when a trade goes sideways.',
    visibility: 'members', position: 3,
  });
  const now = Date.now();
  await storage.createNewsItem({
    groupId: group.id, title: 'Trading fair — Saturday 25th',
    body: 'Bring produce, tools and skills to the community hall from 10am.',
    publishedAt: new Date(now - 3 * 86_400_000).toISOString(),
  });
  await storage.createNewsItem({
    groupId: group.id, title: 'New neighbourhood coordinators',
    body: 'Riverside and Chesterton now have their own welcome volunteers.',
    publishedAt: new Date(now - 14 * 86_400_000).toISOString(),
  });
  await storage.createNewsItem({
    groupId: group.id, title: 'AGM agenda (scheduled)',
    body: 'The agenda will appear here a week before the meeting.',
    publishedAt: new Date(now + 7 * 86_400_000).toISOString(),
  });
  await storage.createNewsItem({
    groupId: group.id, title: 'Spring seed swap (over)',
    body: 'Thanks to everyone who came — see you next year.',
    publishedAt: new Date(now - 60 * 86_400_000).toISOString(),
    expiresAt: new Date(now - 30 * 86_400_000).toISOString(),
  });

  const report = await storage.verify(group.id);
  console.log(`ledger verify: ${report.ok ? 'OK' : 'FAILED'}`
    + (report.errors.length ? `\n${report.errors.join('\n')}` : ''));
  console.log(`
seeded ${opts.db}:
  members       ${members.length + 1} (incl. admin Grace, grace@demo.org / password-grace)
  listings      ${listings.length}
  transactions  ${trades + current} trades over ${opts.months} months + current
  demurrage     ${opts.months} monthly runs
  images        ${photos} (profile/listing photos, logo, header)
  cms           4 pages, 4 news items; transparency: balances

boot it: SILVIO_DB=${opts.db} node server/dist/src/index.js`);
  storage.close();
  if (!report.ok) process.exit(1);
}

await main();
