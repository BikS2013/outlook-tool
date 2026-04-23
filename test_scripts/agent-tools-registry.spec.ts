// test_scripts/agent-tools-registry.spec.ts
//
// Unit tests for src/agent/tools/registry.ts — validates the mutation gate,
// the allowlist filter, and that tool names are unique & snake_case.

import { describe, expect, it } from 'vitest';

import { buildToolCatalog } from '../src/agent/tools/registry';
import type { AgentConfig, AgentDeps } from '../src/agent/tools/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFakeDeps(): AgentDeps {
  // Every method throws if invoked — registry tests should only touch .name.
  return {
    config: {} as AgentDeps['config'],
    sessionPath: '/tmp/no-session',
    loadSession: async () => null,
    saveSession: async () => {
      /* no-op */
    },
    doAuthCapture: async () => {
      throw new Error('doAuthCapture should not be called in registry tests');
    },
    createClient: () => {
      throw new Error('createClient should not be called in registry tests');
    },
  };
}

function buildFakeCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base: AgentConfig = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0,
    maxSteps: 10,
    perToolBudgetBytes: 16_384,
    envFilePath: null,
    allowMutations: false,
    systemPrompt: null,
    systemPromptFile: null,
    verbose: false,
    interactive: false,
    toolsAllowlist: null,
    providerEnv: Object.freeze({}) as Readonly<Record<string, string>>,
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildToolCatalog', () => {
  it('allowMutations=false → catalog has 8 read-only tools only', () => {
    const tools = buildToolCatalog(buildFakeDeps(), buildFakeCfg({ allowMutations: false }));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'auth_check',
        'find_folder',
        'get_event',
        'get_mail',
        'get_thread',
        'list_calendar',
        'list_folders',
        'list_mail',
      ].sort(),
    );
    expect(names).not.toContain('create_folder');
    expect(names).not.toContain('move_mail');
    expect(names).not.toContain('download_attachments');
  });

  it('allowMutations=true → catalog has all 11 tools', () => {
    const tools = buildToolCatalog(buildFakeDeps(), buildFakeCfg({ allowMutations: true }));
    expect(tools).toHaveLength(11);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('create_folder')).toBe(true);
    expect(names.has('move_mail')).toBe(true);
    expect(names.has('download_attachments')).toBe(true);
  });

  it('toolsAllowlist=["list_mail"] → catalog length 1, only list_mail', () => {
    const tools = buildToolCatalog(
      buildFakeDeps(),
      buildFakeCfg({ allowMutations: true, toolsAllowlist: ['list_mail'] }),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('list_mail');
  });

  it('toolsAllowlist applied AFTER mutation gate (mutation name in allowlist but mutations disabled → excluded)', () => {
    const tools = buildToolCatalog(
      buildFakeDeps(),
      buildFakeCfg({
        allowMutations: false,
        toolsAllowlist: ['move_mail', 'list_mail'],
      }),
    );
    // move_mail is NOT in the catalog because mutations were gated out first.
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['list_mail']);
  });

  it('every tool name is unique', () => {
    const tools = buildToolCatalog(
      buildFakeDeps(),
      buildFakeCfg({ allowMutations: true }),
    );
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool name is snake_case (lowercase + underscores only)', () => {
    const tools = buildToolCatalog(
      buildFakeDeps(),
      buildFakeCfg({ allowMutations: true }),
    );
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
