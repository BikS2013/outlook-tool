# Codebase Scan — LangGraph ReAct Agent Integration

Status: Complete
Produced by: codebase-scanner agent
For: investigator, planner, designer, coders
Spec scanned against: docs/design/refined-request-langgraph-agent.md

---

## 1. Project Overview

| Attribute | Value |
|---|---|
| Language | TypeScript |
| Runtime | Node.js (CommonJS, `"type": "commonjs"` in package.json) |
| TypeScript version | `^6.0.3` (tsconfig target: `ES2022`, module: `commonjs`) |
| CLI framework | `commander ^14.0.3` |
| Test framework | `vitest ^4.1.4` |
| Build tool | `tsc` (outputs to `dist/`) |
| Entry point | `src/cli.ts` → `dist/cli.js` (bin: `outlook-cli`) |
| Dev runner | `ts-node src/cli.ts` via `npm run cli` |
| Test config | `vitest.config.ts` — includes `test_scripts/**/*.spec.ts`, environment: `node`, timeout: 10 s |
| Notable deps | `commander` (only runtime dep); `playwright`, `@playwright/test`, `ts-node` (dev) |
| Zod | NOT present — not in `dependencies` or `devDependencies`; must be added explicitly |
| dotenv | NOT present — must be added for `.env` file support |

`package.json:19` — `"type": "commonjs"` means all `.ts` files compile to CJS. LangGraph.js and LangChain packages are ESM-first; `esModuleInterop: true` in tsconfig helps but the team should verify CJS-ESM interop of every LangChain package at install time (see §12).

---

## 2. Module Map

```
src/
  cli.ts                   — Commander bootstrap, subcommand registration, error→exit mapping
  config/
    config.ts              — loadConfig(), CliConfig, CliFlags, ENV, DEFAULTS
    errors.ts              — OutlookCliError, ConfigurationError, AuthError, UpstreamError, IoError
  commands/
    auth-check.ts          — run(deps, opts?) → AuthCheckResult
    login.ts               — run(deps, opts) → LoginResult
    list-mail.ts           — run(deps, opts) → MessageSummary[] | ListMailCountResult
                             Also exports: ensureSession, mapHttpError, UsageError
    get-mail.ts            — run(deps, id, opts?) → Message
    get-thread.ts          — run(deps, idOrConv, opts?) → ThreadResult
    download-attachments.ts — run(deps, id, opts?) → DownloadAttachmentsResult
    list-calendar.ts       — run(deps, opts?) → EventSummary[]
    get-event.ts           — run(deps, id, opts?) → Event
    list-folders.ts        — run(deps, opts?) → FolderSummary[]
    find-folder.ts         — run(deps, spec, opts?) → ResolvedFolder
    create-folder.ts       — run(deps, pathOrName, opts?) → CreateFolderResult
    move-mail.ts           — run(deps, messageIds, opts?) → MoveMailResult
  folders/
    resolver.ts            — parseFolderSpec, resolveFolder, ensurePath, normalizeSegment
    types.ts               — FolderSpec, ResolvedFolder, CreateFolderResult, MoveMailResult, etc.
  http/
    outlook-client.ts      — createOutlookClient(opts): OutlookClient (factory)
    errors.ts              — ApiError, AuthError, NetworkError, CollisionError, codeForStatus, isFolderExistsError
    types.ts               — MessageSummary, Message, Event, EventSummary, FolderSummary, etc.
  output/
    formatter.ts           — formatOutput(data, mode, columns?): string; ColumnSpec<T>; OutputMode
  session/
    schema.ts              — SessionFile, BearerInfo, Account, Cookie, isValidSessionFile, validateSessionJson
    store.ts               — loadSession, saveSession, isExpired, deleteSession
  auth/
    browser-capture.ts     — captureOutlookSession(opts): CaptureResult; AuthCaptureError
    jwt.ts                 — JWT decode helpers (used by browser-capture)
    lock.ts                — acquireLock(path): release fn; PID-based advisory lock
  util/
    dates.ts               — parseTimestamp(raw): TimestampParseResult (ISO / "now±Nd")
    filename.ts            — sanitizeAttachmentName, deduplicateFilename, assertWithinDir
    fs-atomic.ts           — atomicWriteJson, atomicWriteBuffer, readJsonFile
    redact.ts              — redactHeaders, redactJwt, redactString
docs/
  design/
    project-design.md      — normative design (must be updated with agent section)
    refined-request-langgraph-agent.md  — spec being implemented
    configuration-guide.md             — must be updated with new env vars
    plan-001-outlook-cli.md, plan-002-folders.md  — completed plans
  reference/
    codebase-scan-outlook-cli.md, codebase-scan-folders.md — prior scans
test_scripts/
  *.spec.ts                — vitest unit tests, one file per module
CLAUDE.md                  — project conventions; must be updated with `<agent>` tool block
```

---

## 3. CLI Registration Pattern

**File:** `src/cli.ts:591–611` (auth-check registration as the simplest template):

```typescript
// src/cli.ts:604-611
program
  .command('auth-check')
  .description('Verify the cached session is present and accepted by Outlook')
  .action(
    makeAction<Record<string, never>, []>(program, async (deps, g) => {
      const result = await authCheck.run(deps);
      emitResult(result, resolveOutputMode(g));
    }),
  );
```

The `makeAction` wrapper at `src/cli.ts:538-554` is the canonical pattern for ALL subcommands:

```typescript
// src/cli.ts:538-554
function makeAction<O, Args extends unknown[]>(
  program: Command,
  handler: ActionHandler<O, Args>,
): (...args: [...Args, O, Command]) => Promise<void> {
  return async (...args: [...Args, O, Command]): Promise<void> => {
    const cmdOpts = args[args.length - 2] as O;
    const positional = args.slice(0, args.length - 2) as Args;
    const globalOpts = program.opts() as GlobalOpts;
    try {
      const flags = globalOptsToFlags(globalOpts);
      const deps = buildDeps(flags);
      await handler(deps, globalOpts, cmdOpts, ...positional);
    } catch (err) {
      process.exitCode = reportError(err);
    }
  };
}
```

Key points:
- `buildDeps(flags)` at `src/cli.ts:101-133` constructs the `CommandDeps` object (config + session plumbing) passed to every command `run()`.
- Global flags are read from `program.opts()` as `GlobalOpts`, then mapped to `CliFlags` by `globalOptsToFlags` (`src/cli.ts:177-194`).
- All errors are caught, mapped to exit codes by `reportError` (`src/cli.ts:510-519`), and set on `process.exitCode` (NOT `process.exit()`).
- Output is emitted via `emitResult(data, mode, columns?)` at `src/cli.ts:385-397`.
- Commander is configured with `exitOverride` at `src/cli.ts:950-957` so commander errors throw rather than calling `process.exit`.

---

## 4. Command Function Contract

**Representative command — `src/commands/list-mail.ts:78`:**

```typescript
// src/commands/list-mail.ts:78-81
export async function run(
  deps: ListMailDeps,
  opts: ListMailOptions = {},
): Promise<MessageSummary[] | ListMailCountResult>
```

Every command module follows the same contract:
1. Exports a `*Deps` interface (a structural superset of `CommandDeps` from cli.ts) and a `*Options` interface.
2. Exports `async function run(deps, [positional args], [opts])` returning a typed result.
3. Calls `ensureSession(deps)` from `src/commands/list-mail.ts:272` to get a live `SessionFile`.
4. Calls `deps.createClient(session)` to get an `OutlookClient`.
5. Maps HTTP-layer errors with `mapHttpError(err)` from `src/commands/list-mail.ts:299`.
6. Throws `UsageError` (exit 2), `ConfigurationError` (exit 3), `AuthError` (exit 4), `UpstreamError` (exit 5), `IoError` (exit 6).
7. Does NOT emit output — output is always handled in `cli.ts`.

The `ListMailDeps` / `CommandDeps` shape is:

```typescript
// src/cli.ts:80-87
interface CommandDeps {
  config: CliConfig;
  sessionPath: string;
  loadSession: (p: string) => Promise<SessionFile | null>;
  saveSession: (p: string, s: SessionFile) => Promise<void>;
  doAuthCapture: () => Promise<SessionFile>;
  createClient: (s: SessionFile) => OutlookClient;
}
```

---

## 5. Commands the Agent Will Wrap

| Tool name | Source file | Function signature | Returns | Mutates state | Key errors thrown |
|---|---|---|---|---|---|
| `auth_check` | `src/commands/auth-check.ts:40` | `run(deps, _opts?)` | `AuthCheckResult` (`{ status, tokenExpiresAt, account }`) | No | `UpstreamError` (non-401) |
| `list_mail` | `src/commands/list-mail.ts:78` | `run(deps, opts?)` | `MessageSummary[]` or `{ count, exact }` | No | `UsageError`, `UpstreamError`, `AuthError` |
| `get_mail` | `src/commands/get-mail.ts:34` | `run(deps, id, opts?)` | `Message & { Attachments: AttachmentSummary[] }` | No | `UsageError`, `UpstreamError`, `AuthError` |
| `get_thread` | `src/commands/get-thread.ts:63` | `run(deps, idOrConv, opts?)` | `ThreadResult` (`{ conversationId, count, messages }`) | No | `UsageError`, `UpstreamError`, `AuthError` |
| `list_folders` | `src/commands/list-folders.ts:88` | `run(deps, opts?)` | `FolderSummary[]` | No | `UsageError`, `UpstreamError` |
| `find_folder` | `src/commands/find-folder.ts:44` | `run(deps, spec, opts?)` | `ResolvedFolder` | No | `UsageError`, `UpstreamError` |
| `create_folder` | `src/commands/create-folder.ts` | `run(deps, pathOrName, opts?)` | `CreateFolderResult` | Yes (creates folder) | `UsageError`, `CollisionError` (exit 6), `UpstreamError` |
| `move_mail` | `src/commands/move-mail.ts:89` | `run(deps, messageIds, opts?)` | `MoveMailResult` | Yes (moves messages; returns new ids) | `UsageError`, `UpstreamError`, `AuthError` |
| `list_calendar` | `src/commands/list-calendar.ts:43` | `run(deps, opts?)` | `EventSummary[]` | No | `UsageError`, `UpstreamError` |
| `get_event` | `src/commands/get-event.ts:29` | `run(deps, id, opts?)` | `Event` | No | `UsageError`, `UpstreamError` |
| `download_attachments` | `src/commands/download-attachments.ts:89` | `run(deps, id, opts?)` | `DownloadAttachmentsResult` | Yes (writes files) | `ConfigurationError`, `UsageError`, `IoError`, `UpstreamError` |

**Return type details:**

- `AuthCheckResult` (`src/commands/auth-check.ts:27`): `{ status: 'ok'|'expired'|'missing'|'rejected', tokenExpiresAt: string|null, account: { upn: string }|null }`
- `MessageSummary` (`src/http/types.ts:39`): `{ Id, Subject, From?, ReceivedDateTime, HasAttachments, IsRead, WebLink, ConversationId? }`
- `Message` (`src/http/types.ts:55`): extends `MessageSummary` + `Body?, BodyPreview?, ToRecipients, CcRecipients, SentDateTime?, Attachments?`
- `ThreadResult` (`src/commands/get-thread.ts:56`): `{ conversationId, count, messages: MessageSummary[] }`
- `FolderSummary` (`src/http/types.ts:192`): `{ Id, DisplayName, ParentFolderId?, ChildFolderCount?, UnreadItemCount?, TotalItemCount?, IsHidden?, Path? }`
- `ResolvedFolder` (`src/folders/types.ts:84`): extends `FolderSummary` + `{ Path: string, ResolvedVia: 'wellknown'|'path'|'id' }`
- `CreateFolderResult` (`src/folders/types.ts:112`): `{ created: CreateFolderSegment[], leaf: CreateFolderSegment, idempotent: boolean }`
- `MoveMailResult` (`src/folders/types.ts:147`): `{ destination: MoveDestination, moved: MoveEntry[], failed: MoveFailedEntry[], summary }`
- `EventSummary` (`src/http/types.ts:151`): `{ Id, Subject, Start, End, Organizer?, Location?, IsAllDay }`
- `Event` (`src/http/types.ts:162`): extends `EventSummary` + `Body?, Attendees?, BodyPreview?, WebLink?`
- `DownloadAttachmentsResult` (`src/commands/download-attachments.ts:70`): `{ messageId, outDir, saved: [{id,name,path,size}], skipped: [{id,name,reason,...}] }`

---

## 6. Outlook HTTP Client Surface

**Factory:** `createOutlookClient(opts: CreateClientOptions): OutlookClient` at `src/http/outlook-client.ts:218`

**`CreateClientOptions`** (`src/http/outlook-client.ts:185-196`):
```typescript
{
  session: SessionFile;          // mutable ref, updated after re-auth
  httpTimeoutMs: number;
  onReauthNeeded: () => Promise<SessionFile>;  // called once on 401
  noAutoReauth: boolean;         // when true, 401 throws AuthError immediately
}
```

**`OutlookClient` interface** (`src/http/outlook-client.ts:87-183`):
- `get<T>(path, query?)` — generic GET
- `listFolders(parentId, top?)` — paginated, bounded by `MAX_FOLDER_PAGES=50`, `MAX_FOLDERS_VISITED=5000`
- `getFolder(idOrAlias)` — single folder GET; 404 → `UpstreamError{code:'UPSTREAM_FOLDER_NOT_FOUND'}`
- `createFolder(parentId, displayName)` — POST; 400/409+ErrorFolderExists → `CollisionError`
- `moveMessage(messageId, destinationFolderId)` — POST; returns new `MessageSummary` with new Id
- `listMessagesInFolder(folderId, opts)` — with `$select/$orderby/$top/$filter`
- `countMessagesInFolder(folderId, opts?)` — uses `$count=true`; returns `{ count, exact }`
- `listMessagesByConversation(conversationId, opts?)` — filters by `ConversationId eq '...'`

**401 / re-auth behavior** (`src/http/outlook-client.ts:262-288`):
- First 401 with `noAutoReauth: true` → throws `AuthError{reason:'NO_AUTO_REAUTH'}` (HTTP layer).
- First 401 with `noAutoReauth: false` → drains body, calls `onReauthNeeded()`, retries once.
- Second 401 after retry → throws `AuthError{reason:'AFTER_RETRY'}`.

**HTTP-layer error classes** (`src/http/errors.ts`):
- `AuthError` (extends `OutlookHttpError`) — 401 paths; carries `reason: AuthErrorReason`
- `ApiError` (extends `OutlookHttpError`) — non-401 4xx/5xx
- `NetworkError` — pre-response failures (DNS, TLS, timeout); carries `timedOut: boolean`
- `CollisionError` (extends `OutlookCliError`) — folder exists collision; exit code 6

Command modules translate HTTP-layer errors to CLI-layer errors via `mapHttpError(err)` at `src/commands/list-mail.ts:299-329`.

---

## 7. Config Loader Surface

**File:** `src/config/config.ts`

**Exported function:** `loadConfig(cliFlags: CliFlags): CliConfig` — returns a frozen `CliConfig`.

**`ENV` constant** (`src/config/config.ts:89-98`) — env vars currently read:

| Constant | Env var name | Type | Notes |
|---|---|---|---|
| `ENV.HTTP_TIMEOUT_MS` | `OUTLOOK_CLI_HTTP_TIMEOUT_MS` | integer ms | Has default 30000 (exception) |
| `ENV.LOGIN_TIMEOUT_MS` | `OUTLOOK_CLI_LOGIN_TIMEOUT_MS` | integer ms | Has default 300000 (exception) |
| `ENV.CHROME_CHANNEL` | `OUTLOOK_CLI_CHROME_CHANNEL` | string | Has default `"chrome"` (exception) |
| `ENV.SESSION_FILE` | `OUTLOOK_CLI_SESSION_FILE` | path | Optional, defaults to `$HOME/.outlook-cli/session.json` |
| `ENV.PROFILE_DIR` | `OUTLOOK_CLI_PROFILE_DIR` | path | Optional, defaults to `$HOME/.outlook-cli/playwright-profile` |
| `ENV.TZ` | `OUTLOOK_CLI_TZ` | IANA tz string | Optional, defaults to system TZ |
| `ENV.CAL_FROM` | `OUTLOOK_CLI_CAL_FROM` | string | Optional, defaults to `"now"` |
| `ENV.CAL_TO` | `OUTLOOK_CLI_CAL_TO` | string | Optional, defaults to `"now + 7d"` |

**Helper functions** (all private except `loadConfig`):
- `resolveOptionalInt(settingName, flagValue, envName, flagLabel, defaultValue)` (`src/config/config.ts:153`) — CLI flag > env > default; rejects non-positive integers.
- `resolveOptionalString(flagValue, envName, defaultValue)` (`src/config/config.ts:194`) — CLI flag > env > default; treats empty string as unset.
- `parseIntEnv(envName, settingName, checkedSources)` (`src/config/config.ts:116`) — parse + validate integer env var.

**`DEFAULTS` constant** (`src/config/config.ts:104-108`):
```typescript
export const DEFAULTS = {
  HTTP_TIMEOUT_MS: 30_000,
  LOGIN_TIMEOUT_MS: 300_000,
  CHROME_CHANNEL: 'chrome',
} as const;
```

**Error type raised:** `ConfigurationError` from `src/config/errors.ts:36` — code `'CONFIG_MISSING'`, exit 3.
```typescript
new ConfigurationError(missingSetting, checkedSources, detail?)
```
The `checkedSources` array is surfaced verbatim in the JSON error payload under `checkedSources`.

**Current .env support:** None. `loadConfig` reads only `process.env`. It does NOT call `dotenv` or read any `.env` file. The agent's `loadAgentConfig` must call `dotenv.config()` BEFORE `loadConfig` (or before any `process.env` reads) so that `.env` values land in `process.env` with the correct precedence (dotenv's `override: false` default ensures process env takes priority over `.env`).

---

## 8. Output Formatter & Exit Code Conventions

### Output formatter

**File:** `src/output/formatter.ts`

```typescript
// src/output/formatter.ts:35
export function formatOutput<T>(
  data: T | T[],
  mode: OutputMode,                // 'json' | 'table'
  columns?: ColumnSpec<T>[],       // required in 'table' mode
): string
```

- `'json'` mode: `JSON.stringify(data, null, 2)`.
- `'table'` mode: ASCII-only hand-rolled table (header + `---` separator + rows). No third-party dep.
- `ColumnSpec<T>`: `{ header: string; extract: (row: T) => string; maxWidth?: number }` — ellipsis truncation in middle of cell.

In `cli.ts`, output is always emitted via `emitResult` at `src/cli.ts:385-397`:
```typescript
// src/cli.ts:385-397
function emitResult(data, mode, columns?) {
  if (mode === 'table' && columns) {
    process.stdout.write(formatOutput(data, 'table', columns) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
```

Mode is resolved by `resolveOutputMode(g: GlobalOpts)` at `src/cli.ts:163-175`. The `--json` flag has `.default(true)` so when neither is explicit, JSON is used. `--table` wins only when explicitly passed; both explicit → exit 2.

The agent command must use the same `emitResult` / `formatOutput` pattern. For agent-specific `--table` output (final answer + tool-call summary table), the agent will define its own `ColumnSpec[]` array in `cli.ts` following the column-definition pattern at `src/cli.ts:213-357`.

### Exit codes

**File:** `src/cli.ts:481-508` (`exitCodeFor`):

| Code | Error type / condition |
|---|---|
| 0 | Success |
| 1 | Unexpected / unknown error |
| 2 | `CommanderLikeError`, commander errors, `UsageError` |
| 3 | `ConfigurationError` |
| 4 | `AuthError` (CLI layer), `AuthCaptureError` |
| 5 | `UpstreamError` |
| 6 | `IoError`, `CollisionError` |

The agent must reuse the same `reportError` / `exitCodeFor` functions and map its own new errors (`CONFIG_ENV_FILE_NOT_FOUND`, provider errors) to these same codes.

---

## 9. Utility Helpers Available

| File | Exports | Use in agent |
|---|---|---|
| `src/util/dates.ts` | `parseTimestamp(raw): TimestampParseResult` | Tool adapters for `list_mail`, `list_calendar` date window args |
| `src/util/filename.ts` | `sanitizeAttachmentName`, `deduplicateFilename`, `assertWithinDir` | `download_attachments` tool adapter (already handles filename safety) |
| `src/util/fs-atomic.ts` | `atomicWriteJson`, `atomicWriteBuffer`, `readJsonFile` | Log file writes; `.env` file if persisting anything |
| `src/util/redact.ts` | `redactHeaders(headers)`, `redactJwt(token)`, `redactString(s)` | API key redaction in log lines (FR-9); apply to all provider SDK output |
| `src/auth/lock.ts` | `acquireLock(path): release fn` | Available but agent does not need a lock |
| `src/auth/jwt.ts` | JWT decode helpers | Available for token inspection if needed |
| `src/session/store.ts` | `loadSession`, `saveSession`, `isExpired`, `deleteSession` | Used internally by `ensureSession`; agent calls `ensureSession` indirectly |

`redactString` (`src/util/redact.ts:78`) scrubs any run of 100+ base64-URL chars. This is the primary guard against API keys appearing in log output. The agent's log sink must pipe all messages through `redactString` before writing.

---

## 10. Testing Conventions

**Test directory:** `test_scripts/`
**Config:** `vitest.config.ts` — `include: ['test_scripts/**/*.spec.ts']`, `environment: 'node'`
**Run:** `npm test` → `vitest run`

### Mock pattern for OutlookClient

All tests supply a stub `OutlookClient` via `deps.createClient`. There is no shared mock factory — each spec file defines its own `makeStubClient()` using `vi.fn()`:

```typescript
// test_scripts/commands-list-mail-folder.spec.ts:124-148
function makeStubClient(): StubClient {
  const stub = {
    get: vi.fn(async () => { throw new Error('stub: client.get not configured'); }),
    listFolders: vi.fn(async () => { throw new Error('stub: not configured'); }),
    // ... one vi.fn() per OutlookClient method ...
    listMessagesInFolder: vi.fn(async () => { throw new Error('stub: not configured'); }),
  };
  return stub as unknown as StubClient;
}
```

Tests then wire only the methods needed:
```typescript
client.listMessagesInFolder.mockResolvedValueOnce([makeMessage('msg1')]);
```

### Deps builder pattern

```typescript
// test_scripts/commands-list-mail-folder.spec.ts:150-178
function makeDeps(overrides = {}): { deps: ListMailDeps; client: StubClient } {
  const client = overrides.client ?? makeStubClient();
  const deps: ListMailDeps = {
    config: buildFakeConfig(),
    sessionPath: config.sessionFilePath,
    loadSession: async () => buildFakeSession(),
    saveSession: async () => { /* no-op */ },
    doAuthCapture: async () => { throw new Error('should not be called'); },
    createClient: () => client,
  };
  return { deps, client };
}
```

### Session fake

```typescript
// test_scripts/commands-list-mail-folder.spec.ts:32-61
// Uses JWT_SHAPED_TOKEN = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc' (short enough to
// bypass redactString's 100-char threshold)
// Sets bearer.expiresAt = '2099-04-21T12:00:00.000Z' so isExpired() returns false
```

### Spec file naming

`test_scripts/<module>[-<feature>].spec.ts` — examples:
- `outlook-client.spec.ts` — HTTP client retry/error tests
- `outlook-client-folders.spec.ts` — folder-specific client tests
- `commands-list-mail-folder.spec.ts` — list-mail with folder flags
- `commands-move-mail.spec.ts` — move-mail command
- `config.spec.ts` — config loader
- `formatter.spec.ts` — output formatter

### Agent spec filename convention (recommended)

- `test_scripts/commands-agent.spec.ts` — full ReAct loop with MockChatModel
- `test_scripts/agent-provider-registry.spec.ts` — provider factory tests
- `test_scripts/agent-config.spec.ts` — .env loading + precedence tests
- `test_scripts/agent-tools.spec.ts` — individual tool adapter tests
- `test_scripts/agent-redact.spec.ts` — redaction filter tests

### vitest import style

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
```

No `@jest/globals` — vitest globals used directly.

---

## 11. Integration Points for the New `agent` Command

### Checklist

1. **New source file: `src/commands/agent.ts`**
   - Template to copy: `src/commands/auth-check.ts` (simplest deps shape, clear return type, error propagation).
   - Must export `async function run(deps: AgentDeps, prompt: string|null, opts: AgentOptions): Promise<AgentResult>`.
   - `AgentDeps` must extend `CommandDeps` (same shape as every other command deps interface).

2. **CLI registration: `src/cli.ts`**
   - Add `import * as agentCmd from './commands/agent'` with the other command imports (around `src/cli.ts:48-60`).
   - Register using `program.command('agent')...action(makeAction<AgentOptions, ...>(program, ...))` following the same pattern as every other subcommand. First registration point after the last existing subcommand is around `src/cli.ts:947`.
   - Access global flags via `deps.config` (already parsed by `buildDeps` inside `makeAction`).
   - Add agent-specific `ColumnSpec[]` constant near `src/cli.ts:213` for `--table` output.

3. **Config loader: `src/config/config.ts`**
   - Do NOT modify `loadConfig` or `CliConfig` — the agent has its own config domain.
   - Create a NEW module `src/config/agent-config.ts` that:
     - Calls `dotenv.config({ path: envFilePath, override: false })` FIRST.
     - Then reads `process.env` for all `OUTLOOK_AGENT_*` vars.
     - Reuses `ConfigurationError` from `src/config/errors.ts` for missing required vars (same `code: 'CONFIG_MISSING'`, same `missingSetting` / `checkedSources` fields).
     - Reuses `resolveOptionalInt` / `resolveOptionalString` pattern (these are private in `config.ts` but can be duplicated or extracted).
   - Do NOT add `OUTLOOK_AGENT_*` vars to `ENV` in `config.ts` — keep the two config domains separate.

4. **CommandDeps / context type**
   - There is no dedicated `CommandContext` type. All commands receive `CommandDeps` (defined inline in `cli.ts:80-87`).
   - The agent's `AgentDeps` should extend this same shape. Coders should add it:
     ```typescript
     export interface AgentDeps extends CommandDeps { /* nothing extra needed */ }
     ```
   - The agent accesses the Outlook client via `deps.createClient(session)` exactly as all other commands do.

5. **Output formatter pattern**
   - Call `emitResult(result, resolveOutputMode(g))` in the `makeAction` handler in `cli.ts` (not inside `commands/agent.ts`).
   - Define `AGENT_TABLE_COLUMNS: ColumnSpec<AgentStepRow>[]` in `cli.ts` for `--table` step summary.
   - For `--json`: `emitResult(agentResult, mode)` — no columns needed (JSON stringify handles it).
   - `AgentResult` JSON shape must match the envelope in FR-8 exactly.

6. **Error → exit-code mapping**
   - Reuse `exitCodeFor` and `reportError` from `src/cli.ts:481-519` — no changes needed.
   - New agent errors map to existing codes:
     - `ConfigurationError` (missing provider env var) → exit 3 (already handled).
     - `AuthError` (`--no-auto-reauth` triggered) → exit 4 (already handled).
     - Provider SDK 4xx/5xx → wrap in `UpstreamError` → exit 5.
     - `.env` file not found → `ConfigurationError` with `missingSetting: 'envFile'` → exit 3.
     - SIGINT → `process.exit(130)` (special case, not caught by `reportError`).

7. **vitest conventions for agent tests**
   - Use `vi.fn()` stub pattern for `OutlookClient` (copy `makeStubClient` from any commands spec).
   - Use a `MockChatModel` (from `@langchain/core/utils/testing` or a local double) for the LLM.
   - Mock `dotenv.config` with `vi.mock('dotenv')` to test `.env` precedence without touching the filesystem.
   - Follow `test_scripts/commands-list-mail-folder.spec.ts` as the structural template.
   - Spec files in `test_scripts/`, named `agent-*.spec.ts`.

---

## 12. Risks / Sharp Edges

### CJS vs ESM

The project compiles to CommonJS (`"type": "commonjs"`, `tsconfig module: "commonjs"`). LangGraph.js (`@langchain/langgraph`), LangChain core (`@langchain/core`), and all provider packages are published as dual-mode or ESM-only. `esModuleInterop: true` in tsconfig is set and helps with default imports, but the team MUST verify at install time that every LangChain package's CJS build is importable from Node.js CommonJS without dynamic import(). As of mid-2025 all `@langchain/*` packages ship CJS builds, but this should be verified against the exact installed versions. If any package requires ESM, the project either needs `"type": "module"` (a significant migration) or must use `import()` dynamic imports at the call site.

### zod not yet a dependency

`npm ls zod` returns empty. Zod must be added explicitly: `npm install zod`. Tool schemas in FR-6 use `z.object(...)`. Verify that `@langchain/core`'s peer dependency on zod matches the version added.

### TypeScript ^6.0.3

This is a cutting-edge TypeScript version (6.x is still pre-release as of April 2026). LangChain packages may ship type declarations targeting TS 4.x or 5.x. Run `tsc --noEmit` after installing to surface any type incompatibilities. The `skipLibCheck: true` in tsconfig will suppress third-party `.d.ts` errors, which may hide real issues.

### No `resolveRequiredString` helper in config.ts

`src/config/config.ts` only exports `resolveOptionalInt`, `resolveOptionalString`, and `DEFAULTS`. There is no `resolveRequiredString` that would throw `ConfigurationError` on missing values — that pattern is implemented inline in each caller using `??` chains. The agent's `loadAgentConfig` must implement its own `resolveRequired` pattern, reusing `ConfigurationError` from `src/config/errors.ts`.

### dotenv precedence semantics

`dotenv.config({ override: false })` (the default) only sets `process.env` keys that are NOT already set — this is the correct behavior for "process env > .env" precedence. Calling `dotenv.config()` must happen BEFORE any `process.env` reads (including the `CliConfig` load via `loadConfig`). The safest place is at the very top of the `agent` action handler in `cli.ts`, before `buildDeps` is called. Since `makeAction` calls `buildDeps` inside it, `dotenv.config()` must be called in the commander action wrapper before `makeAction` runs, or the agent command must use a custom action pattern that loads dotenv first.

### move-mail id invalidation

The agent spec (§8.8) notes that moved messages get new ids. Tool adapters wrapping `move-mail` must convey this clearly in tool descriptions and output, as the LLM may attempt to chain the original id in a follow-up call. The `MoveMailResult.moved[].newId` field is the correct id to use after a move.

### create-folder idempotency default differs from CLI

The CLI's `create-folder` defaults `--idempotent` to `false` (`src/cli.ts:869`). The agent tool catalog spec (D-5) requires the agent-facing `create_folder` tool to default `idempotent: true`. The tool adapter must pass `idempotent: true` explicitly rather than relying on the CLI default.

### No lock around agent run

`src/auth/lock.ts` provides a PID advisory lock used by the login flow to prevent concurrent browser captures. The agent does not need this for read operations, but if `--no-auto-reauth` is false and the auth-check on boot triggers a re-auth, the existing `doAuthCapture` closure in `buildDeps` already calls `captureOutlookSession` which presumably holds the lock. This path is inherited for free.

### Auth-check before graph start

Per FR-7 / D-8, the agent runs `auth-check` ONCE before constructing the LangGraph graph. Since `auth-check.run` uses `noAutoReauth: true` internally (`src/commands/auth-check.ts:62`), a non-`ok` result does NOT trigger re-auth by itself. The agent's boot sequence must explicitly call `ensureSession` or the full re-auth flow if `auth-check` returns `expired`/`missing`/`rejected`.

---

## Existing Docs to Update

| File | Required update |
|---|---|
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/CLAUDE.md` | Add `<agent>` tool block following the project's `<toolName>` schema |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md` | Add `agent` module layout, provider registry, agent config, ReAct wiring |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/configuration-guide.md` | Add all `OUTLOOK_AGENT_*` env vars with purpose, required/optional, obtain-from |
| `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/.gitignore` | Add `.env` and `.env.*` (except `.env.example`) per NFR-2 |
