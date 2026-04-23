// test_scripts/agent-config.spec.ts
//
// Unit tests for src/config/agent-config.ts — `loadAgentConfig`
// precedence, mandatory-field enforcement, optional-field defaults,
// and the providerEnv snapshot.
//
// Pure-logic: no dotenv loading (the caller does that), no network,
// no browser.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  loadAgentConfig,
  type AgentConfigFlags,
} from '../src/config/agent-config';
import { UsageError } from '../src/commands/list-mail';
import { ConfigurationError } from '../src/config/errors';

// ---------------------------------------------------------------------------
// Env-var hygiene: clear every OUTLOOK_AGENT_* key in beforeEach; restore
// originals in afterAll. We mutate process.env directly — do NOT replace it.
// ---------------------------------------------------------------------------

const ENV_PREFIX = 'OUTLOOK_AGENT_';
let savedEnv: Record<string, string | undefined> = {};

function clearAgentEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) {
      delete process.env[key];
    }
  }
}

beforeAll(() => {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(ENV_PREFIX)) {
      savedEnv[k] = v;
    }
  }
});

beforeEach(() => {
  clearAgentEnv();
});

afterEach(() => {
  clearAgentEnv();
});

afterAll(() => {
  // Restore whatever was there at module load.
  clearAgentEnv();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) {
      process.env[k] = v;
    }
  }
});

// Minimal flags builder so every test doesn't have to set provider+model
// by hand. Tests that care about defaults can still set them explicitly.
function withRequired(flags: AgentConfigFlags = {}): AgentConfigFlags {
  return {
    provider: flags.provider ?? 'openai',
    model: flags.model ?? 'gpt-4o-mini',
    ...flags,
  };
}

// ---------------------------------------------------------------------------
// required: provider
// ---------------------------------------------------------------------------

describe('loadAgentConfig — required provider', () => {
  it('resolves provider from CLI flag', () => {
    const cfg = loadAgentConfig({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(cfg.provider).toBe('openai');
  });

  it('resolves provider from OUTLOOK_AGENT_PROVIDER when flag absent', () => {
    process.env.OUTLOOK_AGENT_PROVIDER = 'anthropic';
    const cfg = loadAgentConfig({ model: 'claude-sonnet-4-5' });
    expect(cfg.provider).toBe('anthropic');
  });

  it('throws ConfigurationError when neither flag nor env var set', () => {
    try {
      loadAgentConfig({ model: 'gpt-4o-mini' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const e = err as ConfigurationError;
      expect(e.missingSetting).toBe('OUTLOOK_AGENT_PROVIDER');
      expect(e.checkedSources).toContain('--provider');
      expect(e.checkedSources).toContain('OUTLOOK_AGENT_PROVIDER');
    }
  });

  it('throws UsageError when provider value is unknown', () => {
    expect(() =>
      loadAgentConfig({ provider: 'hal9000', model: 'x' }),
    ).toThrowError(UsageError);
  });

  it('CLI flag wins over env var', () => {
    process.env.OUTLOOK_AGENT_PROVIDER = 'anthropic';
    const cfg = loadAgentConfig({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(cfg.provider).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// required: model
// ---------------------------------------------------------------------------

describe('loadAgentConfig — required model', () => {
  it('CLI flag wins over env var', () => {
    process.env.OUTLOOK_AGENT_MODEL = 'gpt-3.5-turbo';
    const cfg = loadAgentConfig({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(cfg.model).toBe('gpt-4o-mini');
  });

  it('reads model from env var when flag absent', () => {
    process.env.OUTLOOK_AGENT_MODEL = 'claude-haiku-4-5';
    const cfg = loadAgentConfig({ provider: 'anthropic' });
    expect(cfg.model).toBe('claude-haiku-4-5');
  });

  it('throws ConfigurationError when both flag and env var missing', () => {
    try {
      loadAgentConfig({ provider: 'openai' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const e = err as ConfigurationError;
      expect(e.missingSetting).toBe('OUTLOOK_AGENT_MODEL');
      expect(e.checkedSources).toContain('--model');
      expect(e.checkedSources).toContain('OUTLOOK_AGENT_MODEL');
    }
  });

  it('azure-openai falls back to OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT when OUTLOOK_AGENT_MODEL is unset', () => {
    process.env.OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT = 'my-gpt-4o-deployment';
    const cfg = loadAgentConfig({ provider: 'azure-openai' });
    expect(cfg.model).toBe('my-gpt-4o-deployment');
  });

  it('azure-openai: OUTLOOK_AGENT_MODEL still wins over the DEPLOYMENT fallback', () => {
    process.env.OUTLOOK_AGENT_MODEL = 'explicit-model';
    process.env.OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT = 'ignored-deployment';
    const cfg = loadAgentConfig({ provider: 'azure-openai' });
    expect(cfg.model).toBe('explicit-model');
  });

  it('azure-anthropic falls back to OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL', () => {
    process.env.OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    const cfg = loadAgentConfig({ provider: 'azure-anthropic' });
    expect(cfg.model).toBe('claude-sonnet-4-5');
  });

  it('azure-deepseek falls back to OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL', () => {
    process.env.OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL = 'DeepSeek-V3.2';
    const cfg = loadAgentConfig({ provider: 'azure-deepseek' });
    expect(cfg.model).toBe('DeepSeek-V3.2');
  });

  it('error for missing azure-openai model lists the provider fallback in checkedSources', () => {
    try {
      loadAgentConfig({ provider: 'azure-openai' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const e = err as ConfigurationError;
      expect(e.missingSetting).toBe('OUTLOOK_AGENT_MODEL');
      expect(e.checkedSources).toContain('OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT');
    }
  });
});

// ---------------------------------------------------------------------------
// maxSteps
// ---------------------------------------------------------------------------

describe('loadAgentConfig — maxSteps', () => {
  it('defaults to 10 when neither flag nor env set', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.maxSteps).toBe(10);
  });

  it('parses a valid env value', () => {
    process.env.OUTLOOK_AGENT_MAX_STEPS = '25';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.maxSteps).toBe(25);
  });

  it('throws UsageError on env value of 0', () => {
    process.env.OUTLOOK_AGENT_MAX_STEPS = '0';
    expect(() => loadAgentConfig(withRequired())).toThrowError(UsageError);
  });

  it('throws UsageError on non-numeric env value', () => {
    process.env.OUTLOOK_AGENT_MAX_STEPS = 'abc';
    expect(() => loadAgentConfig(withRequired())).toThrowError(UsageError);
  });

  it('CLI flag wins over env var', () => {
    process.env.OUTLOOK_AGENT_MAX_STEPS = '25';
    const cfg = loadAgentConfig(withRequired({ maxSteps: 5 }));
    expect(cfg.maxSteps).toBe(5);
  });

  it('throws UsageError on negative CLI flag', () => {
    expect(() =>
      loadAgentConfig(withRequired({ maxSteps: -3 })),
    ).toThrowError(UsageError);
  });
});

// ---------------------------------------------------------------------------
// temperature
// ---------------------------------------------------------------------------

describe('loadAgentConfig — temperature', () => {
  it('defaults to 0', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.temperature).toBe(0);
  });

  it('parses a valid env float', () => {
    process.env.OUTLOOK_AGENT_TEMPERATURE = '0.7';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.temperature).toBeCloseTo(0.7, 10);
  });

  it('throws UsageError on negative env value', () => {
    process.env.OUTLOOK_AGENT_TEMPERATURE = '-0.1';
    expect(() => loadAgentConfig(withRequired())).toThrowError(UsageError);
  });

  it('throws UsageError on NaN env value', () => {
    process.env.OUTLOOK_AGENT_TEMPERATURE = 'NaN';
    expect(() => loadAgentConfig(withRequired())).toThrowError(UsageError);
  });

  it('CLI flag wins over env var', () => {
    process.env.OUTLOOK_AGENT_TEMPERATURE = '0.7';
    const cfg = loadAgentConfig(withRequired({ temperature: 0.2 }));
    expect(cfg.temperature).toBeCloseTo(0.2, 10);
  });
});

// ---------------------------------------------------------------------------
// perToolBudgetBytes
// ---------------------------------------------------------------------------

describe('loadAgentConfig — perToolBudgetBytes', () => {
  it('defaults to 16384', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.perToolBudgetBytes).toBe(16384);
  });

  it('reads canonical OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES', () => {
    process.env.OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES = '8192';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.perToolBudgetBytes).toBe(8192);
  });

  it('falls back to OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES when canonical unset', () => {
    process.env.OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES = '4096';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.perToolBudgetBytes).toBe(4096);
  });

  it('canonical name wins when both are set', () => {
    process.env.OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES = '8192';
    process.env.OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES = '4096';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.perToolBudgetBytes).toBe(8192);
  });

  it('CLI flag wins over env vars', () => {
    process.env.OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES = '8192';
    const cfg = loadAgentConfig(withRequired({ perToolBudgetBytes: 2048 }));
    expect(cfg.perToolBudgetBytes).toBe(2048);
  });

  it('throws UsageError on zero', () => {
    process.env.OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES = '0';
    expect(() => loadAgentConfig(withRequired())).toThrowError(UsageError);
  });
});

// ---------------------------------------------------------------------------
// allowMutations
// ---------------------------------------------------------------------------

describe('loadAgentConfig — allowMutations', () => {
  it('defaults to false', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.allowMutations).toBe(false);
  });

  it.each(['true', '1', 'yes', 'TRUE', 'True', 'YES'])(
    'parses %s as true',
    (raw) => {
      process.env.OUTLOOK_AGENT_ALLOW_MUTATIONS = raw;
      const cfg = loadAgentConfig(withRequired());
      expect(cfg.allowMutations).toBe(true);
    },
  );

  it.each(['false', '0', 'no', ''])('parses %s as false', (raw) => {
    process.env.OUTLOOK_AGENT_ALLOW_MUTATIONS = raw;
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.allowMutations).toBe(false);
  });

  it('CLI flag (true) wins over env var (false)', () => {
    process.env.OUTLOOK_AGENT_ALLOW_MUTATIONS = 'false';
    const cfg = loadAgentConfig(withRequired({ allowMutations: true }));
    expect(cfg.allowMutations).toBe(true);
  });

  it('CLI flag (false) wins over env var (true)', () => {
    process.env.OUTLOOK_AGENT_ALLOW_MUTATIONS = 'true';
    const cfg = loadAgentConfig(withRequired({ allowMutations: false }));
    expect(cfg.allowMutations).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toolsAllowlist
// ---------------------------------------------------------------------------

describe('loadAgentConfig — toolsAllowlist', () => {
  it('is null when neither flag nor env set', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.toolsAllowlist).toBeNull();
  });

  it('parses CSV, trims, filters empties', () => {
    const cfg = loadAgentConfig(
      withRequired({ tools: 'list_mail, get_mail ,, ' }),
    );
    expect(cfg.toolsAllowlist).toEqual(['list_mail', 'get_mail']);
  });

  it('reads from env var when flag absent', () => {
    process.env.OUTLOOK_AGENT_TOOLS = 'list_mail,get_mail,get_thread';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.toolsAllowlist).toEqual([
      'list_mail',
      'get_mail',
      'get_thread',
    ]);
  });

  it('throws UsageError on empty CSV flag', () => {
    expect(() =>
      loadAgentConfig(withRequired({ tools: '' })),
    ).toThrowError(UsageError);
  });

  it('throws UsageError on CSV with only whitespace / commas', () => {
    expect(() =>
      loadAgentConfig(withRequired({ tools: ' , , ' })),
    ).toThrowError(UsageError);
  });
});

// ---------------------------------------------------------------------------
// systemPrompt / systemPromptFile
// ---------------------------------------------------------------------------

describe('loadAgentConfig — systemPrompt / systemPromptFile', () => {
  it('throws UsageError when both flags set', () => {
    expect(() =>
      loadAgentConfig(
        withRequired({
          systemPrompt: 'be helpful',
          systemPromptFile: '/tmp/prompt.txt',
        }),
      ),
    ).toThrowError(UsageError);
  });

  it('throws UsageError when flag + env cross over', () => {
    process.env.OUTLOOK_AGENT_SYSTEM_PROMPT_FILE = '/tmp/p.txt';
    expect(() =>
      loadAgentConfig(withRequired({ systemPrompt: 'be helpful' })),
    ).toThrowError(UsageError);
  });

  it('only prompt set: prompt non-null, file null', () => {
    const cfg = loadAgentConfig(
      withRequired({ systemPrompt: 'you are helpful' }),
    );
    expect(cfg.systemPrompt).toBe('you are helpful');
    expect(cfg.systemPromptFile).toBeNull();
  });

  it('only file set: file non-null, prompt null', () => {
    const cfg = loadAgentConfig(
      withRequired({ systemPromptFile: '/tmp/prompt.txt' }),
    );
    expect(cfg.systemPromptFile).toBe('/tmp/prompt.txt');
    expect(cfg.systemPrompt).toBeNull();
  });

  it('both null when neither set', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.systemPrompt).toBeNull();
    expect(cfg.systemPromptFile).toBeNull();
  });

  it('reads systemPrompt from env', () => {
    process.env.OUTLOOK_AGENT_SYSTEM_PROMPT = 'env prompt';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.systemPrompt).toBe('env prompt');
  });

  it('reads systemPromptFile from env', () => {
    process.env.OUTLOOK_AGENT_SYSTEM_PROMPT_FILE = '/tmp/env-prompt.txt';
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.systemPromptFile).toBe('/tmp/env-prompt.txt');
  });
});

// ---------------------------------------------------------------------------
// envFile
// ---------------------------------------------------------------------------

describe('loadAgentConfig — envFile', () => {
  let tmpDir: string;
  let existingFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-test-'));
    existingFile = path.join(tmpDir, 'sample.env');
    fs.writeFileSync(existingFile, 'OUTLOOK_AGENT_PROVIDER=openai\n', {
      mode: 0o600,
    });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('is null when --env-file not supplied', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(cfg.envFilePath).toBeNull();
  });

  it('resolves to absolute path when file exists', () => {
    const cfg = loadAgentConfig(withRequired({ envFile: existingFile }));
    expect(cfg.envFilePath).toBe(path.resolve(existingFile));
  });

  it('throws ConfigurationError when file does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist.env');
    try {
      loadAgentConfig(withRequired({ envFile: missing }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const e = err as ConfigurationError;
      expect(e.missingSetting).toBe('envFile');
      expect(e.checkedSources).toContain('--env-file');
    }
  });
});

// ---------------------------------------------------------------------------
// providerEnv snapshot
// ---------------------------------------------------------------------------

describe('loadAgentConfig — providerEnv snapshot', () => {
  it('includes OUTLOOK_AGENT_OPENAI_* when provider is openai', () => {
    process.env.OUTLOOK_AGENT_OPENAI_API_KEY = 'sk-xxx';
    process.env.OUTLOOK_AGENT_OPENAI_BASE_URL = 'https://proxy.example.com';
    const cfg = loadAgentConfig(withRequired({ provider: 'openai' }));
    expect(cfg.providerEnv.OUTLOOK_AGENT_OPENAI_API_KEY).toBe('sk-xxx');
    expect(cfg.providerEnv.OUTLOOK_AGENT_OPENAI_BASE_URL).toBe(
      'https://proxy.example.com',
    );
  });

  it('does not include other providers’ env vars', () => {
    process.env.OUTLOOK_AGENT_OPENAI_API_KEY = 'sk-xxx';
    const cfg = loadAgentConfig(
      withRequired({ provider: 'anthropic', model: 'claude-x' }),
    );
    expect(cfg.providerEnv.OUTLOOK_AGENT_OPENAI_API_KEY).toBeUndefined();
  });

  it('is frozen', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(Object.isFrozen(cfg.providerEnv)).toBe(true);
  });

  it('omits unset keys (no undefined values)', () => {
    const cfg = loadAgentConfig(withRequired({ provider: 'openai' }));
    // No OPENAI_* vars set → snapshot must be empty, NOT contain undefineds.
    expect(Object.keys(cfg.providerEnv)).toHaveLength(0);
  });

  it('azure-deepseek snapshot includes both AZURE_DEEPSEEK_* and AZURE_AI_INFERENCE_*', () => {
    process.env.OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL = 'DeepSeek-V3.2';
    process.env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY = 'foundry-key';
    process.env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT =
      'https://res.services.ai.azure.com';
    const cfg = loadAgentConfig(
      withRequired({ provider: 'azure-deepseek', model: 'DeepSeek-V3.2' }),
    );
    expect(cfg.providerEnv.OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL).toBe(
      'DeepSeek-V3.2',
    );
    expect(cfg.providerEnv.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY).toBe(
      'foundry-key',
    );
    expect(cfg.providerEnv.OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT).toBe(
      'https://res.services.ai.azure.com',
    );
  });

  it('azure-anthropic snapshot also includes the shared inference block', () => {
    process.env.OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    process.env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY = 'foundry-key';
    const cfg = loadAgentConfig(
      withRequired({
        provider: 'azure-anthropic',
        model: 'claude-sonnet-4-5',
      }),
    );
    expect(cfg.providerEnv.OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL).toBe(
      'claude-sonnet-4-5',
    );
    expect(cfg.providerEnv.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY).toBe(
      'foundry-key',
    );
  });

  it('openai snapshot does NOT include AZURE_AI_INFERENCE_* block', () => {
    process.env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY = 'foundry-key';
    const cfg = loadAgentConfig(withRequired({ provider: 'openai' }));
    expect(
      cfg.providerEnv.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// frozen result + smoke
// ---------------------------------------------------------------------------

describe('loadAgentConfig — overall shape', () => {
  it('returns a frozen config object', () => {
    const cfg = loadAgentConfig(withRequired());
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('sets verbose / interactive from flags (default false)', () => {
    const cfg1 = loadAgentConfig(withRequired());
    expect(cfg1.verbose).toBe(false);
    expect(cfg1.interactive).toBe(false);

    const cfg2 = loadAgentConfig(
      withRequired({ verbose: true, interactive: true }),
    );
    expect(cfg2.verbose).toBe(true);
    expect(cfg2.interactive).toBe(true);
  });
});
