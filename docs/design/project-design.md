# Project Design: Outlook CLI

Design date: 2026-04-21
Status: First complete technical design — replaces any previous `project-design.md`.

This document is the **authoritative contract** that multiple coders will follow to
implement the Outlook CLI in parallel. Every module interface below is normative: coders
must not drift from the signatures, types, error classes, or exit-code mappings.

Inputs consumed (in priority order):

1. `docs/design/refined-request-outlook-cli.md`
2. `docs/design/plan-001-outlook-cli.md`
3. `docs/design/investigation-outlook-cli.md`
4. `docs/research/playwright-token-capture.md`
5. `docs/research/outlook-v2-attachments.md`
6. `docs/reference/codebase-scan-outlook-cli.md`
7. `CLAUDE.md`

Folder-management extension (§10, ADR-13..ADR-16) additionally consumes:

8. `docs/design/refined-request-folders.md`
9. `docs/design/plan-002-folders.md`
10. `docs/design/investigation-folders.md`
11. `docs/research/outlook-v2-folder-pagination-filter.md`
12. `docs/research/outlook-v2-move-destination-alias.md`
13. `docs/research/outlook-v2-folder-duplicate-error.md`
14. `docs/reference/codebase-scan-folders.md`

---

## 1. System Overview

Text-based component diagram. Arrows show runtime call direction; boxes group files by
layer. "Out-of-process" dependencies are labeled.

```
                        ┌──────────────────────────────────────────┐
                        │              user / shell                │
                        │     $ outlook-cli <verb> [flags]         │
                        └──────────────────┬───────────────────────┘
                                           │ argv, env
                                           ▼
                        ┌──────────────────────────────────────────┐
                        │        src/cli.ts  (bin entry)           │
                        │  - #!/usr/bin/env node                   │
                        │  - commander bootstrap                   │
                        │  - top-level try/catch → exit codes      │
                        └──────────────────┬───────────────────────┘
                                           │
              ┌────────────────────────────┼──────────────────────────┐
              ▼                            ▼                          ▼
   ┌────────────────────┐   ┌───────────────────────────┐  ┌─────────────────────┐
   │  src/config/       │   │  src/commands/<verb>.ts   │  │  src/output/        │
   │  config.ts         │   │  (login, auth-check,      │  │  formatter.ts       │
   │  errors.ts         │   │   list-mail, get-mail,    │  │  (JSON / table)     │
   │  (flag > env)      │   │   download-attachments,   │  └─────────────────────┘
   └──────────┬─────────┘   │   list-calendar,          │
              │             │   get-event)              │
              │             └───────────┬───────────────┘
              │                         │
              │      ┌──────────────────┼────────────────────┐
              │      ▼                  ▼                    ▼
              │ ┌──────────────┐ ┌──────────────────┐ ┌──────────────────┐
              │ │ src/session/ │ │ src/auth/        │ │ src/http/        │
              │ │ store.ts     │ │ browser-capture  │ │ outlook-client   │
              │ │ schema.ts    │ │ jwt.ts, lock.ts  │ │ errors.ts        │
              │ │ (0600 file,  │ │ (Playwright +    │ │ (native fetch +  │
              │ │  atomic fs)  │ │  init-script +   │ │  AbortController │
              │ │              │ │  exposeBinding)  │ │  + 401 retry-once│
              │ └──────┬───────┘ └─────────┬────────┘ └─────────┬────────┘
              │        │                   │                    │
              │        │                   │                    │
              ▼        ▼                   ▼                    ▼
       ┌────────────────────┐    ┌──────────────────────┐  ┌────────────────────┐
       │ src/util/          │    │  out-of-process:     │  │  out-of-process:   │
       │  fs-atomic.ts      │    │  headed Chrome       │  │  outlook.office.com│
       │  filename.ts       │    │  (Playwright         │  │  /api/v2.0/*       │
       │                    │    │   launchPersistent-  │  │  /ows/*            │
       │ (used by session,  │    │   Context)           │  │                    │
       │  download-attach)  │    └──────────────────────┘  └────────────────────┘
       └────────────────────┘
```

Dataflow (happy path for any data command):

1. `cli.ts` parses argv → resolves `CliConfig` via `config.ts` (throws `ConfigurationError`
   if mandatory settings missing).
2. Command module calls `session/store.loadSession(path)` → `SessionFile | null`.
3. If null or `isExpired()` → invoke `auth/browser-capture.captureOutlookSession(...)` via
   the command's `onReauthNeeded` callback, then `store.saveSession(...)`.
4. Build `OutlookClient` via `http/outlook-client.createOutlookClient({ session, ... })`.
5. `client.get(path, query)` → native `fetch` → JSON response or typed error.
6. On `401`: one-shot invocation of `onReauthNeeded`, rebuild client with refreshed
   session, retry once. Any further failure → `AuthError` exit 4.
7. Command module shapes the result and passes it to `output/formatter.formatOutput` for
   stdout emission.
8. `cli.ts` catches any thrown error and maps its class to an exit code.

---

## 2. Module-by-Module Interface Contracts

Every TypeScript signature below is **normative**. Coders must implement the exported
identifiers exactly as listed. Additional private helpers inside each module are allowed
but public types / function signatures must not drift.

All modules use:

- CommonJS (`"type": "commonjs"` in `package.json`, unchanged).
- Strict TypeScript (`strict: true`, unchanged).
- Node built-ins imported via `node:` prefix: `import fs from 'node:fs'`, etc.

---

### 2.1 `src/config/config.ts` — Configuration resolver

```typescript
// src/config/config.ts

export type OutputMode = 'json' | 'table';
export type BodyMode   = 'html' | 'text' | 'none';

/**
 * The fully resolved configuration object for a single CLI invocation.
 * Every field marked "mandatory" in the refined spec §8 is non-optional here;
 * loadConfig() throws ConfigurationError if any such field is unresolved.
 */
export interface CliConfig {
  // ── Mandatory (throw ConfigurationError if unresolved) ────────────────────
  /** Per-REST-call HTTP timeout in milliseconds. Spec §8 mandatory. */
  httpTimeoutMs: number;
  /** Max wall-clock time to wait for interactive login + first Bearer capture. */
  loginTimeoutMs: number;
  /** Playwright Chrome channel: e.g. "chrome", "msedge", "chrome-beta". */
  chromeChannel: string;

  // ── Optional with explicit defaults allowed by spec §8 ────────────────────
  /** Path to the session file. Default: $HOME/.outlook-cli/session.json. */
  sessionFilePath: string;
  /** Path to the Playwright persistent profile directory (mode 0700). */
  profileDir: string;
  /** IANA timezone. Default: process.env.TZ ?? Intl DateTimeFormat system tz. */
  tz: string;
  /** Default output mode when neither --json nor --table is passed. */
  outputMode: OutputMode;
  /** Default --top for list-mail. Range 1..100. */
  listMailTop: number;
  /** Default --folder for list-mail. */
  listMailFolder: string;
  /** Default --body format for get-mail / get-event. */
  bodyMode: BodyMode;
  /** Calendar window start. ISO8601 string. Default: "now" (resolved at call time). */
  calFrom: string;
  /** Calendar window end. ISO8601 string. Default: "now + 7d". */
  calTo: string;
  /** When true, suppress progress messages on stderr. */
  quiet: boolean;
  /** When set, the session-file path override from --session-file flag. */
  sessionFileOverride?: string;
  /** When true, 401 or expired session does NOT trigger browser re-auth. */
  noAutoReauth: boolean;
  /** Optional path to a debug log file. When unset, no log file is written. */
  logFilePath?: string;
}

/** Partial of CliConfig representing flags collected from commander argv. */
export type CliFlags = Partial<{
  httpTimeoutMs: number;
  loginTimeoutMs: number;
  chromeChannel: string;
  sessionFilePath: string;
  profileDir: string;
  tz: string;
  outputMode: OutputMode;
  listMailTop: number;
  listMailFolder: string;
  bodyMode: BodyMode;
  calFrom: string;
  calTo: string;
  quiet: boolean;
  sessionFileOverride: string;
  noAutoReauth: boolean;
  logFilePath: string;
}>;

/**
 * Resolve the full CliConfig using precedence: CLI flag > environment variable
 * > explicit default (only where spec §8 allows one). Mandatory fields without
 * any resolved value throw ConfigurationError.
 *
 * @param cliFlags Partial CliConfig populated from commander options.
 * @throws ConfigurationError with .missingSetting naming the first unresolved
 *         mandatory key and .checkedSources listing the precedence chain tried.
 */
export function loadConfig(cliFlags: CliFlags): CliConfig;

/**
 * Environment variable names consumed by loadConfig. Exported for tests and
 * for the configuration-guide document.
 */
export const ENV: {
  readonly HTTP_TIMEOUT_MS: 'OUTLOOK_CLI_HTTP_TIMEOUT_MS';
  readonly LOGIN_TIMEOUT_MS: 'OUTLOOK_CLI_LOGIN_TIMEOUT_MS';
  readonly CHROME_CHANNEL: 'OUTLOOK_CLI_CHROME_CHANNEL';
  readonly SESSION_FILE: 'OUTLOOK_CLI_SESSION_FILE';
  readonly PROFILE_DIR: 'OUTLOOK_CLI_PROFILE_DIR';
  readonly TZ: 'OUTLOOK_CLI_TZ';
  readonly CAL_FROM: 'OUTLOOK_CLI_CAL_FROM';
  readonly CAL_TO: 'OUTLOOK_CLI_CAL_TO';
};
```

**Field matrix — mandatory vs. optional defaults:**

| Field | Mandatory? | Flag | Env | Default if unresolved |
|---|---|---|---|---|
| `httpTimeoutMs` | Yes | `--timeout` | `OUTLOOK_CLI_HTTP_TIMEOUT_MS` | throws `ConfigurationError` |
| `loginTimeoutMs` | Yes | `--login-timeout` | `OUTLOOK_CLI_LOGIN_TIMEOUT_MS` | throws `ConfigurationError` |
| `chromeChannel` | Yes | `--chrome-channel` | `OUTLOOK_CLI_CHROME_CHANNEL` | throws `ConfigurationError` |
| `sessionFilePath` | No | `--session-file` | `OUTLOOK_CLI_SESSION_FILE` | `$HOME/.outlook-cli/session.json` |
| `profileDir` | No | `--profile-dir` | `OUTLOOK_CLI_PROFILE_DIR` | `$HOME/.outlook-cli/playwright-profile` |
| `tz` | No | `--tz` | `OUTLOOK_CLI_TZ` | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| `outputMode` | No | `--json`/`--table` | — | `'json'` |
| `listMailTop` | No | `-n`/`--top` | — | `10` |
| `listMailFolder` | No | `--folder` | — | `'Inbox'` |
| `bodyMode` | No | `--body` | — | `'text'` |
| `calFrom` | No | `--from` | `OUTLOOK_CLI_CAL_FROM` | `"now"` (resolved at call site) |
| `calTo` | No | `--to` | `OUTLOOK_CLI_CAL_TO` | `"now + 7d"` (resolved at call site) |
| `quiet` | No | `--quiet` | — | `false` |
| `sessionFileOverride` | No | `--session-file` | — | `undefined` |
| `noAutoReauth` | No | `--no-auto-reauth` | — | `false` |
| `logFilePath` | No | `--log-file` | — | `undefined` |

**Enforcement rule**: if any mandatory field cannot be resolved, throw a
`ConfigurationError`. No silent defaults. Do NOT, for example, fall back to `30_000` for
`httpTimeoutMs` — that is exactly what the project convention forbids.

---

### 2.2 `src/config/errors.ts` — Typed error classes

```typescript
// src/config/errors.ts

/** Base for all CLI errors. Carries an exit code. */
export abstract class OutlookCliError extends Error {
  /** Stable, machine-friendly code (e.g. "CONFIG_MISSING"). */
  public abstract readonly code: string;
  /** CLI exit code (spec §5). */
  public abstract readonly exitCode: number;
  /** Underlying cause, if any. MUST NOT leak tokens or cookie values. */
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

/**
 * Thrown when a mandatory configuration setting cannot be resolved.
 * Exit code 3.
 */
export class ConfigurationError extends OutlookCliError {
  public readonly code = 'CONFIG_MISSING';
  public readonly exitCode = 3;
  /** Name of the unresolved mandatory setting (e.g. "httpTimeoutMs"). */
  public readonly missingSetting: string;
  /** Ordered list of sources checked (e.g. ["--timeout flag", "OUTLOOK_CLI_HTTP_TIMEOUT_MS"]). */
  public readonly checkedSources: readonly string[];

  constructor(missingSetting: string, checkedSources: readonly string[]);
}

/**
 * Thrown on auth capture failure: user cancellation, login timeout, second 401.
 * Exit code 4.
 */
export class AuthError extends OutlookCliError {
  public readonly code: 'AUTH_LOGIN_CANCELLED' | 'AUTH_LOGIN_TIMEOUT' | 'AUTH_401_AFTER_RETRY' | 'AUTH_NO_REAUTH';
  public readonly exitCode = 4;
  constructor(code: AuthError['code'], message: string, cause?: unknown);
}

/**
 * Thrown on any non-401 upstream HTTP error, network error, or abort.
 * Exit code 5.
 */
export class UpstreamError extends OutlookCliError {
  public readonly code: string; // e.g. "UPSTREAM_HTTP_403", "UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK"
  public readonly exitCode = 5;
  public readonly httpStatus?: number;
  public readonly requestId?: string;
  public readonly url?: string;   // redacted of query-string tokens
  constructor(init: {
    code: string;
    message: string;
    httpStatus?: number;
    requestId?: string;
    url?: string;
    cause?: unknown;
  });
}

/**
 * Thrown on file-system errors: session file read/write, output dir, attachment
 * overwrite guard, etc. Exit code 6.
 */
export class IoError extends OutlookCliError {
  public readonly code: string; // e.g. "IO_WRITE_EEXIST", "IO_MKDIR_EACCES"
  public readonly exitCode = 6;
  public readonly path?: string;
  constructor(init: { code: string; message: string; path?: string; cause?: unknown });
}
```

**Exit-code mapping** (referenced by `src/cli.ts` top-level handler):

| Error class | Exit code |
|---|---|
| `ConfigurationError` | 3 |
| `AuthError` | 4 |
| `UpstreamError` | 5 |
| `IoError` | 6 |
| Any other `Error` | 1 (unexpected) |
| `commander` argv error | 2 (handled by commander) |

**Redaction contract**: No constructor may place the bearer token, cookie values, or
any header dictionary containing them into `.message`, `.stack`, or `.cause`. Tests in
`test_scripts/ac-no-secret-leak.ts` enforce this.

---

### 2.3 `src/session/schema.ts` — Session file types + validator

```typescript
// src/session/schema.ts

/** Playwright cookie shape, persisted 1:1 in the session file. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix epoch seconds; -1 for session cookies. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface BearerInfo {
  /** Raw JWT. Never logged. */
  token: string;
  /** ISO8601 UTC, derived from JWT `exp` claim. */
  expiresAt: string;
  /** JWT `aud` claim. */
  audience: string;
  /** JWT `scp`/`scope` claim split on whitespace. Empty array if absent. */
  scopes: string[];
}

export interface Account {
  /** User principal name (e.g. "alice@contoso.com"). */
  upn: string;
  /** Put/object ID from JWT `oid` (or `puid` if present). */
  puid: string;
  /** Tenant ID from JWT `tid`. */
  tenantId: string;
}

/** Matches refined spec §7.2 exactly. */
export interface SessionFile {
  /** Schema version. Currently 1. Bump on breaking changes. */
  version: 1;
  /** ISO8601 UTC, set at write time. */
  capturedAt: string;
  account: Account;
  bearer: BearerInfo;
  cookies: Cookie[];
  /** Pre-computed convenience: "PUID:<puid>@<tenantId>". */
  anchorMailbox: string;
}

/**
 * Runtime validator. Returns the typed object on success, throws IoError
 * ("IO_SESSION_CORRUPT") on any structural mismatch.
 *
 * Does NOT fetch or verify the JWT signature. Only shape checking.
 */
export function validateSessionJson(raw: unknown): SessionFile;
```

**Validator rules** (enforced by `validateSessionJson`):

- `version === 1` — any other value → corrupt.
- `capturedAt` parses via `new Date(...)` to a valid Date.
- `account.upn`, `account.puid`, `account.tenantId` are non-empty strings.
- `bearer.token` is a non-empty string starting with three base64url-like segments
  (regex `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`).
- `bearer.expiresAt` parses to a valid Date.
- `bearer.audience` is a non-empty string.
- `bearer.scopes` is an array of strings (may be empty).
- `cookies` is an array (may be empty); each element has all seven fields, correct types.
- `anchorMailbox` starts with `PUID:` and contains `@`.

Partial matches must be rejected rather than coerced.

---

### 2.4 `src/session/store.ts` — Atomic persistence

```typescript
// src/session/store.ts

import { SessionFile } from './schema';

/**
 * Read a session file if present. Returns null when the file does not exist.
 * Throws IoError on read / parse / validation failure.
 *
 * Side effects: none (no writes, no chmod).
 */
export async function loadSession(path: string): Promise<SessionFile | null>;

/**
 * Persist the session file atomically with mode 0600. The parent directory is
 * created with mode 0700 if absent.
 *
 * Implementation requirements:
 *  1. mkdir parent recursive with mode 0o700, then defensive chmod 0o700 on
 *     the exact parent dir (not intermediate dirs created by recursive mkdir).
 *  2. Write to a sibling temp file in the SAME directory, using
 *     fs.open(tmp, 'wx', 0o600) so the file is 0600 from inception (no
 *     chmod-after-write race window).
 *  3. fsync(fd) before close (see §2.10 and ADR-09).
 *  4. fs.rename(tmp, finalPath) — atomic on the same filesystem.
 *  5. On any error, unlink the temp file if it exists and rethrow wrapped in
 *     IoError.
 *
 * @throws IoError("IO_SESSION_WRITE")
 */
export async function saveSession(path: string, s: SessionFile): Promise<void>;

/**
 * Return true if the bearer token is expired relative to `nowMs` (default: Date.now()).
 * A 60-second grace window is applied: if `nowMs + 60_000 >= bearer.expiresAt`,
 * the session is considered expired (per refined spec §6.1).
 */
export function isExpired(s: SessionFile, nowMs?: number): boolean;

/**
 * Delete the session file if it exists. No-op if it does not.
 * Used by tests and by `login --force`.
 */
export async function deleteSession(path: string): Promise<void>;
```

**Permission enforcement** (normative):

- Session dir `mode 0o700`.
- Session file `mode 0o600`.
- Temp file used during atomic write: `mode 0o600` from `open(..., 'wx', 0o600)`.
- After `rename()`, the final file inherits the temp file's mode.

---

### 2.5 `src/auth/jwt.ts` — Manual JWT payload decoder

```typescript
// src/auth/jwt.ts

/**
 * Minimal subset of standard + Microsoft claims we care about.
 * Unknown keys are preserved via the index signature.
 */
export interface JwtClaims {
  /** Expiration time — Unix epoch seconds. */
  exp: number;
  /** Audience (e.g. "https://outlook.office.com/"). */
  aud: string;
  /** Object ID — Microsoft-issued user id, matches `account.puid` in spec §7.2. */
  oid?: string;
  /** Alternate user id that some OWA tokens carry. Used as fallback for `puid`. */
  puid?: string;
  /** Tenant ID (directory id). */
  tid?: string;
  /** User principal name (enterprise). */
  upn?: string;
  /** Microsoft "preferred username" alternative to upn. */
  preferred_username?: string;
  /** Space-delimited scopes. */
  scp?: string;
  /** Array-of-strings alternate scope claim. */
  roles?: string[];
  [k: string]: unknown;
}

/**
 * Decode the payload section of a JWT without verifying the signature.
 *
 * Implementation must:
 *   - Accept a raw JWT ("Bearer " prefix must already be stripped by the caller).
 *   - Split on "." and take segment [1].
 *   - base64url-decode (replace URL-safe chars, pad, then Buffer.from(..., 'base64')).
 *   - JSON.parse the UTF-8 string.
 *
 * @throws Error with message "invalid JWT format" on any parse failure.
 *         (No custom class here — the caller wraps into AuthError as needed.)
 */
export function decodeJwt(token: string): JwtClaims;
```

---

### 2.6 `src/auth/lock.ts` — Advisory PID lock

```typescript
// src/auth/lock.ts

/**
 * Acquire an advisory lock at `path`. The lock file contains a JSON payload
 * { pid: number, startedAt: string } and is created exclusively (O_CREAT|O_EXCL,
 * mode 0o600).
 *
 * Algorithm:
 *   1. Attempt fs.openSync(path, 'wx', 0o600).
 *   2. On success, write { pid: process.pid, startedAt: new Date().toISOString() }.
 *   3. On EEXIST: read the lock file's pid.
 *      - If `process.kill(pid, 0)` succeeds → lock is held by a live process → throw
 *        AuthError("AUTH_LOGIN_CANCELLED", "another outlook-cli login is in progress").
 *      - If it throws ESRCH → stale lock. fs.unlink() the lock and retry from step 1
 *        (exactly once to avoid infinite loops).
 *      - If it throws EPERM (foreign user's PID) → treat as held; do not overwrite.
 *      - Also treat a lock older than max(loginTimeoutMs, 30 minutes) as stale.
 *   4. Register release on process `exit`, SIGINT, SIGTERM.
 *
 * @param path Absolute path to lock file (e.g. $HOME/.outlook-cli/.browser.lock).
 * @returns A release function. Idempotent (calling twice is safe).
 */
export async function acquireLock(path: string): Promise<() => Promise<void>>;

/** Stale-lock threshold: max(configured loginTimeoutMs, 30 * 60 * 1000). */
export function computeStaleThresholdMs(loginTimeoutMs: number): number;
```

---

### 2.7 `src/auth/browser-capture.ts` — Playwright token + cookie capture

```typescript
// src/auth/browser-capture.ts

import { Cookie } from '../session/schema';

export interface CaptureResult {
  bearer: {
    /** Raw JWT (no "Bearer " prefix). */
    token: string;
    /** ISO8601 UTC, derived from JWT exp. */
    expiresAt: string;
    /** From JWT aud. */
    audience: string;
    /** From JWT scp split on whitespace. May be []. */
    scopes: string[];
  };
  cookies: Cookie[];
  account: {
    upn: string;
    puid: string;
    tenantId: string;
  };
  /** Pre-computed "PUID:<puid>@<tenantId>". */
  anchorMailbox: string;
}

export interface CaptureOptions {
  /** Persistent Chrome profile dir. Created with mode 0700 if missing. */
  profileDir: string;
  /** Playwright channel — "chrome", "msedge", etc. */
  chromeChannel: string;
  /** Max wall-clock time waiting for first Bearer capture. */
  loginTimeoutMs: number;
  /** When true, the browser opens even if a cached profile could do silent SSO. */
  force?: boolean;
}

/**
 * Launch headed Chrome, install fetch/XHR init-script, wait for the first
 * Authorization: Bearer header sent to outlook.office.com, then harvest
 * cookies and resolve account metadata.
 *
 * Full sequence (must match docs/research/playwright-token-capture.md §2 + §9):
 *   1. mkdir profileDir with mode 0700, chmod 0700 defensively.
 *   2. chromium.launchPersistentContext(profileDir, { channel, headless: false,
 *        args: ['--no-first-run', '--no-default-browser-check'] }).
 *   3. context.exposeBinding('__outlookCliReportAuth', handler).
 *   4. context.addInitScript(INIT_SCRIPT_TEXT).
 *   5. page = context.pages()[0] ?? await context.newPage().
 *   6. Attach page.once('close') and context.once('close') guards that reject
 *      the capture promise with AuthError("AUTH_LOGIN_CANCELLED", "Browser closed
 *      before Bearer token was captured").
 *   7. setTimeout(loginTimeoutMs, → reject with AuthError("AUTH_LOGIN_TIMEOUT", ...)).
 *   8. page.goto('https://outlook.office.com/mail/', { waitUntil: 'domcontentloaded',
 *        timeout: loginTimeoutMs }).
 *   9. Await the capture promise: { token: "Bearer eyJ...", url: "..." }.
 *  10. Strip "Bearer " prefix from token.
 *  11. decodeJwt(token) → JwtClaims. expiresAt = new Date(claims.exp * 1000).toISOString().
 *  12. scopes = claims.scp?.split(/\s+/).filter(Boolean) ?? [].
 *  13. Resolve account:
 *       - puid    = claims.oid ?? claims.puid ?? (fallback: GET /api/v2.0/me).
 *       - tenantId = claims.tid ?? (fallback: GET /api/v2.0/me).
 *       - upn     = claims.upn ?? claims.preferred_username ?? (fallback: GET /api/v2.0/me).
 *       - If any is still missing, call GET https://outlook.office.com/api/v2.0/me
 *         with the freshly captured token and cookies, using a standalone fetch
 *         (do NOT depend on OutlookClient to avoid a circular dependency).
 *  14. cookies = await context.cookies([
 *        'https://outlook.office.com',
 *        'https://outlook.office365.com',
 *        'https://login.microsoftonline.com',
 *        'https://office.com',
 *      ]).
 *      Filter to domains ending in one of:
 *        '.office.com', '.outlook.office.com', '.outlook.office365.com',
 *        '.login.microsoftonline.com', '.microsoftonline.com', 'office.com'.
 *  15. anchorMailbox = `PUID:${puid}@${tenantId}`.
 *  16. Always context.close() in a finally block, even on error.
 *
 * @throws AuthError("AUTH_LOGIN_CANCELLED") when browser/page closes early.
 * @throws AuthError("AUTH_LOGIN_TIMEOUT")   when loginTimeoutMs elapses.
 * @throws UpstreamError                     when /me fallback fails (unexpected).
 */
export async function captureOutlookSession(opts: CaptureOptions): Promise<CaptureResult>;

/** The exact init-script string — reproduced verbatim from the research doc §9. */
export const INIT_SCRIPT_TEXT: string;
```

**INIT_SCRIPT_TEXT contents (normative):** The full JavaScript IIFE from
`docs/research/playwright-token-capture.md §9` must be embedded as a string constant
(triple-backtick template literal). Key invariants coders MUST NOT alter:

- `window.__outlookCliHooked` idempotency guard.
- `reported` closure flag for one-shot capture.
- `TARGET_PREFIXES` array listing `https://outlook.office.com/api/v2.0/`,
  `https://outlook.office.com/ows/`, and the `.office365.com` mirrors.
- `extractBearer(headers)` handles: Headers instance, Array tuple form, plain object.
- `fetch` patch handles `Request` instance as first argument.
- `XMLHttpRequest.prototype.open / setRequestHeader / send` patched.
- All instrumentation wrapped in `try/catch` so the real fetch/XHR is never blocked.
- `Object.setPrototypeOf` preserves XHR constants (`DONE`, `OPENED`, etc.).

**exposeBinding handler semantics:**

- Registered once via `context.exposeBinding('__outlookCliReportAuth', handler)`.
- Uses a local `alreadyResolved` flag so only the first call resolves the capture
  promise; all subsequent calls are silently ignored.
- Handler signature: `(_source: unknown, payload: { url: string; token: string }) =>
  void`.

---

### 2.8 `src/http/outlook-client.ts` — REST client

```typescript
// src/http/outlook-client.ts

import { SessionFile } from '../session/schema';

export interface OutlookClient {
  /**
   * GET a JSON resource. Returns the parsed body typed as T.
   *
   * @param path  Path starting with '/', e.g. '/api/v2.0/me/messages'.
   * @param query Optional query parameters. URL-encoded by the client.
   */
  get<T>(path: string, query?: Record<string, string>): Promise<T>;

  /**
   * GET binary content (used only for future $value support; not called in
   * the current iteration).
   */
  getBinary(path: string): Promise<Buffer>;
}

export interface CreateClientOptions {
  /** The active session. Re-read on every call so the client uses fresh state after a re-auth. */
  session: SessionFile;
  /** Mandatory; from CliConfig.httpTimeoutMs. */
  httpTimeoutMs: number;
  /** Called exactly once on HTTP 401 before retrying. Must return a new SessionFile. */
  onReauthNeeded: () => Promise<SessionFile>;
  /** When true, 401 throws AuthError immediately (no browser launch). */
  noAutoReauth: boolean;
}

export function createOutlookClient(opts: CreateClientOptions): OutlookClient;
```

**Request construction (normative):**

- Base URL: `https://outlook.office.com`. `path` must start with `/`.
- Query: URL-encode via `new URLSearchParams(query).toString()`; append with `?`.
- Headers (exact order of construction; case-insensitive on the wire):
  - `Authorization: Bearer <session.bearer.token>`
  - `X-AnchorMailbox: <session.anchorMailbox>`
  - `Accept: application/json`
  - `Cookie: <name1=value1; name2=value2; ...>` — serialized from `session.cookies`
    filtered to cookies whose `domain` matches `outlook.office.com` via RFC 6265 suffix
    rules. `httpOnly` cookies MUST be included (they are available on the jar even
    though hidden from `document.cookie`). `secure` cookies MUST be included (requests
    are HTTPS). Format: `name=value`, joined with `; `. Do NOT URL-encode cookie values.
  - For body-bearing endpoints (future): `Content-Type: application/json`.
- `AbortController`: `signal` is passed to `fetch`; a `setTimeout(httpTimeoutMs, abort)`
  fires if the request is not complete. On abort → `UpstreamError("UPSTREAM_TIMEOUT",
  ...)`.

**Re-auth / retry semantics:**

- Before every call, check `isExpired(session)`. If expired AND `!noAutoReauth` → call
  `onReauthNeeded()`, replace the internal session reference, then proceed.
- If `noAutoReauth` and session is expired → throw `AuthError("AUTH_NO_REAUTH", ...)`.
- On HTTP 401 response:
  - If `!noAutoReauth` AND this call has not already retried: call `onReauthNeeded()`,
    rebuild headers from the refreshed session, and retry the same request once.
  - If still 401 → `AuthError("AUTH_401_AFTER_RETRY", ...)`.
  - If `noAutoReauth` → `AuthError("AUTH_NO_REAUTH", ...)`.
- On HTTP 403/404 → `UpstreamError("UPSTREAM_HTTP_403" | "UPSTREAM_HTTP_404", ...)`.
- On HTTP 429 → `UpstreamError("UPSTREAM_HTTP_429", ...)`, include `Retry-After` header
  in the message if present.
- On HTTP 5xx → `UpstreamError("UPSTREAM_HTTP_5XX", ...)`, include `request-id` header.
- On network error / DNS / TLS → `UpstreamError("UPSTREAM_NETWORK", ...)`. Never include
  the auth header in any wrapping error.
- On `AbortError` → `UpstreamError("UPSTREAM_TIMEOUT", "HTTP timeout after ${ms}ms")`.

**Exit code mapping** is the responsibility of `src/cli.ts` via each error's `exitCode`
field; the client only throws the typed errors.

---

### 2.9 `src/http/errors.ts` — HTTP error mapping

```typescript
// src/http/errors.ts

import { AuthError, UpstreamError } from '../config/errors';

/**
 * Inspect a fetch Response + (already-consumed) body text and return the
 * appropriate typed error. Does NOT include the request Authorization header or
 * Cookie header in any field of the returned error.
 *
 * Responsibilities:
 *   - Extract `request-id` response header → include in UpstreamError.requestId.
 *   - Redact query-string tokens from `url` before storing (strip `$filter`,
 *     `access_token`, `code` params defensively — none are expected on GETs we
 *     issue, but belt-and-suspenders).
 *   - Truncate the body text to 512 chars when embedding in .message.
 *   - For 401, the caller (createOutlookClient) is responsible for the
 *     retry-once logic; mapHttpResponseToError is only called when the caller
 *     has decided to surface the error (either because noAutoReauth, or
 *     because this is the second 401). Returns AuthError in that case.
 */
export function mapHttpResponseToError(args: {
  response: Response;
  bodyText: string;
  url: string;
  isSecond401: boolean;
  noAutoReauth: boolean;
}): AuthError | UpstreamError;

/** Format an AbortError into UpstreamError("UPSTREAM_TIMEOUT", ...). */
export function mapAbortError(httpTimeoutMs: number, url: string): UpstreamError;

/** Wrap any non-HTTP network error (TypeError from fetch, TLS, DNS). */
export function mapNetworkError(cause: unknown, url: string): UpstreamError;
```

---

### 2.10 `src/util/fs-atomic.ts` — Atomic writes

```typescript
// src/util/fs-atomic.ts

export interface AtomicWriteOptions {
  /** Mode for the created file. Default: 0o600. */
  mode?: number;
  /** If true, an existing finalPath is overwritten. If false (default), EEXIST throws IoError. */
  overwrite?: boolean;
}

/**
 * Atomically write JSON content to `path`. Implementation:
 *   1. const dir = path.dirname(finalPath).
 *   2. fs.promises.mkdir(dir, { recursive: true, mode: 0o700 }).
 *   3. Defensive fs.promises.chmod(dir, 0o700).
 *   4. tmp = path.join(dir, `.${path.basename(finalPath)}.tmp.${pid}.${rand}`).
 *   5. fd = fs.openSync(tmp, 'wx', mode ?? 0o600).   // 'wx' = O_CREAT|O_EXCL|O_WRONLY
 *   6. fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n').
 *   7. fs.fsyncSync(fd)  — IMPORTANT: without fsync, rename() may land before the
 *                          bytes are on disk, and a crash/power-loss between the
 *                          rename and the delayed write leaves an empty/truncated
 *                          file where a valid session used to be.
 *   8. fs.closeSync(fd).
 *   9. If !overwrite: fs.promises.access(finalPath) → if exists, unlink(tmp) then
 *      throw IoError("IO_WRITE_EEXIST").
 *  10. fs.renameSync(tmp, finalPath)  — atomic on same filesystem.
 *  11. On any error after step 5: unlink tmp if it exists; rethrow wrapped in IoError.
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  options?: AtomicWriteOptions,
): Promise<void>;

/**
 * Same semantics as atomicWriteJson but for arbitrary Buffer content
 * (used by download-attachments).
 */
export async function atomicWriteBuffer(
  filePath: string,
  content: Buffer,
  options?: AtomicWriteOptions,
): Promise<void>;
```

**Why fsync matters (documented here per prompt requirement):** `rename()` on POSIX is
atomic with respect to directory entries but does NOT flush file data to disk. If we
write, rename, and then the system loses power, the rename may be persisted (the dirent
is updated) while the file data blocks are still in the page cache and lost. The result
is an empty or truncated `session.json` where a perfectly valid file used to be —
exactly the situation atomic writes are supposed to prevent. Calling `fsync(fd)` before
`close + rename` forces the data blocks out before we swap. The small perf cost is
irrelevant for an infrequently-written ~4 KB session file.

---

### 2.11 `src/util/filename.ts` — Attachment filename safety

Port the exact logic from `docs/research/outlook-v2-attachments.md §5.1`. Normative
signatures:

```typescript
// src/util/filename.ts

/**
 * Sanitize an attachment Name into a safe filesystem filename.
 * Algorithm: see docs/research/outlook-v2-attachments.md §5.1 steps 1-7.
 *
 * Guarantees:
 *   - No path separators, control chars, Windows-forbidden chars.
 *   - No Windows reserved device names (CON, NUL, COM1..9, LPT1..9).
 *   - No leading dots, no trailing dots or spaces.
 *   - UTF-8 byte length <= 243 (reserves 12 bytes for dedup suffix).
 *   - Non-empty (uses `fallback` when sanitization produces empty).
 *   - NFC-normalized.
 *
 * @param raw      The attachment Name field (may be null/undefined).
 * @param fallback Fallback name when sanitization produces empty (e.g. "attachment-${att.Id}").
 */
export function sanitizeAttachmentName(raw: string | null | undefined, fallback: string): string;

/**
 * Given a directory and a desired filename, return an absolute path that does
 * not already exist. Appends " (N)" suffix before the extension on collision.
 *
 * Defense in depth:
 *   - path.resolve(candidate) must start with path.resolve(dir) + path.sep.
 *     If not, throw IoError("IO_PATH_TRAVERSAL").
 *
 * @throws IoError("IO_PATH_TRAVERSAL") if the filename resolves outside dir.
 * @throws IoError("IO_DEDUP_EXHAUSTED") if no unique name found after 999 tries.
 */
export function deduplicateFilename(dir: string, filename: string): Promise<string>;
```

Constants (normative):

```typescript
export const WINDOWS_RESERVED: RegExp;  // /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i
export const ILLEGAL_CHARS:    RegExp;  // /[/\\:*?"<>|\x00-\x1F]/g
export const MAX_FILENAME_BYTES: number; // 243
export const LARGE_ATTACHMENT_BYTES: number; // 3 * 1024 * 1024
```

**Deviation from research doc**: the research snippet uses `existsSync` inside a
synchronous loop but declares the function as sync while doing a dynamic `import`. Our
contract makes `deduplicateFilename` async and uses `fs.promises.access` to avoid the
TOCTOU-exacerbating sync/async mismatch. The actual atomic write happens in
`atomicWriteBuffer` via `open(wx)` which closes the TOCTOU window.

---

### 2.12 `src/output/formatter.ts` — stdout rendering

```typescript
// src/output/formatter.ts

export type OutputMode = 'json' | 'table';

export interface ColumnSpec<T> {
  /** Human header for the table column. */
  header: string;
  /** Extractor. Return any value; the formatter calls String() unless it is null/undefined. */
  get: (row: T) => unknown;
  /** Optional explicit width (column is padded to this width). */
  width?: number;
  /** Align text right (e.g. for counters). Default: left. */
  align?: 'left' | 'right';
}

/**
 * Render `data` to a string. Modes:
 *
 *   'json'   → JSON.stringify(data, null, 2).
 *   'table'  → columns MUST be provided AND data must be an array. Each row is
 *              rendered with columns[i].get(row). A minimum-dep, hand-rolled
 *              ASCII table is produced (see formatting rules below).
 *
 * For 'table' with a non-array data value, throws an Error.
 */
export function formatOutput<T>(
  data: T,
  mode: OutputMode,
  columns?: ColumnSpec<T extends Array<infer U> ? U : never>[],
): string;
```

**Table rendering rules (hand-rolled — no `cli-table3` dep):**

- Column widths: if `spec.width` provided use it; else compute max of header length
  and `String(cell).length` across all rows, capped at 80.
- Null/undefined cells render as empty string.
- Header row: headers, padded with spaces per column.
- Separator row: `-` repeated to column width, joined by `  ` (two spaces).
- Data rows: one per entry, `String(cell)` left-padded (or right-padded if
  `align: 'right'`), joined by `  `.
- No bordering characters, no Unicode — pure ASCII, two-space column gutter.
- Trailing newline on the output.

---

### 2.13 Commands — one per CLI verb

All command modules live in `src/commands/<verb>.ts`. Shared contract:

```typescript
// Each command module exports a single `register` function.
import type { Command } from 'commander';
import type { CliConfig } from '../config/config';

export function register(program: Command, cfg: CliConfig): void;
```

Each `register` adds the subcommand to `program`, sets up its options, and installs an
async action handler. The action handler:

1. Uses `cfg` (already fully resolved) for mandatory and default values.
2. Loads session via `store.loadSession`; triggers `captureOutlookSession` if missing
   or expired (via the `onReauthNeeded` callback passed to the client).
3. Creates an `OutlookClient`.
4. Performs the REST call(s).
5. Calls `formatOutput(...)` and writes result to stdout.
6. Throws typed errors; the top-level `cli.ts` catches and exits.

---

#### 2.13.1 `src/commands/login.ts`

**commander registration:**

```typescript
program
  .command('login')
  .description('Open Chrome and capture a fresh Outlook session')
  .option('--force', 'Ignore any cached session and always open the browser', false)
  .action(async (opts: { force: boolean }) => { /* algorithm below */ });
```

**Algorithm (7 steps):**

1. Acquire the browser lock at `<sessionDir>/.browser.lock` via `lock.acquireLock`.
2. If `!opts.force`: call `store.loadSession(cfg.sessionFilePath)`. If present and NOT
   `isExpired` → return the cached result (no browser).
3. Call `captureOutlookSession({ profileDir, chromeChannel, loginTimeoutMs, force })`.
4. Build `SessionFile` from result: `version: 1`, `capturedAt: new Date().toISOString()`,
   `account`, `bearer`, `cookies`, `anchorMailbox`.
5. Call `store.saveSession(cfg.sessionFilePath, session)`.
6. Release the lock.
7. Format and print the output JSON:
   ```json
   {
     "status": "ok",
     "sessionFile": "<absolute path>",
     "tokenExpiresAt": "<ISO8601>",
     "account": { "puid": "...", "tenantId": "...", "upn": "..." }
   }
   ```

**REST endpoints:** none directly (the /me fallback inside `captureOutlookSession` may
call `GET /api/v2.0/me` if JWT claims are incomplete).

**Exit codes:** 0 on success; 3 (config missing); 4 (user cancellation or timeout);
5 (upstream /me fallback fails); 6 (session file write fails).

---

#### 2.13.2 `src/commands/auth-check.ts`

**commander registration:**

```typescript
program
  .command('auth-check')
  .description('Verify the cached session is present and accepted by Outlook')
  .action(async () => { /* algorithm below */ });
```

**Algorithm (5 steps):**

1. `session = await loadSession(cfg.sessionFilePath)`.
2. If `session == null` → output `{ status: "missing", tokenExpiresAt: null, account: null }` and exit 0.
3. If `isExpired(session)` → output `{ status: "expired", tokenExpiresAt: session.bearer.expiresAt, account: { upn: session.account.upn } }` and exit 0.
4. Build client with `noAutoReauth: true` (auth-check NEVER reauths). Call
   `client.get('/api/v2.0/me')`.
5. On 200 → output `{ status: "ok", tokenExpiresAt, account: { upn } }`.
   On 401 (caught as `AuthError`) → output `{ status: "rejected", ... }` and exit 0
   (yes — intentionally 0; auth-check reports status rather than failing).
   On 5xx / timeout → propagate `UpstreamError` → exit 5.

**REST endpoint:** `GET /api/v2.0/me` (no query params).

**Exit codes:** 0 (always, unless a genuine upstream error or config problem).

---

#### 2.13.3 `src/commands/list-mail.ts`

**commander registration:**

```typescript
program
  .command('list-mail')
  .description('List recent messages from a well-known folder')
  .option('-n, --top <N>', 'Number of messages (1..100)', parseIntRange(1, 100), 10)
  .option('--folder <name>', 'Folder name (Inbox|SentItems|Drafts|DeletedItems|Archive)', 'Inbox')
  .option('--select <csv>', 'Comma-separated $select fields')
  .action(async (opts) => { /* algorithm below */ });
```

**Algorithm (6 steps):**

1. Validate `--folder` against the allowed set; else throw `OutlookCliError` → exit 2.
2. Load/refresh session as needed; build client.
3. `select = opts.select ?? "Id,Subject,From,ReceivedDateTime,HasAttachments,IsRead,WebLink"`.
4. `path = `/api/v2.0/me/MailFolders/${opts.folder}/messages``;
   `query = { $top: String(opts.top), $orderby: 'ReceivedDateTime desc', $select: select }`.
5. `response = await client.get<{ value: MessageSummary[] }>(path, query)`.
6. Format: `response.value` as array (JSON) or as table with columns
   `[Received, From, Subject, Att, Id]`.

**REST endpoint:** `GET /api/v2.0/me/MailFolders/<folder>/messages?$top=N&$orderby=ReceivedDateTime desc&$select=...`.

**Output shape (JSON):** Array of `MessageSummary` (see §3.2).

**Exit codes:** 0; 2 (bad folder); 3; 4; 5; 6.

---

#### 2.13.4 `src/commands/get-mail.ts`

**commander registration:**

```typescript
program
  .command('get-mail <id>')
  .description('Retrieve one message with optional body')
  .option('--body <mode>', 'Body inclusion: html|text|none', 'text')
  .action(async (id: string, opts: { body: BodyMode }) => { /* ... */ });
```

**Algorithm (5 steps):**

1. Validate `body` ∈ `{'html','text','none'}`.
2. Build client.
3. `message = await client.get<Message>('/api/v2.0/me/messages/${id}')`.
4. `attachments = await client.get<{ value: AttachmentSummary[] }>('/api/v2.0/me/messages/${id}/attachments', { $select: 'Id,Name,ContentType,Size,IsInline' })`.
5. Shape output: `{ ...message, Attachments: attachments.value }`. If `body === 'none'` strip `Body`; if `body === 'text'` and `Body.ContentType === 'HTML'` pass through as-is (client does not convert — refined spec defers HTML→text conversion).

**REST endpoints:**
- `GET /api/v2.0/me/messages/{id}`
- `GET /api/v2.0/me/messages/{id}/attachments?$select=Id,Name,ContentType,Size,IsInline`

**Output:** `Message` (§3.2) with added `Attachments: AttachmentSummary[]` field.

**Exit codes:** 0; 2 (missing id); 3; 4; 5 (invalid id → 404 → exit 5); 6.

---

#### 2.13.5 `src/commands/download-attachments.ts`

**commander registration:**

```typescript
program
  .command('download-attachments <id>')
  .description('Save all non-inline attachments from a message to a directory')
  .requiredOption('--out <dir>', 'Output directory (no default — must be provided)')
  .option('--overwrite', 'Overwrite existing files', false)
  .option('--include-inline', 'Include inline attachments', false)
  .action(async (id: string, opts) => { /* ... */ });
```

**Algorithm (8 steps):** Exact port of the pseudocode in `docs/research/outlook-v2-attachments.md §6`.

1. Resolve `outDir = path.resolve(opts.out)`; mkdir recursive (mode 0700 is NOT set here —
   user-chosen output dir uses default umask).
2. Build client.
3. `list = await client.get<{ value: AttachmentEnvelope[] }>('/api/v2.0/me/messages/${id}/attachments')`.
4. For each attachment:
   - `ReferenceAttachment` → add to `skipped[]` with `reason: "reference-attachment"`, `sourceUrl`.
   - `ItemAttachment` → add to `skipped[]` with `reason: "item-attachment"`.
   - Unknown `@odata.type` → add to `skipped[]` with `reason: "unknown-attachment-type"`, `odataType`.
   - `FileAttachment` with `IsInline === true` and not `--include-inline` → skip (`reason: "inline"`).
   - Else: fetch detail, handle 404 (`not-found`) and 403 (`access-denied`) per-item, continue on
     non-fatal errors.
5. If `detail.ContentBytes == null` → skip with `reason: "content-bytes-null"`, `size`, `hint`.
6. Decode base64 → `Buffer`. Sanitize name via `sanitizeAttachmentName`.
7. `targetPath = opts.overwrite ? path.join(outDir, safeName) : await deduplicateFilename(outDir, safeName)`.
8. `await atomicWriteBuffer(targetPath, fileBytes, { mode: 0o600, overwrite: opts.overwrite })`.
9. Push to `saved[]`. On collision without `--overwrite` → IoError exit 6.

**REST endpoints:**
- `GET /api/v2.0/me/messages/{id}/attachments`
- `GET /api/v2.0/me/messages/{id}/attachments/{attId}` (per `FileAttachment`)

**Output (JSON):**

```typescript
{
  messageId: string;
  outDir: string;                       // absolute
  saved: SavedRecord[];                 // § 3.3
  skipped: SkippedRecord[];             // § 3.3
}
```

**Exit codes:** 0; 2 (missing id or missing --out); 3; 4; 5; 6 (collision w/o --overwrite, disk full, traversal).

---

#### 2.13.6 `src/commands/list-calendar.ts`

**commander registration:**

```typescript
program
  .command('list-calendar')
  .description('List upcoming calendar events within a window')
  .option('--from <iso>', 'Window start (ISO8601). Default: now')
  .option('--to <iso>',   'Window end   (ISO8601). Default: now + 7d')
  .option('--tz <iana>',  'Timezone override', cfg.tz)
  .action(async (opts) => { /* ... */ });
```

**Algorithm (6 steps):**

1. Resolve `from = opts.from ?? cfg.calFrom` (default "now" → `new Date().toISOString()`).
2. Resolve `to   = opts.to   ?? cfg.calTo`   (default "now + 7d" → `new Date(Date.now() + 7*86400000).toISOString()`).
3. Build client.
4. `query = { startDateTime: from, endDateTime: to, $orderby: 'Start/DateTime asc',
      $select: 'Id,Subject,Start,End,Organizer,Location,IsAllDay' }`.
5. `response = await client.get<{ value: EventSummary[] }>('/api/v2.0/me/calendarview', query)`.
6. Format: JSON array; table columns `[Start, End, Subject, Organizer, Location, Id]`.

**REST endpoint:** `GET /api/v2.0/me/calendarview?startDateTime=...&endDateTime=...&$orderby=Start/DateTime asc&$select=...`.

**Output:** `EventSummary[]` (§3.2).

**Exit codes:** 0; 2 (bad ISO date); 3; 4; 5; 6.

---

#### 2.13.7 `src/commands/get-event.ts`

**commander registration:**

```typescript
program
  .command('get-event <id>')
  .description('Retrieve one event with optional body')
  .option('--body <mode>', 'Body inclusion: html|text|none', 'text')
  .action(async (id: string, opts) => { /* ... */ });
```

**Algorithm (4 steps):**

1. Validate `body`.
2. Build client.
3. `event = await client.get<Event>('/api/v2.0/me/events/${id}')`.
4. Strip `Body` if `body === 'none'`; emit as JSON.

**REST endpoint:** `GET /api/v2.0/me/events/{id}`.

**Output:** `Event` (§3.2).

**Exit codes:** 0; 2; 3; 4; 5; 6.

---

### 2.14 `src/cli.ts` — Commander bootstrap

```typescript
#!/usr/bin/env node
// src/cli.ts

import { Command } from 'commander';
import { loadConfig }        from './config/config';
import { OutlookCliError }   from './config/errors';
import * as login            from './commands/login';
import * as authCheck        from './commands/auth-check';
import * as listMail         from './commands/list-mail';
import * as getMail          from './commands/get-mail';
import * as downloadAtt      from './commands/download-attachments';
import * as listCal          from './commands/list-calendar';
import * as getEvent         from './commands/get-event';

async function main(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name('outlook-cli')
    .description('Read-only CLI over outlook.office.com/api/v2.0')
    .option('--timeout <ms>',           'Per-REST-call timeout (mandatory)')
    .option('--login-timeout <ms>',     'Login wait timeout (mandatory)')
    .option('--chrome-channel <name>',  'Chrome channel (mandatory)')
    .option('--session-file <path>',    'Override session file path')
    .option('--profile-dir <path>',     'Override profile directory path')
    .option('--tz <iana>',              'Timezone override')
    .option('--json',                   'Emit JSON (default)')
    .option('--table',                  'Emit human-readable table')
    .option('--quiet',                  'Suppress stderr progress messages', false)
    .option('--no-auto-reauth',         'Do not auto-reopen the browser on 401')
    .option('--log-file <path>',        'Write debug log to a file (mode 0600)');

  // Commander parses global opts in the preAction hook so each command has them.
  program.hook('preAction', (thisCmd) => {
    const globalOpts = thisCmd.opts();
    const cfg = loadConfig(mapGlobalOptsToCliFlags(globalOpts));
    thisCmd.setOptionValue('__cfg', cfg); // pass through
  });

  // Register all commands. Each passes cfg via closure or the hook value above.
  // The actual registration functions take (program, cfg); since cfg is per-invocation,
  // we use a deferred pattern: register a thunk that reads __cfg at action time.
  login.register(program, /* cfg provided at action time */);
  authCheck.register(program);
  listMail.register(program);
  getMail.register(program);
  downloadAtt.register(program);
  listCal.register(program);
  getEvent.register(program);

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown): number {
  if (err instanceof OutlookCliError) {
    process.stderr.write(formatErrorJson(err) + '\n');
    return err.exitCode;
  }
  // Commander throws CommanderError with an exitCode field on bad argv.
  if (err && typeof err === 'object' && 'exitCode' in err) {
    return Number((err as { exitCode: number }).exitCode) || 2;
  }
  process.stderr.write(JSON.stringify({
    error: { code: 'UNEXPECTED', message: String((err as Error)?.message ?? err) }
  }, null, 2) + '\n');
  return 1;
}

main(process.argv).then(code => process.exit(code));
```

**Top-level error → exit code mapping:**

| Thrown class | Exit code | Notes |
|---|---|---|
| `ConfigurationError` | 3 | `error.missingSetting` named in JSON payload |
| `AuthError` | 4 | Message is user-safe — no token |
| `UpstreamError` | 5 | `httpStatus`, `requestId`, redacted `url` in JSON |
| `IoError` | 6 | `path` surfaced |
| `CommanderError` (bad argv) | 2 | Handled by commander's default behavior |
| Any other `Error` | 1 | Unexpected — wrap in generic message, do not leak stack to stdout |

---

## 3. Data Models

All interfaces below are the single source of truth. Coders MUST import them from the
listed module and MUST NOT re-declare shadowed copies.

### 3.1 Session persistence (see §2.3)

`SessionFile`, `Cookie`, `BearerInfo`, `Account` — all defined in `src/session/schema.ts`.

### 3.2 Outlook REST v2 resources (imported by commands + client)

Defined in `src/http/types.ts` (normative additions to §2.8):

```typescript
// src/http/types.ts

export interface EmailAddress {
  Name: string;
  Address: string;
}

export interface Recipient {
  EmailAddress: EmailAddress;
}

export interface Body {
  ContentType: 'HTML' | 'Text';
  Content: string;
}

/** Shape returned by list-mail. */
export interface MessageSummary {
  Id: string;
  Subject: string;
  From?: Recipient;
  ReceivedDateTime: string;
  HasAttachments: boolean;
  IsRead: boolean;
  WebLink: string;
}

/** Full message from GET /me/messages/{id}. Additional fields beyond spec may arrive and
 *  should be pass-through. */
export interface Message extends MessageSummary {
  Sender?: Recipient;
  ToRecipients: Recipient[];
  CcRecipients: Recipient[];
  BccRecipients: Recipient[];
  ReplyTo: Recipient[];
  Body?: Body;
  BodyPreview?: string;
  Importance?: 'Low' | 'Normal' | 'High';
  ConversationId?: string;
  InternetMessageId?: string;
  SentDateTime?: string;
  /** Added by get-mail via a separate request. */
  Attachments?: AttachmentSummary[];
}

/** Shared base for attachments (v2 Outlook REST shape). */
export interface AttachmentBase {
  '@odata.type':
    | '#Microsoft.OutlookServices.FileAttachment'
    | '#Microsoft.OutlookServices.ItemAttachment'
    | '#Microsoft.OutlookServices.ReferenceAttachment';
  Id: string;
  Name: string;
  ContentType: string | null;
  Size: number;
  IsInline: boolean;
  LastModifiedDateTime: string;
}

export interface FileAttachment extends AttachmentBase {
  '@odata.type': '#Microsoft.OutlookServices.FileAttachment';
  ContentId: string | null;
  ContentLocation: string | null;
  /** base64; may be null on list endpoint for large items. */
  ContentBytes: string | null;
}

export interface ItemAttachment extends AttachmentBase {
  '@odata.type': '#Microsoft.OutlookServices.ItemAttachment';
  Item: unknown | null; // only populated with $expand
}

export interface ReferenceAttachment extends AttachmentBase {
  '@odata.type': '#Microsoft.OutlookServices.ReferenceAttachment';
  SourceUrl: string;
  ProviderType: 'oneDriveBusiness' | 'oneDriveConsumer' | 'dropbox' | 'box' | 'google' | 'other';
  ThumbnailUrl: string | null;
  PreviewUrl: string | null;
  Permission: 'Edit' | 'View';
  IsFolder: boolean;
}

export type AttachmentEnvelope = FileAttachment | ItemAttachment | ReferenceAttachment;

/** Subset of attachment fields returned by get-mail's $select query. */
export interface AttachmentSummary {
  Id: string;
  Name: string;
  ContentType: string | null;
  Size: number;
  IsInline: boolean;
}

/** Calendar event summary (list-calendar). */
export interface EventSummary {
  Id: string;
  Subject: string;
  Start: { DateTime: string; TimeZone: string };
  End:   { DateTime: string; TimeZone: string };
  Organizer?: Recipient;
  Location?: { DisplayName: string };
  IsAllDay: boolean;
}

/** Full event (get-event). Additional fields are pass-through. */
export interface Event extends EventSummary {
  Body?: Body;
  Attendees?: Array<{
    EmailAddress: EmailAddress;
    Type: 'Required' | 'Optional' | 'Resource';
    Status?: { Response: string; Time: string };
  }>;
  BodyPreview?: string;
  ResponseRequested?: boolean;
  IsOnlineMeeting?: boolean;
  OnlineMeetingUrl?: string | null;
  WebLink?: string;
}
```

### 3.3 Download-attachments output records

```typescript
// src/commands/download-attachments.ts (types)

export interface SavedRecord {
  id: string;
  originalName: string;
  savedAs: string;   // path.basename(target)
  path: string;      // absolute
  size: number;      // bytes written
  contentType: string | null;
  isInline: boolean;
}

export type SkippedReason =
  | 'inline'
  | 'reference-attachment'
  | 'item-attachment'
  | 'unknown-attachment-type'
  | 'content-bytes-null'
  | 'not-found'
  | 'access-denied';

export interface SkippedRecord {
  id: string;
  name: string;
  reason: SkippedReason;
  /** Populated for reference-attachment. */
  sourceUrl?: string;
  /** Populated for unknown-attachment-type. */
  odataType?: string;
  /** Populated for content-bytes-null. */
  size?: number;
  /** Human hint for content-bytes-null. */
  hint?: string;
}
```

---

## 4. Error Taxonomy

| Exception class | `code` values | Exit code | User-facing message template (stderr JSON) |
|---|---|---|---|
| `ConfigurationError` | `CONFIG_MISSING` | 3 | `{"error":{"code":"CONFIG_MISSING","missingSetting":"<name>","checkedSources":[<sources>],"message":"Mandatory setting <name> was not provided. Checked: <sources>."}}` |
| `AuthError` | `AUTH_LOGIN_CANCELLED` | 4 | `{"error":{"code":"AUTH_LOGIN_CANCELLED","message":"Browser was closed before login completed."}}` |
| `AuthError` | `AUTH_LOGIN_TIMEOUT` | 4 | `{"error":{"code":"AUTH_LOGIN_TIMEOUT","message":"No Bearer token captured within <N>ms — login may not have completed."}}` |
| `AuthError` | `AUTH_401_AFTER_RETRY` | 4 | `{"error":{"code":"AUTH_401_AFTER_RETRY","message":"Authentication failed after re-auth retry."}}` |
| `AuthError` | `AUTH_NO_REAUTH` | 4 | `{"error":{"code":"AUTH_NO_REAUTH","message":"Session is missing or expired and --no-auto-reauth was set."}}` |
| `UpstreamError` | `UPSTREAM_HTTP_403` | 5 | `{"error":{"code":"UPSTREAM_HTTP_403","httpStatus":403,"requestId":"<id>","url":"<redacted>","message":"Outlook rejected the request (403). <bodySnippet>"}}` |
| `UpstreamError` | `UPSTREAM_HTTP_404` | 5 | `{"error":{"code":"UPSTREAM_HTTP_404","httpStatus":404,"requestId":"<id>","url":"<redacted>","message":"Not found. <bodySnippet>"}}` |
| `UpstreamError` | `UPSTREAM_HTTP_429` | 5 | `{"error":{"code":"UPSTREAM_HTTP_429","httpStatus":429,"requestId":"<id>","retryAfter":"<seconds>","message":"Rate limited. Retry-After: <s>s."}}` |
| `UpstreamError` | `UPSTREAM_HTTP_5XX` | 5 | `{"error":{"code":"UPSTREAM_HTTP_5XX","httpStatus":<n>,"requestId":"<id>","url":"<redacted>","message":"Upstream server error <n>."}}` |
| `UpstreamError` | `UPSTREAM_TIMEOUT` | 5 | `{"error":{"code":"UPSTREAM_TIMEOUT","message":"HTTP timeout after <N>ms."}}` |
| `UpstreamError` | `UPSTREAM_NETWORK` | 5 | `{"error":{"code":"UPSTREAM_NETWORK","message":"Network error: <sanitized>"}}` |
| `IoError` | `IO_SESSION_WRITE` | 6 | `{"error":{"code":"IO_SESSION_WRITE","path":"<path>","message":"Failed to write session file."}}` |
| `IoError` | `IO_SESSION_READ` | 6 | `{"error":{"code":"IO_SESSION_READ","path":"<path>","message":"Failed to read session file."}}` |
| `IoError` | `IO_SESSION_CORRUPT` | 6 | `{"error":{"code":"IO_SESSION_CORRUPT","path":"<path>","message":"Session file is corrupt or has unsupported schema."}}` |
| `IoError` | `IO_WRITE_EEXIST` | 6 | `{"error":{"code":"IO_WRITE_EEXIST","path":"<path>","message":"Refusing to overwrite existing file. Pass --overwrite to replace."}}` |
| `IoError` | `IO_PATH_TRAVERSAL` | 6 | `{"error":{"code":"IO_PATH_TRAVERSAL","path":"<name>","message":"Attachment name resolves outside the output directory."}}` |
| `IoError` | `IO_DEDUP_EXHAUSTED` | 6 | `{"error":{"code":"IO_DEDUP_EXHAUSTED","path":"<name>","message":"Could not find a unique filename after 999 attempts."}}` |
| `IoError` | `IO_MKDIR_EACCES` | 6 | `{"error":{"code":"IO_MKDIR_EACCES","path":"<dir>","message":"Cannot create directory (permission denied)."}}` |
| `CommanderError` (external) | — | 2 | Commander's built-in usage message |
| Any other `Error` | — | 1 | `{"error":{"code":"UNEXPECTED","message":"<string>"}}` |

**Secret-leak contract (normative):** `<bodySnippet>` must be the response body truncated
to 512 chars AFTER any substring equal to `session.bearer.token` or any `cookie.value`
is replaced with `[REDACTED]`. The client performs this substitution before wrapping.

---

## 5. Configuration Resolution Algorithm

Pseudocode for `loadConfig`:

```
function loadConfig(cliFlags):

  # 1. Mandatory settings — throw if unresolved
  httpTimeoutMs  = cliFlags.httpTimeoutMs
                   ?? parseIntEnv(ENV.HTTP_TIMEOUT_MS)
                   ?? THROW ConfigurationError('httpTimeoutMs', [
                        '--timeout flag',
                        'OUTLOOK_CLI_HTTP_TIMEOUT_MS env var',
                      ])

  loginTimeoutMs = cliFlags.loginTimeoutMs
                   ?? parseIntEnv(ENV.LOGIN_TIMEOUT_MS)
                   ?? THROW ConfigurationError('loginTimeoutMs', [
                        '--login-timeout flag',
                        'OUTLOOK_CLI_LOGIN_TIMEOUT_MS env var',
                      ])

  chromeChannel  = cliFlags.chromeChannel
                   ?? process.env[ENV.CHROME_CHANNEL]
                   ?? THROW ConfigurationError('chromeChannel', [
                        '--chrome-channel flag',
                        'OUTLOOK_CLI_CHROME_CHANNEL env var',
                      ])

  # 2. Optional settings with explicit defaults (spec §8 allows these)
  sessionFilePath = cliFlags.sessionFilePath
                    ?? process.env[ENV.SESSION_FILE]
                    ?? path.join(os.homedir(), '.outlook-cli', 'session.json')

  profileDir      = cliFlags.profileDir
                    ?? process.env[ENV.PROFILE_DIR]
                    ?? path.join(os.homedir(), '.outlook-cli', 'playwright-profile')

  tz              = cliFlags.tz
                    ?? process.env[ENV.TZ]
                    ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  outputMode      = cliFlags.outputMode ?? 'json'
  listMailTop     = cliFlags.listMailTop ?? 10
  listMailFolder  = cliFlags.listMailFolder ?? 'Inbox'
  bodyMode        = cliFlags.bodyMode ?? 'text'
  calFrom         = cliFlags.calFrom ?? process.env[ENV.CAL_FROM] ?? 'now'
  calTo           = cliFlags.calTo   ?? process.env[ENV.CAL_TO]   ?? 'now + 7d'
  quiet           = cliFlags.quiet ?? false
  noAutoReauth    = cliFlags.noAutoReauth ?? false
  sessionFileOverride = cliFlags.sessionFileOverride
  logFilePath     = cliFlags.logFilePath

  # 3. Sanity checks (also throw ConfigurationError if invalid)
  if httpTimeoutMs  <= 0:   THROW ConfigurationError('httpTimeoutMs', [...], 'must be positive integer')
  if loginTimeoutMs <= 0:   THROW ConfigurationError('loginTimeoutMs', [...], 'must be positive integer')
  if listMailTop < 1 or listMailTop > 100:
                            THROW ConfigurationError('listMailTop', [...], 'must be 1..100')

  # 4. Return the frozen config object
  return Object.freeze({ httpTimeoutMs, loginTimeoutMs, chromeChannel,
                         sessionFilePath, profileDir, tz, outputMode, ... })

function parseIntEnv(name):
  raw = process.env[name]
  if raw == undefined: return undefined
  n = parseInt(raw, 10)
  if isNaN(n): THROW ConfigurationError(name, [env], 'is not a valid integer: "<raw>"')
  return n
```

**Precedence (highest wins):** CLI flag > environment variable > explicit default (when
spec allows). No hidden defaults for mandatory fields.

---

## 6. Parallel Implementation Units

Mapping to plan-001 phases. Each unit is assigned to a coder agent and owns specific
files. "Depends on" lists interfaces that MUST already be published before this unit
starts; "Publishes" lists interfaces this unit is authoritative for.

### Unit P-A: Scaffolding (serial, first)

- **Owns**: `package.json`, `tsconfig.json`, `.gitignore`, `src/cli.ts` (stub only),
  `Issues - Pending Items.md`.
- **Depends on**: nothing.
- **Publishes**: package `bin` entry, build script, tsconfig `include`.

### Unit P-B: Config (parallel with C and E)

- **Owns**: `src/config/config.ts`, `src/config/errors.ts`, `test_scripts/unit/config.spec.ts`.
- **Depends on**: P-A.
- **Publishes**: `CliConfig`, `CliFlags`, `loadConfig()`, `OutlookCliError`, `ConfigurationError`,
  `AuthError`, `UpstreamError`, `IoError`, `ENV` constant.

### Unit P-C: Session (parallel with B and E)

- **Owns**: `src/session/schema.ts`, `src/session/store.ts`, `src/util/fs-atomic.ts`,
  `test_scripts/unit/session-store.spec.ts`.
- **Depends on**: P-A, P-B (for `IoError`).
- **Publishes**: `SessionFile`, `Cookie`, `BearerInfo`, `Account`, `validateSessionJson`,
  `loadSession`, `saveSession`, `isExpired`, `deleteSession`, `atomicWriteJson`,
  `atomicWriteBuffer`.

### Unit P-D: Auth (parallel with E; depends on B and C)

- **Owns**: `src/auth/browser-capture.ts`, `src/auth/jwt.ts`, `src/auth/lock.ts`,
  `test_scripts/unit/jwt.spec.ts`, `test_scripts/unit/lock.spec.ts`.
- **Depends on**: P-B (errors), P-C (`SessionFile`, `Cookie`, `saveSession`).
- **Publishes**: `captureOutlookSession`, `CaptureResult`, `CaptureOptions`,
  `INIT_SCRIPT_TEXT`, `decodeJwt`, `JwtClaims`, `acquireLock`.

### Unit P-E: HTTP client (parallel with D)

- **Owns**: `src/http/outlook-client.ts`, `src/http/errors.ts`, `src/http/types.ts`,
  `test_scripts/unit/outlook-client.spec.ts`.
- **Depends on**: P-B (errors), P-C (`SessionFile`).
- **Publishes**: `OutlookClient`, `createOutlookClient`, `CreateClientOptions`,
  `MessageSummary`, `Message`, `AttachmentEnvelope`, `FileAttachment`, `ItemAttachment`,
  `ReferenceAttachment`, `AttachmentSummary`, `EventSummary`, `Event`,
  `mapHttpResponseToError`, `mapAbortError`, `mapNetworkError`.

### Unit P-F1: Auth commands (parallel within F)

- **Owns**: `src/commands/login.ts`, `src/commands/auth-check.ts`.
- **Depends on**: P-B, P-C, P-D, P-E, P-G (output formatter stub is acceptable).
- **Publishes**: `register()` entry points for `login`, `auth-check`.

### Unit P-F2: Mail/calendar read commands (parallel within F)

- **Owns**: `src/commands/list-mail.ts`, `src/commands/get-mail.ts`,
  `src/commands/list-calendar.ts`, `src/commands/get-event.ts`.
- **Depends on**: P-B, P-C, P-D, P-E.
- **Publishes**: `register()` for each of the four verbs.

### Unit P-F3: Attachments (parallel within F)

- **Owns**: `src/commands/download-attachments.ts`, `src/util/filename.ts`,
  `test_scripts/unit/filename.spec.ts`, `test_scripts/unit/download-attachments.spec.ts`.
- **Depends on**: P-B, P-C, P-D, P-E.
- **Publishes**: `register()` for `download-attachments`, `sanitizeAttachmentName`,
  `deduplicateFilename`, `WINDOWS_RESERVED`, `ILLEGAL_CHARS`, `MAX_FILENAME_BYTES`,
  `LARGE_ATTACHMENT_BYTES`.

### Unit P-G: CLI wiring + formatter (serial after F)

- **Owns**: `src/cli.ts` (final body), `src/output/formatter.ts`,
  `test_scripts/unit/formatter.spec.ts`.
- **Depends on**: all F units.
- **Publishes**: `formatOutput`, `OutputMode`, `ColumnSpec`, the `outlook-cli` binary.

### Unit P-H: Acceptance tests + CLAUDE.md (serial after G)

- **Owns**: every `test_scripts/ac-*.ts`, the `<outlook-cli>` block in `CLAUDE.md`.
- **Depends on**: P-G.
- **Publishes**: no code — only verification artifacts and documentation.

**Parallelization graph** (identical to plan-001 §2):

```
P-A  →  P-B  ─┐
         P-C  ─┼→  P-D  ─┐
         P-E  ─┘         │
                         ▼
                         P-F1, P-F2, P-F3  →  P-G  →  P-H
```

---

## 7. Technology Choices with Justification

**commander** — Chosen over `yargs` and hand-rolled argv. It is tiny, has first-class
TypeScript types, cleanly maps the 7 subcommands with per-command options, and emits
usage messages that match our help expectations. `yargs`' extra middleware and
positional-parsing features are unused in this tool.

**Native `fetch`** (Node ≥ 18, WHATWG API) — Chosen over `axios` and `undici`. Zero
additional runtime deps. `AbortController` is native and maps cleanly to the mandatory
`httpTimeoutMs` config. The CLI makes only 1–2 requests per invocation, so connection
pooling (`undici`'s strength) is irrelevant. `axios`' interceptor model and non-standard
response shape would add surface for no gain.

**vitest** — Chosen over `@playwright/test` (already installed) and `node:test`. `vitest`
is fast, zero-config against our existing `tsconfig.json` (CommonJS), supports `vi.mock`
for mocking `fetch`/Playwright without a separate library, and has a familiar
`expect` API. `@playwright/test` is preserved as a *dev dep* for future browser-level
end-to-end tests but is not used as the unit runner.

**Manual JWT base64url split** — Chosen over `jwt-decode`. We only need to read three
claim fields (`exp`, `oid`, `tid`), and we don't verify signatures (the token is already
trusted by virtue of having been captured live). The decoder is ~6 lines; avoiding a
dependency for such a small piece of logic follows the project's lean-deps philosophy.

**Manual table formatter** — Chosen over `cli-table3` / `table` / `columnify`. Our
table use cases are: list-mail (5 columns) and list-calendar (6 columns). A hand-rolled
ASCII formatter is ~40 lines, keeps the runtime dep list at exactly one (`commander`),
and avoids version-churn risk from formatter libraries.

**No MSAL / no Graph SDK** — Spec NG4 and NG5 forbid Microsoft Graph and MSAL token
decryption. We replay the captured Bearer directly against `outlook.office.com/api/v2.0`.
Avoiding `@azure/msal-node` and `@microsoft/microsoft-graph-client` is intentional;
both are heavyweight and would imply an architecture change.

---

## 8. Integration Points

### 8.1 `package.json`

```json
{
  "name": "outlook-cli",
  "version": "0.1.0",
  "type": "commonjs",
  "bin": {
    "outlook-cli": "dist/cli.js"
  },
  "scripts": {
    "build":      "tsc",
    "dev":        "ts-node src/cli.ts",
    "test":       "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "playwright":        "^1.59.1",
    "@playwright/test":  "^1.59.1",
    "@types/node":       "^25.6.0",
    "ts-node":           "^10.9.2",
    "typescript":        "^6.0.3",
    "vitest":            "^2.0.0"
  }
}
```

The built `dist/cli.js` must begin with `#!/usr/bin/env node`. The source `src/cli.ts`
must also begin with that shebang; `tsc` preserves the first line.

### 8.2 `tsconfig.json`

- Keep: `target: ES2022`, `module: commonjs`, `strict: true`, `esModuleInterop: true`,
  `skipLibCheck: true`, `types: ["node"]`, `outDir: "dist"`.
- **Change**: `"include": ["src/**/*.ts", "test_scripts/**/*.ts"]`.
- Add `"rootDir": "."` so the emitted tree mirrors `src/…` into `dist/…`.

### 8.3 `.gitignore`

Append (even though there is no git repo yet — this is forward-looking):

```
node_modules/
dist/

# Playwright artifacts
.playwright-profile/
.playwright/
.playwright-cli/

# Baseline script output (pre-CLI)
outlook_report.json

# Editor / OS
.DS_Store
*.log
```

### 8.4 `CLAUDE.md` tool documentation

Append after the existing `<structure-and-conventions>` block. One parent `<outlook-cli>`
entry, followed by one child entry per subcommand. Template:

```xml
<outlook-cli>
  <objective>
    Read-only CLI over Outlook Web's REST surface (outlook.office.com/api/v2.0).
    Captures auth by driving headed Chrome via Playwright, then replays the
    Bearer token and cookie jar against the REST API for mail and calendar
    operations.
  </objective>
  <command>
    outlook-cli <subcommand> [flags]
  </command>
  <info>
    Global flags (all subcommands):
      --timeout <ms>         HTTP timeout per REST call (MANDATORY — no fallback).
                             Env: OUTLOOK_CLI_HTTP_TIMEOUT_MS.
      --login-timeout <ms>   Login wait timeout (MANDATORY — no fallback).
                             Env: OUTLOOK_CLI_LOGIN_TIMEOUT_MS.
      --chrome-channel <ch>  Playwright Chrome channel (MANDATORY — no fallback).
                             Env: OUTLOOK_CLI_CHROME_CHANNEL.
      --session-file <path>  Override default $HOME/.outlook-cli/session.json.
      --profile-dir  <path>  Override default $HOME/.outlook-cli/playwright-profile.
      --tz <iana>            Override system timezone.
      --json / --table       Output format (default: --json).
      --quiet                Suppress stderr progress messages.
      --no-auto-reauth       On 401 or expired session, fail instead of re-opening
                             the browser.
      --log-file <path>      Optional debug log (mode 0600).

    Exit codes:
      0 success
      2 invalid arguments / usage
      3 configuration error (mandatory config missing)
      4 auth failure
      5 upstream API error
      6 IO error

    Session file schema: see docs/design/project-design.md §3.1.
  </info>
  <login>
    <objective>Capture a fresh Outlook session via headed Chrome.</objective>
    <command>outlook-cli login [--force]</command>
    <info>Opens Chrome at outlook.office.com/mail/, waits for user to sign in,
          captures the first Authorization: Bearer header, harvests cookies,
          writes $HOME/.outlook-cli/session.json with mode 0600.</info>
  </login>
  <auth-check>
    <objective>Verify the cached session is still accepted.</objective>
    <command>outlook-cli auth-check</command>
    <info>Loads the cached session, performs GET /me, prints
          {status, tokenExpiresAt, account}. Never auto-reauths.</info>
  </auth-check>
  <list-mail>
    <objective>List recent messages from a well-known folder.</objective>
    <command>outlook-cli list-mail [-n N] [--folder NAME] [--select CSV]</command>
    <info>N default 10 (1..100). Folder default Inbox. Allowed folders:
          Inbox, SentItems, Drafts, DeletedItems, Archive.</info>
  </list-mail>
  <get-mail>
    <objective>Retrieve one message with body and attachment metadata.</objective>
    <command>outlook-cli get-mail &lt;id&gt; [--body html|text|none]</command>
    <info>Fetches GET /me/messages/{id} and attachments metadata.
          Body default: text.</info>
  </get-mail>
  <download-attachments>
    <objective>Save all non-inline attachments of a message to disk.</objective>
    <command>outlook-cli download-attachments &lt;id&gt; --out &lt;dir&gt; [--overwrite] [--include-inline]</command>
    <info>ReferenceAttachment and ItemAttachment are skipped with reasons.
          Attachments &gt; ~3 MB may have ContentBytes null and be skipped.</info>
  </download-attachments>
  <list-calendar>
    <objective>List upcoming calendar events within a window.</objective>
    <command>outlook-cli list-calendar [--from ISO] [--to ISO] [--tz IANA]</command>
    <info>Defaults: from=now, to=now+7d, tz=system. Ordered by Start asc.</info>
  </list-calendar>
  <get-event>
    <objective>Retrieve one event with body and attendees.</objective>
    <command>outlook-cli get-event &lt;id&gt; [--body html|text|none]</command>
    <info>Fetches GET /me/events/{id}.</info>
  </get-event>
</outlook-cli>
```

---

## 9. Architectural Decisions Log (ADRs)

Short bullets with rationale. Each reflects a design choice documented above.

- **ADR-01: Native `fetch` over `axios`/`undici`.** We chose native `fetch` because the
  CLI issues only 1–2 requests per invocation; connection pooling and interceptors are
  not needed, and keeping the runtime dep list to `commander` only reduces maintenance
  surface and supply-chain risk.
- **ADR-02: `launchPersistentContext` over `launch + storageState`.** We chose
  persistent context because MSAL silent-SSO across runs depends on Chrome's session
  cache (not just cookies). `storageState` preserves cookies but not MSAL's cached
  auth material, so users would hit MFA on every expiry.
- **ADR-03: Hand-rolled ASCII table over `cli-table3`.** We chose a ~40-line custom
  formatter because our table needs are trivial (5–6 columns, no row wrapping), and
  avoiding the dep keeps us at commander-only in `dependencies`.
- **ADR-04: File-based session at 0600 over macOS Keychain / Windows Cred Manager.**
  We chose file-based storage because spec NG8 explicitly scopes OS-keystore
  integration out of this iteration, and the refined spec §7.1 contracts mode 0600 + 0700
  dir as the security boundary. Future iterations may layer keystore on top.
- **ADR-05: Advisory PID lock at `<sessionDir>/.browser.lock` over OS-level flock.**
  We chose an advisory PID lock because it is portable across macOS/Linux/Windows
  without native addons, and the stale-PID recovery algorithm (`process.kill(pid, 0)`
  + age > max(loginTimeout, 30min)) handles crash recovery cleanly.
- **ADR-06: One-shot re-auth on 401 over loop-until-success.** We chose one-shot retry
  (spec §6.4) because repeatedly opening the browser on pathological 401 loops (e.g.
  tenant revocation) would be hostile UX and would not converge. One retry is the
  sweet spot: it recovers from token expiry but fails fast on real auth problems.
- **ADR-07: Manual JWT base64url decode over `jwt-decode`.** We chose a ~6-line manual
  decoder because we only need 3 claim fields and never verify the signature. The
  dependency would be deadweight for the amount of code it replaces.
- **ADR-08: `context.addInitScript` over `page.addInitScript` for the fetch hook.**
  We chose context-scoped registration because Outlook's login flow uses popup windows
  and redirect chains; page-scoped hooks would miss frames and popups, leading to
  intermittent capture failures.
- **ADR-09: `fsync` before `rename` during atomic session write.** We chose to `fsync`
  because `rename` alone is atomic at the dirent level but does not flush file data.
  A power-loss between write and rename can land the dirent swap before the data
  blocks are persisted, destroying the previous valid session. `fsync` closes this
  window.
- **ADR-10: No auto-retry on 429 / 5xx in this iteration.** We chose to surface these
  errors to the user (exit 5) rather than implement exponential backoff, because the
  CLI is user-driven (the user can rerun) and automatic backoff would complicate the
  mandatory `httpTimeoutMs` semantics. A future iteration can add structured retry with
  its own config.
- **ADR-11: `vitest` over `@playwright/test` for unit tests.** We chose `vitest` because
  its `vi.mock` + `expect` API is more ergonomic for mocking `fetch` and Playwright
  than `@playwright/test`'s runner (which is oriented at browser scenarios). The
  Playwright test runner is kept available in devDependencies for future end-to-end
  browser tests.
- **ADR-12: Skip `ItemAttachment` and `ReferenceAttachment` in downloads.** We chose to
  skip these types (recording them in `skipped[]` with their `reason` and, for
  reference, `sourceUrl`) because `.eml` reconstruction and cloud-file resolution are
  out of scope for this iteration (refined spec §5.5). Users get clear signals and can
  handle those attachments manually.
- **ADR-13: Dedicated `CollisionError` class (exit 6) for `FOLDER_ALREADY_EXISTS`
  instead of reusing `IoError`.** We chose a new `CollisionError extends
  OutlookCliError { exitCode = 6 }` because the cause is not filesystem IO (the
  existing exit-6 path is attachment-file collisions from `download-attachments`).
  Keeping a distinct `instanceof` discriminant in `cli.ts formatErrorJson` /
  `exitCodeFor` yields a deterministic JSON shape (`{code, path?, parentId?}`) that
  scripts can rely on and avoids code sprawl in the `IoError.code` vocabulary.
  The exit code itself is shared (6) — no new exit-code value is introduced.
  Resolves plan-002 OQ-1. Alternative considered: extend `IoError` with a new
  `FOLDER_ALREADY_EXISTS` code; rejected because IO errors are already used for
  filesystem paths, and overloading the class muddies the discriminant.
- **ADR-14: `--first-match` tiebreaker order is `CreatedDateTime asc, Id asc`.**
  When the user opts into automatic disambiguation (via `--first-match` on
  `find-folder`, `list-mail`, `move-mail`), the resolver sorts candidate siblings
  by `CreatedDateTime asc` (oldest first) with a stable `Id asc` lexicographic
  tiebreaker. We chose creation-time order because it matches the user's natural
  mental model ("pick the original, not the accidental duplicate") and because
  `CreatedDateTime` is already cheaply available on the `FolderSummary` wire
  shape via `$select`. Alternative considered: `DisplayName asc, Id asc` —
  rejected because every ambiguous candidate already shares the same
  DisplayName (that is why they are ambiguous), making DisplayName a no-op
  sort key. Resolves plan-002 OQ-2. The resolver's default `$select` is
  extended to include `CreatedDateTime` for this reason.
- **ADR-15: Default parent for `create-folder` and `list-folders` is
  `MsgFolderRoot`, not `Inbox`.** When the user omits `--parent`, the anchor for
  creation and listing is the mailbox root (sibling of Inbox), matching how
  Outlook Web behaves when the user clicks "New folder" at the mailbox level.
  Anchoring on `Inbox` would surprise users who expect "create a folder" to mean
  "create a top-level folder" and would force awkward `--parent MsgFolderRoot`
  flags on every top-level create. Resolves plan-002 OQ-3.
- **ADR-16: Always pre-resolve alias → raw id before `POST /move` (no alias
  pass-through in `DestinationId`).** The Outlook REST v2.0 surface historically
  documented only four aliases (`Inbox`, `Drafts`, `SentItems`, `DeletedItems`)
  as valid `DestinationId` values; Graph v1.0 documents the full modern set but
  v2.0 tenant behaviour for `Archive` / `JunkEmail` / `Outbox` in `DestinationId`
  has no live empirical confirmation (see `docs/research/outlook-v2-move-destination-alias.md`).
  We always resolve every alias to its raw id via `GET /MailFolders/{alias}`
  before issuing `POST /messages/{id}/move`, costing one extra `GET` per
  `move-mail` invocation that uses an alias. This is the conservative choice
  for v1; a future `--raw-alias` opt-in flag could restore pass-through once
  empirically verified. Resolves plan-002 OQ-4.

---

## 10. Folder Management

### 10.1 Overview

**Problem.** The shipped Outlook CLI (documented in §§1-9) reads mail,
attachments, and calendar from the signed-in user's primary mailbox but has no
folder-management surface: the existing `list-mail --folder` flag accepts only
a hard-coded set of five well-known aliases (`Inbox`, `SentItems`, `Drafts`,
`DeletedItems`, `Archive`), there is no way to enumerate or resolve
user-created folders, no way to create folders, and no way to move messages
between folders. Users who want to target any other folder by name, or
reorganize their mailbox through the CLI, cannot.

**Scope (per `docs/design/refined-request-folders.md`).** Extend the tool,
strictly additively, with four new subcommands plus two additive flags on
`list-mail`:

1. `list-folders` — enumerate top-level or child folders (optionally
   recursive), reusing a new shared pagination helper that follows
   `@odata.nextLink` verbatim up to a per-collection cap of 50 pages.
2. `find-folder <query>` — resolve a well-known alias, a display-name path
   such as `Inbox/Projects/Alpha`, or an `id:<raw>` form into a single folder
   with full metadata.
3. `create-folder <path>` — create a folder under a parent, with
   `--create-parents` for intermediate segments and `--idempotent` for
   safe re-runs.
4. `move-mail <id>` — move one or more messages to a destination folder,
   surfacing the `{ sourceId, newId }` mapping because `/move` returns a new
   id.
5. `list-mail` (extended) — accept `--folder-id <id>` and path-based
   `--folder <Inbox/...>`, preserving the existing well-known fast-path.

Non-goals are taken verbatim from refined §3 (NG1 rename, NG2 delete, NG3
copy, NG4 `$batch`, NG5 delta/sync, NG6 search-folder create, NG7 move-folder
parent change, NG8 `IsHidden` mutation, NG9 shared/archive-mailbox access,
NG10 concurrent moves). The extension is strictly additive on top of the
shipped design: no exit codes are added, no new mandatory configuration is
introduced, and the existing auth / session / HTTP / output layers are
extended but not refactored (cross-references: §2.8 for the HTTP client
that gains `post` + `listAll`, §2.2 for the error classes that gain
`CollisionError`, §4 for the error-taxonomy extensions, §2.14 for the CLI
wiring).

### 10.2 Module / file structure

New module `src/folders/` owns every piece of path / alias / NFC / case-fold
/ ambiguity / well-known-precedence / collision-error logic. One file per
new command under `src/commands/`. The existing `src/commands/list-mail.ts`
is extended in place (the well-known fast path is preserved verbatim;
non-well-known names are delegated to the resolver).

```
                        ┌──────────────────────────────────────────┐
                        │        src/cli.ts  (bin entry)           │  CHG
                        │   + list-folders / find-folder /          │
                        │     create-folder / move-mail registrations│
                        │   + --folder-id, --folder-parent on        │
                        │     list-mail                             │
                        │   + CollisionError branch in               │
                        │     formatErrorJson / exitCodeFor          │
                        └──────────────────┬───────────────────────┘
                                           │
              ┌────────────────────────────┼──────────────────────────┐
              ▼                            ▼                          ▼
   ┌────────────────────┐   ┌───────────────────────────┐  ┌─────────────────────┐
   │  src/config/       │   │  src/commands/            │  │  src/output/        │
   │  errors.ts   CHG   │   │   list-folders.ts   NEW   │  │  formatter.ts       │
   │  (+ CollisionError)│   │   find-folder.ts    NEW   │  │  (unchanged; new    │
   │  (+ new code       │   │   create-folder.ts  NEW   │  │   ColumnSpecs in    │
   │   strings on       │   │   move-mail.ts      NEW   │  │   cli.ts)           │
   │   UsageError /     │   │   list-mail.ts      CHG   │  └─────────────────────┘
   │   UpstreamError)   │   │                           │
   └──────────┬─────────┘   └───────────┬───────────────┘
              │                         │
              │                         ▼
              │          ┌───────────────────────────────┐
              │          │  src/folders/        NEW       │
              │          │    resolver.ts                 │
              │          │    types.ts                    │
              │          │  (parseFolderPath,             │
              │          │   buildFolderPath,             │
              │          │   matchesWellKnownAlias,       │
              │          │   listChildren,                │
              │          │   resolveFolder,               │
              │          │   createFolderPath,            │
              │          │   isFolderExistsError)         │
              │          └──────────┬─────────────────────┘
              │                     │
              ▼                     ▼
   ┌────────────────────┐  ┌──────────────────────────┐
   │ src/session/       │  │ src/http/                │  CHG
   │ (unchanged)        │  │   outlook-client.ts       │
   │                    │  │   + post<TBody,TRes>(...) │
   │                    │  │   + listAll<T>(...)       │
   │                    │  │   (refactor doGet         │
   │                    │  │    → doRequest)           │
   │                    │  │   errors.ts (unchanged)   │
   │                    │  │   types.ts   CHG          │
   │                    │  │   (+ FolderSummary,       │
   │                    │  │     FolderCreateRequest,  │
   │                    │  │     MoveMessageRequest)   │
   └────────────────────┘  └──────────────────────────┘
```

**File-touch table.** Every file in scope, with "new" vs "modified" status.

| File                                                  | Status    | Nature of change                                                                                |
|-------------------------------------------------------|-----------|-------------------------------------------------------------------------------------------------|
| `src/folders/types.ts`                                | **new**   | `FolderSpec`, `ResolvedFolder`, `CreateFolderResult`, `MoveMailResult`, constants               |
| `src/folders/resolver.ts`                             | **new**   | `parseFolderPath`, `buildFolderPath`, `matchesWellKnownAlias`, `listChildren`, `resolveFolder`, `createFolderPath`, `isFolderExistsError` |
| `src/commands/list-folders.ts`                        | **new**   | `register()` + `run()` for `list-folders`                                                       |
| `src/commands/find-folder.ts`                         | **new**   | `register()` + `run()` for `find-folder`                                                        |
| `src/commands/create-folder.ts`                       | **new**   | `register()` + `run()` for `create-folder`                                                      |
| `src/commands/move-mail.ts`                           | **new**   | `register()` + `run()` for `move-mail`                                                          |
| `src/commands/list-mail.ts`                           | modified  | adds `--folder-id`, `--folder-parent`; widens `--folder` to accept paths / other aliases        |
| `src/cli.ts`                                          | modified  | registers 4 new subcommands; adds 3 new `ColumnSpec`s; `CollisionError` branch                  |
| `src/config/errors.ts`                                | modified  | adds `CollisionError` class; documents new code strings on `UsageError` / `UpstreamError`       |
| `src/http/outlook-client.ts`                          | modified  | refactor `doGet` → `doRequest`; add `post` + `listAll`                                          |
| `src/http/types.ts`                                   | modified  | add `FolderSummary`, `FolderCreateRequest`, `MoveMessageRequest`                                |
| `CLAUDE.md`                                           | modified  | adds 4 child blocks under `<outlook-cli>`; updates `<list-mail>` documentation                  |
| `docs/design/project-design.md`                       | modified  | this section (§10) + ADR-13..ADR-16                                                             |
| `docs/design/project-functions.MD`                    | modified  | adds FR-008..FR-011; extends FR-003                                                             |
| `Issues - Pending Items.md`                           | modified  | pending-item register updates (if any arise during implementation)                              |
| `test_scripts/unit/folders-resolver.spec.ts`          | **new**   | unit tests for resolver branches                                                                |
| `test_scripts/unit/outlook-client-post.spec.ts`       | **new**   | unit tests for `post` + `listAll`                                                               |
| `test_scripts/unit/list-folders.spec.ts`              | **new**   | unit tests                                                                                       |
| `test_scripts/unit/find-folder.spec.ts`               | **new**   | unit tests                                                                                       |
| `test_scripts/unit/create-folder.spec.ts`             | **new**   | unit tests                                                                                       |
| `test_scripts/unit/move-mail.spec.ts`                 | **new**   | unit tests                                                                                       |
| `test_scripts/unit/list-mail-folder-id.spec.ts`       | **new**   | narrow unit tests for the new path / fast-path decision branches                                |
| `test_scripts/ac-folders-*.ts`                        | **new**   | one script per acceptance criterion (AC-LISTFOLDERS-ROOT … AC-CLAUDEMD-UPDATED-FOLDERS)         |

**Untouched (verified via `docs/reference/codebase-scan-folders.md`):**
`src/auth/*`, `src/session/*`, `src/config/config.ts`, `src/output/formatter.ts`,
`src/util/*` — the existing machinery carries folder calls correctly.

### 10.3 Domain types

REST wire types live next to the existing ones in `src/http/types.ts`.
CLI-layer shapes — the tagged-union `FolderSpec`, the resolved and
post-operation result shapes — live in `src/folders/types.ts`. This split
matches the convention documented in §3.2 (`src/http/types.ts` holds wire
shapes; per-command result shapes live near their consumer).

#### 10.3.1 REST wire types (`src/http/types.ts`, additions)

```typescript
/**
 * `GET /me/MailFolders`, `GET /me/MailFolders/{id}/childfolders`,
 * `POST /me/MailFolders/{parent}/childfolders` response shape.
 * PascalCase matches the REST v2.0 convention (see §3.2).
 */
export interface FolderSummary {
  Id: string;
  DisplayName: string;
  ParentFolderId?: string;
  ChildFolderCount?: number;
  UnreadItemCount?: number;
  TotalItemCount?: number;
  /** Populated by Outlook only on well-known folders (e.g. "inbox"). */
  WellKnownName?: string;
  IsHidden?: boolean;
  /** Selected explicitly by the resolver; required for --first-match ordering (ADR-14). */
  CreatedDateTime?: string;
  /**
   * Not returned by Outlook; materialized by the client during a recursive
   * `list-folders` walk. Slash-separated, `/` and `\` escaped per §10.5.
   */
  Path?: string;
}

/** `POST /me/MailFolders/{parent}/childfolders` request body. */
export interface FolderCreateRequest {
  DisplayName: string;
}

/** `POST /me/messages/{id}/move` request body. */
export interface MoveMessageRequest {
  DestinationId: string;
}

/**
 * Envelope used by OutlookClient.listAll<T>. Mirrors the v2.0 collection shape.
 * See §3.2 — this generalizes the existing ad-hoc `{ value: T[] }` usage.
 */
export interface ODataListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.context'?: string;
}
```

A `MailFolder` "full" shape is not introduced in v1 — `FolderSummary` is
sufficient for every current consumer (no `PATCH` or full-folder `GET` is
part of this iteration; rename/delete are NG1/NG2). A `MailFolderList` type
is unnecessary because the paging helper collapses pages into a flat
`FolderSummary[]` (see §10.4).

#### 10.3.2 CLI-layer types (`src/folders/types.ts`)

```typescript
/**
 * The canonical folder reference understood by the resolver. Discriminated
 * tagged union — every caller uses exactly one kind and the resolver branches
 * on `kind` without heuristics.
 *
 *   { kind: "wellKnown", value: "Inbox" }                      → alias in URL path, no lookup
 *   { kind: "id",        value: "AAMkAGI..." }                 → raw opaque id
 *   { kind: "path",      value: "Projects/Alpha", parent?: FolderSpec }
 *                                                               → segmented walk under an anchor
 *
 * The optional `parent` on a path spec is the anchor for a bare/non-absolute
 * path (default: { kind: "wellKnown", value: "MsgFolderRoot" } — ADR-15).
 */
export type FolderSpec =
  | { kind: 'wellKnown'; value: WellKnownAlias }
  | { kind: 'id'; value: string }
  | { kind: 'path'; value: string; parent?: FolderSpec };

/** Exhaustive PascalCase alias list accepted in the v2.0 URL path.
 *  Source: refined §6.2 + outlook-v2-folder-pagination-filter.md §References #3. */
export type WellKnownAlias =
  | 'Inbox' | 'SentItems' | 'Drafts' | 'DeletedItems'
  | 'Archive' | 'JunkEmail' | 'Outbox'
  | 'MsgFolderRoot' | 'RecoverableItemsDeletions';

export const WELL_KNOWN_ALIASES: readonly WellKnownAlias[] = Object.freeze([
  'Inbox', 'SentItems', 'Drafts', 'DeletedItems',
  'Archive', 'JunkEmail', 'Outbox',
  'MsgFolderRoot', 'RecoverableItemsDeletions',
]);

/** Result of `resolveFolder`. Carries `ResolvedVia` for JSON output of `find-folder`. */
export interface ResolvedFolder extends FolderSummary {
  /** Always present (mandatory on the resolved form). */
  Id: string;
  DisplayName: string;
  /** Materialized path from the anchor down, using the escape grammar in §10.5. */
  Path: string;
  /** How the resolver arrived at this folder. Serialised in `find-folder` JSON. */
  ResolvedVia: 'wellknown' | 'path' | 'id';
}

/** One entry in `CreateFolderResult.created[]`. */
export interface CreateFolderSegment {
  Id: string;
  DisplayName: string;
  /** Slash-delimited path from the anchor down to (and including) this segment. */
  Path: string;
  ParentFolderId: string;
  /** True when the segment already existed (only visible under --idempotent or --create-parents). */
  PreExisting: boolean;
}

export interface CreateFolderResult {
  /** One entry per processed segment (existing and newly created alike). */
  created: CreateFolderSegment[];
  /** Convenience pointer — equals `created[created.length - 1]`. */
  leaf: CreateFolderSegment;
  /** True iff every leaf resolution path was pre-existing (no POST issued for the leaf). */
  idempotent: boolean;
}

/** One entry in `MoveMailResult.moved[]` (success path). */
export interface MoveEntry {
  sourceId: string;
  newId: string;
}

/** One entry in `MoveMailResult.failed[]` (populated only under --continue-on-error). */
export interface MoveFailedEntry {
  sourceId: string;
  error: { code: string; httpStatus?: number; message?: string };
}

/** Destination block included in `MoveMailResult` for id ↔ path symmetry. */
export interface MoveDestination {
  Id: string;
  Path: string;
  DisplayName: string;
}

export interface MoveMailResult {
  destination: MoveDestination;
  moved: MoveEntry[];
  failed: MoveFailedEntry[];
  summary: { requested: number; moved: number; failed: number };
}

/** Safety caps (values pinned in plan-002 §P1 + research §6). */
export const MAX_PATH_SEGMENTS = 16;
export const MAX_FOLDER_PAGES = 50;
export const MAX_FOLDERS_VISITED = 5000;
export const DEFAULT_LIST_TOP = 250;
export const DEFAULT_LIST_FOLDERS_TOP = 100;
```

### 10.4 `OutlookClient` API additions

The `OutlookClient` interface (§2.8) is extended in place. `get<T>` is
unchanged; the 401-retry-once envelope (§2.8 "Re-auth / retry semantics")
is hoisted from the private `doGet` into a method-agnostic `doRequest(method,
path, body?, query?)` so it is shared verbatim by `post` and by every page
fetched inside `listAll`. Every new method returns a discriminated
`Promise<T>` that either resolves to the successful typed value or rejects
with one of the existing `OutlookHttpError` subclasses (`ApiError`,
`AuthError`, `NetworkError`) defined in §2.9. Commands map those
`OutlookHttpError` subclasses to the CLI-layer `OutlookCliError` hierarchy
(`UpstreamError`, `AuthError`, `UsageError`, `CollisionError`) via
`mapHttpError` in `src/commands/list-mail.ts` — the existing pattern is
preserved.

Although this document and `src/config/errors.ts` use concrete classes
(no TypeScript `Result<T, E>` wrapper) — discrimination happens via
`instanceof` in `cli.ts formatErrorJson` / `exitCodeFor`, as documented in
§4 — the effective contract is equivalent to a discriminated
`Result<T, OutlookClientError>`:

```typescript
// Existing (unchanged):
get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
getBinary(path: string): Promise<Buffer>;

// Added:

/**
 * POST a JSON body to `path`. The request body is serialized via
 * `JSON.stringify(body)`. `Content-Type: application/json` is added by the
 * client only for body-bearing methods (POST/PATCH).
 *
 * Returns the parsed response body typed as `TRes`. On HTTP 201 with an
 * empty body, returns `null as unknown as TRes` (rare; the caller validates).
 *
 * 401 → one-shot re-auth via `onReauthNeeded`, retry once. Second 401 →
 * `HttpAuthError{ reason: 'AFTER_RETRY' }` (mapped by `mapHttpError` to
 * `CliAuthError{ code: 'AUTH_401_AFTER_RETRY' }` → exit 4).
 * 403 / 404 / 409 / 429 / 5xx → `ApiError{ code: codeForStatus(status) }`.
 * Network / timeout → `NetworkError{ code: 'NETWORK' | 'TIMEOUT' }`.
 */
post<TBody, TRes>(
  path: string,
  body: TBody,
  query?: Record<string, QueryValue>,
): Promise<TRes>;

/**
 * Enumerate every item in a v2.0 collection, following `@odata.nextLink`
 * verbatim up to `opts.maxPages` (default: MAX_FOLDER_PAGES = 50).
 *
 *   - First GET: `buildUrl(path, { $top: opts.top ?? DEFAULT_LIST_TOP, ...query })`.
 *   - Subsequent GETs: the full absolute URL from `page['@odata.nextLink']`
 *     with NO query merging (the link already encodes `$skip`, `$top`, `$select`).
 *   - Off-host guard: reject any nextLink whose hostname is not
 *     `outlook.office.com` → `ApiError{ code: 'PAGINATION_OFF_HOST' }`.
 *   - Page-cap: on `pageCount >= maxPages` → `ApiError{ code: 'PAGINATION_LIMIT' }`.
 *
 * Each page's GET goes through the shared 401-retry-once envelope. A 401
 * on page N transparently re-auths and retries page N only; preceding pages
 * are not re-fetched (the `$skip` offset is stateless).
 */
listAll<T>(
  path: string,
  query?: Record<string, QueryValue>,
  opts?: { maxPages?: number; top?: number },
): Promise<T[]>;
```

#### Resolver-layer method signatures

These live in `src/folders/resolver.ts`. They consume an `OutlookClient` as
a constructor-style dependency (matching the pattern used across commands)
and raise `OutlookCliError` subclasses (`UpstreamError`, `UsageError`,
`CollisionError`) — NOT raw `OutlookHttpError` — so command callers can
forward the error untouched via `throw mapHttpError(err)`:

```typescript
/** Split + unescape, with validation — see §10.5. */
export function parseFolderPath(input: string): string[];

/** Inverse of parseFolderPath; used to materialize `Path` on recursive list output. */
export function buildFolderPath(segments: string[]): string;

/** Exact match against WELL_KNOWN_ALIASES. Returns canonical form or null. */
export function matchesWellKnownAlias(input: string): WellKnownAlias | null;

/** `GET /me/MailFolders/{parentId}/childfolders` flattened via listAll. */
export function listChildren(
  client: OutlookClient,
  parentId: string,
  opts: { top?: number; includeHidden?: boolean },
): Promise<FolderSummary[]>;

/** Resolve a FolderSpec to a single ResolvedFolder. See §10.5 algorithm. */
export function resolveFolder(
  client: OutlookClient,
  spec: FolderSpec,
  opts: { caseSensitive?: boolean; includeHidden?: boolean; firstMatch?: boolean },
): Promise<ResolvedFolder>;

/** `findChildByName(parent, name)` — single helper used by the create flow. */
export function findFolderByPath(
  client: OutlookClient,
  anchorId: string,
  segments: string[],
  opts: { caseSensitive?: boolean; includeHidden?: boolean; firstMatch?: boolean },
): Promise<FolderSummary | null>;

/**
 * Create (or reuse) a folder path under an anchor. Always idempotent on
 * collision with `--idempotent`; without it, the first collision throws
 * `CollisionError('FOLDER_ALREADY_EXISTS', segmentPath, parentId)`.
 */
export function createFolder(
  client: OutlookClient,
  args: {
    anchorId: string;
    segments: string[];
    createParents: boolean;
    idempotent: boolean;
  },
): Promise<CreateFolderResult>;

/**
 * Move one message. Always pre-resolves alias → raw id before issuing POST
 * (ADR-16). Returns `{ sourceId, newId }`.
 */
export function moveMessage(
  client: OutlookClient,
  sourceId: string,
  destinationId: string,
): Promise<MoveEntry>;

/**
 * List messages inside a folder addressed by id or alias. Thin wrapper over
 * the existing `GET /me/MailFolders/{folder}/messages` path used by
 * `list-mail`; kept on the resolver layer so `list-mail.ts` stays minimal.
 */
export function listMessagesInFolder(
  client: OutlookClient,
  folder: { kind: 'id' | 'wellKnown'; value: string },
  query: Record<string, QueryValue>,
): Promise<MessageSummary[]>;

/**
 * Predicate discriminating the "folder already exists" wire condition. Both
 * HTTP 400 and HTTP 409 with `error.code === 'ErrorFolderExists'` match;
 * see §10.6 and `docs/research/outlook-v2-folder-duplicate-error.md §4.1`.
 */
export function isFolderExistsError(err: unknown): boolean;
```

### 10.5 Path-resolution algorithm

The resolver is the single canonical owner of every path / alias / NFC /
case-fold / ambiguity / well-known-precedence rule. Commands never recompute
any of it.

**Escape grammar (text-pseudocode, normative).** A path string is a
slash-separated sequence of display-name segments. Only two characters ever
require escaping inside a segment:

- `/` inside a DisplayName → encoded as `\/`
- `\` inside a DisplayName → encoded as `\\`

No other escaping rules apply: leading/trailing whitespace is preserved and
not trimmed; Unicode characters pass through verbatim (subject to NFC
normalization at compare time, §10.5.3).

```
parseFolderPath(input):
  segments = []
  current  = ""
  i = 0
  while i < len(input):
    c = input[i]
    if c == '\\':
      # backslash escape — only '\\/' and '\\\\' are legal
      if i + 1 >= len(input): raise UsageError(FOLDER_PATH_INVALID, "dangling escape")
      next = input[i + 1]
      if next == '/':      current += '/';  i += 2
      elif next == '\\':   current += '\\'; i += 2
      else:                raise UsageError(FOLDER_PATH_INVALID, "unknown escape")
    elif c == '/':
      if current == "":    raise UsageError(FOLDER_PATH_INVALID, "empty segment")
      segments.append(NFC(current))
      current = ""
      i += 1
    else:
      current += c
      i += 1
  # final segment
  if current == "" and len(segments) == 0:
    raise UsageError(FOLDER_PATH_INVALID, "empty path")
  if current == "":                # trailing '/'
    raise UsageError(FOLDER_PATH_INVALID, "empty segment")
  segments.append(NFC(current))
  if len(segments) > MAX_PATH_SEGMENTS:  # = 16
    raise UsageError(FOLDER_PATH_INVALID, "path depth > 16")
  return segments
```

**Walk.** Given a parsed segment list and an anchor `FolderSpec`:

```
resolveFolder(client, spec, opts):
  if spec.kind == 'id':
    return client.get<FolderSummary>("/me/MailFolders/" + encode(spec.value))
          ↳ map ApiError(NOT_FOUND) → UpstreamError(UPSTREAM_FOLDER_NOT_FOUND)
          ↳ return ResolvedFolder{ ..., Path: DisplayName, ResolvedVia: 'id' }

  if spec.kind == 'wellKnown':
    return ResolvedFolder{
      Id: spec.value, DisplayName: spec.value,
      Path: spec.value, ResolvedVia: 'wellknown'
    }
    # NOTE: No REST call. Outlook accepts the alias verbatim in every
    # subsequent URL path slot (confirmed §10.4 of research doc).

  # spec.kind == 'path'
  segments = parseFolderPath(spec.value)
  anchor   = resolveFolder(client, spec.parent ?? { kind:'wellKnown', value:'MsgFolderRoot' }, opts)
  currentId   = anchor.Id
  currentPath = anchor.Path == 'MsgFolderRoot' ? "" : anchor.Path
  for each (segment, i) in segments:
    children = listChildren(client, currentId,
                            { top: DEFAULT_LIST_FOLDERS_TOP, includeHidden: opts.includeHidden })
    matches = filter(children, c => nameEquals(c.DisplayName, segment, opts.caseSensitive))
    if matches.length == 0:
      raise UpstreamError(UPSTREAM_FOLDER_NOT_FOUND,
                          "segment '" + segment + "' under parent " + currentId)
    if matches.length > 1:
      if !opts.firstMatch:
        raise UsageError(FOLDER_AMBIGUOUS,
                         candidates = matches.map(c => c.Id))
      # ADR-14 tiebreaker: CreatedDateTime asc, then Id asc.
      sort matches by (CreatedDateTime asc, Id asc)
    chosen = matches[0]
    currentId   = chosen.Id
    currentPath = (currentPath == "" ? segment : currentPath + "/" + escape(segment))
  return ResolvedFolder{ ...chosen, Path: currentPath, ResolvedVia: 'path' }
```

Helper `nameEquals(a, b, caseSensitive)` applies Unicode NFC to both sides,
then compares — with Unicode simple case-fold when `!caseSensitive` (the
default) — exact-equality. No trimming, no whitespace collapsing (refined
§6.3). The `$filter=DisplayName eq '...'` optimization is NOT used in v1
(research §4 — v2.0 `$filter` reliability is medium; client-side compare
is the primary strategy).

**Ambiguity and `--first-match` tiebreaker.** The resolver default is to
raise `UsageError(FOLDER_AMBIGUOUS)` exit 2 whenever a segment lookup
returns more than one match. The user may opt into automatic
disambiguation via `--first-match`, in which case the resolver sorts
candidates by `CreatedDateTime asc, Id asc` (ADR-14) and returns the
first. `CreatedDateTime` is included in the default `$select` for every
`listChildren` call (§10.4).

**Case-folding + NFC normalization.** Every segment is NFC-normalized at
parse time (`parseFolderPath`) and every candidate `DisplayName` is
NFC-normalized at compare time (`nameEquals`). Case-folding uses the
Unicode simple case-fold (ECMAScript `String.prototype.toLowerCase`
suffices for BMP; for non-BMP paths the resolver uses
`s.normalize('NFC').toLocaleLowerCase('en-US')` — stable across tenants).
When `--case-sensitive` is set, case-folding is skipped; NFC still applies.

**Max depth + max pages/nodes (caps, normative).**

| Cap                                 | Value   | Purpose                                                                 | Error raised on breach                                       |
|-------------------------------------|---------|-------------------------------------------------------------------------|--------------------------------------------------------------|
| `MAX_PATH_SEGMENTS`                 | 16      | Bounds `parseFolderPath` output length.                                 | `UsageError('FOLDER_PATH_INVALID')` exit 2                   |
| `MAX_FOLDER_PAGES` (per collection) | 50      | Bounds a single `listChildren` pagination loop.                         | `ApiError('PAGINATION_LIMIT')` → `UpstreamError('UPSTREAM_PAGINATION_LIMIT')` exit 5 |
| `DEFAULT_LIST_TOP` (per page)       | 250     | Default `$top` for every `listAll` first page.                          | —                                                            |
| `MAX_FOLDERS_VISITED` (per walk)    | 5000    | Whole-tree cap for `list-folders --recursive` DFS materialization.      | `UpstreamError('UPSTREAM_PAGINATION_LIMIT')` exit 5          |

Off-host `@odata.nextLink` (not matching `outlook.office.com`) is a
defense-in-depth reject handled inside `OutlookClient.listAll`:
`ApiError('PAGINATION_OFF_HOST')` → `UpstreamError('UPSTREAM_PAGINATION_LIMIT')`
exit 5 with an explanatory message.

**Well-known precedence.** When a user folder at the root shares a
DisplayName with a well-known alias, the alias wins at the root only. A
path `Inbox/Inbox` resolves strictly by display-name lookup inside the
real Inbox — the alias shortcut applies only to segment 0 with an implicit
`MsgFolderRoot` anchor (ADR-15). Users can reach a shadowed top-level
user folder named `Inbox` via `--parent MsgFolderRoot --first-match` or
by passing its id.

### 10.6 Error handling strategy

The folder feature introduces one new error class (`CollisionError`,
ADR-13) and extends the string-code vocabulary on the existing `UsageError`
and `UpstreamError` classes. The exit-code surface is unchanged (the
existing 0/1/2/3/4/5/6 taxonomy in §4 covers every new condition).

**Wire-shape → classified-error mapping.** This table is the canonical
reference for both implementers and reviewers. `codeForStatus` is the
existing helper in `src/http/errors.ts:136`.

| Upstream condition                                              | `ApiError.code` / Network | Resolver-level reclassification                        | `OutlookCliError`                                 | Exit |
|-----------------------------------------------------------------|---------------------------|--------------------------------------------------------|---------------------------------------------------|------|
| HTTP 401 (first)                                                | auto-retry — no error     | —                                                      | (none)                                            | —    |
| HTTP 401 (second, or `--no-auto-reauth`)                        | `AFTER_RETRY` / `NO_REAUTH` | forwarded                                              | `AuthError`                                       | 4    |
| HTTP 403                                                        | `FORBIDDEN`               | forwarded                                              | `UpstreamError('UPSTREAM_HTTP_403')`              | 5    |
| HTTP 404 on `/me/MailFolders/{id}`                              | `NOT_FOUND`               | → `UPSTREAM_FOLDER_NOT_FOUND`                          | `UpstreamError('UPSTREAM_FOLDER_NOT_FOUND')`      | 5    |
| HTTP 404 on `/me/messages/{srcId}/move` (source id)             | `NOT_FOUND`               | forwarded                                              | `UpstreamError('UPSTREAM_HTTP_404')`              | 5    |
| HTTP 400 / 409 with `error.code === 'ErrorFolderExists'`        | `API_ERROR` / `CONFLICT`  | `isFolderExistsError(err) === true`                    | `CollisionError('FOLDER_ALREADY_EXISTS')` (or `PreExisting: true` under `--idempotent`) | 6 |
| HTTP 400 (non-ErrorFolderExists)                                | `API_ERROR`               | forwarded                                              | `UpstreamError('UPSTREAM_HTTP_400')`              | 5    |
| HTTP 409 (non-ErrorFolderExists)                                | `CONFLICT`                | forwarded                                              | `UpstreamError('UPSTREAM_HTTP_409')`              | 5    |
| HTTP 429                                                        | `RATE_LIMITED`            | forwarded                                              | `UpstreamError('UPSTREAM_HTTP_429')`              | 5    |
| HTTP 5xx                                                        | `SERVER_ERROR`            | forwarded                                              | `UpstreamError('UPSTREAM_HTTP_5XX')`              | 5    |
| `listAll` page cap hit                                          | `PAGINATION_LIMIT`        | forwarded                                              | `UpstreamError('UPSTREAM_PAGINATION_LIMIT')`      | 5    |
| `listAll` off-host nextLink                                     | `PAGINATION_OFF_HOST`     | forwarded as PAGINATION_LIMIT                          | `UpstreamError('UPSTREAM_PAGINATION_LIMIT')`      | 5    |
| Ambiguous path segment (resolver-detected, no `--first-match`)  | (no HTTP error)           | resolver-raised                                        | `UsageError('FOLDER_AMBIGUOUS')`                  | 2    |
| Missing intermediate parent (no `--create-parents`)             | (no HTTP error)           | resolver-raised                                        | `UsageError('FOLDER_MISSING_PARENT')`             | 2    |
| Path parse error (depth > 16, empty segment, bad escape)        | (no HTTP error)           | resolver-raised                                        | `UsageError('FOLDER_PATH_INVALID')`               | 2    |
| argv validation (missing `<query>`, XOR violations, range)      | —                         | command-raised                                         | `UsageError('BAD_USAGE')`                         | 2    |
| Network / timeout / abort                                       | `NETWORK` / `TIMEOUT`     | forwarded                                              | `UpstreamError('UPSTREAM_NETWORK' / '_TIMEOUT')`  | 5    |
| Partial move with `--continue-on-error` + at least one failure  | (per-entry `ApiError`)    | absorbed into `failed[]`; re-raised as synthetic after emit | `UpstreamError('UPSTREAM_PARTIAL_MOVE')`      | 5    |

**`ErrorFolderExists` predicate (normative).** The research in
`docs/research/outlook-v2-folder-duplicate-error.md §4.1` pins this down:
both HTTP 400 and HTTP 409 are observed across tenants, with the same
OData `error.code` string. The predicate is placed in
`src/folders/resolver.ts` (or inlined near `createFolder`) and is the
single decision point for the idempotent branch:

```typescript
/**
 * Returns true when an API error from POST /me/MailFolders or
 * POST /me/MailFolders/{id}/childfolders indicates that a folder with the
 * requested DisplayName already exists under the target parent.
 *
 * Both HTTP 400 and HTTP 409 are accepted because Exchange Online tenants are
 * inconsistent: most return 400, some return 409. The `error.code` field is
 * the authoritative discriminator — the message text is NOT used (it embeds
 * the folder name and is not locale-stable).
 */
export function isFolderExistsError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 400 && err.status !== 409) return false;
  const code: unknown = (err.body as { error?: { code?: unknown } })
    ?.error?.code;
  return code === 'ErrorFolderExists';
}
```

This is exactly the shape recommended by the research; no client-level
message parsing, no HTTP-status-only check.

### 10.7 CLI surface delta

Cross-reference: the existing `list-mail` / `get-mail` / etc. shapes live
in §2.13; this table documents only the new and changed surface.

| Subcommand         | Positional     | Flags                                                                                                                                                                                                                                                                           | Exit codes | JSON shape                                                          | Table columns                                |
|--------------------|----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------|---------------------------------------------------------------------|----------------------------------------------|
| `list-folders`     | —              | `--parent <name-or-path-or-id>` (default `MsgFolderRoot`, ADR-15); `--recursive`; `--include-hidden`; `--top <N>` (1..250, default 100)                                                                                                                                          | 0/2/3/4/5  | `FolderSummary[]` (with `Path` when `--recursive`)                  | `Path \| Unread \| Total \| Children \| Id`  |
| `find-folder`      | `<query>`      | `--parent <anchor>` (default `MsgFolderRoot`); `--case-sensitive`; `--include-hidden`; `--first-match`                                                                                                                                                                           | 0/2/3/4/5  | single `ResolvedFolder`                                             | JSON fallback (no ColumnSpec; `find-folder` is a single-object payload — see §2.13.7 pattern) |
| `create-folder`    | `<path>`       | `--parent <anchor>` (default `MsgFolderRoot`); `--create-parents`; `--idempotent`; `--display-name <name>` (override last segment's DisplayName)                                                                                                                                  | 0/2/3/4/5/6 | `CreateFolderResult`                                                | `Path \| Id \| PreExisting` (applied to `result.created`)  |
| `move-mail`        | `[id]`         | `--to <name-or-path>` XOR `--to-id <folderId>`; `--to-parent <anchor>` (default `MsgFolderRoot`); `--ids-from <path-or-dash>` (XOR with `<id>`); `--continue-on-error`; `--stop-at <N>` (default 1000, range 1..10000); `--first-match`                                              | 0/2/3/4/5  | `MoveMailResult`                                                    | `Source Id \| New Id \| Status \| Error`     |
| `list-mail` (ext.) | —              | **Additive to §2.13.3**: `--folder-id <id>` (XOR with `--folder`); `--folder-parent <anchor>` (default `MsgFolderRoot`). `--folder` widened to accept paths and all other well-known aliases (`JunkEmail`, `Outbox`, `MsgFolderRoot`, `RecoverableItemsDeletions`).            | 0/2/3/4/5/6 | `MessageSummary[]` (unchanged)                                      | `Received \| From \| Subject \| Att \| Id` (unchanged) |

**Validation (normative, enforced in command `run()` before REST):**

- `find-folder`: missing `<query>` → `UsageError('BAD_USAGE')` exit 2.
- `create-folder`: missing `<path>`, empty path, or last segment matching a
  well-known alias when anchor is `MsgFolderRoot` → `UsageError('BAD_USAGE')`
  exit 2 (refined §5.3 "cannot create Inbox at root").
- `move-mail`: `<id>` XOR `--ids-from` (both/neither → exit 2); `--to` XOR
  `--to-id` (both/neither → exit 2); `--stop-at` out of range → exit 2;
  `--ids-from` yielding more entries than `--stop-at` → exit 2
  (AC-MOVE-STOPAT).
- `list-mail`: `--folder-id` XOR `--folder` (both present → exit 2).
- All commands: reject unknown flags (commander default) → exit 2.

### 10.8 Move semantics

**Critical invariant: `POST /me/messages/{id}/move` returns a NEW id.** The
response body is a `Message` resource whose `Id` is the new identity of the
(logically same) message in the destination folder. The source id is no
longer addressable via `GET /me/messages/{sourceId}` after a successful
move. This is a property of Outlook's v2.0 `/move` endpoint (confirmed in
`docs/research/outlook-v2-move-destination-alias.md §2c` and refined
§5.4), not a client behaviour — the client merely surfaces it.

Because the existing CLI already exposes message ids through `list-mail`,
`get-mail`, and `download-attachments`, any naive script that chains
`find-folder | move-mail | get-mail <id>` using the source id will break.
The tool mitigates this footgun by surfacing the mapping explicitly in the
command output:

```json
{
  "destination": {
    "Id":          "AAMkAGI...dest",
    "Path":        "Projects/Alpha",
    "DisplayName": "Alpha"
  },
  "moved": [
    { "sourceId": "AAMkAGI...srcA", "newId": "AAMkAGI...newA" },
    { "sourceId": "AAMkAGI...srcB", "newId": "AAMkAGI...newB" }
  ],
  "failed": [],
  "summary": { "requested": 2, "moved": 2, "failed": 0 }
}
```

The table mode mirrors the same pairing as two ID columns (`Source Id`,
`New Id`); both columns are defined without `maxWidth` per the §2.14
"IDs never get `maxWidth`" rule. The CLAUDE.md `<move-mail>` block
(added in phase P7) calls out the new-id semantics in its `<info>`
section so scripted users see it before they run the command.

Under `--continue-on-error`, the `failed[]` array carries one entry per
per-message failure, shape `{ sourceId, error: { code, httpStatus?, message? } }`.
The `summary` aggregates the counts. Exit-code semantics are documented in
§10.9.

### 10.9 Concurrency, idempotency, races

The folder feature is strictly serial: every multi-message move issues one
REST call at a time (NG10), and there is no in-process parallelism. The
project-wide advisory PID lock at `<sessionDir>/.browser.lock` (§2.6)
already prevents two concurrent login flows from racing on the Playwright
profile dir, and the folder feature does not add any new shared mutable
state beyond the session file (itself atomic-rename-protected).

**The one race that does exist — and why it is acceptable.** The
`create-folder --idempotent` flow is a lookup-then-create pattern:

1. `GET /me/MailFolders/{parentId}/childfolders?$filter=DisplayName eq ...`
   (or, equivalently, `listAll` + client-side filter).
2. If found → reuse the id (`PreExisting: true`).
3. If not found → `POST /me/MailFolders/{parentId}/childfolders`.

Between steps 1 and 3 another Outlook client (a concurrent `create-folder`
run, a browser tab, Outlook on the phone) may create the same folder.
When that happens, the POST in step 3 returns HTTP 400 or 409 with
`error.code === 'ErrorFolderExists'`. `isFolderExistsError` catches it,
the resolver re-lists the parent's children, locates the now-existing
folder by DisplayName, and records it as `PreExisting: true` — exactly
the idempotent outcome the user asked for. The tool does NOT trust the
POST body on the collision path; the re-list step is the authoritative
recovery.

**Why this is acceptable for a single-user CLI.** The CLI is user-driven
(the user runs one command at a time in one terminal), the collision
window is milliseconds wide, and the collision outcome is correctly
reported as "this folder was already here" either way. The only
observable difference between "I won the race and created it" and "I
lost the race and it was pre-existing" is the `PreExisting` flag in the
JSON output — and `--idempotent` callers have explicitly asked for that
distinction to not matter. A more elaborate lock (e.g. an Outlook-side
compare-and-swap) is unavailable via REST v2.0, is unnecessary for a
single-user CLI, and is explicitly out of scope (NG10).

The hidden-folder edge case (a collision with a folder that `isHidden:
true` has hidden from the pre-create list — see research
`outlook-v2-folder-duplicate-error.md §3.4`) is handled by the same
safety net: the POST collision is detected by OData code, not by the
pre-create list, so the idempotent recovery works regardless of visibility.

### 10.10 Architectural decisions – Folder Management

The four architectural decisions (OQ-1..OQ-4 from `docs/design/plan-002-folders.md §0`)
are now recorded as **ADR-13..ADR-16** in §9 above. They are cross-referenced
here for searchability:

- **ADR-13 (OQ-1)** — dedicated `CollisionError` class (exit 6) instead of
  reusing `IoError`.
- **ADR-14 (OQ-2)** — `--first-match` tiebreaker order is
  `CreatedDateTime asc, Id asc`.
- **ADR-15 (OQ-3)** — default parent for `create-folder` / `list-folders`
  is `MsgFolderRoot`.
- **ADR-16 (OQ-4)** — always pre-resolve alias → raw id before
  `POST /move`.

Each ADR carries its rationale and the alternative that was rejected.

### 10.11 Parallel implementation contracts

The folder feature splits into 12 implementation units that match
`plan-002-folders.md §5` parallel-safety matrix exactly. The contracts
below document, for each unit, the **interface surface that is public to
other units** (what Wave-4 coders may import) and the **files it is the
sole writer of** (what other units may NOT touch). This is the hard
guarantee that lets Wave-4 run five agents in parallel without write
conflicts.

Graph of implementation dependencies — identical to plan-002 §3:

```
                Wave 1 (parallel)
                P1 (types)  P2 (errors)
                     │          │
                     └────┬─────┘
                          ▼
                Wave 2 — P3 (http client: post + listAll)
                          │
                          ▼
                Wave 3 — P4 (resolver + folder-path utils)
                          │
         ┌────────┬───────┼───────┬──────────┐
         ▼        ▼       ▼       ▼          ▼
         Wave 4 (parallel, five agents)
         P5a      P5b    P5c     P5d         P5e
     list-folders find   create  move-mail   list-mail
                  folder folder                extension
         └────────┴───────┴───────┴──────────┘
                          │
                          ▼
                Wave 5 — P6 (cli.ts wiring + ColumnSpecs + CollisionError branch)
                          │
                          ▼
         Wave 6 (parallel) — P7 (docs) + P8 (tests)
```

**Per-unit contracts.**

| Unit | Sole-writer files                                              | Publishes (imports other units may use)                                                                                                                                                                                      | Must NOT touch                                                                                       |
|------|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| P1   | `src/http/types.ts` (additive); `src/folders/types.ts`          | `FolderSummary`, `FolderCreateRequest`, `MoveMessageRequest`, `ODataListResponse<T>`, `FolderSpec`, `WellKnownAlias`, `WELL_KNOWN_ALIASES`, `ResolvedFolder`, `CreateFolderSegment`, `CreateFolderResult`, `MoveEntry`, `MoveFailedEntry`, `MoveDestination`, `MoveMailResult`, safety-cap constants | everything else                                                                                      |
| P2   | `src/config/errors.ts`                                          | `CollisionError` class (`exitCode = 6`, fields `code`, `path?`, `parentId?`); documented new code strings on `UsageError` / `UpstreamError` (no type changes)                                                                   | everything else                                                                                      |
| P3   | `src/http/outlook-client.ts`                                     | Extended `OutlookClient` interface with `post<TBody, TRes>` and `listAll<T>`; unchanged `get<T>` / `getBinary`                                                                                                                | `src/folders/*`, `src/commands/*`, `src/cli.ts`; must not rename existing exports                    |
| P4   | `src/folders/resolver.ts`                                        | `parseFolderPath`, `buildFolderPath`, `matchesWellKnownAlias`, `listChildren`, `resolveFolder`, `findFolderByPath`, `createFolder`, `moveMessage`, `listMessagesInFolder`, `isFolderExistsError`                                | `src/http/*`, `src/commands/*`, `src/cli.ts`                                                          |
| P5a  | `src/commands/list-folders.ts`                                   | `ListFoldersDeps`, `ListFoldersOptions`, `run(deps, opts): Promise<FolderSummary[]>`                                                                                                                                          | every other `src/commands/*.ts`, `src/folders/*`, `src/http/*`, `src/cli.ts`                          |
| P5b  | `src/commands/find-folder.ts`                                    | `FindFolderDeps`, `FindFolderOptions`, `run(deps, query, opts): Promise<ResolvedFolder>`                                                                                                                                       | every other `src/commands/*.ts`, `src/folders/*`, `src/http/*`, `src/cli.ts`                          |
| P5c  | `src/commands/create-folder.ts`                                  | `CreateFolderDeps`, `CreateFolderOptions`, `run(deps, path, opts): Promise<CreateFolderResult>`                                                                                                                                | every other `src/commands/*.ts`, `src/folders/*`, `src/http/*`, `src/cli.ts`                          |
| P5d  | `src/commands/move-mail.ts`                                      | `MoveMailDeps`, `MoveMailOptions`, `run(deps, id?, opts): Promise<MoveMailResult>`                                                                                                                                             | every other `src/commands/*.ts`, `src/folders/*`, `src/http/*`, `src/cli.ts`                          |
| P5e  | `src/commands/list-mail.ts`                                      | Extended `ListMailOptions` (`folderId?`, `folderParent?`); unchanged `ensureSession`, `mapHttpError`, `UsageError` re-exports                                                                                                 | every other `src/commands/*.ts`, `src/folders/*`, `src/http/*`, `src/cli.ts`                          |
| P6   | `src/cli.ts`                                                     | wired subcommand registrations, new `ColumnSpec` constants, `CollisionError` branch in `formatErrorJson` / `exitCodeFor`                                                                                                      | (none; synthesis-only unit)                                                                          |
| P7   | `CLAUDE.md`, `docs/design/project-design.md`, `docs/design/project-functions.MD`, `Issues - Pending Items.md` | documentation only — no runtime exports                                                                                                                                                                                      | `src/**`                                                                                              |
| P8   | `test_scripts/unit/*.spec.ts`, `test_scripts/ac-folders-*.ts`    | tests only; no runtime exports                                                                                                                                                                                                | `src/**`                                                                                              |

**Interface stability rules for Wave 4.** After P4 lands, every P5 coder
receives:

- A frozen `FolderSpec` tagged union (P1) they must consume without
  extending.
- A frozen `OutlookClient` interface (P3) with exactly the three methods
  `get`, `post`, `listAll` (plus `getBinary`); no coder may call `fetch`
  directly.
- A frozen `resolveFolder` / `createFolder` / `moveMessage` contract (P4)
  they must consume; no coder re-implements path / alias / ambiguity
  logic inside a command file.
- `ensureSession` + `mapHttpError` + `UsageError` re-exports from
  `src/commands/list-mail.ts` (unchanged from §2.13.3). Every new command
  imports these from the same location — no forks.

**What Wave 4 may NOT touch.** Across P5a..P5e, no coder may:

- Modify `src/http/*`, `src/folders/*`, `src/config/errors.ts`, or
  `src/cli.ts`.
- Add a new error class (P2 is the sole owner; folder commands raise
  `CollisionError` / `UsageError` / `UpstreamError` by re-using the
  existing instances).
- Add a new `fetch` call site.
- Touch another command's file (P5a may not modify P5b's file, etc.).
- Redeclare a type that P1 has already published.

These rules mirror the "Patterns to preserve" hard rules from
`docs/reference/codebase-scan-folders.md` §Patterns 1-7, extended for the
folder feature scope.

---

## 11. Threads, date-range filtering, and server-side counting

Features added after the folder-management chapter landed. Additive to §2.8
(`OutlookClient`) and §2.13.3 (`list-mail`); no new top-level modules. Shipped
in versions [1.2.0] and [1.3.0] (see `CHANGELOG.md`).

### 11.1 Scope

Three related capabilities, each reusing the existing HTTP/session/auth
pipeline without new subsystems:

1. **Date-range filter on `list-mail`** — `--from <iso|keyword>` /
   `--to <iso|keyword>` build an OData `$filter=ReceivedDateTime ge X and
   ReceivedDateTime lt Y` threaded through all three folder resolution paths
   (fast-path alias, `--folder-id`, resolver).
2. **Thread retrieval** — new `get-thread <id>` subcommand walks a message's
   `ConversationId` and returns every message in that thread regardless of
   folder.
3. **Server-side count** — new `--just-count` flag on `list-mail` asks Outlook
   for just the count via `$count=true&$top=1` (constant-cost regardless of
   folder size; no client-side paging).

### 11.2 Module additions

| File | Change | Purpose |
|---|---|---|
| `src/util/dates.ts` | **new** | Shared timestamp parser. `parseTimestamp(raw)` accepts ISO8601, space-separated local time, and the keyword grammar `now` / `now + Nd` / `now - Nd`. Returns a discriminated `{ ok: true, iso } | { ok: false, reason }` so callers can attach command-specific error prefixes. `list-calendar`'s `resolveCalendarDate` delegates to it. |
| `src/commands/get-thread.ts` | **new** | Command handler. `run(deps, idOrConv, opts)` returns `{ conversationId, count, messages[] }`. |
| `src/http/types.ts` | extended | `MessageSummary.ConversationId?: string` added (optional — only surfaced when `$select` requests it). `ODataListResponse.'@odata.count'?: number` added. |
| `src/http/outlook-client.ts` | extended | Two new public methods: `listMessagesByConversation(conversationId, opts?)` and `countMessagesInFolder(folderId, opts?)`. `listMessagesInFolder` gains an optional `filter?: string` field. All three route through the existing `doRequest`/`withAutoReauth` pipeline. |
| `src/commands/list-mail.ts` | extended | `ListMailOptions` gains `from?`, `to?`, `justCount?`. `run()` return widens to `MessageSummary[] \| ListMailCountResult`. New internal helper `buildReceivedDateFilter(from, to)` produces the `$filter` string or `undefined`. |
| `src/cli.ts` | extended | Registers `--from` / `--to` / `--just-count` on list-mail; registers the `get-thread` subcommand with `--body` / `--order`. The list-mail action handler discriminates `Array.isArray(result)` to pick JSON vs. table rendering. |

### 11.3 Date-window grammar

Both `--from` and `--to` accept, identically, any of:

1. ISO8601 UTC: `YYYY-MM-DDTHH:MM:SSZ` — e.g. `2026-04-01T00:00:00Z`.
2. Space-separated local time: `YYYY-MM-DD HH:MM:SS` — e.g. `2026-04-01 00:00:00`.
3. Keyword: `now` | `now + Nd` | `now - Nd` (whitespace-insensitive, case-insensitive).

Lower bound is **inclusive** (`ge`), upper bound is **exclusive** (`lt`).
Rationale: day-aligned adjacent windows don't overlap
(`--from 2026-04-01T00:00:00Z --to 2026-05-01T00:00:00Z` covers all of April).

Either, both, or neither bound may be set. Malformed input → `UsageError`
(exit 2) with a `list-mail:` message prefix.

### 11.4 Thread retrieval algorithm

```
run(id):
  if id startsWith "conv:":
    conversationId = id.slice(5)  # skip the resolve hop
  else:
    msg = GET /api/v2.0/me/messages/{id}?$select=Id,ConversationId
    if msg.ConversationId empty → UsageError
    conversationId = msg.ConversationId

  messages = GET /api/v2.0/me/messages
             ?$filter=ConversationId eq '<escaped>'
             &$orderby=ReceivedDateTime <order>
             &$select=<base ± Body,BodyPreview>

  return { conversationId, count: messages.length, messages }
```

OData string literal escaping: single quotes in the value are doubled
(`'` → `''`). Outlook ConversationIds are base64-safe so this is defensive.

### 11.5 Server-side count algorithm

```
run(--just-count):
  folderId = <resolve via the existing three paths>
  resp = GET /api/v2.0/me/MailFolders/{folderId}/messages
         ?$count=true&$top=1&$select=Id[&$filter=<window>]
  if resp['@odata.count'] is a finite number:
    return { count: resp['@odata.count'], exact: true }
  else:
    return { count: resp.value.length, exact: false }
```

`--just-count` **ignores** `--top` and `--select` — the flag is about
"how many match", not "show me N". The `--top` range-validation step is
skipped in count mode so values like `--top 5000` do not raise a
`UsageError` when paired with `--just-count`.

### 11.6 Interaction matrix — `list-mail`

Every combination of folder flag × date window × just-count is valid:

| Folder path | Date window | Count mode | Terminal call |
|---|---|---|---|
| `--folder <fast-alias>` | optional | — | `client.get(/MailFolders/{alias}/messages, …)` |
| `--folder <fast-alias>` | optional | `--just-count` | `client.countMessagesInFolder(alias, {filter})` |
| `--folder-id <raw>` | optional | — | `client.listMessagesInFolder(id, {filter, …})` |
| `--folder-id <raw>` | optional | `--just-count` | `client.countMessagesInFolder(id, {filter})` |
| `--folder <path>` [+ `--folder-parent`] | optional | — | resolve → `client.listMessagesInFolder(resolvedId, {filter, …})` |
| `--folder <path>` [+ `--folder-parent`] | optional | `--just-count` | resolve → `client.countMessagesInFolder(resolvedId, {filter})` |

The existing folder-flag exclusivity rules (§10.7) remain unchanged.

### 11.7 Known limitations / follow-ups

- If the upstream server ignores `$count=true` (rare on v2.0 but possible on
  some tenants), `countMessagesInFolder` falls back to `value.length` and
  returns `exact: false`. Callers that need the authoritative total when
  this happens would have to fetch pages — explicitly deferred.
- `get-thread` does not resolve attachments per message; callers still use
  `get-mail` / `download-attachments` for that.
- No thread-level bulk operations (e.g. "move whole thread to folder X") —
  deferred; compose `get-thread` + `move-mail` in the shell instead.

### 11.8 Test coverage (as shipped)

- `test_scripts/outlook-client-threads.spec.ts` — `countMessagesInFolder`
  (4 tests), `listMessagesByConversation` (4 tests), `listMessagesInFolder.filter`
  option (2 tests).
- `test_scripts/commands-list-mail-daterange.spec.ts` — 7 tests covering the
  three folder paths, malformed-input branches, and keyword grammar.
- `test_scripts/commands-list-mail-count.spec.ts` — 6 tests covering all three
  folder paths, `--from`/`--to` threading, `--top` skip in count mode, and
  `exact: false` propagation.
- `test_scripts/commands-get-thread.spec.ts` — 11 tests covering message-id
  mode, `conv:` mode, body / order options, empty-input guards, and the
  no-ConversationId edge case.

Total suite at [1.3.0]: **240 tests** across 21 files.

---

## Summary

- Full, contract-grade TypeScript design spanning 14 base modules + 6 folder-feature
  modules across 7 layers (config, session, auth, http, folders, commands, output/util).
- Mandatory vs. optional configuration enforced per refined spec §8; `ConfigurationError`
  is the only path for missing mandatory settings.
- 9 base data types (`SessionFile`, `Cookie`, `MessageSummary`, `Message`,
  `AttachmentEnvelope` with 3 sub-types, `EventSummary`, `Event`, `SavedRecord`,
  `SkippedRecord`) plus the folder-feature types (`FolderSummary`, `FolderSpec`
  tagged-union, `ResolvedFolder`, `CreateFolderResult`, `MoveMailResult`) — single
  source of truth for all coders.
- 8 base parallelizable implementation units (P-A..P-H, plan-001) plus 12 folder-feature
  units (P1, P2, P3, P4, P5a..P5e, P6, P7, P8 per plan-002) with each unit's file
  ownership and dependency edges spelled out.
- 16 ADRs justify every non-obvious technology and architecture choice (ADR-13..ADR-16
  cover plan-002 OQ-1..OQ-4).

Absolute output path: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md`


# Agent Subcommand (Plan 003)

Status: Designer-signed, ready for coder swarm.
Upstream inputs: `docs/design/refined-request-langgraph-agent.md`,
`docs/reference/codebase-scan-langgraph-agent.md`,
`docs/design/investigation-langgraph-agent.md`,
`docs/research/azure-deepseek-tool-calling.md`,
`docs/design/plan-003-langgraph-agent.md`.
Normative scope: this section is the single source of truth for every
coder-facing interface, file boundary, config name, and ADR for the
LangGraph ReAct agent feature. Where details are exhaustively specified
upstream (e.g., plan §2 phase-by-phase verification commands, research
§7.5 curl test), this section references the file rather than duplicating
it — but every interface a coder must implement appears explicitly below.

## 1. System Architecture & Control Flow

```
                  user
                   |
                   v
          +------------------+
          |  node src/cli.ts |
          |  (commander)     |
          +--------+---------+
                   |
                   | .action(...)  ── `makeAction<AgentOptions,[prompt?]>`
                   v
          +--------------------------+
          |  agent action handler    |   src/cli.ts (Phase H)
          |  - buildDeps(flags)      |     builds CommandDeps
          |  - calls agentCmd.run(…) |
          |  - emitResult(result,…)  |     final envelope → stdout
          +--------+-----------------+
                   |
                   v
  +------------------------------------------------+
  |  commands/agent.ts :: run(deps, prompt, opts)  |
  |  1. loadDotenv(opts.envFile ?? null)           |   (dotenv before env reads)
  |  2. cfg = loadAgentConfig(opts)                |
  |  3. await authCheck.run(deps)                  |
  |     - status != 'ok' + noAutoReauth → AuthError
  |     - status != 'ok' + auto-reauth → deps.doAuthCapture()
  |  4. if (opts.interactive) return runInteractive(deps,cfg)
  |  5. return runOneShot(deps,cfg,prompt)         |
  +------+-----------------------------------------+
         |
         |      (both runners share this build path)
         v
  +------------------+     +------------------+     +------------------+
  | providerRegistry |     | buildToolCatalog |     | createAgentLogger|
  | (Phase C)        |     | (Phase D)        |     | (Phase E)        |
  | env → model      |     | deps,cfg → tools |     | cfg → Logger     |
  +---------+--------+     +---------+--------+     +---------+--------+
            \                        |                        /
             \                       v                       /
              \             +-----------------+             /
               +----------> | createAgentGraph | <---------+
                            | (Phase F)        |
                            | imports          |
                            | createAgent from |
                            | 'langchain' v1   |
                            +--------+---------+
                                     |
               +---------------------+---------------------+
               |                                           |
               v                                           v
      runOneShot(deps,cfg,prompt)            runInteractive(deps,cfg)
      - one invoke                           - MemorySaver checkpointer
      - thread_id = runId                    - thread_id per REPL session
      - recursionLimit = cfg.maxSteps        - readline loop
      - returns AgentResult                  - slash commands local
                                             - returns void
                       |
                       v
               +-----------------+
               |  AgentResult    |   JSON envelope (FR-8)
               +-----------------+
                       |
                       v
               +----------------+
               |  cli.ts        |   emitResult(result, mode, AGENT_TABLE_COLUMNS?)
               +----------------+
                       |
                       v
                   stdout
```

`AgentDeps` is a structural extension of `CommandDeps` (see §3). It is
threaded top-to-bottom: `cli.ts :: makeAction` calls `buildDeps(flags)`
and passes the resulting `CommandDeps` into `agentCmd.run(deps, prompt,
opts)`. Every tool adapter closes over this `deps` at construction time
(see ADR-3), so the ReAct graph never has to carry it as state.

Redaction boundary. `createAgentLogger(cfg)` (§10) returns a logger whose
`info/warn/error/debug` methods funnel every string argument and every
string value inside their `meta` object through `redactString` from
`src/util/redact.ts` BEFORE writing to stderr or the log file. Tool
result payloads also flow through the byte-budget truncation helper
(`src/agent/tools/truncate.ts`) BEFORE being handed to the LLM — so the
LLM never sees > `cfg.perToolBudgetBytes` per tool result and never sees
anything the logger would not have sanitized.

`recursionLimit` boundary. LangGraph enforces the ReAct step ceiling via
its own `recursionLimit` in the invoke config — NOT via a hand-rolled
counter in our code. `runOneShot` and `runInteractive` translate
`cfg.maxSteps` directly: `invoke(state, { configurable: { thread_id },
recursionLimit: cfg.maxSteps })`. When LangGraph raises
`GraphRecursionError`, the runner catches it, marks `AgentResult.meta.
terminatedBy = "maxSteps"`, sets `truncated: true`, and returns
`answer: null` (the LLM did not produce a final AIMessage) but exit
code remains 0 per FR-13.

## 2. Module Layout

Every file listed is new unless marked `[MODIFY]`. Each file is owned by
exactly one implementation unit (§12) to eliminate merge conflicts.

```
src/
  cli.ts                                        [MODIFY — Phase H]
                                                register `agent` subcommand;
                                                add AGENT_TABLE_COLUMNS;
                                                import agentCmd.

  config/
    agent-config.ts                             [NEW — Phase B]
      export type ProviderName
      export interface AgentConfig
      export interface AgentCliFlags
      export function loadAgentConfig(opts: AgentCliFlags): AgentConfig
      export function loadDotenv(envFilePath: string | null): void

  commands/
    agent.ts                                    [NEW — Phase G]
      export interface AgentDeps extends CommandDeps {}
      export interface AgentOptions extends AgentCliFlags {...}
      export async function run(deps, prompt, opts): Promise<AgentResult | void>

  agent/
    system-prompt.ts                            [NEW — Phase F]
      export const DEFAULT_SYSTEM_PROMPT_TEMPLATE: string
      export const MUTATIONS_DISABLED_CLAUSE: string
      export const MUTATIONS_ENABLED_CLAUSE: string
      export function renderSystemPrompt(cfg: AgentConfig,
                                         override?: string): string

    result.ts                                   [NEW — Phase F]
      export interface AgentResult
      export interface AgentStep
      export interface AgentUsage
      export interface AgentMeta

    logging.ts                                  [NEW — Phase E]
      export interface AgentLogger
      export function createAgentLogger(cfg: AgentConfig): AgentLogger

    graph.ts                                    [NEW — Phase F — SOLE importer
                                                 of `createAgent`]
      export interface BuildGraphOpts
      export function createAgentGraph(opts: BuildGraphOpts): CompiledGraph

    run.ts                                      [NEW — Phase F]
      export async function runOneShot(deps, cfg, prompt): Promise<AgentResult>
      export async function runInteractive(deps, cfg): Promise<void>

    providers/
      registry.ts                               [NEW — Phase C]
        export type ProviderFactory
        export type ProviderRegistry
        export const PROVIDERS: ProviderRegistry
        export function getProvider(name: ProviderName): ProviderFactory
      openai.ts                                 [NEW — Phase C]
        export const createOpenAiModel: ProviderFactory
      anthropic.ts                              [NEW — Phase C]
      google.ts                                 [NEW — Phase C]
      azure-openai.ts                           [NEW — Phase C]
      azure-anthropic.ts                        [NEW — Phase C]
      azure-deepseek.ts                         [NEW — Phase C — denylist
                                                 gate per §5.6]

    tools/
      registry.ts                               [NEW — Phase D]
        export type ToolAdapterFactory
        export function buildToolCatalog(deps, cfg): StructuredTool[]
      truncate.ts                               [NEW — Phase D]
        export function truncateToolResult(result, budgetBytes): string
      auth-check-tool.ts                        [NEW — Phase D]
        export function makeAuthCheckTool(deps, cfg): StructuredTool
      list-mail-tool.ts                         [NEW — Phase D]
      get-mail-tool.ts                          [NEW — Phase D]
      get-thread-tool.ts                        [NEW — Phase D]
      list-folders-tool.ts                      [NEW — Phase D]
      find-folder-tool.ts                       [NEW — Phase D]
      list-calendar-tool.ts                     [NEW — Phase D]
      get-event-tool.ts                         [NEW — Phase D]
      create-folder-tool.ts                     [NEW — Phase D — mutation]
      move-mail-tool.ts                         [NEW — Phase D — mutation]
      download-attachments-tool.ts              [NEW — Phase D — mutation]

test_scripts/
  agent-config.spec.ts                          [NEW — Phase B]
  agent-provider-registry.spec.ts               [NEW — Phase C]
  agent-provider-openai.spec.ts                 [NEW — Phase C]
  agent-provider-anthropic.spec.ts              [NEW — Phase C]
  agent-provider-google.spec.ts                 [NEW — Phase C]
  agent-provider-azure-openai.spec.ts           [NEW — Phase C]
  agent-provider-azure-anthropic.spec.ts        [NEW — Phase C]
  agent-provider-azure-deepseek.spec.ts         [NEW — Phase C]
  agent-tools.spec.ts                           [NEW — Phase D]
  agent-tool-truncate.spec.ts                   [NEW — Phase D]
  agent-redact.spec.ts                          [NEW — Phase E]
  agent-graph.spec.ts                           [NEW — Phase F]
  agent-run-oneshot.spec.ts                     [NEW — Phase F]
  agent-run-interactive.spec.ts                 [NEW — Phase F]
  commands-agent.spec.ts                        [NEW — Phase G]
  agent-acceptance.spec.ts                      [NEW — Phase J]

package.json                                    [MODIFY — Phase A]
package-lock.json                               [MODIFY — Phase A]
.gitignore                                      [MODIFY — Phase A]
.env.example                                    [NEW — Phase A]
CLAUDE.md                                       [MODIFY — Phase I]
docs/design/configuration-guide.md              [MODIFY — Phase I]
docs/design/project-functions.MD                [MODIFY — Phase I]
README.md                                       [MODIFY — Phase I]
Issues - Pending Items.md                       [MODIFY — Phase I]
```

Exactly ONE file imports `createAgent` from `langchain`: `src/agent/
graph.ts`. This isolates Risk 2 (investigation §7) — swapping to
`createReactAgent` from `@langchain/langgraph/prebuilt` is a one-file
edit.

Exactly ONE file calls `dotenv.config(...)`: `src/config/agent-config.ts`
(via `loadDotenv`). `src/cli.ts` and `makeAction` remain dotenv-free.
See ADR-5.

## 3. Public TypeScript Interfaces

All interface declarations below are normative. Coders must not add
undeclared fields, rename fields, or change cardinality without a
design-amendment round-trip. Field order in `AgentResult` matches
FR-8's worked example exactly so JSON output is diff-stable.

```typescript
// ============================================================
// src/config/agent-config.ts
// ============================================================

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure-openai'
  | 'azure-anthropic'
  | 'azure-deepseek';

/**
 * Commander-produced option object for the `agent` subcommand.
 * Populated in `cli.ts` before `agentCmd.run(...)` is called.
 * Mirrors the CLI surface in refined §7 one-for-one.
 */
export interface AgentCliFlags {
  interactive: boolean;               // -i / --interactive
  provider?: string;                  // --provider (validated against ProviderName)
  model?: string;                     // --model
  temperature?: number;               // --temperature
  maxSteps?: number;                  // --max-steps
  system?: string;                    // --system
  systemFile?: string;                // --system-file
  tools?: string;                     // --tools <csv>
  envFile?: string;                   // --env-file
  allowMutations: boolean;            // --allow-mutations (default false)
  perToolBudget?: number;             // --per-tool-budget
  verbose: boolean;                   // --verbose
  // Inherited from global flags via `deps.config` (not re-read here):
  //   json/table mode, quiet, noAutoReauth, logFile, sessionFile, profileDir,
  //   tz, timeout, loginTimeout, chromeChannel.
}

/**
 * Frozen configuration produced by loadAgentConfig(). No defaults for
 * mandatory fields (providerName); operational tunables have defaults
 * per §4.
 */
export interface AgentConfig {
  readonly providerName: ProviderName;
  readonly model: string | null;            // null when provider derives from env
  readonly temperature: number;              // default 0
  readonly maxSteps: number;                 // default 10; range [1..50]
  readonly perToolBudgetBytes: number;       // default 16384
  readonly envFilePath: string | null;
  readonly allowMutations: boolean;          // default false
  readonly systemPrompt: string | null;      // resolved text (inline > file > null→built-in)
  readonly systemPromptFile: string | null;  // for audit/logging only
  readonly verbose: boolean;
  readonly quiet: boolean;                   // inherited from global --quiet
  readonly interactive: boolean;
  readonly toolsAllowlist: readonly string[] | null;  // null = full permitted set
  readonly logFilePath: string | null;       // inherited from global --log-file
  readonly runId: string;                    // crypto.randomUUID()
}

export function loadAgentConfig(opts: AgentCliFlags): AgentConfig;
export function loadDotenv(envFilePath: string | null): void;

// ============================================================
// src/commands/agent.ts
// ============================================================

import type { CommandDeps } from '../cli';

/** Structural superset of CommandDeps. No new fields in v1. */
export interface AgentDeps extends CommandDeps {}

/** Same shape as AgentCliFlags; kept as a distinct name for symmetry. */
export interface AgentOptions extends AgentCliFlags {}

export async function run(
  deps: AgentDeps,
  prompt: string | null,
  opts: AgentOptions,
): Promise<AgentResult | void>;   // void only for --interactive

// ============================================================
// src/agent/result.ts
// ============================================================

export interface AgentResult {
  answer: string | null;              // FR-8 final answer; null on maxSteps-without-answer
  provider: ProviderName;
  model: string | null;
  prompt: string;                     // truncated at 512 chars
  steps: AgentStep[];
  usage: AgentUsage | null;
  meta: AgentMeta;
}

export interface AgentStep {
  index: number;                       // 1-based
  tool?: string;                       // snake_case tool name (omitted for pure reasoning steps)
  args?: unknown;                      // redacted, parsed JSON args
  result?: unknown;                    // redacted tool-result payload (may be truncated)
  reasoning?: string;                  // optional AI content preceding the tool call
  error?: { code: string; message: string };
  durationMs: number;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentMeta {
  maxSteps: number;                    // echoes cfg.maxSteps
  stepsUsed: number;                   // count of AgentStep entries that invoked a tool
  durationMs: number;                  // total wall-clock
  terminatedBy:                        // why the loop ended
    | 'final-answer'
    | 'maxSteps'
    | 'wallClock'
    | 'sigint'
    | 'error';
  runId: string;                       // mirror of cfg.runId
  truncated: boolean;                  // true iff terminatedBy === 'maxSteps' or 'wallClock'
}

// ============================================================
// src/agent/providers/registry.ts
// ============================================================

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Async to allow providers that need startup validation (e.g., the
 * DeepSeek denylist regex test is synchronous, but future providers
 * may need a network probe). Coders MUST NOT make network calls in
 * v1; the async signature is forward-compatible.
 */
export type ProviderFactory = (
  env: NodeJS.ProcessEnv,
  cfg: Pick<AgentConfig, 'model' | 'temperature'>,
) => Promise<BaseChatModel>;

export type ProviderRegistry = Record<ProviderName, ProviderFactory>;

export const PROVIDERS: ProviderRegistry;

export function getProvider(name: ProviderName): ProviderFactory;

// ============================================================
// src/agent/tools/registry.ts
// ============================================================

import type { StructuredTool } from '@langchain/core/tools';

export type ToolAdapterFactory = (
  deps: AgentDeps,
  cfg: AgentConfig,
) => StructuredTool;

export function buildToolCatalog(
  deps: AgentDeps,
  cfg: AgentConfig,
): StructuredTool[];

// ============================================================
// src/agent/graph.ts
// ============================================================

import type { Runnable } from '@langchain/core/runnables';
import type { MemorySaver } from '@langchain/langgraph';

export interface BuildGraphOpts {
  model: BaseChatModel;
  tools: StructuredTool[];
  systemPrompt: string;
  checkpointer?: MemorySaver;
}

/**
 * Returns a LangGraph-compiled runnable. The type alias `CompiledGraph`
 * is shorthand for `Runnable<{ messages: BaseMessage[] }, { messages:
 * BaseMessage[] }>`; coders may use `Runnable` directly.
 */
export type CompiledGraph = Runnable;

export function createAgentGraph(args: BuildGraphOpts): CompiledGraph;

// ============================================================
// src/agent/run.ts
// ============================================================

export async function runOneShot(
  deps: AgentDeps,
  cfg: AgentConfig,
  prompt: string,
): Promise<AgentResult>;

export async function runInteractive(
  deps: AgentDeps,
  cfg: AgentConfig,
): Promise<void>;

// ============================================================
// src/agent/logging.ts
// ============================================================

export interface AgentLogger {
  info(line: string, meta?: Record<string, unknown>): void;
  warn(line: string, meta?: Record<string, unknown>): void;
  error(line: string, meta?: Record<string, unknown>): void;
  debug(line: string, meta?: Record<string, unknown>): void;  // only when verbose || logFile
  close(): Promise<void>;
}

export function createAgentLogger(cfg: AgentConfig): AgentLogger;

// ============================================================
// src/agent/system-prompt.ts
// ============================================================

export const DEFAULT_SYSTEM_PROMPT_TEMPLATE: string;
export const MUTATIONS_DISABLED_CLAUSE: string;
export const MUTATIONS_ENABLED_CLAUSE: string;

export function renderSystemPrompt(
  cfg: AgentConfig,
  override?: string,
): string;
```

Every field above maps directly to the FR-8 envelope; coders serialize
`AgentResult` with `JSON.stringify(result, null, 2)` and the output
already satisfies the spec.

## 4. Configuration Surface

Canonical, de-duplicated, precedence-normalized env-var table. Any
inconsistency between the refined request, the investigation, and the
research doc has been resolved here (see ADR-7 for DeepSeek variant
handling; the `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` row is
explicitly flagged "informational — not passed to constructor" per
investigation §3 note 3).

| Env var | CLI flag | Required by | Purpose | Default (NONE = required) |
|---|---|---|---|---|
| `OUTLOOK_AGENT_PROVIDER` | `--provider`, `-p` | agent core (always) | Selects the LLM provider factory | NONE |
| `OUTLOOK_AGENT_MODEL` | `--model`, `-m` | openai, anthropic, google, azure-deepseek (custom), azure-anthropic (custom) | Model id / deployment name | NONE (unless a provider-specific model env var is set, see below) |
| `OUTLOOK_AGENT_MAX_STEPS` | `--max-steps` | agent core (optional) | ReAct iteration ceiling; 1..50 | `10` |
| `OUTLOOK_AGENT_TEMPERATURE` | `--temperature` | agent core (optional) | Sampling temperature | `0` |
| `OUTLOOK_AGENT_SYSTEM_PROMPT` | `--system` | agent core (optional) | Inline system prompt override | built-in (§11) |
| `OUTLOOK_AGENT_SYSTEM_PROMPT_FILE` | `--system-file` | agent core (optional) | File-backed system prompt | none |
| `OUTLOOK_AGENT_TOOLS` | `--tools` | agent core (optional) | CSV allowlist of tool names | full permitted set |
| `OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES` | `--per-tool-budget` | tool adapters | Per-tool result byte budget | `16384` |
| `OUTLOOK_AGENT_ALLOW_MUTATIONS` | `--allow-mutations` | tool catalog | Enables `create_folder`, `move_mail`, `download_attachments` | `false` |
| `OUTLOOK_AGENT_OPENAI_API_KEY` | — | openai | OpenAI secret key | NONE |
| `OUTLOOK_AGENT_OPENAI_BASE_URL` | — | openai (optional) | Gateway override | OpenAI default |
| `OUTLOOK_AGENT_OPENAI_ORG` | — | openai (optional) | Organization id | none |
| `OUTLOOK_AGENT_ANTHROPIC_API_KEY` | — | anthropic | Anthropic secret key | NONE |
| `OUTLOOK_AGENT_ANTHROPIC_BASE_URL` | — | anthropic (optional) | Gateway override | Anthropic default |
| `OUTLOOK_AGENT_GOOGLE_API_KEY` | — | google | Gemini API key | NONE |
| `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY` | — | azure-openai | Azure OpenAI secret key | NONE |
| `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` | — | azure-openai | Resource endpoint URL (full, e.g. `https://my-res.openai.azure.com`) | NONE |
| `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION` | — | azure-openai | API version (e.g. `2024-10-21`) | NONE |
| `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` | — | azure-openai | Deployment name | NONE |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | — | azure-anthropic, azure-deepseek (shared) | Foundry resource key | NONE |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | — | azure-anthropic, azure-deepseek (shared) | Foundry resource base URL. Factory strips trailing `/` and `/models`, then appends `/anthropic` (azure-anthropic) or `/openai/v1` (azure-deepseek). | NONE |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` | — | — (informational only) | Retained for audit — **not passed to any constructor** per investigation §3 note 3. | none |
| `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` | `--model` | azure-anthropic | Foundry deployment name for Anthropic model (e.g. `claude-sonnet-4-5`) | NONE (unless `--model`) |
| `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` | `--model` | azure-deepseek | Foundry deployment name (e.g. `DeepSeek-V3.2`); rejected at config load if it matches §5.6 denylist | NONE (unless `--model`) |

Precedence. For every row above: **CLI flag > process env > `.env`
file > NO DEFAULT** for mandatory rows; for optional rows with a
default, the default applies only after all three tiers are exhausted.
This rule is enforced by `loadAgentConfig` via the same pattern
`src/config/config.ts` uses for `OUTLOOK_CLI_*` vars — no new helper is
added to `config.ts` (ADR-8).

Dotenv call site. `loadDotenv(envFilePath)` is invoked at the TOP of
`commands/agent.ts :: run(...)`, BEFORE `loadAgentConfig(opts)` runs.
Semantics: `dotenv.config({ path: envFilePath ?? undefined, override:
false })`. `override: false` is the default and guarantees the
precedence rule — `.env` never overwrites values already present in
`process.env`.

`.env` file default path. When `--env-file`/`envFile` is not set,
`loadDotenv(null)` calls `dotenv.config({ override: false })` with no
`path` option, which defaults to `$(cwd)/.env` per dotenv's
documented behavior. Missing default `.env` is a no-op (dotenv returns
a parse error object that `loadDotenv` discards — files are a
convenience, not a config setting).

`--env-file` with missing file. `loadDotenv` MUST stat the path first;
if `fs.existsSync(envFilePath) === false`, throw `ConfigurationError({
missingSetting: 'envFile', checkedSources: [\`file:${envFilePath}\`],
detail: 'File does not exist' })` → exit 3. This is NOT a fallback
violation: the user EXPLICITLY asked for the file via the flag.

## 5. LLM Provider Registry — Concrete Design

Every provider factory is async (§3), reads ONLY the env vars declared
in its row, and throws `ConfigurationError` on any missing required
variable with the precedence-traced `checkedSources` array matching the
existing `src/config/config.ts` convention. All six factories return a
`BaseChatModel` that supports `.bindTools([...])` — `createAgent`/
`createReactAgent` will call this internally.

### 5.1 `openai`

- Stable id: `openai`
- Class: `ChatOpenAI` (npm `@langchain/openai`)
- Constructor (interface-level):
  ```typescript
  new ChatOpenAI({
    model: cfg.model!,                          // required; validated upstream
    apiKey: env.OUTLOOK_AGENT_OPENAI_API_KEY,   // required
    configuration: {
      baseURL: env.OUTLOOK_AGENT_OPENAI_BASE_URL,   // optional
      organization: env.OUTLOOK_AGENT_OPENAI_ORG,   // optional
    },
    temperature: cfg.temperature,
  });
  ```
- Required env: `OUTLOOK_AGENT_OPENAI_API_KEY`
- Optional env: `OUTLOOK_AGENT_OPENAI_BASE_URL`, `OUTLOOK_AGENT_OPENAI_ORG`
- Tool binding: `createAgent({ tools })` calls `.bindTools()` internally; factory does NOT call it.
- Quirks: `gpt-4o`+ supports parallel tool calls; older models do not. Streaming deferred (D9).

### 5.2 `anthropic`

- Stable id: `anthropic`
- Class: `ChatAnthropic` (npm `@langchain/anthropic`)
- Constructor:
  ```typescript
  new ChatAnthropic({
    model: cfg.model!,                           // required
    apiKey: env.OUTLOOK_AGENT_ANTHROPIC_API_KEY, // required
    clientOptions: {
      baseURL: env.OUTLOOK_AGENT_ANTHROPIC_BASE_URL,  // optional
    },
    temperature: cfg.temperature,
  });
  ```
- Required env: `OUTLOOK_AGENT_ANTHROPIC_API_KEY`
- Optional env: `OUTLOOK_AGENT_ANTHROPIC_BASE_URL`
- Tool binding: via `createAgent({ tools })`.
- Quirks: `anthropic-version` header managed by the SDK (2023-06-01). Extended thinking not used in v1.

### 5.3 `google`

- Stable id: `google`
- Class: `ChatGoogleGenerativeAI` (npm `@langchain/google-genai`)
- Constructor:
  ```typescript
  new ChatGoogleGenerativeAI({
    model: cfg.model!,                          // e.g. 'gemini-2.5-pro'
    apiKey: env.OUTLOOK_AGENT_GOOGLE_API_KEY,   // required
    temperature: cfg.temperature,
  });
  ```
- Required env: `OUTLOOK_AGENT_GOOGLE_API_KEY`
- Optional env: none
- Tool binding: via `createAgent({ tools })`.
- Quirks: max-output varies by model; no `apiVersion`.

### 5.4 `azure-openai`

- Stable id: `azure-openai`
- Class: `AzureChatOpenAI` (npm `@langchain/openai`)
- Constructor:
  ```typescript
  new AzureChatOpenAI({
    azureOpenAIApiKey: env.OUTLOOK_AGENT_AZURE_OPENAI_API_KEY,          // required
    azureOpenAIEndpoint: env.OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT,       // required (full URL)
    azureOpenAIApiVersion: env.OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION,  // required
    azureOpenAIApiDeploymentName:
      env.OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT,                        // required
    temperature: cfg.temperature,
  });
  ```
- Required env: all four listed above.
- Tool binding: via `createAgent({ tools })`.
- Quirks: `cfg.model` is **advisory only** — Azure OpenAI routes by deployment; the factory still stores `cfg.model ?? OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` in `AgentResult.model` for observability.

### 5.5 `azure-anthropic`

- Stable id: `azure-anthropic`
- Class: `ChatAnthropic` (npm `@langchain/anthropic`, with custom baseUrl)
- Constructor:
  ```typescript
  const baseUrl = normalizeFoundryEndpoint(
    env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT!,  // strip trailing / and /models
  ) + '/anthropic';
  new ChatAnthropic({
    model: cfg.model ?? env.OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL!,
    apiKey: env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY,
    clientOptions: { baseURL: baseUrl },
    temperature: cfg.temperature,
  });
  ```
- Required env: `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`,
  `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`,
  `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` (unless `--model` given).
- Optional env: `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` (retained
  for audit; NOT passed to constructor — ADR-7 / investigation §3 note 3).
- Tool binding: via `createAgent({ tools })`.
- Quirks: Foundry endpoint is wire-compatible with Anthropic Messages API.

### 5.6 `azure-deepseek`

- Stable id: `azure-deepseek`
- Class: `ChatOpenAI` (npm `@langchain/openai`, NOT `AzureChatOpenAI`)
- Constructor:
  ```typescript
  const baseURL = normalizeFoundryEndpoint(
    env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT!,
  ) + '/openai/v1';
  new ChatOpenAI({
    model: cfg.model ?? env.OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL!,
    apiKey: env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY,
    configuration: { baseURL },
    temperature: cfg.temperature,
    // Do NOT set: apiVersion, reasoning, extra_body.thinking
  });
  ```
- Required env: `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`,
  `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`,
  `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` (unless `--model` given).
- Optional env: `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` (informational).
- **Model-variant allowlist (enforced at config load, research §7.2–7.3)**:
  - **Denylist (reject with `ConfigurationError`)**: regexes
    `/deepseek-v3\.2-speciale/i`, `/deepseek-r1(?!-0528)/i`,
    `/deepseek-r1-0528/i` (rejected due to `ChatOpenAI` parameter-injection
    incompatibility), `/deepseek-reasoner/i`, `/mai-ds-r1/i`.
    Error message names the model and tells the user to switch to a
    V3.x variant.
  - **Allowlist (accepted silently)**: names matching `/deepseek-v3(\.[12])?$/i`.
  - **Custom names**: accepted with a `console.warn` to stderr
    (suppressed when `cfg.quiet`).
- Tool binding: via `createAgent({ tools })`.
- Quirks: no `api-version` query param; model name must match the exact
  deployment name from Azure portal.

A shared helper `normalizeFoundryEndpoint(raw: string): string` lives
inside the factory files (duplicated or extracted — coder choice) and
strips trailing `/` and a trailing `/models` segment. Unit tests in
`agent-provider-azure-anthropic.spec.ts` and
`agent-provider-azure-deepseek.spec.ts` cover the four variants: no
suffix, `/`, `/models`, `/models/`.

## 6. Tool Adapter Contracts

Every adapter is a `ToolAdapterFactory` — `(deps, cfg) =>
StructuredTool`. Adapters capture `deps` and `cfg` in a closure (ADR-3)
so they carry NO per-invocation state. The order of fields below
corresponds to the Zod schemas shipped in v1 and mirrors the refined
spec §8 shapes.

Common rules:
- `name` is snake_case.
- `description` is ≤ 240 chars, LLM-facing, written as an imperative.
- Every return value is serialized as JSON and passed through
  `truncateToolResult(result, cfg.perToolBudgetBytes)`.
- Recoverable errors (see plan §2 Phase D "Error handling contract")
  become a JSON `{ error: { code, message } }` that the LLM sees as a
  ToolMessage and may react to. Fatal errors (ConfigurationError,
  AuthError with `reason: 'NO_AUTO_REAUTH'`, IoError outside
  `download_attachments`) rethrow and propagate through `makeAction` to
  the process exit code.
- `toolsAllowlist` is applied after the mutation gate: if
  `cfg.allowMutations === false`, mutation tools are **omitted from the
  catalog entirely** (ADR-4). They are not registered-but-refused.

### 6.1 `auth_check`

- Description: "Verify the current Outlook session is accepted without opening a browser. Call before other tools if a call returns an auth error."
- Zod schema: `z.object({})`
- Delegates to: `authCheck.run(deps)` (no options)
- Output: `{ status, tokenExpiresAt, account }` (the existing `AuthCheckResult` shape)
- Errors: `UpstreamError` → recoverable ToolMessage JSON
- Mutation: N

### 6.2 `list_mail`

- Description: "List recent messages in a folder (alias, path, or id), optionally filtered by a date window. Set justCount=true to return only a count."
- Zod schema:
  ```typescript
  z.object({
    top: z.number().int().min(1).max(1000).default(10),
    folder: z.string().optional(),
    folderId: z.string().optional(),
    folderParent: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    select: z.string().optional(),
    justCount: z.boolean().default(false),
  }).refine(v => !(v.folder && v.folderId),
    { message: 'folder and folderId are mutually exclusive' });
  ```
- Delegates to: `listMail.run(deps, opts)`, mapping each input field to
  the same-named `ListMailOptions` field (camelCase pass-through; no
  key remapping needed).
- Output: `MessageSummary[]` OR `{ count, exact }` when `justCount`.
- Errors: `UsageError`/`FOLDER_*`/`UpstreamError`/`AuthError(AFTER_RETRY)`
  → recoverable. `AuthError(NO_AUTO_REAUTH)` + flag set → fatal.
- Mutation: N

### 6.3 `get_mail`

- Description: "Retrieve one email by id, including body and attachment metadata."
- Zod schema:
  ```typescript
  z.object({
    id: z.string().min(1),
    body: z.enum(['html', 'text', 'none']).default('text'),
  })
  ```
- Delegates to: `getMail.run(deps, id, { body })`.
- Output: `Message & { Attachments: AttachmentSummary[] }` (attachment
  bytes omitted — the existing command only returns metadata).
- Errors: `UPSTREAM_MESSAGE_NOT_FOUND`, `UpstreamError`, `AuthError` → recoverable.
- Mutation: N

### 6.4 `get_thread`

- Description: "Retrieve every message in the conversation thread that a message id belongs to."
- Zod schema:
  ```typescript
  z.object({
    id: z.string().min(1),   // message id or 'conv:<rawConvId>'
    body: z.enum(['html', 'text', 'none']).default('text'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  ```
- Delegates to: `getThread.run(deps, id, { body, order })`.
- Output: `{ conversationId, count, messages }`.
- Errors: same as `get_mail`.
- Mutation: N

### 6.5 `list_folders`

- Description: "Enumerate mail folders under a parent (alias, path, or id). recursive=true walks the full tree."
- Zod schema:
  ```typescript
  z.object({
    parent: z.string().default('MsgFolderRoot'),
    top: z.number().int().min(1).max(250).default(100),
    recursive: z.boolean().default(false),
    includeHidden: z.boolean().default(false),
    firstMatch: z.boolean().default(false),
  })
  ```
- Delegates to: `listFolders.run(deps, { parent, top, recursive, includeHidden, firstMatch })`.
- Output: `FolderSummary[]` (with materialized `Path` when recursive).
- Errors: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`,
  `UPSTREAM_PAGINATION_LIMIT`, `AuthError` → recoverable.
- Mutation: N

### 6.6 `find_folder`

- Description: "Resolve a folder query (alias, display-name path, or id:<raw>) to a single folder object."
- Zod schema:
  ```typescript
  z.object({
    spec: z.string().min(1),
    anchor: z.string().default('MsgFolderRoot'),
    firstMatch: z.boolean().default(false),
  })
  ```
- Delegates to: `findFolder.run(deps, spec, { anchor, firstMatch })`.
- Output: `ResolvedFolder`.
- Errors: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`,
  `FOLDER_PATH_INVALID` → recoverable.
- Mutation: N

### 6.7 `list_calendar`

- Description: "List calendar events between a start and end datetime."
- Zod schema:
  ```typescript
  z.object({
    from: z.string().default('now'),
    to: z.string().default('now + 7d'),
    tz: z.string().optional(),
  })
  ```
- Delegates to: `listCalendar.run(deps, { from, to, tz })`.
- Output: `EventSummary[]`.
- Errors: `UpstreamError`, `AuthError` → recoverable.
- Mutation: N

### 6.8 `get_event`

- Description: "Retrieve a single calendar event by id."
- Zod schema:
  ```typescript
  z.object({
    id: z.string().min(1),
    body: z.enum(['html', 'text', 'none']).default('text'),
  })
  ```
- Delegates to: `getEvent.run(deps, id, { body })`.
- Output: `Event`.
- Errors: `UPSTREAM_EVENT_NOT_FOUND`, `AuthError` → recoverable.
- Mutation: N

### 6.9 `create_folder`  *(mutation — gated)*

- Description: "Create a folder (optionally nested). Idempotent by default."
- Zod schema:
  ```typescript
  z.object({
    pathOrName: z.string().min(1),
    parent: z.string().default('MsgFolderRoot'),
    createParents: z.boolean().default(false),
    idempotent: z.boolean().default(true),   // NB: agent default differs from CLI (ADR-4 and codebase-scan §12)
  })
  ```
- Delegates to: `createFolder.run(deps, pathOrName, { parent, createParents, idempotent })`.
- Output: `CreateFolderResult`.
- Errors: `FOLDER_PATH_INVALID`, `FOLDER_MISSING_PARENT`,
  `FOLDER_ALREADY_EXISTS` (only when `idempotent: false`) → recoverable.
- Mutation: **Y** — omitted from catalog when `cfg.allowMutations === false`.

### 6.10 `move_mail`  *(mutation — gated)*

- Description: "Move messages to a destination folder. Returns NEW ids (source ids become invalid)."
- Zod schema:
  ```typescript
  z.object({
    messageIds: z.array(z.string().min(1)).min(1).max(50),
    to: z.string().min(1),
    firstMatch: z.boolean().default(false),
    continueOnError: z.boolean().default(true),
  })
  ```
- Delegates to: `moveMail.run(deps, messageIds, { to, firstMatch, continueOnError })`.
- Output: `MoveMailResult` (`destination`, `moved[]`, `failed[]`, `summary`).
- Errors: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`,
  `UPSTREAM_MESSAGE_NOT_FOUND`, partial-failure summary → recoverable.
- Mutation: **Y** — omitted from catalog when `cfg.allowMutations === false`.

### 6.11 `download_attachments`  *(mutation — gated)*

- Description: "Download file attachments of a message to a local directory. Byte content is never returned."
- Zod schema:
  ```typescript
  z.object({
    messageId: z.string().min(1),
    outDir: z.string().min(1),
    overwrite: z.boolean().default(false),
    includeInline: z.boolean().default(false),
  })
  ```
- Delegates to: `downloadAttachments.run(deps, messageId, { outDir, overwrite, includeInline })`.
- Output: `{ messageId, outDir, saved, skipped }` — byte content is explicitly NOT returned.
- Errors: `UPSTREAM_MESSAGE_NOT_FOUND`, `AuthError` → recoverable.
  IoError (filesystem) is surfaced to the LLM as a recoverable
  ToolMessage error (so it can suggest a different `outDir`) **except**
  for path-traversal violations (`assertWithinDir` throws) and EACCES on
  `outDir`, which remain fatal per refined §8.11.
- Mutation: **Y** — omitted from catalog when `cfg.allowMutations === false`.

## 7. ReAct Loop Contract

Library entry point. `createAgent` from `langchain` v1 is the primary
path (ADR-1, investigation D1). `src/agent/graph.ts` is the SOLE file
importing `createAgent`. If `createAgent` fails to compile or runtime-load
(investigation Risk 2), swap the import to `createReactAgent` from
`@langchain/langgraph/prebuilt` and pass `{ llm: model, tools,
stateModifier: systemPrompt, checkpointSaver: checkpointer }` — the
surrounding code does not change.

State carried by the graph. LangGraph's built-in `messages` channel
carries the `BaseMessage[]` transcript (System + Human + AI + Tool).
Our code tracks these externally:
- `stepCount: number` — incremented for each AIMessage with `tool_calls`
  (derived from `messages` post-invoke; NOT a graph channel).
- `usage: AgentUsage | null` — accumulated from `AIMessage.usage_metadata`
  when the provider emits it; `null` when no step emitted usage.
- `toolResults: AgentStep[]` — stitched from consecutive `AIMessage`
  (with `tool_calls`) + `ToolMessage` (with `tool_call_id`) pairs after
  `.invoke()` resolves. Not fed back to the LLM (LangGraph's built-in
  ToolNode already did that).
- `terminatedBy: 'final-answer' | 'maxSteps' | 'wallClock' | 'sigint' | 'error'`
  — determined by which branch of the termination check fires.

Termination rules (precedence order, evaluated after `.invoke()` returns
or throws):
1. SIGINT during invoke → `AbortController.signal` aborts the graph;
   runner catches `AbortError`, sets `terminatedBy: 'sigint'`; one-shot
   exits 130; interactive keeps REPL alive.
2. `GraphRecursionError` from LangGraph (our `cfg.maxSteps` translated to
   `recursionLimit`) → runner catches it, sets `terminatedBy:
   'maxSteps'`, `truncated: true`, returns with the last extracted
   AIMessage content (or `null` if none), exit 0.
3. Wall-clock budget (see §14 — default 5 min for one-shot, unlimited
   for interactive turn) → `AbortController` fires, same path as SIGINT
   but `terminatedBy: 'wallClock'`, exit 5 (upstream timeout class).
4. `.invoke()` resolves with a final AIMessage that has no `tool_calls`
   → `terminatedBy: 'final-answer'`, `answer = last AIMessage.content`,
   exit 0.
5. Any other exception → `terminatedBy: 'error'`, envelope emitted with
   `answer: null`, exit code via `exitCodeFor(err)`.

Error propagation into the loop vs. aborts. Tool adapter errors follow
§6 (recoverable vs. fatal). Recoverable errors become ToolMessages and
are counted toward `maxSteps`. Fatal errors bubble out of `.invoke()`
and are caught by `runOneShot`/`runInteractive`; the envelope is still
emitted for one-shot (with `answer: null`, `steps[]` accumulated so
far, `meta.terminatedBy: 'error'`) before `makeAction`'s own `catch`
maps them to the exit code.

Interactive mode. `MemorySaver` is instantiated once per REPL session.
`thread_id = \`outlook-agent-${process.pid}-${Date.now()}\`` so logs can
tie turns together. Slash commands (`/exit`, `/clear`, `/tools`,
`/system`, `/help`) are handled locally in `runInteractive` before any
LLM call. `/clear` discards the `MemorySaver` and generates a fresh
`thread_id`. `/system <text>` replaces `cfg.systemPrompt` and rebuilds
the graph (providers and tools are reused). History persists for the
life of the process only (D2). No on-disk thread store in v1.

Per-run identity. `cfg.runId = crypto.randomUUID()` is generated in
`loadAgentConfig` and threaded into every log record and every
`AgentResult`. In interactive mode, the same runId persists across
turns (it identifies the REPL session); each `invoke()` call's
`thread_id` is the runId.

## 8. JSON Output Envelope

Exact shape emitted when `--json` is active (the default unless
`--table` is explicit on a TTY). Field order is stable. `steps[]` is
1-indexed. `args` and `result` are the POST-redaction, POST-truncation
payloads — identical to what the LLM observed.

```json
{
  "answer": "Your three most recent unread inbox messages are: 1) \"Q3 kickoff\" from Alice (Id=AAMkAGI...a), 2) \"Status update\" from Bob (Id=AAMkAGI...b), 3) \"Design review\" from Carol (Id=AAMkAGI...c).",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "prompt": "list my 3 most recent unread emails",
  "steps": [
    {
      "index": 1,
      "tool": "list_mail",
      "args": { "top": 3, "folder": "Inbox" },
      "result": [
        { "Id": "AAMkAGI...a", "Subject": "Q3 kickoff", "From": { "EmailAddress": { "Name": "Alice", "Address": "alice@example.com" } }, "ReceivedDateTime": "2026-04-22T09:12:03Z", "IsRead": false },
        { "Id": "AAMkAGI...b", "Subject": "Status update", "From": { "EmailAddress": { "Name": "Bob", "Address": "bob@example.com" } }, "ReceivedDateTime": "2026-04-22T08:41:58Z", "IsRead": false },
        { "Id": "AAMkAGI...c", "Subject": "Design review", "From": { "EmailAddress": { "Name": "Carol", "Address": "carol@example.com" } }, "ReceivedDateTime": "2026-04-22T07:15:22Z", "IsRead": false }
      ],
      "durationMs": 843
    },
    {
      "index": 2,
      "tool": "get_mail",
      "args": { "id": "AAMkAGI...a", "body": "text" },
      "result": { "Id": "AAMkAGI...a", "Subject": "Q3 kickoff", "BodyPreview": "Hi team — kicking off Q3 planning this Friday...", "Attachments": [] },
      "durationMs": 412
    }
  ],
  "usage": {
    "promptTokens": 1234,
    "completionTokens": 456,
    "totalTokens": 1690
  },
  "meta": {
    "maxSteps": 10,
    "stepsUsed": 2,
    "durationMs": 3987,
    "terminatedBy": "final-answer",
    "runId": "f9f8e0a0-7f9a-4c1b-9a33-0d1b0a8b6f55",
    "truncated": false
  }
}
```

Optionality:
- `answer` — `string | null`. Null only when `meta.terminatedBy` is
  `"maxSteps"`, `"wallClock"`, `"sigint"`, or `"error"` and the last
  AIMessage carried no content.
- `usage` — `AgentUsage | null`. Null when no step emitted
  `usage_metadata`.
- `steps[].tool` — optional; absent for pure reasoning steps (AIMessage
  without tool_calls that isn't the final answer — e.g., streaming
  artifacts in future).
- `steps[].args` / `steps[].result` — present iff `tool` is present.
- `steps[].error` — present iff the tool adapter returned a recoverable
  error ToolMessage; `result` is still populated with the error JSON so
  no information is lost.
- `steps[].reasoning` — present iff the preceding AIMessage had
  non-empty `content` alongside `tool_calls`.

`--table` output (§8 continuation). Human-friendly fallback. Stdout
receives the wrapped `answer` (or the string `(no final answer —
terminatedBy=<reason>)` when null), followed by the step summary table:

| Column | Source |
|---|---|
| `#` | `steps[].index` |
| `Tool` | `steps[].tool ?? "-"` |
| `Status` | `steps[].error ? "ERROR" : "OK"` |
| `DurationMs` | `steps[].durationMs` |

`AGENT_TABLE_COLUMNS: ColumnSpec<AgentStep>[]` is defined in
`src/cli.ts` (Phase H) and passed to `emitResult`.

## 9. Error & Exit-Code Mapping

The agent introduces NO new exit codes (ADR-8 rationale). Every new
error class either reuses an existing class from `src/config/errors.ts`
or sets its `code` such that `exitCodeFor` maps it to the right exit.

| Error class / condition | Raised by | Maps to exit |
|---|---|---|
| `ConfigurationError{missingSetting: 'providerName'}` | `loadAgentConfig` | 3 |
| `ConfigurationError{missingSetting: 'OUTLOOK_AGENT_OPENAI_API_KEY'}` (and every other provider-required var) | provider factory | 3 |
| `ConfigurationError{missingSetting: 'envFile'}` | `loadDotenv` | 3 |
| `ConfigurationError{missingSetting: 'systemPromptFile'}` (unreadable file) | `loadAgentConfig` | 3 |
| `ConfigurationError{missingSetting: 'OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL', detail: '…'}` (denylist match) | `azure-deepseek` factory | 3 |
| `UsageError` (invalid `--max-steps`, mutual exclusion, unknown provider name, unknown tool name in `--tools`) | `loadAgentConfig`, `getProvider` | 2 |
| `AuthError` (`auth-check != 'ok'` + `--no-auto-reauth`) | `agentCmd.run` | 4 |
| `AuthError` from a tool adapter with `--no-auto-reauth` set | tool adapter (fatal branch) | 4 |
| Provider SDK 4xx/5xx during `.invoke()` | wrapped in `UpstreamError` by `runOneShot`/`runInteractive` catch | 5 |
| Tool adapter runtime bug (unexpected throw, Zod failure on OUTPUT) | wrapped in `OutlookCliError` | 1 |
| Step-limit reached without a final AIMessage | runner sets `meta.terminatedBy: 'maxSteps'`, `truncated: true`; envelope emitted normally | **0** (not an error — per FR-13) |
| Wall-clock budget exceeded | wrapped in `UpstreamError{code: 'UPSTREAM_TIMEOUT'}` | 5 |
| IoError writing `--log-file` | `createAgentLogger` | 6 |
| SIGINT in interactive mode (idle prompt) | `runInteractive` | 130 |
| SIGINT during a running turn | `runInteractive` catches `AbortError`, keeps REPL alive | — (no exit) |
| SIGINT in one-shot mode | `runOneShot` catches `AbortError`, envelope emitted with `terminatedBy: 'sigint'`, `answer: null` | 130 |

All error classes (`ConfigurationError`, `UsageError`, `AuthError`,
`UpstreamError`, `IoError`, `OutlookCliError`) come from existing
`src/config/errors.ts`; the agent does NOT add new classes.

## 10. Logging & Redaction

`createAgentLogger(cfg)` is the single log sink for the agent. It
respects `cfg.quiet` and `cfg.logFilePath`:

| Condition | stderr | log file |
|---|---|---|
| `cfg.quiet && !cfg.logFilePath` | suppressed | — |
| `cfg.quiet && cfg.logFilePath` | suppressed | written (mode 0600) |
| `!cfg.quiet && !cfg.logFilePath` | written | — |
| `!cfg.quiet && cfg.logFilePath` | written | written |
| `cfg.verbose` (any) | includes DEBUG lines (per-step thinking + tool call + tool result, tool result body truncated to `cfg.perToolBudgetBytes`) | includes DEBUG lines |

Every string argument and every string value inside `meta` is passed
through `redactString` from `src/util/redact.ts` BEFORE any sink
writes. JSON-lines format (one record per line) with fields:
`{ ts, level, runId, message, ...meta }`.

Log file opening: `fs.promises.open(path, 'a', 0o600)` on first write.
A Node `EACCES` / `ENOENT` / `EISDIR` surfaces as
`IoError{code: 'IO_LOG_WRITE_FAILED'}` → exit 6.

## 11. Default System Prompt

Coders copy this block verbatim into `src/agent/system-prompt.ts`. The
`{mutationsEnabled}` token is replaced at runtime by `renderSystemPrompt`
with the corresponding clause.

```
You are an Outlook assistant embedded in the outlook-cli tool. You have access to tools that read the user's Outlook mailbox, calendar, and folder tree. Your job is to answer questions and fulfill tasks by calling these tools and reporting what you observe.

TOOL USE RULES:
- Always use tools to retrieve information. Never invent message content, sender names, email addresses, timestamps, subject lines, folder names, or event details. If you do not know something, call a tool to find out.
- Prefer the smallest, most specific tool call. If you only need one email, do not list 100. If you need to locate a folder, use find_folder before list_folders.
- Always cite the exact Id field (message Id, event Id, folder Id) when you reference a specific item in your reply. The user may need it for follow-up actions.
- If a tool returns an error, report the error to the user clearly. Do not retry the same failing call more than once without changing the input parameters.
- Respect the --max-steps budget. If you are close to the limit, summarize what you have found rather than making more tool calls.

SENSITIVE DATA:
- Do not repeat raw email body content verbatim unless the user explicitly asks for the full text. Summarize instead.
- Do not include API keys, authentication tokens, passwords, or other credentials in your replies, even if they appear in tool outputs (they should not, but treat them as confidential if they do).

MUTATION OPERATIONS:
{mutationsEnabled}

When in doubt, ask a clarifying question rather than taking an irreversible action.
```

`MUTATIONS_DISABLED_CLAUSE` (substituted when `cfg.allowMutations ===
false`):

```
The tools create_folder, move_mail, and download_attachments are NOT available in this session. If the user asks you to create a folder, move messages, or download attachments, inform them that they need to re-run with --allow-mutations to enable these operations.
```

`MUTATIONS_ENABLED_CLAUSE` (substituted when `cfg.allowMutations ===
true`):

```
The tools create_folder, move_mail, and download_attachments are ENABLED. Before executing any of these tools, confirm the intended action with the user in plain language: state exactly what will be created, moved, or downloaded, and ask for explicit confirmation. Do not execute a mutating tool based on an ambiguous or overly broad instruction.
```

Note: this design's `MUTATIONS_DISABLED_CLAUSE` wording differs from
the investigation's §5 text (which still said mutation tools are "in
the catalog but disabled"). The plan (Phase D) OMITS mutation tools
from the catalog entirely when `--allow-mutations` is absent, so the
prompt must reflect that — otherwise the LLM may hallucinate
tool-use attempts and waste steps. This reconciliation is the final
authoritative wording.

## 12. Parallel Implementation Units

Plan phases A..J map to six implementation units. Exactly ONE unit
owns each file; no unit crosses file boundaries with another.

### Unit 1 — Dependencies & hygiene *(maps to Phase A)*
- **Owned files**: `package.json`, `package-lock.json`, `.gitignore`,
  `.env.example`.
- **Depends on**: none.
- **Must satisfy**: package manifest in plan §Phase A; CJS smoke test
  in plan §Phase A acceptance criteria.
- **Interface contracts**: none (no source code).
- **Sequencing**: runs FIRST, serially. Units 2–5 cannot start until
  Unit 1 lands.

### Unit 2 — Agent config loader *(maps to Phase B)*
- **Owned files**:
  - `src/config/agent-config.ts`
  - `test_scripts/agent-config.spec.ts`
- **Depends on**: Unit 1.
- **Must satisfy**: §3 interfaces `ProviderName`, `AgentConfig`,
  `AgentCliFlags`, `loadAgentConfig`, `loadDotenv`. §4 precedence rule.
  §9 exit-code mapping for `ConfigurationError{'providerName'|'envFile'|
  'systemPromptFile'}` and `UsageError`.
- **Parallelizable with**: Units 3, 4, 5.

### Unit 3 — LLM provider registry *(maps to Phase C)*
- **Owned files**:
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
- **Depends on**: Unit 1. (Type-imports `AgentConfig` from Unit 2 —
  this is compile-only; runtime independence is total.)
- **Must satisfy**: §3 interfaces `ProviderFactory`, `ProviderRegistry`,
  `PROVIDERS`, `getProvider`. §5 per-provider constructor table. §5.6
  DeepSeek denylist.
- **Parallelizable with**: Units 2, 4, 5.

### Unit 4 — Tool adapters *(maps to Phase D)*
- **Owned files**:
  - `src/agent/tools/auth-check-tool.ts`
  - `src/agent/tools/list-mail-tool.ts`
  - `src/agent/tools/get-mail-tool.ts`
  - `src/agent/tools/get-thread-tool.ts`
  - `src/agent/tools/list-folders-tool.ts`
  - `src/agent/tools/find-folder-tool.ts`
  - `src/agent/tools/list-calendar-tool.ts`
  - `src/agent/tools/get-event-tool.ts`
  - `src/agent/tools/create-folder-tool.ts`
  - `src/agent/tools/move-mail-tool.ts`
  - `src/agent/tools/download-attachments-tool.ts`
  - `src/agent/tools/truncate.ts`
  - `src/agent/tools/registry.ts`
  - `test_scripts/agent-tools.spec.ts`
  - `test_scripts/agent-tool-truncate.spec.ts`
- **Depends on**: Unit 1. (Type-imports `AgentConfig` and `AgentDeps`
  from Units 2 and 6 — compile-only.)
- **Must satisfy**: §3 interfaces `ToolAdapterFactory`,
  `buildToolCatalog`. §6 per-adapter contracts (name, description,
  schema, mapping, output, error handling, mutation gate).
- **Parallelizable with**: Units 2, 3, 5.

### Unit 5 — ReAct core + logging + system prompt *(maps to Phases E + F)*
- **Owned files**:
  - `src/agent/logging.ts`
  - `src/agent/graph.ts`
  - `src/agent/run.ts`
  - `src/agent/result.ts`
  - `src/agent/system-prompt.ts`
  - `test_scripts/agent-redact.spec.ts`
  - `test_scripts/agent-graph.spec.ts`
  - `test_scripts/agent-run-oneshot.spec.ts`
  - `test_scripts/agent-run-interactive.spec.ts`
- **Depends on**: Unit 1 at runtime; Units 2, 3, 4 at type-import.
  (Unit 5's modules import `AgentConfig` from Unit 2, `getProvider`
  from Unit 3, and `buildToolCatalog` from Unit 4 — all compile-only,
  no execution dependency during unit tests thanks to `vi.mock`.)
- **Must satisfy**: §3 interfaces `AgentResult`, `AgentStep`,
  `AgentUsage`, `AgentMeta`, `AgentLogger`, `createAgentLogger`,
  `BuildGraphOpts`, `createAgentGraph`, `CompiledGraph`, `runOneShot`,
  `runInteractive`, `DEFAULT_SYSTEM_PROMPT_TEMPLATE`, `renderSystemPrompt`.
  §7 termination rules. §8 envelope shape. §10 redaction + log modes.
  §11 system prompt verbatim.
- **Parallelizable with**: Units 2, 3, 4.

### Unit 6 — Command wiring & docs *(maps to Phases G + H + I)*
- **Owned files**:
  - `src/commands/agent.ts`
  - `src/cli.ts` **[MODIFY]** — ONLY Unit 6 edits this file.
  - `test_scripts/commands-agent.spec.ts`
  - `test_scripts/agent-acceptance.spec.ts`
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/CLAUDE.md` **[MODIFY]**
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/configuration-guide.md` **[MODIFY]**
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-functions.MD` **[MODIFY]** (only if not already populated by planner)
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/README.md` **[MODIFY]**
  - `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/Issues - Pending Items.md` **[MODIFY]**
- **Depends on**: Units 2, 3, 4, 5.
- **Must satisfy**: §3 interfaces `AgentDeps`, `AgentOptions`,
  `run(deps, prompt, opts)`. §8 `--table` column spec
  (`AGENT_TABLE_COLUMNS`). §9 full exit-code mapping on the commander
  action path.
- **Sequencing**: runs LAST, serially. Its edits to `src/cli.ts`
  cannot race other units because no other unit touches that file.

Execution order:
`Unit 1` → (`Unit 2` ∥ `Unit 3` ∥ `Unit 4` ∥ `Unit 5`) → `Unit 6` → Phase J gate.

## 13. Architectural Decisions Record (ADR)

- **ADR-1: ReAct engine = `createAgent` from `langchain` v1.**
  Rationale: `createReactAgent` from `@langchain/langgraph/prebuilt` is
  soft-deprecated as of LangGraph v1 (Oct 2025); `createAgent` is the
  forward-looking entry point and ships the middleware hooks we'll need
  for v2 (human-in-the-loop, PII redaction). Both compile; the
  swap-to-prebuilt path is a one-file edit in `src/agent/graph.ts`
  (Risk 2 mitigation).

- **ADR-2: Provider registry is an object map keyed by `ProviderName`.**
  Rationale: pluggability — adding a seventh provider is a single new
  factory file + one entry in `PROVIDERS` + a test spec. Testability —
  each factory is independently `vi.mock`-able. No visitor pattern, no
  class hierarchy, no dynamic import — these would buy nothing at six
  providers and would complicate CJS/ESM interop (Risk 1).

- **ADR-3: Tool adapters hold a closure over `AgentDeps` rather than
  receiving `deps` per-invocation.** Rationale: LangGraph passes tool
  input to the adapter function at call time, but `deps` (Outlook
  client, session plumbing, config) is fixed for the life of a run.
  Capturing it in a closure (the factory signature) keeps the
  tool-call hot path free of deps threading and matches LangChain's
  `tool(fn, meta)` contract natively. The adapters become pure
  input-to-output functions from the LLM's perspective.

- **ADR-4: Mutation tools are EXCLUDED from the catalog unless
  `--allow-mutations` is set.** Rationale: this is stricter than the
  investigation's D4 (which registered them and refused at runtime).
  Reasons for the stricter stance: (a) NFR-8's "closed-set tool
  registry" principle — the LLM should not know about tools it cannot
  invoke, because a prompt-injection email body could trick it into
  attempting one; (b) omission eliminates an entire step-waste pattern
  where the LLM repeatedly tries a disabled tool; (c) the system
  prompt already tells the LLM about the mode, so the UX is
  equivalent. `create_folder`'s agent default of `idempotent: true`
  (diverging from the CLI default of `false`) is kept because D5
  locked it in and it reduces LLM retry confusion on an already-gated
  operation.

- **ADR-5: `.env` is loaded INSIDE `commands/agent.ts` (not in
  `makeAction`).** Rationale: scope — only the agent subcommand needs
  `.env` support; every other subcommand continues to read
  `process.env` only. Loading dotenv inside the agent command keeps
  `cli.ts` thin, leaves other commands unaffected, and makes the call
  order (`dotenv → loadAgentConfig`) unit-testable via `vi.mock('dotenv')`.
  A global dotenv in `cli.ts` would silently change every other
  subcommand's config resolution and violate the existing strict
  no-fallback rule for `OUTLOOK_CLI_*` vars.

- **ADR-6: Conversation memory is in-process only (MemorySaver).**
  Rationale: simplicity in v1. On-disk thread stores (SQLite, Redis)
  introduce schema migrations, file-locking against concurrent REPLs,
  and a secret-at-rest concern. The refined spec (D2) locked this;
  v2 can add a `--thread-id` flag backed by SQLite.

- **ADR-7: DeepSeek R1 family and V3.2-Speciale rejected at config
  time.** Rationale: authoritative Microsoft Learn docs confirm R1
  original does not support tool calling; V3.2-Speciale omits tool
  calling by design; R1-0528 technically added tool calling but
  LangChain.js's `ChatOpenAI` injects `presence_penalty` / `temperature`
  / `top_p` defaults that R1-family models reject with 400 (research
  §5, GitHub langchainjs #7564). Rejecting at config load produces a
  clear exit-3 ConfigurationError naming the model and pointing at a
  supported V3.x variant; accepting and failing at first tool call
  would silently burn `--max-steps` and a user's API credit. Per
  CLAUDE.md global rule, no fallback to a "no-tools mode" is built —
  the factory throws.

- **ADR-8: No `resolveRequiredString` helper is added to
  `src/config/config.ts`; `agent-config.ts` implements its own
  resolution.** Rationale: keep `config.ts`'s public surface small.
  The CLI config domain (`OUTLOOK_CLI_*`) and the agent config domain
  (`OUTLOOK_AGENT_*`) are separate; co-locating the mandatory-value
  resolver with the agent config file keeps the blast radius of agent
  changes contained and avoids growing the existing loader's API.

Additional ADRs specific to this design:

- **ADR-9: `.env` loader does NOT throw on missing default file but DOES
  throw on missing `--env-file`.** Rationale: the presence of a default
  `.env` is a convenience, never contractual. When the user explicitly
  passes `--env-file <path>`, they've made it contractual; a silent
  no-op would violate expectations and hide typos.

- **ADR-10: `AgentResult.answer` may be null.** Rationale: when the
  step-limit is hit without a final AIMessage, forcing a synthetic
  string is misleading. `null` + `meta.terminatedBy` is an
  unambiguous signal for callers.

- **ADR-11: Wall-clock budget is enforced INSIDE the runners, not in
  individual tools.** Rationale: per-tool `--timeout` already exists at
  the HTTP client layer and covers tool-level stalls. A separate
  run-level budget catches pathological LLM loops that spam cheap
  tools. Default 5 min for one-shot, disabled for interactive (see
  §14).

## 14. Non-Functional Requirements Restated

- **Secrets never logged.** Every log line flows through `redactString`
  (§10). Provider API keys are passed to constructors by reference;
  they never touch the logger. `vi.spyOn` sweeps in
  `agent-redact.spec.ts` assert zero matches for injected keys.

- **`.env` is never written by the agent.** `loadDotenv` only calls
  `dotenv.config(...)` (read-only). The agent has no code path that
  writes to `.env` or any file matching `.env*`.

- **Per-run wall-clock budget.** Default: one-shot 5 minutes
  (300 000 ms); interactive: unlimited per turn (REPL users control
  cancellation via Ctrl-C). Override: `OUTLOOK_AGENT_WALL_CLOCK_MS` env
  var (optional, no CLI flag in v1) — when set, applies to both modes.
  Enforced via `AbortController.signal` passed into LangGraph's
  `.invoke(state, { signal, recursionLimit })`. On timeout,
  `meta.terminatedBy: 'wallClock'`, exit 5, envelope still emitted.

- **Deterministic mode for tests.** `cfg.temperature` default is `0`.
  Unit tests instantiate `FakeListChatModel` or
  `FakeMessagesListChatModel` from `@langchain/core/utils/testing`
  (falling back to a local `ScriptedChatModel` double under
  `test_scripts/_helpers/` if the entry-point proves unavailable at
  Phase C start — plan §7).

- **CJS-compatible only.** `package.json`'s `"type": "commonjs"` is
  preserved. Phase A's smoke test (`node -e "require('@langchain/
  langgraph');"`) is the gate; if any package refuses `require()`, the
  fallback is dynamic `import()` isolated to `src/agent/graph.ts` and
  `src/agent/providers/*.ts` (plan §5 Risk 1).

Absolute output path: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md`

