// src/agent/tools/truncate.ts
//
// Per-tool byte-budget serializer. See project-design.md §6 ("Common rules")
// and plan-003 Phase D §truncate.
//
// Contract:
//   - Input is the raw `commands/*.run()` return value. Output is a JSON
//     string whose byte length is ≤ `maxBytes`.
//   - If JSON.stringify(obj) already fits under the budget, it is returned
//     verbatim.
//   - Array payloads shrink by dropping entries from the TAIL; `Id`,
//     `ConversationId`, `ParentFolderId` inside kept entries are never
//     touched (we drop whole array elements, never fields within them).
//     The truncated result is wrapped
//       { "__truncated": true, "kept": N, "original": M, "items": [...] }.
//   - Object payloads fall back to a hard prefix truncation, wrapped
//       { "__truncated": true, "raw": "<prefix>...TRUNCATED" }.
//   - Any value we return is always valid JSON.

/** Byte length of a JS string encoded as UTF-8. */
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Wrap-overhead helper: computes the JSON-stringified wrapper around items. */
function wrappedArrayBytes(
  kept: unknown[],
  original: number,
): { str: string; bytes: number } {
  const str = JSON.stringify({
    __truncated: true,
    kept: kept.length,
    original,
    items: kept,
  });
  return { str, bytes: utf8Bytes(str) };
}

/**
 * Serialize `obj` as JSON and truncate it to fit within `maxBytes`. Always
 * returns a valid JSON string.
 *
 * @param obj       The original payload.
 * @param maxBytes  Upper bound on the UTF-8 byte length of the output.
 */
export function truncateToolResult(obj: unknown, maxBytes: number): string {
  // Guard against callers passing a silly budget. We do not throw — just pick
  // a generous floor so downstream sinks don't have to deal with 0-length
  // strings.
  const budget = Math.max(64, Math.floor(maxBytes));

  let baseline: string;
  try {
    baseline = JSON.stringify(obj);
  } catch {
    // Non-serializable input (BigInt, circular, ...) — fall back to a stable
    // raw-string wrapper so the downstream model still sees valid JSON.
    const fallback = JSON.stringify({
      __truncated: true,
      raw: '(non-serializable payload)',
    });
    return fallback;
  }

  // Fast path — fits under the budget.
  if (utf8Bytes(baseline) <= budget) {
    return baseline;
  }

  // Array path — drop entries from the tail until the wrapped shape fits or
  // we have zero items left.
  if (Array.isArray(obj)) {
    const original = obj.length;
    let kept = obj.slice();
    while (kept.length > 0) {
      const { str, bytes } = wrappedArrayBytes(kept, original);
      if (bytes <= budget) {
        return str;
      }
      kept = kept.slice(0, kept.length - 1);
    }
    // Even the empty-array wrapper blew the budget (tiny budget corner case).
    return wrappedArrayBytes([], original).str;
  }

  // Object / scalar path — hard prefix truncate. We aim for budget - 30
  // bytes of prefix content (30 bytes leaves headroom for
  // `{"__truncated":true,"raw":"…TRUNCATED"}` overhead), then wrap.
  const PREFIX_CAP = Math.max(16, budget - 30);

  // Prefix `baseline` down to PREFIX_CAP characters then JSON-escape via
  // re-stringify. Hard-truncating characters (not bytes) is acceptable:
  // Outlook v2 JSON is ASCII-dominant, and the final JSON.stringify pass
  // re-encodes any stray surrogate halves defensively.
  let prefix = baseline.slice(0, PREFIX_CAP);
  let wrapped = JSON.stringify({
    __truncated: true,
    raw: `${prefix}...TRUNCATED`,
  });

  // If the wrapper grew larger than the budget because of escape overhead,
  // back off the prefix until it fits (bounded linear loop — cheap because
  // each step strips ~budget/8 bytes on average).
  while (utf8Bytes(wrapped) > budget && prefix.length > 0) {
    const nextLen = Math.max(0, prefix.length - Math.ceil(prefix.length / 8) - 1);
    prefix = prefix.slice(0, nextLen);
    wrapped = JSON.stringify({
      __truncated: true,
      raw: `${prefix}...TRUNCATED`,
    });
  }

  return wrapped;
}
