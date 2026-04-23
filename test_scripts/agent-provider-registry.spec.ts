// test_scripts/agent-provider-registry.spec.ts
//
// Unit tests for the six provider factories plus the registry surface.
// Factories MUST NOT call the network at construction time — we assert only
// on class identity and thrown errors.

import { describe, it, expect } from 'vitest';

import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

import type {
  AgentConfig,
  ProviderName,
} from '../src/config/agent-config';
import { ConfigurationError } from '../src/config/errors';
import { UsageError } from '../src/commands/list-mail';

import { createOpenaiModel } from '../src/agent/providers/openai';
import { createAnthropicModel } from '../src/agent/providers/anthropic';
import { createGoogleModel } from '../src/agent/providers/google';
import { createAzureOpenaiModel } from '../src/agent/providers/azure-openai';
import { createAzureAnthropicModel } from '../src/agent/providers/azure-anthropic';
import { createAzureDeepseekModel } from '../src/agent/providers/azure-deepseek';
import {
  PROVIDERS,
  getProvider,
} from '../src/agent/providers/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freezeEnv(
  obj: Record<string, string>,
): Readonly<Record<string, string>> {
  return Object.freeze({ ...obj });
}

function makeCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base: AgentConfig = {
    provider: 'openai' as ProviderName,
    model: 'gpt-4o-mini',
    temperature: 0,
    maxSteps: 10,
    perToolBudgetBytes: 16384,
    systemPrompt: null,
    systemPromptFile: null,
    toolsAllowlist: null,
    allowMutations: false,
    envFilePath: null,
    verbose: false,
    interactive: false,
    providerEnv: freezeEnv({}),
    ...overrides,
  } as AgentConfig;
  return Object.freeze(base) as AgentConfig;
}

// Utility: run a factory and expect it to throw a ConfigurationError whose
// `missingSetting` equals the given key.
function expectMissingSetting(
  factory: (cfg: AgentConfig) => unknown,
  cfg: AgentConfig,
  missingSetting: string,
): void {
  try {
    factory(cfg);
    throw new Error(
      `expected ConfigurationError (missingSetting=${missingSetting}) but factory returned`,
    );
  } catch (e) {
    expect(e, `factory did not throw for missing ${missingSetting}`).toBeInstanceOf(
      ConfigurationError,
    );
    expect((e as ConfigurationError).missingSetting).toBe(missingSetting);
  }
}

// ---------------------------------------------------------------------------
// openai
// ---------------------------------------------------------------------------

describe('createOpenaiModel', () => {
  it('constructs ChatOpenAI when API key is present', () => {
    const cfg = makeCfg({
      provider: 'openai',
      model: 'gpt-4o-mini',
      providerEnv: freezeEnv({
        OUTLOOK_AGENT_OPENAI_API_KEY: 'sk-test',
      }),
    });
    const m = createOpenaiModel(cfg);
    expect(m).toBeInstanceOf(ChatOpenAI);
    // AzureChatOpenAI extends ChatOpenAI via composition in some versions —
    // assert the concrete constructor name to disambiguate.
    expect(m.constructor.name).toBe('ChatOpenAI');
  });

  it('accepts optional baseURL and organization without throwing', () => {
    const cfg = makeCfg({
      provider: 'openai',
      providerEnv: freezeEnv({
        OUTLOOK_AGENT_OPENAI_API_KEY: 'sk-test',
        OUTLOOK_AGENT_OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OUTLOOK_AGENT_OPENAI_ORG: 'org-abc',
      }),
    });
    expect(() => createOpenaiModel(cfg)).not.toThrow();
  });

  it('throws ConfigurationError(OUTLOOK_AGENT_OPENAI_API_KEY) when API key is missing', () => {
    const cfg = makeCfg({ provider: 'openai', providerEnv: freezeEnv({}) });
    expectMissingSetting(
      createOpenaiModel,
      cfg,
      'OUTLOOK_AGENT_OPENAI_API_KEY',
    );
  });

  it('throws ConfigurationError when API key is empty string', () => {
    const cfg = makeCfg({
      provider: 'openai',
      providerEnv: freezeEnv({ OUTLOOK_AGENT_OPENAI_API_KEY: '' }),
    });
    expectMissingSetting(
      createOpenaiModel,
      cfg,
      'OUTLOOK_AGENT_OPENAI_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// anthropic
// ---------------------------------------------------------------------------

describe('createAnthropicModel', () => {
  it('constructs ChatAnthropic when API key is present', () => {
    const cfg = makeCfg({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      providerEnv: freezeEnv({
        OUTLOOK_AGENT_ANTHROPIC_API_KEY: 'sk-ant-test',
      }),
    });
    const m = createAnthropicModel(cfg);
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  it('accepts optional baseURL', () => {
    const cfg = makeCfg({
      provider: 'anthropic',
      providerEnv: freezeEnv({
        OUTLOOK_AGENT_ANTHROPIC_API_KEY: 'sk-ant-test',
        OUTLOOK_AGENT_ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      }),
    });
    expect(() => createAnthropicModel(cfg)).not.toThrow();
  });

  it('throws ConfigurationError(OUTLOOK_AGENT_ANTHROPIC_API_KEY) when missing', () => {
    const cfg = makeCfg({
      provider: 'anthropic',
      providerEnv: freezeEnv({}),
    });
    expectMissingSetting(
      createAnthropicModel,
      cfg,
      'OUTLOOK_AGENT_ANTHROPIC_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// google
// ---------------------------------------------------------------------------

describe('createGoogleModel', () => {
  it('constructs ChatGoogleGenerativeAI when API key is present', () => {
    const cfg = makeCfg({
      provider: 'google',
      model: 'gemini-2.5-pro',
      providerEnv: freezeEnv({
        OUTLOOK_AGENT_GOOGLE_API_KEY: 'AIza-test',
      }),
    });
    const m = createGoogleModel(cfg);
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('throws ConfigurationError(OUTLOOK_AGENT_GOOGLE_API_KEY) when missing', () => {
    const cfg = makeCfg({ provider: 'google', providerEnv: freezeEnv({}) });
    expectMissingSetting(
      createGoogleModel,
      cfg,
      'OUTLOOK_AGENT_GOOGLE_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// azure-openai
// ---------------------------------------------------------------------------

describe('createAzureOpenaiModel', () => {
  const fullEnv = {
    OUTLOOK_AGENT_AZURE_OPENAI_API_KEY: 'azkey',
    OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT: 'https://resource.openai.azure.com',
    OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT: 'gpt4o-deploy',
    OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION: '2024-10-21',
  };

  it('constructs AzureChatOpenAI when all required vars are present', () => {
    const cfg = makeCfg({
      provider: 'azure-openai',
      model: 'gpt-4o',
      providerEnv: freezeEnv(fullEnv),
    });
    const m = createAzureOpenaiModel(cfg);
    expect(m).toBeInstanceOf(AzureChatOpenAI);
  });

  it('constructs without OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION (optional)', () => {
    const { OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION: _dropped, ...rest } =
      fullEnv;
    void _dropped;
    const cfg = makeCfg({
      provider: 'azure-openai',
      model: 'gpt-4o',
      providerEnv: freezeEnv(rest),
    });
    expect(() => createAzureOpenaiModel(cfg)).not.toThrow();
  });

  for (const key of [
    'OUTLOOK_AGENT_AZURE_OPENAI_API_KEY',
    'OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT',
    'OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT',
  ] as const) {
    it(`throws ConfigurationError(${key}) when missing`, () => {
      const partial = { ...fullEnv } as Record<string, string>;
      delete partial[key];
      const cfg = makeCfg({
        provider: 'azure-openai',
        model: 'gpt-4o',
        providerEnv: freezeEnv(partial),
      });
      expectMissingSetting(createAzureOpenaiModel, cfg, key);
    });
  }
});

// ---------------------------------------------------------------------------
// azure-anthropic
// ---------------------------------------------------------------------------

describe('createAzureAnthropicModel', () => {
  const fullEnv = {
    OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT:
      'https://resource.services.ai.azure.com',
    OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY: 'azai-key',
  };

  it('constructs ChatAnthropic when all required vars are present', () => {
    const cfg = makeCfg({
      provider: 'azure-anthropic',
      model: 'claude-opus-4-7',
      providerEnv: freezeEnv(fullEnv),
    });
    const m = createAzureAnthropicModel(cfg);
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  it('accepts OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL when it matches cfg.model', () => {
    const cfg = makeCfg({
      provider: 'azure-anthropic',
      model: 'claude-opus-4-7',
      providerEnv: freezeEnv({
        ...fullEnv,
        OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL: 'claude-opus-4-7',
      }),
    });
    expect(() => createAzureAnthropicModel(cfg)).not.toThrow();
  });

  it('throws UsageError when OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL disagrees with cfg.model', () => {
    const cfg = makeCfg({
      provider: 'azure-anthropic',
      model: 'claude-opus-4-7',
      providerEnv: freezeEnv({
        ...fullEnv,
        OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      }),
    });
    expect(() => createAzureAnthropicModel(cfg)).toThrow(UsageError);
  });

  for (const key of [
    'OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT',
    'OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY',
  ] as const) {
    it(`throws ConfigurationError(${key}) when missing`, () => {
      const partial = { ...fullEnv } as Record<string, string>;
      delete partial[key];
      const cfg = makeCfg({
        provider: 'azure-anthropic',
        model: 'claude-opus-4-7',
        providerEnv: freezeEnv(partial),
      });
      expectMissingSetting(createAzureAnthropicModel, cfg, key);
    });
  }
});

// ---------------------------------------------------------------------------
// azure-deepseek
// ---------------------------------------------------------------------------

describe('createAzureDeepseekModel', () => {
  const baseEnv = {
    OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT:
      'https://resource.services.ai.azure.com',
    OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY: 'azai-key',
  };

  it('constructs ChatOpenAI for allowed model DeepSeek-V3.2', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv(baseEnv),
    });
    const m = createAzureDeepseekModel(cfg);
    // Explicitly ChatOpenAI (NOT AzureChatOpenAI).
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect(m.constructor.name).toBe('ChatOpenAI');
  });

  it('accepts DeepSeek-V3, DeepSeek-V3.1, DeepSeek-V3.2 (allowlist)', () => {
    for (const model of ['DeepSeek-V3', 'DeepSeek-V3.1', 'DeepSeek-V3.2']) {
      const cfg = makeCfg({
        provider: 'azure-deepseek',
        model,
        providerEnv: freezeEnv(baseEnv),
      });
      expect(
        () => createAzureDeepseekModel(cfg),
        `model=${model}`,
      ).not.toThrow();
    }
  });

  it('accepts allowed models case-insensitively (deepseek-v3.2)', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'deepseek-v3.2',
      providerEnv: freezeEnv(baseEnv),
    });
    expect(() => createAzureDeepseekModel(cfg)).not.toThrow();
  });

  // Denylist — each pattern (research §7 / design §5.6) must reject.
  const deniedModels: readonly string[] = [
    'DeepSeek-V3.2-Speciale',
    'deepseek-v3.2-speciale',
    'DeepSeek-R1',
    'deepseek-r1',
    'DeepSeek-R1-0528',
    'deepseek-r1-0528',
    'deepseek-reasoner',
    'MAI-DS-R1',
    'mai-ds-r1',
  ];
  for (const model of deniedModels) {
    it(`rejects ${model} with ConfigurationError (missingSetting=OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL)`, () => {
      const cfg = makeCfg({
        provider: 'azure-deepseek',
        model,
        providerEnv: freezeEnv(baseEnv),
      });
      expectMissingSetting(
        createAzureDeepseekModel,
        cfg,
        'OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL',
      );
    });
  }

  it('throws UsageError when cfg.model disagrees with OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv({
        ...baseEnv,
        OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL: 'DeepSeek-V3.1',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).toThrow(UsageError);
  });

  it('constructs when cfg.model agrees with OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv({
        ...baseEnv,
        OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL: 'DeepSeek-V3.2',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).not.toThrow();
  });

  for (const key of [
    'OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT',
    'OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY',
  ] as const) {
    it(`throws ConfigurationError(${key}) when missing`, () => {
      const partial = { ...baseEnv } as Record<string, string>;
      delete partial[key];
      const cfg = makeCfg({
        provider: 'azure-deepseek',
        model: 'DeepSeek-V3.2',
        providerEnv: freezeEnv(partial),
      });
      expectMissingSetting(createAzureDeepseekModel, cfg, key);
    });
  }

  it('normalizes trailing slash in the endpoint', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv({
        ...baseEnv,
        OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT:
          'https://resource.services.ai.azure.com/',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).not.toThrow();
  });

  it('normalizes trailing /models segment in the endpoint', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv({
        ...baseEnv,
        OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT:
          'https://resource.services.ai.azure.com/models',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('PROVIDERS registry', () => {
  it('has exactly six entries, one per ProviderName literal', () => {
    const names = Object.keys(PROVIDERS).sort();
    expect(names).toEqual(
      [
        'anthropic',
        'azure-anthropic',
        'azure-deepseek',
        'azure-openai',
        'google',
        'openai',
      ].sort(),
    );
  });

  it('every entry is a function', () => {
    for (const [name, f] of Object.entries(PROVIDERS)) {
      expect(typeof f, `PROVIDERS["${name}"] should be a function`).toBe(
        'function',
      );
    }
  });

  it('getProvider returns the matching factory for each known name', () => {
    expect(getProvider('openai')).toBe(createOpenaiModel);
    expect(getProvider('anthropic')).toBe(createAnthropicModel);
    expect(getProvider('google')).toBe(createGoogleModel);
    expect(getProvider('azure-openai')).toBe(createAzureOpenaiModel);
    expect(getProvider('azure-anthropic')).toBe(createAzureAnthropicModel);
    expect(getProvider('azure-deepseek')).toBe(createAzureDeepseekModel);
  });

  it('getProvider throws UsageError on unknown name', () => {
    expect(() => getProvider('bogus' as unknown as ProviderName)).toThrow(
      UsageError,
    );
  });

  it('registry is frozen (cannot be monkey-patched)', () => {
    expect(Object.isFrozen(PROVIDERS)).toBe(true);
  });
});
