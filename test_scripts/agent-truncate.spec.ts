// test_scripts/agent-truncate.spec.ts
//
// Unit tests for the per-tool byte-budget serializer.
// See src/agent/tools/truncate.ts and project-design.md §6.

import { describe, expect, it } from 'vitest';

import { truncateToolResult } from '../src/agent/tools/truncate';

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('truncateToolResult', () => {
  it('(1) short JSON under budget → unchanged', () => {
    const obj = { Id: 'AAMkAG_abc', Subject: 'hello', IsRead: false };
    const out = truncateToolResult(obj, 16_384);
    expect(out).toBe(JSON.stringify(obj));
    // Round-trips.
    expect(JSON.parse(out)).toEqual(obj);
  });

  it('(2) long array → tail truncation, wrapper carries kept/original', () => {
    // Build an array bigger than the budget.
    const entries = Array.from({ length: 200 }).map((_, i) => ({
      Id: `AAMkAG_${i}`,
      Subject: `subject-${i}`,
      Body: 'x'.repeat(200),
    }));
    const budget = 2048;
    const out = truncateToolResult(entries, budget);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(budget);

    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      __truncated: true,
      original: 200,
    });
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.kept).toBe(parsed.items.length);
    expect(parsed.kept).toBeGreaterThan(0);
    expect(parsed.kept).toBeLessThan(200);

    // The KEPT entries must be the head of the original array (tail-drop).
    // Id and other fields inside kept entries must be intact — we drop whole
    // entries, never fields within them.
    for (let i = 0; i < parsed.kept; i += 1) {
      expect(parsed.items[i].Id).toBe(entries[i].Id);
      expect(parsed.items[i].Subject).toBe(entries[i].Subject);
    }
  });

  it('(3) large non-array object → wrapper with __truncated and raw prefix', () => {
    const big = {
      Id: 'AAMkAG_xyz',
      Body: 'x'.repeat(20_000),
      Subject: 'subj',
    };
    const budget = 1024;
    const out = truncateToolResult(big, budget);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(budget);

    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ __truncated: true });
    expect(typeof parsed.raw).toBe('string');
    expect(parsed.raw.endsWith('...TRUNCATED')).toBe(true);
    // The raw prefix should begin with the JSON serialization start.
    expect(parsed.raw.startsWith('{')).toBe(true);
  });

  it('(4) truncated output is always valid JSON (both branches)', () => {
    const arr = Array.from({ length: 50 }).map((_, i) => ({
      Id: `id-${i}`,
      Body: 'y'.repeat(500),
    }));
    const objOut = truncateToolResult({ Body: 'z'.repeat(10_000) }, 256);
    const arrOut = truncateToolResult(arr, 512);
    // JSON.parse throws if invalid.
    expect(() => JSON.parse(objOut)).not.toThrow();
    expect(() => JSON.parse(arrOut)).not.toThrow();
  });

  it('(5) empty array under budget → unchanged', () => {
    const out = truncateToolResult([], 16_384);
    expect(out).toBe('[]');
  });

  it('(6) array whose entries exceed even the empty wrapper still returns valid JSON', () => {
    // Extreme low budget forces the "all dropped" branch.
    const arr = [{ Id: 'a', Body: 'x'.repeat(500) }];
    const out = truncateToolResult(arr, 80);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ __truncated: true, original: 1 });
  });
});
