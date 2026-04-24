// test_scripts/agent-config-folder.spec.ts
//
// Unit tests for src/config/agent-config-folder.ts
//
// Tests use a tmpdir to avoid writing to the real ~/.tool-agents/ directory.
// All assertions about folder creation, file mode, .env seeding, and
// config.json validation run against the tmpdir.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  ensureAgentConfigFolder,
  loadConfigJson,
  getAgentConfigFolderPath,
} from '../src/config/agent-config-folder';

// ---------------------------------------------------------------------------
// tmp dir helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-folder-spec-'));
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function freshFolder(): string {
  const p = path.join(tmpRoot, `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return p;
}

// ---------------------------------------------------------------------------
// getAgentConfigFolderPath
// ---------------------------------------------------------------------------

describe('getAgentConfigFolderPath', () => {
  it('returns ~/.tool-agents/outlook-cli when no override given', () => {
    const p = getAgentConfigFolderPath();
    expect(p).toBe(path.join(os.homedir(), '.tool-agents', 'outlook-cli'));
  });

  it('returns the override resolved as absolute when provided', () => {
    const p = getAgentConfigFolderPath('/custom/path');
    expect(p).toBe('/custom/path');
  });
});

// ---------------------------------------------------------------------------
// ensureAgentConfigFolder — folder creation
// ---------------------------------------------------------------------------

describe('ensureAgentConfigFolder — folder creation', () => {
  it('creates the folder if absent', () => {
    const folder = freshFolder();
    ensureAgentConfigFolder(folder);
    expect(fs.existsSync(folder)).toBe(true);
  });

  it('does not throw if the folder already exists', () => {
    const folder = freshFolder();
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    expect(() => ensureAgentConfigFolder(folder)).not.toThrow();
  });

  it('seeds .env if absent', () => {
    const folder = freshFolder();
    ensureAgentConfigFolder(folder);
    const envPath = path.join(folder, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('OPENAI_API_KEY=REPLACE_ME');
  });

  it('does NOT overwrite .env if it already exists', () => {
    const folder = freshFolder();
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const envPath = path.join(folder, '.env');
    fs.writeFileSync(envPath, 'MY_CUSTOM=content\n', { mode: 0o600 });
    ensureAgentConfigFolder(folder);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toBe('MY_CUSTOM=content\n');
  });

  it('seeds config.json if absent', () => {
    const folder = freshFolder();
    ensureAgentConfigFolder(folder);
    const cfgPath = path.join(folder, 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(parsed.schemaVersion).toBe(1);
  });

  it('does NOT overwrite config.json if it already exists', () => {
    const folder = freshFolder();
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const cfgPath = path.join(folder, 'config.json');
    const existing = { schemaVersion: 1, maxSteps: 42 };
    fs.writeFileSync(cfgPath, JSON.stringify(existing), { mode: 0o600 });
    ensureAgentConfigFolder(folder);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(parsed.maxSteps).toBe(42);
  });

  it('seeded .env contains only placeholder values, never real env', () => {
    // Temporarily set a key to a real value.
    process.env.OPENAI_API_KEY = 'real-secret-key';
    try {
      const folder = freshFolder();
      ensureAgentConfigFolder(folder);
      const envPath = path.join(folder, '.env');
      const content = fs.readFileSync(envPath, 'utf-8');
      // The seed must not contain the real key value.
      expect(content).not.toContain('real-secret-key');
      expect(content).toContain('REPLACE_ME');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('warns to stderr and continues when folder is read-only (integration)', () => {
    // Use a path that cannot be created: a subpath of an existing file.
    const existingFile = path.join(tmpRoot, 'not-a-folder.txt');
    fs.writeFileSync(existingFile, 'I am a file');
    // Try to use a subdirectory of that file — mkdirSync will fail on macOS/Linux.
    const impossiblePath = path.join(existingFile, 'subdir');
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    let result: unknown;
    try {
      result = ensureAgentConfigFolder(impossiblePath);
    } catch (err) {
      // Should NOT throw — just warn.
      throw new Error(`ensureAgentConfigFolder must not throw, got: ${String(err)}`);
    } finally {
      vi.restoreAllMocks();
    }
    // Should return null (could not create folder).
    expect(result).toBeNull();
    expect(stderrWrites.some(s => s.includes('WARNING'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadConfigJson
// ---------------------------------------------------------------------------

describe('loadConfigJson', () => {
  it('returns null for non-existent file', () => {
    const result = loadConfigJson(path.join(tmpRoot, 'does-not-exist.json'));
    expect(result).toBeNull();
  });

  it('returns null and warns for invalid JSON', () => {
    const cfgPath = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(cfgPath, '{ this is not json }');
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const result = loadConfigJson(cfgPath);
    expect(result).toBeNull();
    expect(stderrWrites.some(s => s.includes('not valid JSON'))).toBe(true);
  });

  it('returns null and warns for wrong schemaVersion', () => {
    const cfgPath = path.join(tmpRoot, 'wrong-version.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 99 }));
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const result = loadConfigJson(cfgPath);
    expect(result).toBeNull();
    expect(stderrWrites.some(s => s.includes('unsupported schemaVersion'))).toBe(true);
  });

  it('returns parsed config for valid schemaVersion 1', () => {
    const cfgPath = path.join(tmpRoot, 'valid.json');
    const data = { schemaVersion: 1, provider: 'openai', model: 'gpt-4o', maxSteps: 20 };
    fs.writeFileSync(cfgPath, JSON.stringify(data));
    const result = loadConfigJson(cfgPath);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openai');
    expect(result!.model).toBe('gpt-4o');
    expect(result!.maxSteps).toBe(20);
  });

  it('emits expiry warning when apiKeyExpiresAt is within 7 days', () => {
    const cfgPath = path.join(tmpRoot, 'expiry-soon.json');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, apiKeyExpiresAt: yesterday }));
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    loadConfigJson(cfgPath);
    expect(stderrWrites.some(s => s.includes('apiKeyExpiresAt') && s.includes('expires'))).toBe(true);
  });

  it('does NOT warn when expiresAt is far in the future (> 7 days)', () => {
    const cfgPath = path.join(tmpRoot, 'expiry-future.json');
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, expiresAt: farFuture }));
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    loadConfigJson(cfgPath);
    expect(stderrWrites.filter(s => s.includes('expires'))).toHaveLength(0);
  });

  it('accepts a path pointing at the file directly (ends in .json)', () => {
    const cfgPath = path.join(tmpRoot, 'direct.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, maxSteps: 15 }));
    const result = loadConfigJson(cfgPath);
    expect(result!.maxSteps).toBe(15);
  });
});
