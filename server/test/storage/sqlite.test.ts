import { describe } from 'vitest';
import { storageContractTests } from './contract.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';

describe('SqliteStorage (in-memory)', () => {
  storageContractTests(async () => new SqliteStorage(':memory:'));
});
