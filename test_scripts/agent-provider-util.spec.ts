// test_scripts/agent-provider-util.spec.ts
//
// Unit tests for `normalizeFoundryEndpoint` — the shared helper that
// prepares the Azure Foundry base URL for both azure-anthropic (append
// /anthropic) and azure-deepseek (append /openai/v1) factories. Rules are
// spec'd in docs/design/project-design.md §5.5 / §5.6.

import { describe, expect, it } from 'vitest';

import { normalizeFoundryEndpoint } from '../src/agent/providers/util';

describe('normalizeFoundryEndpoint', () => {
  const BASE = 'https://resource.services.ai.azure.com';

  it('appends /anthropic to a bare base URL', () => {
    expect(normalizeFoundryEndpoint(BASE, '/anthropic')).toBe(
      `${BASE}/anthropic`,
    );
  });

  it('appends /openai/v1 to a bare base URL', () => {
    expect(normalizeFoundryEndpoint(BASE, '/openai/v1')).toBe(
      `${BASE}/openai/v1`,
    );
  });

  it('strips a single trailing slash before appending', () => {
    expect(normalizeFoundryEndpoint(`${BASE}/`, '/anthropic')).toBe(
      `${BASE}/anthropic`,
    );
    expect(normalizeFoundryEndpoint(`${BASE}/`, '/openai/v1')).toBe(
      `${BASE}/openai/v1`,
    );
  });

  it('strips multiple trailing slashes before appending', () => {
    expect(normalizeFoundryEndpoint(`${BASE}///`, '/anthropic')).toBe(
      `${BASE}/anthropic`,
    );
  });

  it('strips a trailing /models segment (legacy AI Inference SDK)', () => {
    expect(normalizeFoundryEndpoint(`${BASE}/models`, '/anthropic')).toBe(
      `${BASE}/anthropic`,
    );
    expect(normalizeFoundryEndpoint(`${BASE}/models`, '/openai/v1')).toBe(
      `${BASE}/openai/v1`,
    );
  });

  it('strips /models/ (with trailing slash)', () => {
    expect(normalizeFoundryEndpoint(`${BASE}/models/`, '/openai/v1')).toBe(
      `${BASE}/openai/v1`,
    );
  });

  it('strips /models case-insensitively', () => {
    expect(normalizeFoundryEndpoint(`${BASE}/Models`, '/anthropic')).toBe(
      `${BASE}/anthropic`,
    );
    expect(normalizeFoundryEndpoint(`${BASE}/MODELS/`, '/openai/v1')).toBe(
      `${BASE}/openai/v1`,
    );
  });

  it('trims surrounding whitespace from the base URL', () => {
    expect(normalizeFoundryEndpoint(`  ${BASE}  `, '/anthropic')).toBe(
      `${BASE}/anthropic`,
    );
  });

  it('does not strip /models when it is not the final segment', () => {
    // "/modelsX" is not "/models" so we leave it alone.
    expect(
      normalizeFoundryEndpoint(`${BASE}/modelsX`, '/anthropic'),
    ).toBe(`${BASE}/modelsX/anthropic`);
  });
});
