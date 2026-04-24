# Agent Alignment Audit — outlook-cli

**Date:** 2026-04-24
**Auditor:** Claude Code (agent definition v2 — standardized conventions)
**Scope:** Compare the existing `src/agent/` implementation against the canonical guidelines defined in the agent-definition system prompt. This is a read-only analysis; no code has been modified.
**Baseline:** 495/495 tests passing, `tsc --noEmit` clean.

---

## 1. Executive Summary

The existing agent implementation is structurally sound and closely follows the spec-agent-on-tool.md (the tool's own normative spec), but it diverges from several canonical guidelines in the agent-definition system prompt in four meaningful ways: (1) all env vars use an `OUTLOOK_AGENT_*` prefix instead of the standard vendor-documented names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.); (2) the `~/tool-agents/outlook-cli/` centralized config folder tier is entirely absent from both the running code and the precedence chain; (3) the provider registry is missing the `local-openai` slot (approved for addition); and (4) the `azure-deepseek` provider is present as a first-class default slot instead of being the optional add-on described in the canonical guidelines. All other architectural patterns (directory layout, mutation gating, per-tool truncation, redaction, error routing, MemorySaver interactive mode, event-based readline) conform well.

**Overall verdict:** Architecturally aligned on 80% of dimensions; two env-var conventions and the config-folder tier are the significant gaps, with `local-openai` addition pre-approved.

---

## 2. Canonical Guidelines (Summary)

The agent-definition system prompt's relevant canonical patterns:

### Directory layout

```
src/commands/agent.ts
src/config/agent-config.ts
src/agent/
  system-prompt.ts, logging.ts, graph.ts, run.ts
  providers/{types,util,registry,openai,anthropic,gemini,azure-openai,azure-anthropic,local-openai}.ts
  tools/{types,truncate,registry,<command>-tool.ts}
test_scripts/agent-*.spec.ts, commands-agent.spec.ts
docs/reference/.env.example
docs/reference/config.json.example
```

### Canonical provider slot set (6 standard + azure-deepseek only if explicitly requested)

| Slot | SDK class | Note |
|---|---|---|
| `openai` | `ChatOpenAI` | |
| `anthropic` | `ChatAnthropic` | |
| `gemini` | `ChatGoogleGenerativeAI` | Note: canonical name is `gemini`, not `google` |
| `azure-openai` | `AzureChatOpenAI` | |
| `azure-anthropic` | `ChatAnthropic` with Foundry `baseURL` | |
| `local-openai` | `ChatOpenAI` with custom `baseURL` | APPROVED FOR IMPLEMENTATION |

`azure-deepseek` is listed as an extra-on-request provider only, not a default slot.

### Canonical config precedence chain

```
CLI flag > shell env var (standard name) > ~/tool-agents/<tool>/.env > ~/tool-agents/<tool>/config.json > NONE (throw ConfigurationError)
```

Key: `~/tool-agents/outlook-cli/` is an explicit tier between shell env and throw. This tier does not exist in the current implementation.

### Canonical env-var naming convention

Standard, vendor-documented names — **no tool-specific prefix**:
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- `GOOGLE_API_KEY` (alias: `GEMINI_API_KEY`)
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_AI_INFERENCE_KEY`, `AZURE_AI_INFERENCE_ENDPOINT`
- `OPENAI_BASE_URL` / `LOCAL_OPENAI_BASE_URL` / `OLLAMA_HOST` (for `local-openai`)

The current implementation prefixes every provider-specific var with `OUTLOOK_AGENT_` (e.g. `OUTLOOK_AGENT_OPENAI_API_KEY`). This is a deliberate project-local choice and a known deviation from canonical.

### Canonical tool-adapter shape

Each adapter: `ToolAdapterFactory = (deps, cfg) => StructuredToolInterface`. Inside the handler: call `commands/<name>.run(deps, ...)`, pipe through `truncateToolResult(result, cfg.perToolBudgetBytes)`, route errors through `handleToolError`. Mutation tools descriptions must start with `[MUTATING]`. All of this is satisfied.

### Canonical CLI flag surface

```
agent [prompt] [-i] [-p provider] [-m model] [--base-url] [--config <path>] [--env-file <path>]
  [--max-steps] [--temperature] [--system | --system-file] [--tools] [--per-tool-budget]
  [--allow-mutations] [--verbose]
```

The canonical spec adds `--base-url` (provider URL override, useful for `local-openai`) and `--config <path>` (override for the `~/tool-agents/outlook-cli/config.json` path). Neither is present in the current implementation.

---

## 3. Delta Table — Current vs. Canonical

| # | Area | Current | Canonical | Delta | Severity | Effort |
|---|---|---|---|---|---|---|
| D1 | Provider: `local-openai` slot | Absent | Required as one of 6 standard slots | Missing slot; user cannot point agent at OLLaMA / LightLLM / MLX-LM | **Blocking** (pre-approved) | S |
| D2 | Env-var naming — provider creds | Prefixed: `OUTLOOK_AGENT_OPENAI_API_KEY`, `OUTLOOK_AGENT_ANTHROPIC_API_KEY`, etc. | Standard vendor names: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. Shell env var standard names must be used | Behavioral; breaks every user who exports standard names. Conflicts with canonical invariant #1 | **Blocking** | L |
| D3 | Config folder tier `~/tool-agents/outlook-cli/` | Absent — no `config.json`, no folder-seed logic, no `.env` at that path | Mandatory tier between shell env and throw; seeded on first run | Missing precedence layer; no non-secret defaults store; `.env` discovery does not consult `~/tool-agents/` | **Blocking** | M |
| D4 | Provider name: `google` vs `gemini` | Provider id is `google` in `ProviderName` union, `PROVIDERS` map, CLI `--provider` flag, and `.env.example` | Canonical id is `gemini` (matching `<provider>` column in the standard table) | User-facing naming mismatch; minor breakage if canonical docs are referenced | **Recommended** | S |
| D5 | Provider: `azure-deepseek` as default slot | Ships as a first-class default slot (7th provider, in `PROVIDERS` map) | Should be an optional/extra-on-request provider, not in the default 6-slot set | Canonical says "add only if explicitly requested"; this is a project-specific extension | **Recommended** (low risk — keep if tested) | S |
| D6 | CLI flag: `--base-url` | Absent | Required for `local-openai` override; also useful for `openai` proxy | Without it, `local-openai` cannot set its endpoint via flag (must use env var) | **Recommended** | S |
| D7 | CLI flag: `--config <path>` | Absent | Override path for `~/tool-agents/outlook-cli/config.json` | Blocked until D3 lands | Recommended (depends on D3) | S |
| D8 | `config.json` schema with `schemaVersion` | Absent (no `config.json` concept at all) | Required field `"schemaVersion": 1`; load must reject unknown versions with upgrade hint | Protects against future schema drift | Recommended (depends on D3) | S |
| D9 | `.env` example location | `.env.example` at project root | Canonical: `docs/reference/.env.example` | Minor location mismatch; existing location is sensible for the project | Cosmetic | XS |
| D10 | `config.json.example` for non-secret defaults | Absent | Required at `docs/reference/config.json.example` | Documentation gap only until D3 lands | Cosmetic (depends on D3) | S |
| D11 | `~/tool-agents/<tool>/logs/` mode `0600` | Log file path is user-supplied via `--log-file`; no managed logs folder | Log files created under `~/tool-agents/outlook-cli/logs/` with mode `0600` on first open | Managed path is not created; security-relevant but low impact since logs are opt-in | Cosmetic | XS |
| D12 | `ConfigurationError` `checkedSources` JSON shape | Current shape: `{ error: { code, missingSetting, checkedSources } }` (implicit from error class fields) | Canonical JSON: `{"error":{"code":"CONFIG_MISSING","missingSetting":"...","checkedSources":[...]}}` | Shape matches; no delta | — | — |
| D13 | Mutation tool descriptions | `create_folder`, `move_mail`, `download_attachments` descriptions start with `[MUTATING]` | Required prefix `[MUTATING]` | Fully satisfied | — | — |
| D14 | `normalizeFoundryEndpoint` helper | Present in `src/agent/providers/util.ts` | Required | Satisfied | — | — |
| D15 | `local-openai` dummy API key when none provided | N/A (slot absent) | Must default to `"not-needed"` when `OPENAI_API_KEY` unset for local servers | Will be needed when D1 is implemented | — (deferred to D1) | — |
| D16 | Agent env var prefix for non-provider settings | `OUTLOOK_AGENT_PROVIDER`, `OUTLOOK_AGENT_MODEL`, `OUTLOOK_AGENT_*` for all control vars | Same pattern — `<YOUR_AGENT>_*` — is explicitly permitted in spec §5 | Not a delta; the `OUTLOOK_AGENT_` prefix for control vars is canonical. Only the *provider-specific credential* vars should use standard unprefixed names | — | — |
| D17 | `UpstreamError` on `local-openai` connect fail | N/A | Missing `baseURL` in error must be wrapped in `UpstreamError` with resolved URL | Deferred to D1 implementation | — | — |
| D18 | `expiresAt` warning for API keys near expiry | Absent | `config.json` `expiresAt` field + 7-day warn on startup | Not blocking; no `config.json` yet | Cosmetic (depends on D3) | S |
| D19 | Interactive mode uses event-based `readline` | Legacy REPL in `runInteractiveLegacy` uses `rl.on('line', …)` correctly; TUI layer is an additional abstraction | Spec §17.8 requires event-based readline, not `readline/promises.question()` | Satisfied in the legacy path; TUI layer is out-of-scope extra | — | — |
| D20 | `createAgent` from `langchain` (not prebuilt) | `import { createAgent } from 'langchain'` in `graph.ts` | Spec §10 + §17.4 require `createAgent` from `langchain`, NOT `createReactAgent` from `@langchain/langgraph/prebuilt` | Fully satisfied | — | — |

---

## 4. Prioritized Action List

### Blocking — must address before claiming canonical compliance

#### B1 — Add `local-openai` provider slot (PRE-APPROVED)
- **Files:** `src/agent/providers/local-openai.ts` (new), `src/agent/providers/registry.ts`, `src/config/agent-config.ts` (add `'local-openai'` to `ProviderName` union + `PROVIDER_NAMES` + `PROVIDER_ENV_PREFIX`), `.env.example`, `test_scripts/agent-provider-registry.spec.ts`.
- **Change:** New `ChatOpenAI` factory that reads `OPENAI_BASE_URL` (or `LOCAL_OPENAI_BASE_URL` or `OLLAMA_HOST`) as `baseURL`; when `OPENAI_API_KEY` is unset, defaults `apiKey` to `"not-needed"`. Wraps connection-refused errors in `UpstreamError` with the resolved `baseURL`. Full design in §5 below.
- **Type:** Behavioral (new user-visible provider).

#### B2 — Adopt standard vendor env-var names for provider credentials
- **Files:** `src/agent/providers/openai.ts`, `anthropic.ts`, `google.ts`, `azure-openai.ts`, `azure-anthropic.ts`, `azure-deepseek.ts`, `src/config/agent-config.ts` (`PROVIDER_ENV_PREFIX` map), `.env.example`, `CLAUDE.md` `<agent>` block, `docs/design/configuration-guide.md`, `README.md`.
- **Change:** Replace `OUTLOOK_AGENT_OPENAI_API_KEY` → `OPENAI_API_KEY`, `OUTLOOK_AGENT_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY`, `OUTLOOK_AGENT_GOOGLE_API_KEY` → `GOOGLE_API_KEY` (alias `GEMINI_API_KEY`), `OUTLOOK_AGENT_AZURE_OPENAI_*` → `AZURE_OPENAI_*`, `OUTLOOK_AGENT_AZURE_AI_INFERENCE_*` → `AZURE_AI_INFERENCE_*`. Keep `OUTLOOK_AGENT_PROVIDER`, `OUTLOOK_AGENT_MODEL`, and other control vars as-is — those are canonical.
- **Type:** Behavioral and breaking — existing `.env` files using old names must be migrated. **Requires migration note in docs.**
- **Note:** The test suite currently builds `AgentConfig` by setting the old prefixed vars in `process.env` inside `vi.mock` scopes. All affected provider tests will need updated env-var keys.

#### B3 — Implement `~/tool-agents/outlook-cli/` config folder tier
- **Files:** New `src/config/agent-config-folder.ts` (folder-seed logic), updated `src/config/agent-config.ts` (extend precedence chain), `src/commands/agent.ts` (call seed + load `config.json` before `loadAgentConfig`), new `docs/reference/config.json.example`, updated `docs/design/configuration-guide.md`.
- **Change:** On first invocation of `agent`, create `~/tool-agents/outlook-cli/` (mode `0700`), place a seeded `.env` (mode `0600`, placeholder values only — never copy `process.env`), and a `config.json` copied from `docs/reference/config.json.example`. Load `~/tool-agents/outlook-cli/.env` via `dotenv.config({ override: false })` after the existing `.env`/`--env-file` load. Load `~/tool-agents/outlook-cli/config.json` (Zod-validated, `schemaVersion: 1`) as the last fallback before throw.
- **Type:** Behavioral (new precedence tier; no regression for existing users unless they relied on "no `~/tool-agents/` folder" being an error).

### Recommended — significant improvement, no regression risk

#### R1 — Rename provider id `google` → `gemini`
- **Files:** `src/config/agent-config.ts`, `src/agent/providers/registry.ts`, `.env.example`, `CLAUDE.md`, `README.md`.
- **Change:** Add `'gemini'` to `ProviderName`, keep `'google'` as a deprecated alias accepted with a deprecation warning on stderr. Update `PROVIDER_ENV_PREFIX` to map `gemini` → prefix determined after B2 lands (would be no prefix for creds, `gemini` for internal route).
- **Type:** Behavioral (flag value change, backwards compat via alias).

#### R2 — Add `--base-url` CLI flag
- **Files:** `src/cli.ts` (commander wiring), `src/commands/agent.ts`, `src/config/agent-config.ts` (`AgentConfigFlags.baseUrl`).
- **Change:** Thread `--base-url <url>` through to `AgentConfigFlags.baseUrl`; the `local-openai` factory reads it first (overrides `OPENAI_BASE_URL`). Also useful for OpenAI-compatible proxies on the `openai` provider.
- **Type:** Behavioral (new flag, no regression).

#### R3 — Add `--config <path>` CLI flag
- **Files:** Same as R2 plus `src/config/agent-config-folder.ts`.
- **Change:** Allows user to override `~/tool-agents/outlook-cli/config.json` path. Depends on B3.
- **Type:** Behavioral (new flag, no regression). Deferred until B3 lands.

#### R4 — Clarify `azure-deepseek` as optional extra, not default
- **Files:** Documentation and `.env.example` only. No code change needed if the 7-slot map is working.
- **Change:** Mark `azure-deepseek` as "project-extended" in CLAUDE.md and README; the canonical 6-slot default set is explicitly documented as the base. The slot stays in the code.
- **Type:** Documentation only.

### Cosmetic — low impact, clean-up

#### C1 — Move `.env.example` to `docs/reference/.env.example`
- **Files:** `.env.example` → `docs/reference/.env.example`; update `.gitignore` reference, `README.md`, `CLAUDE.md`.
- **Note:** The existing project root location is also standard; this is a canonical-location preference only.

#### C2 — Add `docs/reference/config.json.example`
- **Files:** New file. Canonical sample `config.json` documenting every non-secret key with `"schemaVersion": 1`.
- **Depends on B3.**

#### C3 — Add `expiresAt` field hint in config.json for API keys
- **Files:** `docs/reference/config.json.example`, `docs/design/configuration-guide.md`.
- **Change:** Document an optional `expiresAt` (ISO8601) per provider-key entry; log a warning on agent startup if within 7 days of expiry.
- **Depends on B3.**

---

## 5. Pre-Approved Items — `local-openai` Provider

**Status:** APPROVED FOR IMPLEMENTATION in the next invocation.

### Design

**New file:** `src/agent/providers/local-openai.ts`

**Env vars read from `cfg.providerEnv`** (after B2 standard-naming lands):
- `OPENAI_BASE_URL` — primary; also `LOCAL_OPENAI_BASE_URL` as override; also `OLLAMA_HOST` as alias (maps to `http://${OLLAMA_HOST}/v1`)
- `OPENAI_API_KEY` — optional; defaults to `"not-needed"` when absent (most local servers accept any non-empty string)

**Factory sketch:**
```typescript
// src/agent/providers/local-openai.ts
import { ChatOpenAI } from '@langchain/openai';
import { ConfigurationError } from '../../config/errors';
import { UpstreamError } from '../../config/errors';
// ...

export const createLocalOpenaiModel: ProviderFactory = (cfg) => {
  const env = cfg.providerEnv;
  const baseURL =
    env['LOCAL_OPENAI_BASE_URL'] ??
    env['OPENAI_BASE_URL'] ??
    (env['OLLAMA_HOST'] ? `http://${env['OLLAMA_HOST']}/v1` : undefined);

  if (!baseURL) {
    throw new ConfigurationError('OPENAI_BASE_URL', [
      'LOCAL_OPENAI_BASE_URL', 'OPENAI_BASE_URL', 'OLLAMA_HOST',
      '~/tool-agents/outlook-cli/config.json',
    ]);
  }

  const apiKey = env['OPENAI_API_KEY'] ?? 'not-needed';

  const model = new ChatOpenAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
    configuration: { baseURL },
  });

  // Wrap connection errors to surface the attempted baseURL.
  // (Wrapping happens in the tool adapter layer, not the factory —
  //  factory is synchronous and does not probe the network.)
  return model;
};
```

**Registry change** (after B2 also renames `google` → `gemini`):
```typescript
// src/agent/providers/registry.ts — add one line:
'local-openai': createLocalOpenaiModel,
```

**`ProviderName` union change:**
```typescript
// src/config/agent-config.ts
export type ProviderName =
  | 'openai' | 'anthropic' | 'gemini' | 'azure-openai'
  | 'azure-anthropic' | 'local-openai'      // 6 canonical
  | 'azure-deepseek';                         // project-extended
```

**`PROVIDER_ENV_PREFIX` entry:**
```typescript
'local-openai': '',   // reads standard OPENAI_* names directly
```
(Or after B2: reads `LOCAL_OPENAI_BASE_URL`, `OPENAI_BASE_URL`, `OLLAMA_HOST`, `OPENAI_API_KEY`.)

**`UpstreamError` wrapping:** Connection-refused errors from the model's `.invoke()` call bubble up through `runOneShot`. The `isRecursionLimitError` check won't catch them; they'll fall to the re-throw path, which exits 1. To give a useful error, `run.ts`'s catch block should detect `ECONNREFUSED` / `ENOTFOUND` and rethrow as `UpstreamError` with `code: 'UPSTREAM_NETWORK'` and the resolved `baseURL` in the message.

**Test additions:** Unit test asserting `createLocalOpenaiModel(cfg) instanceof ChatOpenAI`, no-baseURL throws `ConfigurationError`, `OLLAMA_HOST` alias resolves correctly.

---

## 6. Risks & Rollback Notes

### B2 (env-var renaming) — highest risk

- **Existing users** who have exported `OUTLOOK_AGENT_OPENAI_API_KEY` etc. will get `ConfigurationError` after migration until they update their shell. This is a **breaking change** requiring a documented migration guide and semver bump.
- **Test suite impact:** Every `agent-provider-*.spec.ts` that seeds `process.env` with old-style keys will need updated key names. Approximately 15-25 test assertions affected across 3-4 spec files.
- **Rollback:** Revert the `PROVIDER_ENV_PREFIX` map entries and factory `ENV_*` constants. Consider a compatibility shim that reads both old and new names with a deprecation warning for one release cycle.
- **Spec doc update required:** `docs/design/spec-agent-on-tool.md` §4 + §8 currently lists the `OUTLOOK_AGENT_*` prefixed names as the normative contract. Updating the code without updating that doc will create confusion.
- **CLAUDE.md `<agent>` block** "Providers → env var prefixes" table must be rewritten.

### B3 (config folder tier) — medium risk

- **First-run side-effect:** The folder-seed step writes files to `~/tool-agents/outlook-cli/` on first agent invocation. This is new behavior and could surprise users who run in restrictive environments (CI, containers, read-only home dirs). Guard with a `try/catch` that logs a warning rather than throwing if the folder cannot be created.
- **No existing tests use `~/tool-agents/`** — no regressions expected; add tests with a `vi.stub` on `os.homedir()` to avoid writing to real home.
- **Rollback:** The folder and its files are inert if the config loader is reverted. The folder itself can remain without harm.

### B1 (local-openai addition) — low risk

- Purely additive; no existing code paths change.
- The only test that could be affected is `agent-provider-registry.spec.ts` which asserts "registry has exactly N providers" — update the count assertion.

### R1 (google → gemini rename) — medium risk

- Breaking for any user who has `OUTLOOK_AGENT_PROVIDER=google` in their `.env`. Must ship with a backwards-compat alias for at least one release.
- All `commands-agent.spec.ts` and `agent-provider-registry.spec.ts` assertions on the `google` string need updating.

### Spec doc updates required for any landing

| Action | Docs to update |
|---|---|
| B2 lands | `spec-agent-on-tool.md` §4/§8, `CLAUDE.md` `<agent>` block, `README.md`, `docs/design/configuration-guide.md`, `.env.example` |
| B3 lands | `CLAUDE.md`, `README.md`, `docs/design/configuration-guide.md`, `docs/design/project-design.md` |
| B1 lands | `CLAUDE.md` `<agent>` block, `README.md`, `.env.example` |
| R1 lands | `CLAUDE.md`, `README.md`, `.env.example`, `spec-agent-on-tool.md` |
