# Issues - Pending Items

## Pending

<!-- Most critical / highest priority first. -->

### 1. Global `~/.claude/CLAUDE.md` still references voided `memoryFile`/`modelFile` exception

**Status:** pending (2026-04-30, surfaced by the tool-conventions audit
F-2).

**Context:** the global memory file mentions an exception approved on
2026-04-23 for the agent's `memoryFile` and `modelFile` settings. Those
settings were part of the agent layer that was removed in v3.0.0, so
the exception is moot. The project CLAUDE.md is already correct (it
only documents the three surviving runtime-plumbing exceptions).

**Action required:** edit `~/.claude/CLAUDE.md` (or wherever the global
exception was recorded) and either remove the `memoryFile`/`modelFile`
paragraph or annotate it as voided. Documentation hygiene only — no
code change.

**Effort:** trivial.

---

## Completed

<!-- Completed items moved here. -->

### 2026-04-30 — runtime data consolidated under `~/.tool-agents/outlook-cli/` (v3.1.0)

- **[done] `sessionFilePath` and `profileDir` defaults moved.** From
  `~/.outlook-cli/...` to `~/.tool-agents/outlook-cli/...` so all
  outlook-cli state (config + runtime) lives under the conventions
  parent dir. Implementation in `src/config/config.ts` (lines 245,
  254). Test `test_scripts/config.spec.ts` updated to assert the new
  endings. Override flags and env vars unchanged.

- **[done] One-shot legacy auto-migration added.** `src/cli.ts →
  migrateLegacyRuntimeData()` runs after `bootstrapToolConfigDir()`
  and moves `~/.outlook-cli/session.json` and the
  `playwright-profile/` directory into the new location if (a) they
  exist, (b) the new path is empty, and (c) the user has not
  overridden the path via env. Best-effort cleanup of the empty
  legacy directory afterwards. Skipped entirely when env overrides
  are present.

### 2026-04-30 — tool-conventions audit fixes (v3.0.1)

- **[done] F-1 (critical) — Stale agent-era `.env` content cleaned up.**
  `~/.tool-agents/outlook-cli/.env` regenerated with only the eight
  `OUTLOOK_CLI_*` keys the CLI actually reads. All `OUTLOOK_AGENT_*`
  and LLM-provider blocks removed. Mode preserved at `0600`.

- **[done] F-3 (major) — Four-tier env-var resolution chain implemented.**
  `src/cli.ts` now calls `bootstrapToolConfigDir()` at the top of
  `main()`. It ensures `~/.tool-agents/outlook-cli/` at mode `0700`,
  loads `~/.tool-agents/outlook-cli/.env` (if present), then loads
  `./.env` — both with `override: false, quiet: true`. The shell env
  still wins; CLI flags still win over everything. `dotenv` re-added
  as a runtime dependency.

- **[done] F-5 (minor) — `~/.tool-agents/outlook-cli/` auto-created on
  startup.** Folded into `bootstrapToolConfigDir()`. Idempotent;
  tightens an existing wider mode to `0700`.

- **[done] F-4 (minor) — Project CLAUDE.md subcommand count fixed.**
  Tools entry now reads "12 subcommands" instead of "11".

- **[done] F-6 (minor) — `docs/tools/outlook-cli.md` subcommands
  renumbered.** Now sequential `1..12`; the informal `4a` label is
  gone.

- **[deferred] F-2 (major) — Global `~/.claude/CLAUDE.md` still
  references the voided agent-era exception.** Documentation-only;
  added as new pending item #1.

### 2026-04-30 — design docs cleaned up after agent removal

- **[done] `docs/design/configuration-guide.md` rewritten.** Now covers
  only `OUTLOOK_CLI_*` runtime-plumbing variables. The agent provider
  matrix (`OUTLOOK_AGENT_*`, `~/.tool-agents/outlook-cli/`,
  `--base-url`, `--config`) is gone. A history note at the top points
  to `CHANGELOG.md` 3.0.0.

- **[done] `docs/design/project-design.md` truncated at line 2984.** The
  former Agent Subcommand (Plan 003) and Agent Interactive TUI (Plan
  004) sections (lines 2985–5142) were removed and replaced with a
  short "Removed in v3.0.0" footer pointing at the changelog and tag
  `v2.1.0`.

- **[done] `docs/design/project-functions.MD` truncated.** The 13
  FR-AGT-* requirements and 7 F-TUI.* feature blocks were removed and
  replaced with a single "Removed in v3.0.0" paragraph.

- **[done] `docs/research/azure-deepseek-tool-calling.md` deleted.**
  Was agent-only research material.

- **[done] `docs/reference/codebase-scan-langgraph-agent.md` and
  `docs/reference/config.json.example` deleted.** Both were
  agent-only artifacts.

### 2026-04-30 — agent layer removed (v3.0.0)

- **[done] Agent layer removed in its entirety.** `src/agent/`,
  `src/commands/agent.ts`, `src/config/agent-config*.ts`, the
  `agent [prompt]` block in `src/cli.ts`, all `agent-*` /
  `tui-*` / `commands-agent` test specs, `docs/tools/agent.md`, and
  the agent plan/investigation/audit docs are gone. Dependencies
  `@langchain/core`, `@langchain/openai`, `@langchain/anthropic`,
  `@langchain/google-genai`, `@langchain/langgraph`, `langchain`,
  `dotenv`, and `zod` were dropped from `package.json`. CLAUDE.md no
  longer carries the `memoryFile`/`modelFile` exception or the agent
  Tools entry. `.env.example` was rewritten to cover only the
  outlook-cli runtime plumbing variables. See `CHANGELOG.md` 3.0.0.

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
