# Changelog

All notable changes to **outlook-cli** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are ISO8601 (local calendar day).

---

## [2.1.0] — 2026-04-24

### Changed — BEHAVIORAL (config precedence reversed)

**The `~/.tool-agents/outlook-cli/.env` file now OVERRIDES shell environment
variables.** This is a deliberate reversal of the cli-agent-builder canonical
"shell-wins" precedence and a project-specific policy recorded in the
`cli-agent-builder` subagent definition.

**New precedence:**
```
CLI flag > ~/.tool-agents/outlook-cli/.env > process env
  > cwd/.env (--env-file) > ~/.tool-agents/outlook-cli/config.json
  > default (optional) / throw (mandatory)
```

**Implementation:** `ensureAgentConfigFolder` now calls
`dotenv.config({ override: true })` on the folder `.env`. CLI flags still
win over everything because they are read before `process.env` resolution.

**Rationale:** The per-user folder holds durable, intentional configuration.
A stale shell export left over from another project — e.g.
`export AZURE_OPENAI_DEPLOYMENT=gpt-5.1` in `~/.zshrc` — must not silently
shadow the user's deliberately-set folder value. If you want a shell export
to take effect, either remove the folder `.env` entry or pass the value via
`--` CLI flag.

**Migration:** Any user who was relying on shell-wins behavior must either
(a) clear or comment out the conflicting line in
`~/.tool-agents/outlook-cli/.env`, or (b) use a `--` CLI flag for the
override they want.

### Changed — seeded `.env` template

The seeded `~/.tool-agents/outlook-cli/.env` now has ALL credential lines
commented out (including `OPENAI_API_KEY`, which previously was active as
`OPENAI_API_KEY=REPLACE_ME`). This prevents the seeded placeholder from
clobbering real shell values via the new override behavior. Users uncomment
only the lines they need.

### Fixed

- **Config folder path renamed `~/tool-agents/` → `~/.tool-agents/`** to
  follow the POSIX convention for hidden per-user config directories. The
  previous un-dotted path was a leftover from an earlier implementation
  pass and created two folders (one live, one orphaned) on existing systems.
- **Test isolation bug in `agent-config.spec.ts`**: tests now stub `HOME`
  to a `tmpdir` in `beforeAll`, preventing them from reading developers'
  real `~/.tool-agents/outlook-cli/.env`.
- **Lazy `os.homedir()` resolution in `agent-config-folder.ts`**: the
  `toolAgentsRoot()` helper is now called at each `getAgentConfigFolderPath`
  invocation instead of being baked into a module-level constant. Module-
  level capture silently bypassed test `HOME` stubs.

---

## [2.0.0] — 2026-04-24

### BREAKING CHANGES

Provider credential environment variable names have been renamed from
`OUTLOOK_AGENT_`-prefixed names to the vendor-documented standard names.
The control variables (provider, model, max-steps, etc.) are unchanged.

**Rename map:**

| Old name (1.x) | New name (2.0) |
|---|---|
| `OUTLOOK_AGENT_OPENAI_API_KEY` | `OPENAI_API_KEY` |
| `OUTLOOK_AGENT_OPENAI_BASE_URL` | `OPENAI_BASE_URL` |
| `OUTLOOK_AGENT_OPENAI_ORG` | `OPENAI_ORG_ID` |
| `OUTLOOK_AGENT_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` |
| `OUTLOOK_AGENT_ANTHROPIC_BASE_URL` | `ANTHROPIC_BASE_URL` |
| `OUTLOOK_AGENT_GOOGLE_API_KEY` | `GOOGLE_API_KEY` (also `GEMINI_API_KEY`) |
| `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY` | `AZURE_OPENAI_API_KEY` |
| `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` | `AZURE_OPENAI_ENDPOINT` |
| `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION` | `AZURE_OPENAI_API_VERSION` |
| `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` | `AZURE_OPENAI_DEPLOYMENT` |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | `AZURE_AI_INFERENCE_KEY` |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | `AZURE_AI_INFERENCE_ENDPOINT` |
| `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` | `AZURE_ANTHROPIC_MODEL` |
| `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` | `AZURE_DEEPSEEK_MODEL` |

**Control vars (unchanged — do NOT rename):**
`OUTLOOK_AGENT_PROVIDER`, `OUTLOOK_AGENT_MODEL`, `OUTLOOK_AGENT_MAX_STEPS`,
`OUTLOOK_AGENT_TEMPERATURE`, `OUTLOOK_AGENT_SYSTEM_PROMPT`,
`OUTLOOK_AGENT_SYSTEM_PROMPT_FILE`, `OUTLOOK_AGENT_TOOLS`,
`OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES`, `OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES`,
`OUTLOOK_AGENT_ALLOW_MUTATIONS`, `OUTLOOK_AGENT_MEMORY_FILE`, `OUTLOOK_AGENT_MODEL_FILE`.

**Provider `google` → `gemini`:**
The provider id `google` is now deprecated. It is still accepted at runtime
(normalised to `gemini`) with a deprecation warning on stderr, but support
will be removed in a future version. Update your `OUTLOOK_AGENT_PROVIDER`
value from `google` to `gemini`.

### Added

- **`local-openai` provider** (B1) — new sixth canonical provider slot that
  speaks the OpenAI wire format. Reads `OPENAI_BASE_URL` (first), then
  `LOCAL_OPENAI_BASE_URL`, then `OLLAMA_HOST` (mapped to
  `http://<host>/v1`). `OPENAI_API_KEY` is optional (defaults to
  `"not-needed"` for local servers that don't enforce authentication).

- **`~/.tool-agents/outlook-cli/` config folder** (B3) — per-user
  configuration folder created on first agent invocation:
  - `~/.tool-agents/outlook-cli/` mode 0700
  - `.env` mode 0600 — seeded with placeholder values only (never copies
    from `process.env`). Contains `OPENAI_API_KEY=REPLACE_ME` etc.
  - `config.json` mode 0600 — non-secret runtime defaults (`provider`,
    `model`, `maxSteps`, `temperature`, `perToolBudgetBytes`,
    `allowMutations`, `tools`, etc.). Schema version 1. Validated by Zod
    at load time; malformed files are reported but never auto-overwritten.
  - Expiry hint checking: if `apiKeyExpiresAt`, `azureKeyExpiresAt`, or
    `expiresAt` fields are present in `config.json` and within 7 days of
    the current date, a warning is written to stderr on startup.

- **Extended configuration precedence chain** (B3) — now:
  `CLI flag > process env > cwd/.env (caller) > ~/.tool-agents/outlook-cli/.env
  > ~/.tool-agents/outlook-cli/config.json > default / throw`.

- **`--base-url <url>` CLI flag** (R2) — overrides the LLM provider base
  URL. For `openai` and `local-openai` it is injected as `OPENAI_BASE_URL`
  into the `providerEnv` snapshot.

- **`--config <path>` CLI flag** (R3) — overrides the
  `~/.tool-agents/outlook-cli/config.json` path. Can point at the file
  directly (`*.json`) or at the containing folder.

- **`GEMINI_API_KEY` alias** — accepted as an alias for `GOOGLE_API_KEY`
  in the `gemini` provider factory.

- **`docs/reference/config.json.example`** (C2) — canonical shape
  template for the `~/.tool-agents/outlook-cli/config.json` file with
  `"schemaVersion": 1`, placeholder keys for every provider, and
  `expiresAt` field hints.

- **Expiry-date checking** (C3) — `apiKeyExpiresAt`, `azureKeyExpiresAt`,
  and `expiresAt` ISO8601 fields in `config.json` trigger a stderr warning
  when within 7 days of expiry.

### Changed

- **Provider id `google` → `gemini`** (R1) — the canonical id is now
  `gemini`. Deprecated alias `google` is accepted at parse time, normalised
  to `gemini`, and emits exactly one deprecation warning to stderr.

- **`azure-deepseek` is a project-extension provider** (R4) — it is NOT
  part of the canonical 6-slot standard set (which is: `openai`,
  `anthropic`, `gemini`, `azure-openai`, `azure-anthropic`, `local-openai`).
  Documentation and code comments updated accordingly.

- **TUI `/model` flag-to-env table** — updated to use the new standard
  credential env var names (e.g. `--api-key` now maps to `OPENAI_API_KEY`
  instead of `OUTLOOK_AGENT_OPENAI_API_KEY`). `local-openai` and `gemini`
  entries added.

### Migration guide (1.x → 2.0)

1. In your `.env` file (or shell `export` statements), rename credential
   vars per the table above. Control vars (`OUTLOOK_AGENT_PROVIDER`, etc.)
   are unchanged.

2. If you set `OUTLOOK_AGENT_PROVIDER=google`, change it to
   `OUTLOOK_AGENT_PROVIDER=gemini`. The old value still works but emits a
   deprecation warning on every startup.

3. If you use `local-openai` (new): set `OPENAI_BASE_URL` or
   `LOCAL_OPENAI_BASE_URL` (or `OLLAMA_HOST`) and optionally `OPENAI_API_KEY`.

4. On first startup, `~/.tool-agents/outlook-cli/` is created and seeded.
   Inspect `.env` there and fill in your credential values (replace the
   `REPLACE_ME` placeholders). Process env always wins over the folder .env.

5. If you use `/model` TUI commands with `--api-key` or `--endpoint` flags,
   the flag-to-env mapping now uses the standard names — no flag rename is
   needed, only the underlying env vars changed.

---

## [1.3.0] — 2026-04-22

### Added

- **`list-mail --just-count`** — return only the count of matching messages
  instead of the messages themselves. Uses Outlook's server-side
  `$count=true` with a minimal `$top=1&$select=Id` payload, so the cost is
  constant regardless of mailbox size (no client-side paging). Works with
  every folder flag (`--folder`, `--folder-id`, `--folder-parent`) and the
  `--from`/`--to` date window. Output becomes `{ count, exact }`; `exact: false`
  signals the server did not return `@odata.count` and the reported count
  reflects only the first page.
- **`OutlookClient.countMessagesInFolder(folderId, opts?)`** — new public
  method returning `{ count: number, exact: boolean }`. Accepts an optional
  `filter` threaded into the `$filter` query param.
- **`ODataListResponse.'@odata.count'?: number`** — new optional envelope
  field so the count path can read the server-reported total.

### Changed

- **`list-mail --top` cap raised from 100 → 1000.** Enforced consistently in
  `src/commands/list-mail.ts`, `src/config/config.ts`, CLI help, CLAUDE.md
  docs, and the two regression tests that pinned the old bound. Default
  remains `10`.
- **`list-mail --from`/`--to` help text expanded** to spell out the exact
  accepted formats: `"YYYY-MM-DDTHH:MM:SSZ"` (ISO8601 UTC),
  `"YYYY-MM-DD HH:MM:SS"` (local time), or the keyword grammar `now` /
  `now + Nd` / `now - Nd`.

### Tests

- +10 tests: `test_scripts/commands-list-mail-count.spec.ts` (6), new
  `countMessagesInFolder` block in `outlook-client-threads.spec.ts` (4).
  Total suite: **240 tests** across 21 files.

---

## [1.2.0] — 2026-04-22

### Added

- **`list-mail --from <iso|keyword>` and `--to <iso|keyword>`** — filter the
  result by `ReceivedDateTime`. Each bound accepts ISO8601 or the keyword
  grammar `now` / `now + Nd` / `now - Nd`. Lower bound is inclusive (`ge`),
  upper bound is exclusive (`lt`). Either, both, or neither may be set.
  Malformed input exits 2.
- **New subcommand `get-thread <id>`** — retrieves every message in the
  conversation that `<id>` belongs to, regardless of folder. Accepts either a
  raw message id (tool fetches `ConversationId` with a tight `$select` first)
  or `conv:<rawConversationId>` to skip that hop. Flags: `--body html|text|none`
  (default `text`), `--order asc|desc` (default `asc`, oldest-first). JSON
  output is `{ conversationId, count, messages[] }`; table mode renders only
  the messages array with columns `Received | From | Subject | Id`.
- **New `OutlookClient.listMessagesByConversation(conversationId, opts?)`**
  method — queries `GET /me/messages?$filter=ConversationId eq '<id>'` and
  correctly escapes single quotes inside the id per OData rules.
- **New `filter?: string` option on `OutlookClient.listMessagesInFolder`** —
  threads a raw OData `$filter` through to the request. Used by the
  `list-mail --from/--to` wiring.
- **New shared utility `src/util/dates.ts`** with `parseTimestamp(raw)` —
  understands `now`, `now + Nd`, `now - Nd`, and ISO8601. The calendar
  command's `resolveCalendarDate` now delegates to it, which also upgrades
  `list-calendar` to accept `now - Nd`.
- **Tests**: +22 tests across three new spec files
  (`outlook-client-threads.spec.ts`, `commands-list-mail-daterange.spec.ts`,
  `commands-get-thread.spec.ts`). Total suite: **230 tests** across 20 files.

### Changed

- `MessageSummary.ConversationId?: string` — added as an optional field so it
  can be selected via `$select` (used by `get-thread`). Purely additive;
  existing consumers that ignore the field continue to work.
- `list-calendar --from/--to` — now also accepts the `now - Nd` keyword
  variant, inherited from the shared timestamp parser.

### Docs

- `CLAUDE.md`'s `<outlook-cli>` tool block — `list-mail` entry expanded with
  `--from` / `--to` documentation; new `4a. get-thread` entry added.
- `README.md` — new "Mail received between two timestamps" and "Full thread of
  an email" example sections under Usage.

---

## [1.1.0] — 2026-04-21

### Added

- **Folder management** — four new subcommands plus folder-scoped listing.
  Delivered via a plan-002-folders design and a 4-wave parallel implementation.
  - `list-folders [--parent <spec>] [--top <N>] [--recursive] [--include-hidden] [--first-match]`
    — lists direct children of a parent folder, or the full sub-tree with
    `--recursive` (bounded at 5000 nodes). Parent accepts well-known alias,
    display-name path, or `id:<raw>`.
  - `find-folder <spec> [--anchor <spec>] [--first-match]` — resolves a folder
    query to a single `ResolvedFolder` (`ResolvedVia: "wellknown" | "path" | "id"`).
  - `create-folder <path-or-name> [--parent <spec>] [--create-parents] [--idempotent]`
    — creates a folder or a nested path. `--idempotent` recovers from
    `ErrorFolderExists` and returns the pre-existing folder.
  - `move-mail <messageIds...> --to <spec> [--first-match] [--continue-on-error]`
    — moves one or more messages; surfaces the `{ sourceId, newId }` pairs
    explicitly because `POST /move` assigns a new id in the destination folder.
- **Additive folder flags on `list-mail`**: `--folder-id <id>` (raw id, skips
  the resolver) and `--folder-parent <spec>` (anchor for paths in `--folder`).
  The existing `--folder` flag was widened to accept display-name paths
  (`Inbox/Projects/Alpha`) and all well-known aliases, not just the original
  five fast-path names.
- **New folder module** `src/folders/` — `types.ts` (the tagged union
  `FolderSpec`, `ResolvedFolder`, caps like `MAX_PATH_SEGMENTS = 16`,
  `MAX_FOLDERS_VISITED = 5000`) and `resolver.ts` (`parseFolderSpec`,
  `normalizeSegment`, `resolveFolder`, `ensurePath`) implementing NFC +
  case-fold matching and the documented escape grammar for `/` and `\`.
- **New `OutlookClient` methods**: `listFolders`, `getFolder`, `createFolder`,
  `moveMessage`, `listMessagesInFolder`. All share the existing
  `doRequest` / `withAutoReauth` pipeline.
- **New `CollisionError` class** (exit code 6) and `isFolderExistsError` body
  predicate matching `{ error.code === "ErrorFolderExists" }` on HTTP 400 or
  409 (tenants vary).
- **Generic `listAll<T>` helper** inside `OutlookClient` — follows
  `@odata.nextLink` verbatim with a `MAX_FOLDER_PAGES = 50` safety cap.
- **Tests**: +110 tests across six new spec files (folder resolver,
  folder OutlookClient methods, and one per new command). Total suite after
  1.1.0: **208 tests** across 17 files.

### Changed — **Exception to the no-default config rule**

- Three runtime-plumbing settings now have documented defaults instead of
  exiting 3 on miss. Recorded under CLAUDE.md "Project-specific exceptions to
  global rules". Precedence is unchanged (CLI flag > env var > default);
  malformed flag/env values still throw `ConfigurationError`.

  | Setting | Default |
  |---|---|
  | `httpTimeoutMs` | `30000` (30 s) |
  | `loginTimeoutMs` | `300000` (5 min) |
  | `chromeChannel` | `"chrome"` |

- `outlook-cli --help` now shows `(default 30000)` / `(default 300000)` /
  `(default "chrome")` for the three flags. `docs/design/configuration-guide.md`
  and the `<outlook-cli>` doc block in CLAUDE.md were updated accordingly.

### Fixed (during code review of the folder work)

- `list-mail` accepts display-name paths and the corrected
  `--folder` / `--folder-id` / `--folder-parent` mutual-exclusion rules.
- `create-folder <nested>` without `--idempotent` now correctly raises
  `CollisionError` when the leaf pre-exists via pre-list detection.
- `create-folder --parent <anchor>` for nested paths is no longer silently
  ignored — the anchor is threaded through `ensurePath`.

### Known / deferred (tracked in `Issues - Pending Items.md`)

- `move-mail` is missing the spec flags `--ids-from`, `--to-id`, `--stop-at`
  (shell substitutes exist; deferred as additive).
- `find-folder` uses `--anchor`; the spec says `--parent` (cosmetic rename).
- `isFolderExistsError` parses the body out of a redacted error-message
  string; edge-case risk that `CollisionError` (exit 6) could degrade to
  `UpstreamError` (exit 5) on unusual bodies. Fix: attach parsed body to
  `ApiError` directly.

---

## [1.0.0] — 2026-04-21

### Added — initial release

- Interactive login via headed Playwright Chrome window, capturing the first
  outbound Bearer token + cookies and persisting them to
  `$HOME/.outlook-cli/session.json` (mode `0600`, parent dir `0700`).
- `auth-check` — non-interactive session verification.
- `list-mail` (five well-known folder aliases), `get-mail`,
  `download-attachments`.
- `list-calendar`, `get-event`.
- Shared error taxonomy and exit-code contract (`0/1/2/3/4/5/6`).
- PID-based advisory lock at `$HOME/.outlook-cli/.browser.lock` to prevent
  two login flows from racing on the profile directory.
- Single-retry 401 auto-reauth with `--no-auto-reauth` opt-out.
- Body-snippet redaction on every error path so Bearer tokens and cookie
  values never appear in stderr, logs, or thrown error messages.
- Baseline test suite: 96 tests across 10 spec files.
