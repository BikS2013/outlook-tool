# Plan 003 — LangGraph ReAct Agent Subcommand

Status: Ready for designer
Stage: 4/6 (planning)
Owner: planner
Produced: 2026-04-23
Inputs consumed (in priority order):

1. `docs/design/refined-request-langgraph-agent.md` (contract)
2. `docs/reference/codebase-scan-langgraph-agent.md` (integration map)
3. `docs/design/investigation-langgraph-agent.md` (library + decisions)
4. `docs/research/azure-deepseek-tool-calling.md` (DeepSeek gating rules)
5. `docs/design/project-design.md` (current baseline)
6. `CLAUDE.md` (project conventions + no-fallback rule)

Downstream: `designer` → `project-design.md` (Agent section) → coder swarm
(Phase B…Phase H) → reviewer → test-builder verification → Phase J gate.

---

## 0. Ambiguities / Decisions Requiring User Input

**None — all decisions resolved by the investigation + deep-research documents.**

(The investigation's §2 D1..D15 locks provider classes, packages, the `createAgent`
vs `createReactAgent` choice, dotenv semantics, tool-output truncation, memory
saver, streaming posture, and test strategy. The research document resolves the
one flagged topic — Azure DeepSeek tool-calling variant gating — by supplying
an explicit allow-/denylist the factory must enforce at config-load time. No
further user input is required before implementation starts.)

---

## 1. Goals / Non-Goals

### Goals (condensed from refined spec §2)

- Add a new `agent [prompt]` subcommand to the existing commander program,
  sharing all global flags (`--session-file`, `--profile-dir`, `--tz`,
  `--json`, `--table`, `--quiet`, `--no-auto-reauth`, `--log-file`,
  `--timeout`, `--login-timeout`, `--chrome-channel`).
- Run a LangGraph.js ReAct loop built with `createAgent` from `langchain` v1
  (with `createReactAgent` from `@langchain/langgraph/prebuilt` as a fallback
  isolated to a single factory file).
- Ship eleven tools wrapping existing `src/commands/*.run()` modules:
  `auth_check`, `list_mail`, `get_mail`, `get_thread`, `list_folders`,
  `find_folder`, `list_calendar`, `get_event`, `create_folder` (mutation),
  `move_mail` (mutation), `download_attachments` (mutation).
- Plug-in LLM provider registry with six entries (`openai`, `anthropic`,
  `google`, `azure-openai`, `azure-anthropic`, `azure-deepseek`); a seventh
  provider is a single new factory file away.
- Load configuration from process env and an optional `.env` file via
  `dotenv` with strict precedence **CLI flag > process env > `.env` >
  NO FALLBACK** for mandatory values. Missing mandatory → `ConfigurationError`
  exit 3.
- Two invocation modes: one-shot (`outlook-cli agent "..."`) and interactive
  REPL (`outlook-cli agent -i`) with in-process `MemorySaver` and slash
  commands (`/exit`, `/clear`, `/tools`, `/system`, `/help`).
- Auth policy: run `auth-check` once at boot; non-`ok` + `--no-auto-reauth`
  → exit 4; otherwise the existing login flow fires once via the
  `doAuthCapture` callback already wired into `buildDeps`.
- Output envelope parity: `--json` default (envelope per FR-8), `--table`
  summary; `--verbose` dumps the transcript to stderr post-run.
- Mutation safety: `create_folder` / `move_mail` / `download_attachments`
  are gated by `--allow-mutations`. Without the flag they are **omitted
  from the tool catalog** (design decision — see §5 Risks). The system
  prompt announces the mode.
- Redaction: every log line passes through `src/util/redact.ts:redactString`;
  API keys never appear in stdout, stderr, or the `--log-file`.

### Non-Goals (lifted verbatim from refined §3)

- No fine-tuning / LoRA / training.
- No RAG / embeddings / vector DB / long-term memory beyond a single
  interactive session.
- No multi-agent orchestration (planner + executor + critic).
- No web / desktop / server UI.
- No voice / audio / image modalities.
- No streaming of tool output mid-call (final-answer token streaming is
  explicitly deferred to v2).
- No cost budgeting beyond `--max-steps`.
- No send-mail / reply / create-calendar-event tools in v1.
- No cross-invocation thread persistence (`--thread-id` flag is v2).
- No auto-learning / prompt self-improvement.
- No non-Outlook backends (Gmail, IMAP, etc.).

---

## 2. Phase Breakdown

### Phase A — Dependencies & project hygiene

- **Purpose**: Get `package.json` right, `.env` ignored, a usable `.env.example`,
  and confirm every LangChain package loads under CommonJS.
- **Depends on**: none.
- **Can run in parallel with**: nothing (all later phases assume deps installed).
- **Files to create / modify**:
  - `package.json` — add dependencies (MODIFY).
  - `package-lock.json` — auto-regenerated (MODIFY).
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/.gitignore` — add `.env`, `.env.*` rules (MODIFY or CREATE).
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/.env.example` — new, every `OUTLOOK_AGENT_*` var with empty value (CREATE).
- **Add dependencies (versions quoted EXACTLY from investigation §6 Package Manifest Delta):**
  - `langchain` `^1.0.0`
  - `@langchain/langgraph` `^1.0.0`
  - `@langchain/core` `^0.3.x`
  - `@langchain/openai` `^0.4.x`
  - `@langchain/anthropic` `^0.3.x`
  - `@langchain/google-genai` `^0.2.x`
  - `dotenv` `^17.0.0`
  - `zod` `^3.24.x`
- **`.gitignore` delta** (add if missing):
  ```
  # Agent env files (NFR-2)
  .env
  .env.*
  !.env.example
  ```
- **`.env.example` template** — one commented line per `OUTLOOK_AGENT_*` var
  (§6 matrix in the refined spec), grouped by provider with a `###` heading.
- **Acceptance criteria (binary)**:
  - `npm install` completes with no peer-dep warnings beyond pre-existing ones.
  - `node -e "require('@langchain/langgraph'); require('@langchain/core'); require('@langchain/openai'); require('@langchain/anthropic'); require('@langchain/google-genai'); require('langchain'); require('dotenv'); require('zod');"` exits 0.
  - `npx tsc --noEmit` green with the new packages present (no code consumes
    them yet, so this is just the type-only sanity check).
  - `.env` matches a `git check-ignore .env` test.
  - `.env.example` exists and is committed-safe (all values empty).
- **Verification commands**:
  - `npm install`
  - `node -e "require('@langchain/langgraph');"` (and the full chain above)
  - `npx tsc --noEmit`
  - `git check-ignore .env`
  - `cat .env.example | head -40` (sanity visual)

---

### Phase B — Agent config loader

- **Purpose**: Centralize the `OUTLOOK_AGENT_*` env-var + CLI-flag resolution,
  enforce the precedence, and keep `src/config/config.ts` untouched.
- **Depends on**: Phase A.
- **Can run in parallel with**: Phase C, Phase D, Phase E.
- **Files to create / modify**:
  - `src/config/agent-config.ts` (CREATE) — new `loadAgentConfig(opts)` entry point.
  - `src/config/errors.ts` (MODIFY only if a new error code is needed; prefer
    reusing `ConfigurationError` unchanged).
  - `test_scripts/agent-config.spec.ts` (CREATE).
- **Exports**:
  ```typescript
  export type ProviderName =
    | 'openai' | 'anthropic' | 'google'
    | 'azure-openai' | 'azure-anthropic' | 'azure-deepseek';

  export interface AgentConfig {
    providerName: ProviderName;
    model: string | null;               // some providers derive from env; null = use provider default
    temperature: number;                 // default 0
    maxSteps: number;                    // default 10, range [1..50]
    perToolBudgetBytes: number;          // default 16384
    envFilePath: string | null;          // null when flag not set
    allowMutations: boolean;             // default false
    systemPrompt: string | null;         // resolved text (inline > file > built-in)
    systemPromptFile: string | null;     // passthrough for audit/logging
    verbose: boolean;
    interactive: boolean;
    toolsAllowlist: string[] | null;     // null = full MVP set
    logFilePath: string | null;          // inherited from global --log-file
  }

  export function loadAgentConfig(opts: AgentCliFlags): AgentConfig;
  ```
- **Precedence rule** (strict): CLI flag > process env > `.env` file > NO FALLBACK
  (for mandatory settings — currently only `providerName`; `model` is mandatory
  unless the provider derives it from env, see §3 of investigation).
- **dotenv loading** is NOT done inside `loadAgentConfig`. Instead, the caller
  (the agent command wrapper in `cli.ts`) invokes a small helper
  `loadDotenv(envFilePath?: string): void` BEFORE `buildDeps` runs. This helper
  lives in `src/config/agent-config.ts` and:
  - If `envFilePath` is set: `dotenv.config({ path: envFilePath, override: false })`
    AND throw `ConfigurationError({ missingSetting: 'envFile', detail: '...' })`
    if the file does not exist (exit 3).
  - If `envFilePath` is null: `dotenv.config({ override: false })` (default
    CWD `.env` lookup, silently no-op when absent).
- **Missing-mandatory behavior**: `loadAgentConfig` throws
  `new ConfigurationError('providerName', ['cli:--provider', 'env:OUTLOOK_AGENT_PROVIDER'])`
  verbatim with the same shape as existing `loadConfig` callers.
- **Acceptance criteria**:
  - Unit test matrix:
    - No `--provider` + no `OUTLOOK_AGENT_PROVIDER` → throws `ConfigurationError`
      with `missingSetting === 'providerName'`.
    - `--provider azure-openai` overrides `OUTLOOK_AGENT_PROVIDER=openai`.
    - Process env filled from `.env` when process env absent.
    - `--env-file ./missing.env` → throws `ConfigurationError` with
      `missingSetting === 'envFile'`.
    - `--max-steps 0` / `--max-steps 51` → throws `UsageError` exit 2.
    - `--system` + `--system-file` together → `UsageError` exit 2.
    - `--system-file <unreadable>` → `ConfigurationError` exit 3
      (`missingSetting === 'systemPromptFile'`).
- **Verification commands**:
  - `npm test -- test_scripts/agent-config.spec.ts`
  - `npx tsc --noEmit`

---

### Phase C — LLM provider registry

- **Purpose**: Provide a six-entry factory registry returning LangChain
  `BaseChatModel` instances, one per provider, each enforcing its required env
  vars with `ConfigurationError` on miss.
- **Depends on**: Phase A. (Independent of Phase B — they share no files.)
- **Can run in parallel with**: Phase B, Phase D, Phase E.
- **Files to create**:
  - `src/agent/providers/openai.ts`
  - `src/agent/providers/anthropic.ts`
  - `src/agent/providers/google.ts`
  - `src/agent/providers/azure-openai.ts`
  - `src/agent/providers/azure-anthropic.ts`
  - `src/agent/providers/azure-deepseek.ts`
  - `src/agent/providers/registry.ts`
  - `test_scripts/agent-provider-registry.spec.ts`
  - `test_scripts/agent-provider-openai.spec.ts`
  - `test_scripts/agent-provider-anthropic.spec.ts`
  - `test_scripts/agent-provider-google.spec.ts`
  - `test_scripts/agent-provider-azure-openai.spec.ts`
  - `test_scripts/agent-provider-azure-anthropic.spec.ts`
  - `test_scripts/agent-provider-azure-deepseek.spec.ts`
- **Factory signature** (all six):
  ```typescript
  export type ProviderFactory = (
    env: NodeJS.ProcessEnv,
    cfg: Pick<AgentConfig, 'model' | 'temperature'>,
  ) => BaseChatModel;
  ```
- **Per-provider env-var matrix** (see investigation §3 for the exact table;
  deviations from refined §6 live in investigation §3 notes 1..3 and must be
  followed verbatim):

  | Provider | Required env | Optional env | LangChain class | npm pkg |
  |---|---|---|---|---|
  | `openai` | `OUTLOOK_AGENT_OPENAI_API_KEY` | `..._BASE_URL`, `..._ORG` | `ChatOpenAI` | `@langchain/openai` |
  | `anthropic` | `OUTLOOK_AGENT_ANTHROPIC_API_KEY` | `..._BASE_URL` | `ChatAnthropic` | `@langchain/anthropic` |
  | `google` | `OUTLOOK_AGENT_GOOGLE_API_KEY` | — | `ChatGoogleGenerativeAI` | `@langchain/google-genai` |
  | `azure-openai` | `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY`, `..._ENDPOINT`, `..._API_VERSION`, `..._DEPLOYMENT` | — | `AzureChatOpenAI` | `@langchain/openai` |
  | `azure-anthropic` | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`, `..._ENDPOINT`, `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` (or `--model`) | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` (informational — not passed) | `ChatAnthropic` with `baseUrl` | `@langchain/anthropic` |
  | `azure-deepseek` | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`, `..._ENDPOINT`, `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` (or `--model`) | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` (informational — not passed) | `ChatOpenAI` with `configuration.baseURL` | `@langchain/openai` |

- **Azure URL derivation** (investigation §3 notes 2–3):
  - Strip trailing slash and any `/models` suffix from
    `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`.
  - `azure-anthropic` → append `/anthropic`.
  - `azure-deepseek` → append `/openai/v1`.
- **`azure-deepseek` model gating** (research doc §7.2 and §7.3):
  - Allowlist patterns: `DeepSeek-V3`, `DeepSeek-V3.1`, `DeepSeek-V3.2`
    (case-insensitive).
  - Denylist patterns (reject at config load with
    `ConfigurationError({ missingSetting: 'OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL', detail: '<reason>' })`):
    - `/deepseek-v3\.2-speciale/i` — "omits tool calling by design"
    - `/deepseek-r1(?!-0528)/i` — "original R1 does not support tool calling"
    - `/deepseek-reasoner/i`
    - `/mai-ds-r1/i`
    - R1-0528 is also rejected with a message about `ChatOpenAI` parameter-injection
      incompatibility (unless a future iteration adds a `ChatOpenAI` subclass
      that strips the offending params).
  - Unknown / custom deployment names → accepted with a single
    `console.warn` (suppressed by `--quiet`) noting the pattern was not
    recognized.
- **`registry.ts` export**:
  ```typescript
  export const PROVIDERS: Record<ProviderName, ProviderFactory> = { /* ... */ };
  export function getProvider(name: ProviderName): ProviderFactory;
  ```
  `getProvider` throws `UsageError` (exit 2) with the list of valid names if
  `name` is not in the map.
- **Acceptance criteria**:
  - For every provider × every required env var: missing one → throws
    `ConfigurationError` naming that env var; all set → returns an instance
    that is `instanceof` the expected LangChain class.
  - `azure-deepseek` with model name matching each denylist pattern →
    `ConfigurationError` with the correct explanation text.
  - `azure-deepseek` with model `DeepSeek-V3.2` → factory succeeds,
    `configuration.baseURL` equals
    `https://<resource>.services.ai.azure.com/openai/v1` (the `/models` suffix
    is stripped if the user left it in).
  - `azure-anthropic` `baseUrl` ends with `/anthropic`.
  - No factory reads vars other than those declared in its row of the matrix
    (enforced by `vi.stubEnv` of only the declared ones).
- **Verification commands**:
  - `npm test -- test_scripts/agent-provider-*.spec.ts`
  - `npx tsc --noEmit`

---

### Phase D — Tool adapters (outlook commands → LangChain tools)

- **Purpose**: Wrap existing `src/commands/*.run()` functions as LangChain
  `tool(...)` objects with Zod input schemas, byte-budget truncation, and
  error handling that distinguishes retriable (→ ToolMessage error JSON) from
  fatal (→ rethrow).
- **Depends on**: Phase A (for `zod` + `@langchain/core` being installed).
- **Can run in parallel with**: Phase B, Phase C, Phase E.
- **Files to create**:
  - `src/agent/tools/auth-check-tool.ts`
  - `src/agent/tools/list-mail-tool.ts`
  - `src/agent/tools/get-mail-tool.ts`
  - `src/agent/tools/get-thread-tool.ts`
  - `src/agent/tools/list-folders-tool.ts`
  - `src/agent/tools/find-folder-tool.ts`
  - `src/agent/tools/list-calendar-tool.ts`
  - `src/agent/tools/get-event-tool.ts`
  - `src/agent/tools/create-folder-tool.ts`   **(mutation, gated)**
  - `src/agent/tools/move-mail-tool.ts`       **(mutation, gated)**
  - `src/agent/tools/download-attachments-tool.ts` **(mutation, gated)**
  - `src/agent/tools/registry.ts`
  - `src/agent/tools/truncate.ts`              (shared byte-budget helper)
  - `test_scripts/agent-tools.spec.ts`
  - `test_scripts/agent-tool-truncate.spec.ts`
- **Adapter shape**:
  ```typescript
  export function makeListMailTool(deps: AgentDeps, cfg: AgentConfig) {
    return tool(
      async (input: z.infer<typeof schema>) => { /* call commands/list-mail.run(...) */ },
      {
        name: 'list_mail',
        description: '…<=240 chars…',
        schema,
      },
    );
  }
  ```
- **Zod schemas** — taken verbatim from refined §8.1..§8.11. Keys in camelCase
  (JavaScript convention); the adapter maps camelCase to the snake/Pascal
  expected by `commands/*` option types.
- **Error handling contract** (per adapter):
  - Recoverable, surfaced to the model as a JSON string result:
    `UsageError` with code `FOLDER_*`, `UpstreamError`, `AuthError` with
    `reason: 'AFTER_RETRY'` only when `--no-auto-reauth` is NOT set (auto-reauth
    transparently happened but failed).
  - Rethrow (fatal, graph aborts via `makeAction` catch):
    `ConfigurationError`, `AuthError` with `reason: 'NO_AUTO_REAUTH'` when
    `--no-auto-reauth` IS set, `IoError` (unless the tool is
    `download_attachments` — see below).
  - `download_attachments` IO errors are surfaced to the model as ToolMessage
    errors (the model may suggest a different `outDir`), consistent with
    refined §8.11 error taxonomy. Path-traversal and permission errors remain
    fatal per the existing command behavior.
- **Truncation helper** (`src/agent/tools/truncate.ts`):
  ```typescript
  export function truncateToolResult(result: unknown, budgetBytes: number): string;
  ```
  - Serializes to JSON; if under budget → return as-is.
  - If array → trim from tail, append `{ _truncated: true, _originalCount: N }`.
  - If object with large string fields (`Body.Content`, `BodyPreview`) → truncate
    the string with `… [truncated N chars]`.
  - Never truncates `Id`, `ConversationId`, `ParentFolderId`, `newId`, `sourceId`.
  - Final fallback: hard-truncate JSON string and close braces (marked
    `_truncated: true`).
- **Mutation gate** (investigation D4, this plan's design decision):
  - When `cfg.allowMutations === false`, `buildToolCatalog` does NOT include
    `create_folder`, `move_mail`, or `download_attachments` in the returned
    array. The system prompt (see Phase F) tells the LLM these tools are
    disabled, which the model sees as "no such tool" — simpler than runtime
    refusal and eliminates prompt-injection risk of a malicious context
    trying to invoke a disabled mutator.
  - **Note**: this is a stricter stance than the investigation's D4 (which
    returned a `MUTATIONS_DISABLED` ToolMessage); the plan chooses omission
    because (a) it is safer, (b) it mirrors refined-request §NFR-8's
    "closed-set tool registry" principle, and (c) it reduces LLM step waste.
    The decision is documented in §5 Risks.
- **`src/agent/tools/registry.ts`**:
  ```typescript
  export function buildToolCatalog(deps: AgentDeps, cfg: AgentConfig): StructuredTool[];
  ```
  Applies `cfg.toolsAllowlist` after applying the mutation gate.
- **Acceptance criteria**:
  - Each adapter: happy path (stub `OutlookClient` returns a realistic payload
    → adapter returns serialized JSON matching the shape from the codebase
    scan §5).
  - Each adapter: result > 16 KB → `_truncated: true` appears and Id fields
    are preserved.
  - Each adapter: command throws `UpstreamError{UPSTREAM_FOLDER_NOT_FOUND}` →
    adapter returns JSON `{ error: { code, message } }` (model-visible) without
    rethrowing.
  - `ConfigurationError` thrown by a command → adapter rethrows (fatal).
  - Mutation tools: `cfg.allowMutations === false` → absent from catalog.
  - Mutation tools: `cfg.allowMutations === true` → present and callable.
  - `cfg.toolsAllowlist = ['list_mail', 'get_mail']` → only those two tools
    in the catalog.
- **Verification commands**:
  - `npm test -- test_scripts/agent-tools.spec.ts test_scripts/agent-tool-truncate.spec.ts`
  - `npx tsc --noEmit`

---

### Phase E — Redaction & logging sink

- **Purpose**: Single logger for the agent that writes to stderr and/or
  `--log-file`, every line passing through `redactString`, respecting `--quiet`.
- **Depends on**: Phase A.
- **Can run in parallel with**: Phase B, Phase C, Phase D.
- **Files to create**:
  - `src/agent/logging.ts`
  - `test_scripts/agent-redact.spec.ts`
- **Exports**:
  ```typescript
  export interface AgentLogger {
    info(line: string, meta?: Record<string, unknown>): void;
    warn(line: string, meta?: Record<string, unknown>): void;
    error(line: string, meta?: Record<string, unknown>): void;
    debug(line: string, meta?: Record<string, unknown>): void;   // DEBUG only when --verbose or --log-file set
    close(): Promise<void>;
  }
  export function createAgentLogger(cfg: AgentConfig): AgentLogger;
  ```
- **Behavior**:
  - Every line is passed through `redactString` from `src/util/redact.ts` AND,
    when `meta` is given, all string values in `meta` are passed through
    `redactString` recursively.
  - `--quiet` suppresses stderr writes but NOT `--log-file` writes.
  - `--log-file` writes JSON-lines (one JSON object per line); the file is
    opened with mode `0600` on first write (use `fs.promises.open` with mode
    `0o600`, flag `a`). An IO error raising a Node `EACCES` / `ENOENT` →
    `IoError` → fatal (exit 6).
  - Each record carries a `runId` (crypto.randomUUID() generated once at
    logger construction) and a `ts` ISO timestamp.
- **Acceptance criteria**:
  - Log line containing `sk-abc…` (plausible OpenAI key shape) appears
    redacted.
  - JWT-shaped string (100+ base64-URL chars) → replaced with `<redacted>`.
  - Bearer token string → redacted (covered by `redactString` rule set).
  - `--quiet` → no stderr output; `--log-file` still receives records.
  - `--log-file /some/unwritable/dir/agent.log` → throws `IoError`
    (exit 6).
- **Verification commands**:
  - `npm test -- test_scripts/agent-redact.spec.ts`
  - `npx tsc --noEmit`

---

### Phase F — ReAct agent core

- **Purpose**: Build the LangGraph graph (with `createAgent` from `langchain`
  v1 as the primary path), invoke it, surface the `AgentResult` envelope.
- **Depends on**: Phase C (providers) + Phase D (tools) + Phase E (logger).
  Phase B is a caller-side concern but the core module type-imports
  `AgentConfig`.
- **Can run in parallel with**: nothing inside this plan (it is the join
  point for C + D + E).
- **Files to create**:
  - `src/agent/graph.ts`       (graph construction; the ONLY file that imports
                                 `createAgent` from `langchain` — risk
                                 isolation per investigation Risk 2).
  - `src/agent/run.ts`         (one-shot + interactive runners).
  - `src/agent/result.ts`      (TypeScript types for `AgentResult`,
                                 `AgentStep`, `AgentUsage`).
  - `src/agent/system-prompt.ts` (default system prompt + `{mutationsEnabled}`
                                 template substitution — text taken from
                                 investigation §5).
  - `test_scripts/agent-graph.spec.ts`
  - `test_scripts/agent-run-oneshot.spec.ts`
  - `test_scripts/agent-run-interactive.spec.ts`
- **`graph.ts` API**:
  ```typescript
  export interface BuildGraphOpts {
    model: BaseChatModel;
    tools: StructuredTool[];
    systemPrompt: string;
    checkpointer?: MemorySaver;
  }
  export function createAgentGraph(opts: BuildGraphOpts): Runnable;
  ```
  - Implementation: prefer
    ```typescript
    import { createAgent } from 'langchain';
    return createAgent({ model, tools, systemPrompt, checkpointer });
    ```
  - Fallback path (comment in file): if `createAgent` import fails at runtime,
    swap to
    ```typescript
    import { createReactAgent } from '@langchain/langgraph/prebuilt';
    return createReactAgent({ llm: model, tools, stateModifier: systemPrompt, checkpointSaver: checkpointer });
    ```
    The plan picks `createAgent` per investigation D1. If Phase J's smoke test
    fails on `createAgent`, swap by editing only `graph.ts`.
- **`run.ts` API**:
  ```typescript
  export interface RunResult {
    result: AgentResult;
  }
  export async function runOneShot(deps: AgentDeps, cfg: AgentConfig, prompt: string): Promise<AgentResult>;
  export async function runInteractive(deps: AgentDeps, cfg: AgentConfig): Promise<void>;
  ```
- **One-shot flow** (`runOneShot`):
  1. Build model via `getProvider(cfg.providerName)(process.env, cfg)`.
  2. Build tool catalog via `buildToolCatalog(deps, cfg)`.
  3. Render system prompt (inject `{mutationsEnabled}` block).
  4. Build graph via `createAgentGraph(...)` (no checkpointer for one-shot).
  5. Invoke with
     `{ messages: [new HumanMessage(prompt)] }` and
     `{ configurable: { thread_id: runId }, recursionLimit: cfg.maxSteps }`.
  6. Collect step-by-step tool calls by reading the final state's `messages`
     array — each `ToolMessage` corresponds to a completed tool call; each
     `AIMessage` with `tool_calls` preceded it. Stitch them into
     `AgentResult.steps[]`.
  7. Accumulate `usage` from each `AIMessage.usage_metadata` if present;
     else `null`.
  8. Detect `truncated` by comparing step count to `cfg.maxSteps`.
  9. Return `AgentResult` shaped exactly per refined §FR-8.
- **Interactive flow** (`runInteractive`):
  - Create a `MemorySaver`, a stable `thread_id = crypto.randomUUID()`.
  - `readline.createInterface({ prompt: 'outlook-agent> ' })`.
  - Slash commands handled locally (never sent to the LLM):
    `/exit`, `/quit` → exit 0.
    `/clear` → drop checkpointer state (new `MemorySaver` + new `thread_id`).
    `/tools` → print `tool.name + tool.description` lines.
    `/system <text>` → replace system prompt for subsequent turns
                       (rebuild graph on next turn).
    `/help` → print command list.
  - Each user input → one graph invoke (same `thread_id`, same checkpointer).
    Output the final answer as a paragraph, not the full JSON envelope.
  - Ctrl-C at prompt → exit 130. Ctrl-C during run → cancel via `AbortSignal`,
    keep REPL alive.
- **`AgentResult` envelope shape** (exact match to refined §FR-8):
  ```typescript
  export interface AgentResult {
    provider: ProviderName;
    model: string | null;
    prompt: string;                      // truncated at 512 chars
    finalAnswer: string | null;          // null on fatal error (never reached here)
    steps: AgentStep[];
    usage: AgentUsage | null;
    truncated: boolean;
    durationMs: number;
    runId: string;
  }
  export interface AgentStep {
    index: number;
    tool: string;
    input: unknown;                      // redacted
    output: unknown;                     // redacted
    error: { code: string; message: string } | null;
    durationMs: number;
  }
  export interface AgentUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }
  ```
- **Acceptance criteria**:
  - `agent-graph.spec.ts`: `createAgentGraph({ model: FakeListChatModel, tools: [], systemPrompt: '…' })`
    returns an invokable runnable (smoke only).
  - `agent-run-oneshot.spec.ts`: scripted `FakeMessagesListChatModel` returns
    step 1 = `AIMessage{ tool_calls: [{ name: 'list_mail', args: { top: 3 } }] }`,
    step 2 = `AIMessage{ content: 'Here are three…' }`. Assert
    `result.steps.length === 1`, `result.steps[0].tool === 'list_mail'`,
    `result.finalAnswer` non-empty, `result.truncated === false`.
  - `agent-run-interactive.spec.ts`: two turns; turn 2 references "the email
    from turn 1" and the transcript carries both turns' messages.
  - `--max-steps 1` with a scripted two-tool-call model → `truncated === true`,
    exit 0.
- **Verification commands**:
  - `npm test -- test_scripts/agent-graph.spec.ts test_scripts/agent-run-*.spec.ts`
  - `npx tsc --noEmit`

---

### Phase G — `agent` command module

- **Purpose**: A single entry point `src/commands/agent.ts` that the CLI
  binds to, mirroring the structural contract of every other command module.
- **Depends on**: Phase B, Phase C, Phase D, Phase E, Phase F.
- **Can run in parallel with**: nothing.
- **Files to create**:
  - `src/commands/agent.ts`
  - `test_scripts/commands-agent.spec.ts`
- **Exports**:
  ```typescript
  import type { CommandDeps } from '../cli';
  export interface AgentDeps extends CommandDeps {}
  export interface AgentOptions extends AgentCliFlags { /* commander-produced */ }
  export type { AgentResult } from '../agent/result';

  export async function run(
    deps: AgentDeps,
    prompt: string | null,
    opts: AgentOptions,
  ): Promise<AgentResult | void>;   // void only for --interactive mode
  ```
- **`run` flow**:
  1. Call `loadDotenv(opts.envFile ?? null)` from `src/config/agent-config.ts`.
     (Must happen BEFORE any `process.env.OUTLOOK_AGENT_*` reads. Placing it
     here — inside the command — keeps `cli.ts` thin and makes the order
     testable with `vi.mock('dotenv')`.)
  2. `const cfg = loadAgentConfig(opts);`
  3. Auth-check at boot:
     - `await authCheck.run(deps)` → if `status !== 'ok'`:
       - `opts.noAutoReauth` (inherited via `deps.config`) → throw `AuthError`
         (exit 4).
       - Else → `await deps.doAuthCapture()` (which runs the existing
         `captureOutlookSession` with the lock). Re-run `authCheck.run(deps)`;
         second non-`ok` → throw `AuthError` exit 4.
  4. `if (opts.interactive) return runInteractive(deps, cfg);`
  5. `return runOneShot(deps, cfg, prompt!);`
- **Validation inside `run`**:
  - `prompt === null && !opts.interactive` → `UsageError` exit 2
    (`"Provide a prompt or use --interactive"`).
  - `prompt !== null && opts.interactive` → `UsageError` exit 2.
- **Acceptance criteria**:
  - `commands-agent.spec.ts`:
    - Full one-shot end-to-end with
      - `FakeMessagesListChatModel` (one tool call + final answer),
      - mocked `OutlookClient` returning a realistic `MessageSummary[]`,
      - `loadAgentConfig` seeded via `vi.stubEnv`.
      Assertions: `auth-check` was called exactly once; `list_mail` adapter
      was invoked once; envelope matches FR-8 shape.
    - Missing `OUTLOOK_AGENT_OPENAI_API_KEY` with `--provider openai` →
      promise rejects with `ConfigurationError` (exit 3 upstream).
    - `--no-auto-reauth` + `auth-check.status === 'expired'` → promise rejects
      with `AuthError` (exit 4 upstream).
    - `prompt === null && !interactive` → `UsageError` exit 2.
    - `--allow-mutations` included in catalog with mutation tools; without it,
      catalog has the 8 read-only tools only.
- **Verification commands**:
  - `npm test -- test_scripts/commands-agent.spec.ts`
  - `npx tsc --noEmit`

---

### Phase H — CLI wiring

- **Purpose**: Register the `agent` command on the commander program and hand
  off to `src/commands/agent.ts`. Must NOT disturb any other subcommand.
- **Depends on**: Phase G.
- **Can run in parallel with**: Phase I.
- **Files to modify**:
  - `src/cli.ts` (MODIFY — add import, add column spec, add
    `.command('agent')` registration in the same style as every other
    subcommand).
- **Edits to `src/cli.ts`**:
  - Add import near the other command imports (around line 48–60):
    ```typescript
    import * as agentCmd from './commands/agent';
    import type { AgentResult, AgentOptions } from './commands/agent';
    ```
  - Add `AGENT_TABLE_COLUMNS` near the existing column-spec section (around
    line 213–357). Two renderings:
    - Top-level: `Step | Tool | Status | DurationMs` — 4 columns for
      `result.steps[]`.
    - Final answer printed as a header above the table.
  - Register the command around `src/cli.ts:947` (after the last existing
    subcommand):
    ```typescript
    program
      .command('agent [prompt]')
      .description('Run a LangGraph ReAct agent over your Outlook mailbox')
      .option('-i, --interactive', 'REPL mode', false)
      .option('-p, --provider <name>', 'LLM provider (openai|anthropic|google|azure-openai|azure-anthropic|azure-deepseek)')
      .option('-m, --model <id>', 'LLM model / deployment id')
      .option('--temperature <f>', 'Sampling temperature (default 0)', parseFloatOrExit)
      .option('--max-steps <n>', 'Max ReAct iterations (1..50, default 10)', parseIntOrExit)
      .option('--system <text>', 'Inline system prompt override')
      .option('--system-file <path>', 'System prompt file')
      .option('--tools <csv>', 'Whitelist subset of tool names')
      .option('--env-file <path>', 'Dotenv file to load')
      .option('--allow-mutations', 'Enable create_folder / move_mail / download_attachments', false)
      .option('--per-tool-budget <bytes>', 'Per-tool result byte budget (default 16384)', parseIntOrExit)
      .option('--verbose', 'Print transcript to stderr', false)
      .option('--no-thread', '(v1 no-op, reserved for v2 cross-invocation threads)')
      .action(
        makeAction<AgentOptions, [string | undefined]>(program, async (deps, _g, cmdOpts, prompt) => {
          const result = await agentCmd.run(deps, prompt ?? null, cmdOpts);
          if (result === undefined) return; // interactive mode
          emitResult(result, resolveOutputMode(_g), AGENT_TABLE_COLUMNS);
        }),
      );
    ```
  - **Do NOT** call `dotenv.config()` inside `cli.ts` or `makeAction` — that
    lives in `commands/agent.ts` per the isolation rule in Phase G step 1.
- **Acceptance criteria**:
  - `node dist/cli.js agent --help` prints the command surface with every
    option above.
  - `node dist/cli.js --help` still prints every existing subcommand plus
    `agent`.
  - `node dist/cli.js agent` (no prompt, no `-i`) exits 2 with a usage error.
  - No existing spec in `test_scripts/` breaks (`npm test -- --run` green).
- **Verification commands**:
  - `npm run build`
  - `node dist/cli.js agent --help`
  - `node dist/cli.js --help`
  - `node dist/cli.js agent` (expect exit 2)
  - `npm test -- --run`

---

### Phase I — Docs & tool block

- **Purpose**: Update every documentation surface the project's conventions
  demand.
- **Depends on**: Phase G (the contract must be stable). Can run in
  parallel with Phase H.
- **Files to modify**:
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/CLAUDE.md` — add `<agent>` block in the Tools section after the `<outlook-cli>` block.
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md` — (NOT touched by planner — the designer phase owns this; the plan merely notes the required addition).
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-functions.MD` — append "Agent Subcommand (FR-AGT-1..FR-AGT-13)" section (the planner MUST do this per the "ALSO DO" step; see end of plan).
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/configuration-guide.md` — add every `OUTLOOK_AGENT_*` env var.
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/README.md` — add "Agent mode" section with 3 worked examples (OpenAI one-shot, Azure OpenAI interactive, Azure DeepSeek).
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/Issues - Pending Items.md` — add any deferred items (e.g., "R1-0528 ChatOpenAI subclass workaround" if deferred to v2).
- **`<agent>` CLAUDE.md block** — mirror the `<outlook-cli>` structure:
  objective, command, info. Info must enumerate every flag, the env var table
  per provider, exit codes, and three example invocations.
- **Configuration-guide deltas**:
  - One sub-section per provider (§6.2..§6.7 of refined request), with
    columns: purpose / required? / default / CLI flag / obtain-from.
  - One sub-section for provider-agnostic vars (§6.1).
  - Note that expiring credentials (`OUTLOOK_AGENT_OPENAI_API_KEY`,
    `OUTLOOK_AGENT_ANTHROPIC_API_KEY`, `OUTLOOK_AGENT_GOOGLE_API_KEY`, Azure
    keys) SHOULD carry an expiration date — propose
    `OUTLOOK_AGENT_<provider>_KEY_EXPIRES_AT` (ISO date) as an optional
    companion variable (per CLAUDE.md §configuration-guide rule on expiring
    credentials). Mark "v1: advisory only — no active warning yet".
- **Acceptance criteria**:
  - `CLAUDE.md` contains the `<agent>` block and parses (rendering is a no-op
    since it's raw XML-ish text, but a visual review catches missing fields).
  - `docs/design/configuration-guide.md` enumerates all 15+ new env vars.
  - `README.md` has a section titled "Agent mode" with three runnable
    examples.
  - `docs/design/project-functions.MD` has 13 FR-AGT-N bullets after the
    planner's "ALSO DO" step.
- **Verification commands**:
  - `grep -c '<agent>' CLAUDE.md` == 2 (open + close tag).
  - `grep -c 'FR-AGT-' docs/design/project-functions.MD` >= 13.

---

### Phase J — Integration verification (final gate)

- **Purpose**: Prove the whole feature works end-to-end under unit-test
  conditions and matches every AC.
- **Depends on**: Phase H + Phase I.
- **Can run in parallel with**: nothing.
- **Actions** (in order):
  1. `npx tsc --noEmit` — green.
  2. `npm test -- --run` — green.
  3. `npm run build` — green.
  4. `node dist/cli.js agent --help` — shows every option.
  5. `node dist/cli.js agent` — exits 2 (no prompt, no `-i`).
  6. Scripted acceptance run (`test_scripts/agent-acceptance.spec.ts`) exercising
     AC-1..AC-11 with `FakeMessagesListChatModel`. No live network.
  7. `.env.example` present; `git check-ignore .env` confirms ignored.
  8. `Issues - Pending Items.md` has no UNRESOLVED agent-related pending
     items (deferred items are allowed only when explicitly called out).
- **Acceptance criteria**: all of §10 Definition of Done boxes tickable.
- **Verification commands**: as above.

---

## 3. Parallelization Map

| Phase | After | Before | Can run in parallel with |
|---|---|---|---|
| A | — | all | — |
| B | A | F, G | C, D, E |
| C | A | F, G | B, D, E |
| D | A | F, G | B, C, E |
| E | A | F, G | B, C, D |
| F | A, C, D, E | G | — |
| G | B, C, D, E, F | H | — |
| H | G | J | I |
| I | G | J | H |
| J | H, I | — | — |

Four coder agents can work concurrently on B, C, D, E once A lands.
F synchronizes them. G is a serial handoff. H and I again fan out.

---

## 4. File Inventory

Single source of truth. Coders MUST NOT touch files outside this table without
amending the plan.

| Path | Status | Phase | Purpose |
|---|---|---|---|
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/package.json` | modified | A | Add runtime deps (langchain, langgraph, core, openai, anthropic, google-genai, dotenv, zod). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/package-lock.json` | modified | A | Regenerated by npm install. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/.gitignore` | modified | A | Add `.env` and `.env.*` except `.env.example`. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/.env.example` | created | A | Commented template of every `OUTLOOK_AGENT_*` var. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/config/agent-config.ts` | created | B | `AgentConfig` + `loadAgentConfig` + `loadDotenv`. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/openai.ts` | created | C | `createOpenAiModel` factory. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/anthropic.ts` | created | C | `createAnthropicModel` factory. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/google.ts` | created | C | `createGoogleModel` factory. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/azure-openai.ts` | created | C | `createAzureOpenAiModel` factory. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/azure-anthropic.ts` | created | C | `createAzureAnthropicModel` factory (Foundry `/anthropic` base URL). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/azure-deepseek.ts` | created | C | `createAzureDeepSeekModel` factory with denylist gating. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/providers/registry.ts` | created | C | `PROVIDERS` map + `getProvider()`. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/auth-check-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/list-mail-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/get-mail-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/get-thread-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/list-folders-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/find-folder-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/list-calendar-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/get-event-tool.ts` | created | D | Tool adapter (read-only). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/create-folder-tool.ts` | created | D | Tool adapter (mutation — gated by `--allow-mutations`). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/move-mail-tool.ts` | created | D | Tool adapter (mutation — gated). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/download-attachments-tool.ts` | created | D | Tool adapter (mutation — gated). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/truncate.ts` | created | D | Byte-budget truncation helper. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/tools/registry.ts` | created | D | `buildToolCatalog`. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/logging.ts` | created | E | `createAgentLogger` with redaction + quiet + log-file. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/graph.ts` | created | F | `createAgentGraph` — only file importing `createAgent`. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/run.ts` | created | F | `runOneShot`, `runInteractive`. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/result.ts` | created | F | `AgentResult`, `AgentStep`, `AgentUsage` types. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/agent/system-prompt.ts` | created | F | Default system prompt + mutation-mode substitution. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/commands/agent.ts` | created | G | Command entry point (auth-check + dispatch). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/cli.ts` | modified | H | Register `agent` subcommand + column spec. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/CLAUDE.md` | modified | I | Add `<agent>` tool block. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md` | modified | I (designer phase) | Add "Agent Subcommand (Plan 003)" section. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-functions.MD` | modified | planner (this turn) | FR-AGT-1..FR-AGT-13 block. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/configuration-guide.md` | modified | I | Every `OUTLOOK_AGENT_*` var documented. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/README.md` | modified | I | "Agent mode" section + three examples. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/Issues - Pending Items.md` | modified | I | Record deferred items (R1-0528 workaround, streaming, send-mail tools). |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-config.spec.ts` | created | B | Config loader + dotenv precedence. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-registry.spec.ts` | created | C | `getProvider` valid + invalid names. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-openai.spec.ts` | created | C | Missing-env-var matrix + happy path. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-anthropic.spec.ts` | created | C | Same. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-google.spec.ts` | created | C | Same. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-azure-openai.spec.ts` | created | C | Same. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-azure-anthropic.spec.ts` | created | C | Same + base-URL derivation. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-provider-azure-deepseek.spec.ts` | created | C | Same + denylist enforcement. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-tools.spec.ts` | created | D | Per-tool happy path + error surfacing + mutation gate. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-tool-truncate.spec.ts` | created | D | Byte-budget truncation cases. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-redact.spec.ts` | created | E | Redaction filter test. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-graph.spec.ts` | created | F | Graph build smoke. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-run-oneshot.spec.ts` | created | F | One-shot ReAct loop with FakeMessagesListChatModel. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-run-interactive.spec.ts` | created | F | Two-turn interactive memory test. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/commands-agent.spec.ts` | created | G | End-to-end with mocked client + model. |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/test_scripts/agent-acceptance.spec.ts` | created | J | AC-1..AC-11 explicit mapping test. |

---

## 5. Risks & Mitigations

- **CJS/ESM interop risk (HIGH per investigation §7 Risk 1)** — Mitigation:
  Phase A's smoke test (`node -e "require('@langchain/langgraph');"` for every
  new package). If `ERR_REQUIRE_ESM` appears, stop and escalate — the
  fallback is dynamic `import()` inside `src/agent/graph.ts` and
  `src/agent/providers/*.ts` (smaller change than a full CJS→ESM migration).
- **TypeScript 6.x compatibility (LOW per investigation Risk 5)** —
  Mitigation: `skipLibCheck: true` already set. Run `tsc --noEmit` after
  Phase A and again at Phase J.
- **LangGraph v1 `createAgent` vs. `createReactAgent` (MEDIUM per
  investigation Risk 2)** — Mitigation: the ONLY file importing `createAgent`
  is `src/agent/graph.ts`. Swap to `createReactAgent` by editing that single
  file. Ship a commented-out fallback block so the swap takes < 5 minutes.
- **Azure DeepSeek model-variant gating (MEDIUM per research §4)** —
  Mitigation: enforce the denylist regexes from research §7.2 at config-load
  time inside `src/agent/providers/azure-deepseek.ts`; surface a
  `ConfigurationError` exit 3 with a message that names the model and
  advises a V3.x replacement. Document every denied variant in
  `docs/design/configuration-guide.md`.
- **Tool-call safety for mutation tools (MEDIUM — prompt-injection attack
  surface)** — Mitigation: when `--allow-mutations` is absent, mutation
  tools are **omitted from the tool catalog** (not merely refused at runtime),
  following NFR-8's "closed-set tool registry" principle. The system prompt
  announces the mode. This is a stricter stance than investigation D4 and
  is documented as the plan's deliberate choice. `create_folder`'s agent
  default of `idempotent: true` is passed explicitly (per codebase scan §12
  note on idempotency default divergence).
- **Azure Anthropic base-URL normalization (MEDIUM per investigation Risk 4)**
  — Mitigation: unit test the URL-stripping logic
  (`'https://X.services.ai.azure.com/models/' → 'https://X.services.ai.azure.com/anthropic'`),
  with four input variants (no suffix, `/`, `/models`, `/models/`).
- **`FakeMessagesListChatModel` tool-call format drift (LOW per investigation
  Risk 6)** — Mitigation: verify the exact `AIMessage.tool_calls` shape
  against the installed `@langchain/core` version before Phase F; add a
  tiny compile-check that imports `AIMessage` and constructs a test
  instance.
- **dotenv order-of-operations (MEDIUM)** — Mitigation: `loadDotenv` is
  invoked INSIDE `commands/agent.ts:run()`, not inside `makeAction`, so
  other subcommands are unaffected. The unit test in
  `test_scripts/agent-config.spec.ts` mocks `dotenv` and asserts the call
  order.
- **Interactive REPL + Ctrl-C cancellation** — Mitigation: the
  `runInteractive` function installs a `SIGINT` handler scoped to the
  running `invoke()`; on signal it aborts the in-flight graph via an
  `AbortController.signal` passed through `config.signal`. An idle-prompt
  SIGINT exits 130 cleanly.

---

## 6. Acceptance Criteria Mapping

From refined §10 (AC-1..AC-11):

| AC | Delivered by | Verified by |
|---|---|---|
| AC-1 — one-shot `openai` list_mail top-3 returns JSON envelope | Phase F, G, H | `test_scripts/commands-agent.spec.ts::it('runs a one-shot with one tool call')` + manual `node dist/cli.js agent "list 3 emails" --provider openai` (requires live key — out of CI). |
| AC-2 — swap `openai` for `azure-openai` works with no code change | Phase C | `test_scripts/agent-provider-azure-openai.spec.ts::it('builds AzureChatOpenAI with all env set')` + the shared provider-registry test. |
| AC-3 — missing required env var → exit 3 `CONFIG_MISSING` | Phase B, C | `test_scripts/agent-provider-openai.spec.ts::it('throws ConfigurationError when OUTLOOK_AGENT_OPENAI_API_KEY missing')`. |
| AC-4 — `.env` + process env precedence | Phase B | `test_scripts/agent-config.spec.ts::it('prefers process env over .env')` and `it('falls back to .env when process env missing')`. |
| AC-5 — interactive two-turn memory | Phase F | `test_scripts/agent-run-interactive.spec.ts::it('carries state across turns')`. |
| AC-6 — unknown tool name → schema/registry rejection, not execution | Phase D, F | `test_scripts/commands-agent.spec.ts::it('LLM hallucinated tool name surfaces as ToolMessage error')`. |
| AC-7 — vitest run green covering (a)..(e) | Phase J | Full `npm test -- --run` sweep. |
| AC-8 — tsc green + CLAUDE.md has `<agent>` block | Phase H, I, J | `npx tsc --noEmit` + `grep '<agent>' CLAUDE.md`. |
| AC-9 — `--max-steps 2` on 3-tool prompt → `truncated: true`, exit 0 | Phase F | `test_scripts/agent-run-oneshot.spec.ts::it('sets truncated=true when maxSteps hit')`. |
| AC-10 — `--no-auto-reauth` + expired session → exit 4 | Phase G | `test_scripts/commands-agent.spec.ts::it('exits 4 on expired session with --no-auto-reauth')`. |
| AC-11 — API keys absent from json/verbose/log-file | Phase E | `test_scripts/agent-redact.spec.ts` — regex sweep of captured output. |

Additional ACs derived from the plan:

| AC (plan-local) | Delivered by | Verified by |
|---|---|---|
| AC-P1 — Azure DeepSeek denylist model → exit 3 | Phase C | `test_scripts/agent-provider-azure-deepseek.spec.ts::it('rejects DeepSeek-V3.2-Speciale')`. |
| AC-P2 — `--allow-mutations` excluded → mutation tools absent from catalog | Phase D | `test_scripts/agent-tools.spec.ts::it('omits mutation tools without --allow-mutations')`. |
| AC-P3 — tool result > 16 KB → `_truncated: true`, Id preserved | Phase D | `test_scripts/agent-tool-truncate.spec.ts`. |

---

## 7. Testing Strategy (Test Budget)

Total new specs: **15** under `test_scripts/`. Zero hit the network.
Every provider factory is tested with `vi.mock` of the provider npm package so
no real LangChain model constructor runs.

### Spec files and focus

| Spec file | Focus | Key stubs |
|---|---|---|
| `agent-config.spec.ts` | Precedence, missing-env, env-file-not-found, `--system`/`--system-file` exclusion, `--max-steps` range | `vi.mock('dotenv')`, `vi.stubEnv` |
| `agent-provider-registry.spec.ts` | `getProvider` valid + invalid names | — |
| `agent-provider-openai.spec.ts` | Each required env missing + happy path | `vi.mock('@langchain/openai')` |
| `agent-provider-anthropic.spec.ts` | Same | `vi.mock('@langchain/anthropic')` |
| `agent-provider-google.spec.ts` | Same | `vi.mock('@langchain/google-genai')` |
| `agent-provider-azure-openai.spec.ts` | Same + endpoint URL passed | `vi.mock('@langchain/openai')` |
| `agent-provider-azure-anthropic.spec.ts` | Same + `/models` stripping + `/anthropic` suffix | `vi.mock('@langchain/anthropic')` |
| `agent-provider-azure-deepseek.spec.ts` | Same + denylist regexes + `/openai/v1` suffix | `vi.mock('@langchain/openai')` |
| `agent-tools.spec.ts` | Per-tool happy + error-surfacing + mutation gate | `makeStubClient()` per existing pattern |
| `agent-tool-truncate.spec.ts` | Byte-budget, array trim, Id preservation, fallback | — |
| `agent-redact.spec.ts` | API keys, bearer tokens, quiet mode, log-file writes | `vi.mock('fs')` for log-file |
| `agent-graph.spec.ts` | `createAgentGraph` smoke (returns a runnable) | `FakeListChatModel` |
| `agent-run-oneshot.spec.ts` | Scripted ReAct loop one-shot + truncated | `FakeMessagesListChatModel` + `makeStubClient` |
| `agent-run-interactive.spec.ts` | Two-turn memory via `MemorySaver` | Same |
| `commands-agent.spec.ts` | End-to-end: auth-check + config load + run | Same |
| `agent-acceptance.spec.ts` | AC-1..AC-11 mapping | Composite — reuses above helpers |

### vitest hygiene

- All mocks hoisted with `vi.mock` at the top of each spec.
- `beforeEach` snapshots `process.env` via `vi.stubEnv`; `afterEach` unstubs.
- Every provider factory spec uses `vi.clearAllMocks()` in `beforeEach` to
  prevent state leaks.
- `FakeMessagesListChatModel` is imported from `@langchain/core/utils/testing`;
  if that entry-point proves unavailable at Phase C-start, a local double
  `class ScriptedChatModel extends BaseChatModel` is added under
  `test_scripts/_helpers/scripted-chat-model.ts`.

---

## 8. Rollback Plan

- All new source code lives under `src/agent/` + `src/commands/agent.ts` +
  `src/config/agent-config.ts`. Reverting the feature is a matter of:
  1. Revert `src/cli.ts` to the pre-Phase-H snapshot (single registration
     block + the agent column spec + the agent import).
  2. Delete `src/agent/`, `src/commands/agent.ts`, `src/config/agent-config.ts`.
  3. Revert `package.json` + `package-lock.json`.
  4. Revert `.gitignore`, delete `.env.example`.
  5. Revert doc files (`CLAUDE.md`, `README.md`, `configuration-guide.md`,
     `project-functions.MD`, `project-design.md`).
- No changes to `src/config/config.ts`, `src/http/*`, `src/commands/*` (the
  existing commands). The existing commands' behavior is preserved verbatim
  and every existing spec continues to pass. Rollback therefore cannot leave
  a corrupted core CLI.

---

## 9. Out-of-Repo References

(Trimmed from the investigation's §9 list to what coders will actually open.)

- **LangGraph.js quickstart** — https://docs.langchain.com/oss/javascript/langgraph/quickstart
- **LangGraph v1 release notes** — https://docs.langchain.com/oss/javascript/releases/langgraph-v1
- **LangChain v1 `createAgent`** — https://docs.langchain.com/oss/javascript/releases/langchain-v1
- **MemorySaver + thread_id** — https://langchain-ai.github.io/langgraphjs/agents/memory
- **LangChain Azure OpenAI** — https://docs.langchain.com/oss/javascript/integrations/chat/azure
- **LangChain Anthropic** — https://docs.langchain.com/oss/javascript/integrations/chat/anthropic
- **LangChain Google Gemini** — https://docs.langchain.com/oss/javascript/integrations/chat/google_generativeai
- **Anthropic on Microsoft Foundry** — https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry
- **DeepSeek tool calls** — https://api-docs.deepseek.com/guides/tool_calls
- **Azure Foundry `/openai/v1`** — https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
- **Azure Foundry endpoints** — https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints
- **Azure Foundry LangChain guide** — https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/langchain-models
- **dotenv README** — https://github.com/motdotla/dotenv
- **Research doc (local)** — `docs/research/azure-deepseek-tool-calling.md` — required reading before Phase C for the DeepSeek factory.

---

## 10. Definition of Done

- [ ] `npx tsc --noEmit` green.
- [ ] `npm test -- --run` green (all new + existing specs).
- [ ] `npm run build` green.
- [ ] `node dist/cli.js agent --help` shows the new command surface.
- [ ] `node dist/cli.js agent` (no prompt, no `-i`) exits 2.
- [ ] `.env.example` present; `git check-ignore .env` exits 0.
- [ ] Each provider factory has a spec proving `ConfigurationError` on every
      required-env-var absence.
- [ ] `azure-deepseek` factory rejects every denylist pattern from research §7.2.
- [ ] Mutation tools are absent from the catalog without `--allow-mutations`.
- [ ] `CLAUDE.md` has an `<agent>` block following the project's
      `<toolName>` schema.
- [ ] `docs/design/project-design.md` has an "Agent Subcommand (Plan 003)"
      section (designer's deliverable, not planner's).
- [ ] `docs/design/project-functions.MD` has FR-AGT-1..FR-AGT-13.
- [ ] `docs/design/configuration-guide.md` documents every `OUTLOOK_AGENT_*`
      env var.
- [ ] `README.md` has an "Agent mode" section with three worked examples.
- [ ] `Issues - Pending Items.md` lists any deferred items (R1-0528
      workaround, streaming, send-mail tools) under completed/pending as
      appropriate.
- [ ] Manual smoke test `test_scripts/agent-acceptance.spec.ts` maps AC-1
      through AC-11 to green assertions.

---

## Appendix — Design contract the designer phase must absorb

The designer phase will lift the following into
`docs/design/project-design.md` as an "Agent Subcommand (Plan 003)" section:

1. Module layout table (from §4 of this plan).
2. Control flow: commander → `makeAction` → `commands/agent.ts:run()` →
   `loadDotenv` → `loadAgentConfig` → `authCheck.run` (+ optional
   `doAuthCapture`) → `getProvider` → `buildToolCatalog` → `createAgentGraph`
   → `invoke` → `AgentResult` → `emitResult`.
3. Decisions locked here that differ from earlier docs:
   - Mutation tools are **omitted from the catalog** (not refused at runtime)
     when `--allow-mutations` is false (stricter than investigation D4).
   - `createAgent` from `langchain` is the primary path;
     `createReactAgent` from `@langchain/langgraph/prebuilt` is the fallback
     (isolated to `src/agent/graph.ts`).
   - `dotenv.config` is called from `commands/agent.ts:run()`, NOT from
     `cli.ts`.
4. Error-taxonomy table (which new errors map to which exit codes) — already
   covered by the existing `ConfigurationError` / `AuthError` /
   `UpstreamError` / `IoError` / `UsageError` classes; the designer should
   note that NO new error subclass is introduced.
