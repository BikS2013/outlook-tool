# Issues - Pending Items

## Pending

<!-- Most critical / highest priority first. -->

### 2. configuration-guide.md needs refresh for v2.0.0 standard env var names

**Status:** pending (2026-04-24, after v2.0.0 provider rename landed).

**Context:** `docs/design/configuration-guide.md` still documents
the old `OUTLOOK_AGENT_OPENAI_API_KEY`-style names. It should be updated
to document the new standard names (`OPENAI_API_KEY`, etc.), the new
`local-openai` provider, the `gemini` provider (and `google` deprecation),
the extended precedence chain including `~/tool-agents/outlook-cli/`,
and the new `--base-url` / `--config` flags.

**Action required:** refresh `docs/design/configuration-guide.md` and
`docs/design/project-design.md §4–5` with the v2.0.0 provider/env table.

**Effort:** low (documentation only).

### 1. `/monitor` slash command is stubbed — rich monitoring not implemented

**Status:** pending (2026-04-23, after plan-004 Agent TUI landed).

**Context:** `src/agent/tui/commands/monitor.ts` currently prints
`"monitoring disabled (built-in monitoring not yet available)"`. The
spec at `prompts/004-agent-tui-spec.md` §2.3 / §11 describes a richer
`/monitor` that reports: thread id, turn count, LLM call count, tool
call count, token totals, total duration, top-used tools, and a JSONL
log path. Implementing the stub fully requires a new
`src/agent/monitoring/` module with a callback handler attachable to
`graph.streamEvents({...callbacks: [...]})`.

**Action required:** build `src/agent/monitoring/` with
`createMonitoringSession(threadId): MonitoringSession` as described in
spec §11. Wire it into `runTui` — instantiate on startup, close and
recreate on `/new` + `/model` + `/model reset`, pass its handler to
`graph.streamEvents` callbacks, surface summary on `/monitor`.

**Effort:** medium (new module, tests for counter accumulation, JSONL
logger). Deferred from plan-004 to keep the initial TUI scope finite.

## Review — Agent TUI (plan-004, 2026-04-23)

Scope: Phase 6 deliverables for the Agent Interactive TUI.

**Files reviewed (21 touched / new):**
- Modified (9): `.env.example`, `CLAUDE.md`, `Issues - Pending Items.md`,
  `docs/design/project-design.md`, `docs/design/project-functions.MD`,
  `src/agent/run.ts`, `src/cli.ts`, `src/commands/agent.ts`,
  `src/config/agent-config.ts`.
- New (12) under `src/agent/tui/`: `ansi.ts`, `clipboard.ts`, `index.ts`,
  `input.ts`, `io.ts`, `memory-store.ts`, `model-store.ts`, `spinner.ts`,
  `turn.ts`, `types.ts`, plus `commands/` (copy, help, history, index,
  last, memory, model, monitor, new-thread, quit, state).
- New tests (4): `tui-clipboard.spec.ts`, `tui-memory-store.spec.ts`,
  `tui-model-store.spec.ts`, `tui-spinner.spec.ts`.

**Build + test state:**
- `npx tsc --noEmit` → 0 errors.
- `npx vitest run` → 35 files / 439 tests passing.

**Design-compliance audit (10/10 passed):**
1. §TUI.1.1 (no `process.env` outside `commands/model.ts`) — PASS. Only
   `commands/model.ts:114` reads it, through the documented `resolveParam`
   seam.
2. §TUI.1.2 (`loadAgentConfig` only in `index.ts` + `commands/model.ts`)
   — PASS. Three call sites total: `index.ts:143`, `commands/model.ts:168`,
   `commands/model.ts:294`, all in the sanctioned files.
3. §TUI.1.3 (`streamEvents` only in `turn.ts`) — PASS. Declared in
   `types.ts` (AgentGraph), consumed only at `turn.ts:179`.
4. No raw `process.exit()` in TUI tree — PASS. Only `process.exitCode =
   2` assignments in `index.ts` (lines 188, 314). `commands/quit.ts`
   returns `{ exit: true }` and lets the main loop unwind.
5. No fallback defaults for mandatory config — PASS. `agent-config.ts`
   throws `ConfigurationError` on missing `OUTLOOK_AGENT_PROVIDER` /
   `OUTLOOK_AGENT_MODEL`; `memoryFile` / `modelFile` defaults are the
   two new rows in the project exception block.
6. Header-once invariant (§TUI.4) — PASS. `io.ts` gates on
   `_headerPrintedThisTurn`; `turn.ts:136` calls `resetAgentHeader()`
   at turn start; every chunk / tool-start path calls
   `printAgentHeader(...)` before the first stdout write.
7. Single-active-spinner lock — PASS. Module-global `_active` in
   `spinner.ts:10`; `start()` stops the prior handle before replacing.
8. Atomic-write + 0600/0700 — PASS. Both `memory-store.ts` and
   `model-store.ts` use `openSync(tmp, "w", 0o600)` →
   `writeFileSync(fd, …)` → `fsyncSync(fd)` → `closeSync` →
   `renameSync`. Parent dir is `mkdirSync(..., { recursive: true, mode:
   0o700 })`.
9. TuiContext.rebuildGraph closure — PASS. Reassigns `ctx.cfg` and
   `ctx.graph`, and re-runs `composeSystemPrompt(base, memoryStore)` so
   fresh memory entries land in the next graph (`index.ts:253`).
10. `/model` saves BEFORE `rebuildGraph` — PASS. Order in
    `commands/model.ts:315` → `326`.

**Spec-compliance audit (7/7 passed):**
- §2.1 keybindings — every byte sequence in spec §5 is handled in
  `input.ts` (confirmed against the table row-by-row).
- §2.2 spinner frames `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]`
  and 80 ms tick — PASS (`spinner.ts:6-7`).
- §2.3 slash commands — every row in the spec table has a handler; the
  dispatcher maps aliases `/reset` → `new`, `/raw` → `last`, `/exit` →
  `quit`.
- §2.5 banner — lines 1, 2, 4, 5, 6 rendered in `index.ts#printBanner`;
  line 3 (monitoring path) is legitimately omitted — monitoring is
  stubbed, see pending item #1.
- §2.6 `unhandledRejection` allow-list — PASS. Only
  `"Error reading from the stream"` and `"GoogleGenerativeAI"` are
  swallowed (`index.ts:273-275`); everything else is re-thrown via
  `queueMicrotask`.
- §9 `/model` tokenizer regex `/(?:[^\s"]+|"[^"]*")/g` — PASS
  (`commands/index.ts:21`). Factored into the shared parser; `model.ts`
  consumes post-tokenized `args` so no duplicate regex needed.
- §10 `<user-instructions>` wrapper — PASS
  (`index.ts#composeSystemPrompt`, lines 85–90).

**Security & redaction:**
- `maskSecret` in `commands/model.ts:85-88` replaces ≤ 8-char values
  with `****` and otherwise emits `first4…last4`. `isSecretKeyName`
  fires on KEY / SECRET / TOKEN / PASSWORD (case-insensitive) in
  `printCurrentConfig` (`commands/model.ts:137`).
- No raw `.toString(` / `JSON.stringify(` of api-key-like fields found
  in the TUI tree. `args.logger.warn` in `index.ts:280` runs every
  string through `redactString` inside `logging.ts`.

**Documentation:**
- `CLAUDE.md` `<agent>` block carries the "Interactive TUI (plan-004)"
  subsection with all slash commands, env vars, flags, persistence
  files, keybindings, and limitations (lines 565–695).
- `CLAUDE.md` exception block was updated on 2026-04-23 from
  three-setting to five-setting exception, listing `memoryFile` and
  `modelFile` (lines 91–103).
- `docs/design/project-functions.MD` has F-TUI.1–F-TUI.7 filled in
  (lines 519–730 ish).
- `.env.example` carries `OUTLOOK_AGENT_MEMORY_FILE` and
  `OUTLOOK_AGENT_MODEL_FILE` (lines 102–109).
- `Issues - Pending Items.md` TOP entry captures the `/monitor` stub.

**Test coverage:**
- All four expected spec files exist and pass:
  `tui-clipboard.spec.ts` (21 tests?), `tui-memory-store.spec.ts`,
  `tui-model-store.spec.ts`, `tui-spinner.spec.ts`. `agent-run.spec.ts`
  still passes (legacy readline REPL path still supported via
  `runInteractiveLegacy`).
- Coverage gaps (deferred to Phase 9): no unit tests yet for the
  `input.ts` pure helpers (`replaceInput` / `insertNewline` /
  `handleBackspace` / `redrawCurrentLine`), no dispatcher tests
  (`parseSlashCommand` token parsing, slash-command routing), no
  `turn.ts` harness exercise via `TurnEventHandlers`, no
  `composeSystemPrompt` test, no `io.ts` header-once state-machine
  test, and no PTY smoke test for `runTui` itself.

**Fixes applied:** none. Every audited item either passed or was
  already tracked in the pending list. No design-compliance regression
  required an in-place edit during this review.

**Remaining concerns:**
- [LOW] `runInteractiveLegacy` in `src/agent/run.ts:499` calls
  `process.exit(130)` on SIGINT. Out of TUI scope — legacy readline
  REPL only — but worth flagging because the CLI no longer routes
  there in production (`commands/agent.ts` always passes the TUI
  fields). Can be removed when the legacy path is retired.
- [LOW] `turn.ts:37-45` uses a `require()` wrapped in try/catch to
  load `redactString`, with an identity fall-through. The module path
  is stable today, so the fall-through is effectively dead code; a
  future move would fail silently (no redaction). Consider replacing
  with a static import.
- [LOW] Six of the ten test seams documented in design §TUI.11 are
  uncovered (see "Test coverage" above). Tracked for Phase 9.
- [LOW] Banner line 3 is intentionally omitted because monitoring is
  stubbed. Once pending item #1 is implemented, the banner printer
  needs to grow a "Monitoring: …" row behind the same feature flag.

**Sign-off:** READY for integration verification.

## Integration Verification — Agent TUI (2026-04-23)

Phase 10 gate for plan-004 Agent TUI. Executed against current master
HEAD (`80724ad +initial agent support`) with the plan-004 tree in
place.

**Build status:** PASS — `npx tsc --noEmit` returned exit 0 with no
output.

**Test results:** PASS — `npx vitest run` reported
`Test Files 39 passed (39)` / `Tests 475 passed (475)` / 0 failed.
Duration 9.74 s. One expected stderr line (`stdin is not a TTY —
interactive mode requires a terminal`) came from the TTY-guard unit
test.

**Lint:** SKIPPED — `package.json` has no `lint` script
(only `build`, `postbuild`, `cli`, `test`, `test:watch`).

**CLI startup error path:** PASS — `OUTLOOK_AGENT_PROVIDER= npx
ts-node src/cli.ts agent --interactive` emitted
```json
{ "error": { "code": "CONFIG_MISSING", "missingSetting":
  "OUTLOOK_AGENT_PROVIDER", "checkedSources": ["--provider",
  "OUTLOOK_AGENT_PROVIDER"] } }
```
and exited with code **3**. No Chrome, no network.

**Help text:** PASS — `agent --help` lists the two new flags
`--agent-memory-file <path>` and `--agent-model-file <path>` alongside
`-i, --interactive`, `-p, --provider`, `-m, --model`, and every other
previously-documented flag.

**Acceptance criteria audit (spec §2 + plan §6):**

MET:
- §2.1 Input — raw-mode reader (`src/agent/tui/input.ts`), multiline
  with Enter (0x0d) submit / Ctrl+J (0x0a) newline insert, Backspace
  merges at col 0 (`handleBackspace`), every escape sequence from spec
  §5 handled in `tryHandleEscape` (arrows, Home/End, word motion
  `\x1bb`/`\x1bf`/`\x1b[1;3D/C`/`\x1b[1;5D/C`, deletion `\x1b[3~` /
  `\x1b[3;9~`, Ctrl+A/E/W/U/K), Ctrl+C (0x03) → SIGINT /
  Ctrl+D (0x04) on empty buffer → EOF (`handleSingleByte`),
  consecutive-dup suppression in `submit()` at line 340.
- §2.2 Execution/Streaming — `SPINNER_FRAMES =
  ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` and `SPINNER_TICK_MS = 80`
  (`src/agent/tui/spinner.ts`), `setLabel` on handle, token-level
  streaming in `runTurn` (`turn.ts` line 92 writes chunks directly),
  tool-call indicator in `on_tool_start` / `on_tool_end` cases (`↳
  calling X(...)` + `✓`), header once per turn via
  `printAgentHeader` / `resetAgentHeader` / `isAgentHeaderPrinted`
  (`io.ts`), ESC abort via `AbortController` (`turn.ts` line 144 +
  `escHandler` lines 166–174), `[interrupted]` post-stream render at
  line 221.
- §2.3 Slash commands — dispatcher in
  `src/agent/tui/commands/index.ts` routes all 11 commands:
  `help`, `history`, `state`, `memory` (+ `add` / `remove` / `clear`),
  `new` / `reset`, `last` / `raw`, `copy`, `copy-all`, `model`
  (+ `reset`), `monitor`, `quit` / `exit`.
- §2.4 Persistence — input history memory-only
  (`ctx.inputHistory: string[]` in `runTui`, never flushed to disk);
  user memory JSON at `$HOME/.outlook-cli/agent-memory.json` with
  0600 + atomic write (`memory-store.ts`); model override JSON at
  `$HOME/.outlook-cli/agent-model.json` with same recipe
  (`model-store.ts`). Deviation from spec's `.agent-memory.json` is
  intentional and documented in design §TUI.6.1 / §TUI.6.2 (reuses
  the existing 0700 profile dir).
- §2.5 Startup & banner — 5-line banner via `printBanner` in
  `index.ts` lines 112–118, emitted to stderr; banner line 3 covers
  `Session: <id>` instead of monitoring path because monitoring is
  deferred (see pending item #1). First-line prompt `You> ` in green
  (`PROMPT` line 291) and continuation prompt ` .. ` in green (`CONT`
  line 292).
- §2.6 Error handling — `main()` wraps errors through the existing
  CLI taxonomy (ConfigurationError → exit 3, AuthError → exit 4, etc.);
  unhandledRejection allow-list in `runTui`'s `onUnhandled` (lines
  267–288) swallows only `"Error reading from the stream"` and
  `"GoogleGenerativeAI"`, re-throws everything else via
  `queueMicrotask`; `src/config/agent-config.ts` still throws
  `ConfigurationError` for missing `OUTLOOK_AGENT_PROVIDER` (line
  371) / `OUTLOOK_AGENT_MODEL` (line 401) — no fallback defaults.
- Plan §6.1 — `npx tsc --noEmit` clean.
- Plan §6.2 — 475 tests pass.
- Plan §6.4 — `Issues - Pending Items.md` top pending entry
  is the `/monitor` stub.
- Plan §6.5 — `CLAUDE.md` `<agent>` block (lines 565–695) documents
  every new slash command, keybinding, env var
  (`OUTLOOK_AGENT_MEMORY_FILE`, `OUTLOOK_AGENT_MODEL_FILE`), CLI flag
  (`--agent-memory-file`, `--agent-model-file`, `-i, --interactive`),
  persistence file, and limitation.

DEFERRED:
- `/monitor` rich output (spec §2.3 / §11) — stub only, tracked as
  pending item #1. Banner line 3 still emits `Session: <id>`; once
  monitoring lands the banner printer should grow a "Monitoring: …"
  row behind the same feature flag.

FAIL: none.

**Manual smoke:** OUT OF SCOPE — an end-to-end TUI launch requires a
live Outlook session and a real LLM provider key. Deliberately not
executed from this automated verification pass.

**Fixes applied:** none. Every build and test artifact was clean on
first run; no unilateral edits were needed.

**Overall verdict:** **READY**.

### MAJOR

- **[folder-isFolderExistsError-fragile] `createFolder` relies on
  parsing the upstream body out of a truncated-and-redacted error
  message string.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/http/outlook-client.ts`
  (`parseErrorBody`). `throwForResponse` only embeds the upstream
  body as a 512-char snippet inside `ApiError.message` after
  `truncateAndRedactBody` runs. The `parseErrorBody` helper then tries
  to JSON-parse a prefix of that message to recover
  `{ error: { code: 'ErrorFolderExists' } }`. For typical Outlook
  responses the JSON survives verbatim, but an unusually long message
  (or a base64-like run inside the message body) could cause
  `redactString` to mangle the JSON before the predicate sees it, and
  a `CollisionError` would degrade to a plain
  `UpstreamError('UPSTREAM_HTTP_400')` (exit 5 instead of 6).
  Recommended fix: attach the parsed body object directly to
  `ApiError` (e.g. `ApiError.body?: unknown`) at throw time, so
  `isFolderExistsError` can consume the real object instead of
  re-parsing the redacted message. Requires a small `ApiError`
  signature change.

### MINOR

- **[move-mail-missing-flags] `move-mail` command is missing three
  flags specified in `refined-request-folders.md §5.4` and
  `plan-002-folders.md §P5d`: `--ids-from <file>` (read message ids
  from a file, one per line), `--to-id <rawId>` (bypass alias/path
  resolution), and `--stop-at <n>` (cap loop early with exit 2 on
  overflow).** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/commands/move-mail.ts`
  (`MoveMailOptions`) and
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/cli.ts`
  (`move-mail` registration). Current surface (variadic positional
  `<messageIds...>` + `--to <spec>`) covers the common case; each
  missing flag can be simulated from the shell (xargs for ids-from,
  explicit id: prefix in --to for to-id, head/tail for stop-at). Blocks
  AC-MOVE-STOPAT outright and partially weakens AC-MOVE-MANY (the
  end-state is achievable but the flag surface the spec promises is
  absent). Additive fix — no backward-compatibility risk.

- **[find-folder-flag-name] `find-folder` uses `--anchor` where the
  refined spec §5.2 and `project-design.md §10.7` table both use
  `--parent`.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/cli.ts`
  (`find-folder` registration). Semantically identical (the flag is
  the anchor for path-form queries, default `MsgFolderRoot`), but the
  name is inconsistent with `list-folders`, `create-folder`, and the
  documented surface. Suggested fix: rename the flag to `--parent` and
  surface a deprecated alias for `--anchor` during a transition window.

- **[nested-create-PreExisting-accuracy] On a concurrent-create race,
  `create-folder --idempotent <nested path>` may report
  `PreExisting: false` even though the leaf pre-existed.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/commands/create-folder.ts`
  (`runNestedPath`). The happy path resolves the full path up front
  via `tryResolveExistingPath` (sets `PreExisting: true` correctly).
  If that resolution fails and `ensurePath` then hits a pre-existing
  leaf via pre-list detection, the command surfaces the leaf with
  `PreExisting: false`. Accurate tracking would require propagating a
  per-segment flag from `ensurePath` upward — deferred as a future
  refactor (the top-level `idempotent` flag in the payload is still
  accurate for the common path).

### MAJOR

- **[sec-leak] Body-snippet redaction is pattern-based, not token-equality based.**
  File: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/http/errors.ts` (`truncateAndRedactBody`)
  + `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/util/redact.ts` (`redactString`).
  Design §4 says the client must replace any substring equal to
  `session.bearer.token` or any `cookie.value` with `[REDACTED]` before embedding
  upstream body text in an error message. The current `redactString` only catches
  any base64-url run >100 chars. This covers JWTs and most session cookies in
  practice, but the normative contract is stricter. To close the gap, thread the
  active session into the HTTP client and do an explicit `.replaceAll(token, ...)`
  + `.replaceAll(cookie.value, ...)` pass before redactString runs. Not fixed in
  this review because it requires a signature change to `createOutlookClient`
  options.

- **[design-drift] HTTP error hierarchy diverges from design §2.2.**
  Files: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/http/errors.ts`,
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/commands/list-mail.ts`
  (`mapHttpError`). Design contract has a single `OutlookCliError` hierarchy
  (Configuration/Auth/Upstream/Io). The implementation introduces a parallel
  `OutlookHttpError` family (`ApiError`, `AuthError`, `NetworkError`). This works
  because every command funnels errors through `mapHttpError` before re-throwing,
  but the extra layer is fragile: any future command that forgets to wrap will
  leak an `ApiError` up to `cli.ts`, where it will be treated as "UNEXPECTED"
  (exit 1). Suggested follow-up: either delete the parallel hierarchy and throw
  `UpstreamError`/`AuthError` directly from the http layer, or add a generic
  `err instanceof OutlookHttpError` → `UpstreamError` map in `cli.ts`.

### MINOR / NIT

- **[dedup] `deduplicateFilename` uses an in-memory `Set` instead of the
  filesystem.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/util/filename.ts`. Design §2.11
  specifies an async function that checks for existing files on disk and caps
  attempts at 999. The current implementation caps at 10 000 and only tracks
  names generated in the current batch. Behaviour is correct for a single
  `download-attachments` call because the `atomicWriteBuffer` call with
  `overwrite:false` surfaces on-disk collisions via `IO_WRITE_EEXIST`, but the
  API signature drift means future callers that pass only a bare name (without
  the Set) get no dedup at all.

- **[login-save-twice] `login` command saves the session file twice.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/commands/login.ts` line 80 +
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/cli.ts` line 99 (inside
  `doAuthCapture`). The first save happens inside the injected `doAuthCapture`;
  the second happens immediately after in `login.run`. The second call is an
  idempotent rewrite, so no harm done, but it doubles disk IO and is confusing.

- **[signature-drift] `sanitizeAttachmentName` signature.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/util/filename.ts`. Design §2.11
  specifies `sanitizeAttachmentName(raw: string | null | undefined, fallback:
  string)`; the implementation is `sanitizeAttachmentName(raw: string)` with a
  hard-coded fallback of `"attachment"`. All current callers pass a string, but
  the API deviates from the normative contract.

- **[race-toctou] `atomicWriteBuffer` `overwrite:false` still has a TOCTOU.**
  File: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/util/fs-atomic.ts`. The
  sequence `access(finalPath)` + `rename(tmp, finalPath)` matches design §2.10
  step 9 but `rename()` silently replaces an existing target on POSIX, so a file
  that appears between the check and the rename will be clobbered. The
  POSIX-idiomatic fix is `link(tmp, finalPath)` + `unlink(tmp)` which returns
  EEXIST atomically when the target exists. Low priority because only the
  attachments path hits `overwrite:false` and that directory is user-chosen.

- **[config-error-mix] `download-attachments --out` missing uses
  `ConfigurationError`.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/commands/download-attachments.ts`
  line 98. The refined spec §5.5 specifies exit 3 for missing `--out`, which is
  consistent with `ConfigurationError`. Name-wise this is a command-level option
  not an "environment" setting, but exit-code-wise the behaviour is correct.

- **[redundant-check] `createOutlookClient` rejects zero/negative
  `httpTimeoutMs` with a plain `Error`.** File:
  `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/http/outlook-client.ts` line 71.
  This can never fire because `loadConfig` already rejects non-positive timeouts
  via `ConfigurationError`. Harmless defensive code, but if it ever does fire
  it will surface as UNEXPECTED (exit 1) instead of CONFIG_MISSING (exit 3).

- **[auth-capture-errors] `AuthCaptureError` does not extend `OutlookCliError`.**
  File: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/src/auth/browser-capture.ts`
  lines 58-68. The CLI top-level handler does check for it explicitly
  (`cli.ts` lines 321, 338), so exit code 4 is emitted correctly. However this
  is another spot of hierarchy drift; consolidating into `AuthError` from
  `config/errors` would simplify the taxonomy.

## Completed

<!-- Completed items moved here. -->

### BLOCKER / MAJOR fixes applied during 2026-04-23 agent Phase 7 review

- **[fixed] [agent-azure-foundry-env-mismatch]** `azure-anthropic` and
  `azure-deepseek` factories now read the shared
  `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` /
  `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` env vars per design
  §5.5 / §5.6. Endpoint normalization (strip trailing `/`, strip a
  trailing `/models`, append `/anthropic` or `/openai/v1`) is
  implemented in a shared helper `normalizeFoundryEndpoint` at
  `src/agent/providers/util.ts` and exercised by the two factories.
  `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` /
  `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` are treated as
  user-convenience aliases of `OUTLOOK_AGENT_MODEL`; the factories
  cross-check against `cfg.model` and raise `UsageError` on
  disagreement. Tests rewritten in
  `test_scripts/agent-provider-registry.spec.ts` plus new
  `test_scripts/agent-provider-util.spec.ts` cover the four
  normalization variants (no suffix, `/`, `/models`, `/models/`).

- **[fixed] [agent-azure-deepseek-denylist-incomplete]** DeepSeek
  denylist expanded to the full research §7 set:
  `/deepseek-v3\.2-speciale/i`, `/deepseek-r1(?!-0528)/i`,
  `/deepseek-reasoner/i`, `/mai-ds-r1/i`, `/deepseek-r1-0528/i`.
  Rejection now raises `ConfigurationError({ missingSetting:
  'OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL' })` with a descriptive detail
  message listing the accepted V3.x variants. Allowlist tests cover
  V3, V3.1, V3.2; denylist tests exercise every pattern in both
  casings.

- **[fixed] [agent-stub-AgentConfig-drift]** `src/agent/tools/types.ts`
  now imports the real `AgentConfig` from `src/config/agent-config.ts`
  and the real `AgentDeps` from `src/commands/agent.ts`; the
  forward-stub interfaces were deleted. Consequently, the structural
  `deps as any` / `cfg as any` casts in `src/commands/agent.ts`
  around the `buildToolCatalog(...)` call were removed. Tests that
  constructed stub `AgentConfig` values were updated to use the real
  field names (`provider` instead of `providerName`, added
  `providerEnv`, dropped `quiet`/`logFilePath`/`runId`).

### BLOCKER / MAJOR fixes applied during 2026-04-21 folder-management review (Phase 7)

- **[fixed] `list-mail` did not accept display-name paths in `--folder`
  and treated `--folder-parent` as a third mutually-exclusive flag.**
  File: `src/commands/list-mail.ts`. The mutual-exclusion rule was
  corrected to `--folder` XOR `--folder-id` (per design §10.7) and the
  value of `--folder` is now routed through the resolver when it is
  neither an original-five fast-path alias nor a direct id. Also added
  two additional validations: `--folder-parent` with `--folder-id` →
  exit 2; `--folder-parent` without `--folder` → exit 2. Fixes
  AC-LISTMAIL-PATH and preserves AC-LISTMAIL-WELLKNOWN-BACKCOMPAT.

- **[fixed] `create-folder <nested-path>` without `--idempotent` did
  not raise `CollisionError` when the leaf pre-existed (pre-list
  detection path).** File: `src/folders/resolver.ts` (`ensurePath`).
  The walk previously advanced silently on any pre-existing segment,
  which caused a nested non-idempotent re-run to return success with
  `PreExisting: false` instead of exit 6 (AC-CREATE-COLLISION).
  `ensurePath` now throws `CollisionError('FOLDER_ALREADY_EXISTS')`
  when the LEAF segment pre-exists and `idempotent === false`.
  Intermediate segments still advance without POST so
  `--create-parents` remains strictly about missing parents.

- **[fixed] `create-folder --parent <anchor>` was silently ignored
  for nested paths (always anchored at `MsgFolderRoot`).** File:
  `src/folders/resolver.ts` (`ensurePath`) +
  `src/commands/create-folder.ts` (`runNestedPath`). `ensurePath`
  now accepts an optional `anchor: FolderSpec` and resolves it via
  `resolveFolder` before the walk. `runNestedPath` parses `--parent`,
  passes it into both `ensurePath` and `tryResolveExistingPath`, and
  applies the "well-known alias leaf at root is forbidden" validation
  only when the anchor resolves to `MsgFolderRoot`.

### BLOCKER / MAJOR fixes applied during 2026-04-21 code review

- **[fixed] 401 + `--no-auto-reauth` now yields `AUTH_NO_REAUTH`, not
  `AUTH_401_AFTER_RETRY`.** Added a `reason` discriminator to `http/errors
  AuthError`, threaded through `outlook-client.doGet`, and updated
  `list-mail.mapHttpError` to emit the correct CLI code. Matches design §2.8 /
  §4.

- **[fixed] `download-attachments` now uses `atomicWriteBuffer` (fsync +
  rename) with the `overwrite` flag instead of `fs.writeFile`.** Matches design
  §2.13.5 step 8 and gives us torn-write protection + a proper EEXIST guard.

- **[fixed] `atomicWriteBuffer` no longer forces the parent directory to
  mode 0o700.** Added an opt-in `parentDirMode` option. The session file still
  gets 0o700; the user's `download-attachments --out` directory now keeps its
  own mode (user umask). Matches design §2.13.5 step 1.

- **[fixed] `download-attachments` `ensureOutDir` no longer passes
  `mode: 0o700`.** Same motivation as above.
