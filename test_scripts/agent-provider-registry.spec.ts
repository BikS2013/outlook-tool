// test_scripts/agent-provider-registry.spec.ts
//
// Unit tests for the seven provider factories plus the registry surface.
// Factories MUST NOT call the network at construction time — we assert only
// on class identity and thrown errors.
//
// v2.0.0: credential env vars use standard vendor-documented names.
// Provider `google` → `gemini`; new `local-openai` slot added.

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
import { createGeminiModel } from '../src/agent/providers/gemini';
import { createAzureOpenaiModel } from '../src/agent/providers/azure-openai';
import { createAzureAnthropicModel } from '../src/agent/providers/azure-anthropic';
import { createAzureDeepseekModel } from '../src/agent/providers/azure-deepseek';
import { createLocalOpenaiModel } from '../src/agent/providers/local-openai';
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
        OPENAI_API_KEY: 'sk-test',
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
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_ORG_ID: 'org-abc',
      }),
    });
    expect(() => createOpenaiModel(cfg)).not.toThrow();
  });

  it('throws ConfigurationError(OPENAI_API_KEY) when API key is missing', () => {
    const cfg = makeCfg({ provider: 'openai', providerEnv: freezeEnv({}) });
    expectMissingSetting(
      createOpenaiModel,
      cfg,
      'OPENAI_API_KEY',
    );
  });

  it('throws ConfigurationError when API key is empty string', () => {
    const cfg = makeCfg({
      provider: 'openai',
      providerEnv: freezeEnv({ OPENAI_API_KEY: '' }),
    });
    expectMissingSetting(
      createOpenaiModel,
      cfg,
      'OPENAI_API_KEY',
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
        ANTHROPIC_API_KEY: 'sk-ant-test',
      }),
    });
    const m = createAnthropicModel(cfg);
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  it('accepts optional baseURL', () => {
    const cfg = makeCfg({
      provider: 'anthropic',
      providerEnv: freezeEnv({
        ANTHROPIC_API_KEY: 'sk-ant-test',
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      }),
    });
    expect(() => createAnthropicModel(cfg)).not.toThrow();
  });

  it('throws ConfigurationError(ANTHROPIC_API_KEY) when missing', () => {
    const cfg = makeCfg({
      provider: 'anthropic',
      providerEnv: freezeEnv({}),
    });
    expectMissingSetting(
      createAnthropicModel,
      cfg,
      'ANTHROPIC_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// gemini (replaces google)
// ---------------------------------------------------------------------------

describe('createGeminiModel', () => {
  it('constructs ChatGoogleGenerativeAI when GOOGLE_API_KEY is present', () => {
    const cfg = makeCfg({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      providerEnv: freezeEnv({
        GOOGLE_API_KEY: 'AIza-test',
      }),
    });
    const m = createGeminiModel(cfg);
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('accepts GEMINI_API_KEY as alias for GOOGLE_API_KEY', () => {
    const cfg = makeCfg({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      providerEnv: freezeEnv({
        GEMINI_API_KEY: 'AIza-alias-test',
      }),
    });
    expect(() => createGeminiModel(cfg)).not.toThrow();
    const m = createGeminiModel(cfg);
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('throws ConfigurationError(GOOGLE_API_KEY) when neither key is present', () => {
    const cfg = makeCfg({ provider: 'gemini', providerEnv: freezeEnv({}) });
    expectMissingSetting(
      createGeminiModel,
      cfg,
      'GOOGLE_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// azure-openai
// ---------------------------------------------------------------------------

describe('createAzureOpenaiModel', () => {
  const fullEnv = {
    AZURE_OPENAI_API_KEY: 'azkey',
    AZURE_OPENAI_ENDPOINT: 'https://resource.openai.azure.com',
    AZURE_OPENAI_DEPLOYMENT: 'gpt4o-deploy',
    AZURE_OPENAI_API_VERSION: '2024-10-21',
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

  it('constructs without AZURE_OPENAI_API_VERSION (optional)', () => {
    const { AZURE_OPENAI_API_VERSION: _dropped, ...rest } = fullEnv;
    void _dropped;
    const cfg = makeCfg({
      provider: 'azure-openai',
      model: 'gpt-4o',
      providerEnv: freezeEnv(rest),
    });
    expect(() => createAzureOpenaiModel(cfg)).not.toThrow();
  });

  for (const key of [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
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
    AZURE_AI_INFERENCE_ENDPOINT:
      'https://resource.services.ai.azure.com',
    AZURE_AI_INFERENCE_KEY: 'azai-key',
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

  it('accepts AZURE_ANTHROPIC_MODEL when it matches cfg.model', () => {
    const cfg = makeCfg({
      provider: 'azure-anthropic',
      model: 'claude-opus-4-7',
      providerEnv: freezeEnv({
        ...fullEnv,
        AZURE_ANTHROPIC_MODEL: 'claude-opus-4-7',
      }),
    });
    expect(() => createAzureAnthropicModel(cfg)).not.toThrow();
  });

  it('throws UsageError when AZURE_ANTHROPIC_MODEL disagrees with cfg.model', () => {
    const cfg = makeCfg({
      provider: 'azure-anthropic',
      model: 'claude-opus-4-7',
      providerEnv: freezeEnv({
        ...fullEnv,
        AZURE_ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      }),
    });
    expect(() => createAzureAnthropicModel(cfg)).toThrow(UsageError);
  });

  for (const key of [
    'AZURE_AI_INFERENCE_ENDPOINT',
    'AZURE_AI_INFERENCE_KEY',
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
    AZURE_AI_INFERENCE_ENDPOINT:
      'https://resource.services.ai.azure.com',
    AZURE_AI_INFERENCE_KEY: 'azai-key',
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
    it(`rejects ${model} with ConfigurationError (missingSetting=AZURE_DEEPSEEK_MODEL)`, () => {
      const cfg = makeCfg({
        provider: 'azure-deepseek',
        model,
        providerEnv: freezeEnv(baseEnv),
      });
      expectMissingSetting(
        createAzureDeepseekModel,
        cfg,
        'AZURE_DEEPSEEK_MODEL',
      );
    });
  }

  it('throws UsageError when cfg.model disagrees with AZURE_DEEPSEEK_MODEL', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv({
        ...baseEnv,
        AZURE_DEEPSEEK_MODEL: 'DeepSeek-V3.1',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).toThrow(UsageError);
  });

  it('constructs when cfg.model agrees with AZURE_DEEPSEEK_MODEL', () => {
    const cfg = makeCfg({
      provider: 'azure-deepseek',
      model: 'DeepSeek-V3.2',
      providerEnv: freezeEnv({
        ...baseEnv,
        AZURE_DEEPSEEK_MODEL: 'DeepSeek-V3.2',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).not.toThrow();
  });

  for (const key of [
    'AZURE_AI_INFERENCE_ENDPOINT',
    'AZURE_AI_INFERENCE_KEY',
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
        AZURE_AI_INFERENCE_ENDPOINT:
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
        AZURE_AI_INFERENCE_ENDPOINT:
          'https://resource.services.ai.azure.com/models',
      }),
    });
    expect(() => createAzureDeepseekModel(cfg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// local-openai
// ---------------------------------------------------------------------------

describe('createLocalOpenaiModel', () => {
  it('constructs ChatOpenAI with OPENAI_BASE_URL', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
      }),
    });
    const m = createLocalOpenaiModel(cfg);
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect(m.constructor.name).toBe('ChatOpenAI');
  });

  it('constructs with LOCAL_OPENAI_BASE_URL when OPENAI_BASE_URL is absent', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({
        LOCAL_OPENAI_BASE_URL: 'http://localhost:8080/v1',
      }),
    });
    expect(() => createLocalOpenaiModel(cfg)).not.toThrow();
  });

  it('constructs with OLLAMA_HOST and maps to http://<host>/v1', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({
        OLLAMA_HOST: 'localhost:11434',
      }),
    });
    expect(() => createLocalOpenaiModel(cfg)).not.toThrow();
  });

  it('uses OPENAI_API_KEY when provided', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_API_KEY: 'real-key',
      }),
    });
    expect(() => createLocalOpenaiModel(cfg)).not.toThrow();
  });

  it('defaults to sentinel key "not-needed" when OPENAI_API_KEY is absent', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
      }),
    });
    // Should not throw even without an API key.
    expect(() => createLocalOpenaiModel(cfg)).not.toThrow();
  });

  it('throws ConfigurationError(OPENAI_BASE_URL) when no base URL is resolvable', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({}),
    });
    expectMissingSetting(createLocalOpenaiModel, cfg, 'OPENAI_BASE_URL');
  });

  it('OPENAI_BASE_URL takes priority over LOCAL_OPENAI_BASE_URL', () => {
    const cfg = makeCfg({
      provider: 'local-openai',
      model: 'llama-3.2',
      providerEnv: freezeEnv({
        OPENAI_BASE_URL: 'http://primary:11434/v1',
        LOCAL_OPENAI_BASE_URL: 'http://secondary:8080/v1',
      }),
    });
    // Both present — should use OPENAI_BASE_URL without error.
    expect(() => createLocalOpenaiModel(cfg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('PROVIDERS registry', () => {
  it('has seven entries (six canonical + azure-deepseek extension)', () => {
    const names = Object.keys(PROVIDERS).sort();
    expect(names).toEqual(
      [
        'anthropic',
        'azure-anthropic',
        'azure-deepseek',
        'azure-openai',
        'gemini',
        'local-openai',
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
    expect(getProvider('gemini')).toBe(createGeminiModel);
    expect(getProvider('azure-openai')).toBe(createAzureOpenaiModel);
    expect(getProvider('azure-anthropic')).toBe(createAzureAnthropicModel);
    expect(getProvider('local-openai')).toBe(createLocalOpenaiModel);
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
