import { vi, describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// Mock db.js so accounts.ts's APP_ROOT points to our temporary folder
vi.mock('../src/db.js', () => {
  return {
    APP_ROOT: './tests/temp_accounts_test_root',
  };
});

const mockAppRoot = path.resolve('./tests/temp_accounts_test_root');

let mockExitCode = 0;
let mockStdout = '';
let mockStderr = '';
let mockSpawnError: Error | null = null;
const spawnedProcesses: { command: string; args: string[]; env?: any }[] = [];

// Mock child_process's spawn function
vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: string[], options?: any) => {
      spawnedProcesses.push({ command, args, env: options?.env });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};

      process.nextTick(() => {
        if (mockSpawnError) {
          child.emit('error', mockSpawnError);
        } else {
          if (mockStdout) {
            child.stdout.emit('data', mockStdout);
          }
          if (mockStderr) {
            child.stderr.emit('data', mockStderr);
          }
          child.emit('close', mockExitCode);
        }
      });
      return child;
    },
  };
});

// Import the module under test AFTER defining mocks
import {
  ACCOUNTS_ROOT,
  accountDir,
  credentialsPath,
  accountExists,
  listAccounts,
  tagJobAccount,
  getJobAccount,
  getActiveAccount,
  setActiveAccount,
  getAccountStatus,
  addAccount,
} from '../src/accounts.js';

describe('AccountManager (accounts.ts)', () => {
  beforeAll(() => {
    if (fs.existsSync(mockAppRoot)) {
      fs.rmSync(mockAppRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(mockAppRoot, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(mockAppRoot)) {
      fs.rmSync(mockAppRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    mockExitCode = 0;
    mockStdout = '';
    mockStderr = '';
    mockSpawnError = null;
    spawnedProcesses.length = 0;

    // Reset the temporary accounts directory for each test
    if (fs.existsSync(ACCOUNTS_ROOT)) {
      fs.rmSync(ACCOUNTS_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(ACCOUNTS_ROOT, { recursive: true });
  });

  test('accountDir and credentialsPath return correct Windows/Unix absolute paths', () => {
    const dir = accountDir('test-user');
    const credPath = credentialsPath('test-user');
    expect(dir).toBe(path.join(ACCOUNTS_ROOT, 'test-user'));
    expect(credPath).toBe(path.join(ACCOUNTS_ROOT, 'test-user', 'credentials.json'));
  });

  test('accountExists and listAccounts behave correctly with local file detection', () => {
    expect(accountExists('alice')).toBe(false);
    expect(listAccounts()).toEqual([]);

    // Manually register Alice by writing a fake credentials file
    const aliceCred = credentialsPath('alice');
    fs.mkdirSync(path.dirname(aliceCred), { recursive: true });
    fs.writeFileSync(aliceCred, '{}');

    expect(accountExists('alice')).toBe(true);
    expect(listAccounts()).toEqual(['alice']);

    // Manually register Bob
    const bobCred = credentialsPath('bob');
    fs.mkdirSync(path.dirname(bobCred), { recursive: true });
    fs.writeFileSync(bobCred, '{}');

    expect(listAccounts()).toEqual(['alice', 'bob']);
  });

  test('tagJobAccount and getJobAccount correctly track and query usage tags', () => {
    expect(getJobAccount('job-1')).toBeNull();

    tagJobAccount('job-1', 'alice');
    expect(getJobAccount('job-1')).toBe('alice');

    tagJobAccount('job-2', 'bob');
    expect(getJobAccount('job-1')).toBe('alice');
    expect(getJobAccount('job-2')).toBe('bob');
  });

  test('getActiveAccount and setActiveAccount handle active profile state per project', () => {
    expect(getActiveAccount('project-a')).toBeNull();

    // setActiveAccount throws if account does not exist (no credentials.json)
    expect(() => setActiveAccount('project-a', 'missing')).toThrow();

    // Create bob's credentials
    const bobCred = credentialsPath('bob');
    fs.mkdirSync(path.dirname(bobCred), { recursive: true });
    fs.writeFileSync(bobCred, '{}');

    setActiveAccount('project-a', 'bob');
    expect(getActiveAccount('project-a')).toBe('bob');
  });

  test('getAccountStatus returns unauthenticated immediately if credentials are missing', async () => {
    const status = await getAccountStatus('missing');
    expect(status).toEqual({
      name: 'missing',
      balance: null,
      authenticated: false,
    });
    expect(spawnedProcesses).toHaveLength(0);
  });

  test('getAccountStatus parses numeric and string JSON balances from status stdout', async () => {
    const bobCred = credentialsPath('bob');
    fs.mkdirSync(path.dirname(bobCred), { recursive: true });
    fs.writeFileSync(bobCred, '{}');

    // Case 1: Numeric balance key
    mockStdout = JSON.stringify({ balance: 456.78 });
    let status = await getAccountStatus('bob');
    expect(status).toEqual({
      name: 'bob',
      balance: 456.78,
      authenticated: true,
    });

    // Case 2: String credits key with comma
    mockStdout = JSON.stringify({ credits: '1,234.56' });
    status = await getAccountStatus('bob');
    expect(status.balance).toBe(1234.56);

    // Case 3: Key credit_balance
    mockStdout = JSON.stringify({ credit_balance: '500' });
    status = await getAccountStatus('bob');
    expect(status.balance).toBe(500);
  });

  test('getAccountStatus parses plain text credits from stdout/stderr when not JSON', async () => {
    const bobCred = credentialsPath('bob');
    fs.mkdirSync(path.dirname(bobCred), { recursive: true });
    fs.writeFileSync(bobCred, '{}');

    mockStdout = 'User balance is: 75.25 cr (active)';
    const status = await getAccountStatus('bob');
    expect(status).toEqual({
      name: 'bob',
      balance: 75.25,
      authenticated: true,
    });
  });

  test('getAccountStatus flags authenticated=false when auth failure text is detected', async () => {
    const bobCred = credentialsPath('bob');
    fs.mkdirSync(path.dirname(bobCred), { recursive: true });
    fs.writeFileSync(bobCred, '{}');

    mockStderr = 'Error: session expired, please log in again';
    mockExitCode = 1;

    const status = await getAccountStatus('bob');
    expect(status).toEqual({
      name: 'bob',
      balance: null,
      authenticated: false,
    });
  });

  test('addAccount creates dir and spawns interactive auth login command', async () => {
    mockExitCode = 0;

    const result = await addAccount('alice');
    expect(result.code).toBe(0);

    expect(spawnedProcesses).toHaveLength(1);
    expect(spawnedProcesses[0].args.slice(-2)).toEqual(['auth', 'login']);
    expect(spawnedProcesses[0].env?.HIGGSFIELD_CREDENTIALS_PATH).toBe(credentialsPath('alice'));
    expect(fs.existsSync(accountDir('alice'))).toBe(true);
  });

  test('runCli propagates spawn error correctly', async () => {
    mockSpawnError = new Error('CLI path error');
    await expect(addAccount('bob')).rejects.toThrow('Failed to spawn Higgsfield CLI');
  });
});
