# Configuration Guide — outlook-cli

## Configuration sources and precedence

The CLI resolves every setting through a fixed precedence chain. **Highest wins.**

1. **CLI flag** — e.g. `--timeout 30000`, passed on the command line for one invocation.
2. **Environment variable** — e.g. `OUTLOOK_CLI_HTTP_TIMEOUT_MS=30000` exported in the shell (or sourced from `outlook-cli.env`).
3. **Default** — allowed *only* for the three runtime-plumbing settings listed below (`httpTimeoutMs`, `loginTimeoutMs`, `chromeChannel`), per the project-specific exception recorded in CLAUDE.md (2026-04-21). All other settings that were marked mandatory still throw `ConfigurationError` (exit code `3`) on miss — there is no silent fallback for those.

A `.env`-style file (like `outlook-cli.env` in the project root) is simply a convenient way to populate **source #2** — it does not introduce a new precedence level.

## Configuration parameters

### Runtime plumbing (defaults allowed — CLAUDE.md exception 2026-04-21)

CLI flag overrides env var overrides default. A malformed value from flag or env (e.g. non-integer, non-positive) still throws `ConfigurationError` — the default only covers the unset case.

| Name | CLI flag | Env var | Default | Purpose |
|---|---|---|---|---|
| HTTP timeout | `--timeout <ms>` | `OUTLOOK_CLI_HTTP_TIMEOUT_MS` | `30000` (30 s) | Abort a single REST call to `outlook.office.com` after this many milliseconds. Positive integer. |
| Login timeout | `--login-timeout <ms>` | `OUTLOOK_CLI_LOGIN_TIMEOUT_MS` | `300000` (5 min) | Max time to wait for the user to finish logging in inside the Playwright-controlled Chrome window. Positive integer. |
| Chrome channel | `--chrome-channel <name>` | `OUTLOOK_CLI_CHROME_CHANNEL` | `chrome` | Which Chrome or Edge build Playwright should launch. One of `chrome`, `chrome-beta`, `chrome-dev`, `msedge`, `msedge-beta`. Must be installed locally. |

### Optional (defaults allowed by the spec)

| Name | CLI flag | Env var | Default | Purpose |
|---|---|---|---|---|
| Session file path | `--session-file <path>` | `OUTLOOK_CLI_SESSION_FILE` | `$HOME/.outlook-cli/session.json` | Where captured cookies + Bearer token are persisted. Mode `0600`. |
| Profile directory | `--profile-dir <path>` | `OUTLOOK_CLI_PROFILE_DIR` | `$HOME/.outlook-cli/playwright-profile` | Playwright persistent profile so you don't re-login every browser open. Mode `0700`. |
| Timezone | `--tz <iana>` | — | System timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) | IANA zone used for `list-calendar` window calculations. |
| Output mode | `--json` / `--table` | — | `--json` | JSON (scriptable) vs. human-readable table. |
| Quiet | `--quiet` | — | `false` | Suppress progress messages on stderr. |
| No auto reauth | `--no-auto-reauth` | — | `false` | On 401 / expired session, FAIL rather than re-opening the browser. |

### Command-local options

Several commands have their own options (`-n / --top`, `--folder`, `--from`, `--to`, `--body`, `--out`, `--overwrite`, `--include-inline`). See `outlook-cli <command> --help` for each.

## Recommended storage / management

- **Non-secret values** (timeouts, Chrome channel) can be tracked in `outlook-cli.env` at the project root. This file is safe to commit if you want team defaults; or add it to `.gitignore` and keep it local.
- **Secrets** (captured Bearer token, session cookies) are NEVER placed in config files. They live only in `$HOME/.outlook-cli/session.json` at mode `0600`, written atomically by the CLI itself.
- **Permanent setup**: append `source /abs/path/to/outlook-cli.env` to `~/.zshrc` or `~/.bashrc` so every shell has the three mandatory settings preloaded.
- **One-off invocations**: prefix the command, e.g.
  ```bash
  OUTLOOK_CLI_HTTP_TIMEOUT_MS=30000 \
  OUTLOOK_CLI_LOGIN_TIMEOUT_MS=300000 \
  OUTLOOK_CLI_CHROME_CHANNEL=chrome \
    node dist/cli.js list-mail -n 5
  ```
- **Per-call override**: the CLI flag always wins, so you can bump a single call's timeout without touching env:
  ```bash
  node dist/cli.js --timeout 60000 list-mail -n 50
  ```

## Expiring values — proposal

None of the three mandatory settings expire. They are static runtime knobs.

The **session file** (`$HOME/.outlook-cli/session.json`) contains a short-lived Bearer token whose `bearer.expiresAt` field is an ISO-8601 timestamp derived from the JWT `exp` claim. The CLI already:

- Checks `expiresAt` before every call (`auth-check` reports `status: "expired"`).
- Triggers a browser re-auth automatically on expiry (unless `--no-auto-reauth`).
- Rotates the token transparently on 401.

If future iterations add settings that expire (e.g., a long-lived personal access token for an alternate auth backend), follow the CLAUDE.md guidance and add a companion setting to capture the expiration date, so the CLI can proactively warn the user before expiry.

## Validation errors

If a mandatory setting is missing, stderr receives pretty-printed JSON and the process exits 3. Example:

```json
{
  "error": {
    "code": "CONFIG_MISSING",
    "message": "Mandatory setting \"httpTimeoutMs\" was not provided. Checked: --timeout flag, OUTLOOK_CLI_HTTP_TIMEOUT_MS env var.",
    "missingSetting": "httpTimeoutMs",
    "checkedSources": [
      "--timeout flag",
      "OUTLOOK_CLI_HTTP_TIMEOUT_MS env var"
    ]
  }
}
```

Numeric settings also validate ranges — a non-positive integer for either timeout will surface a `ConfigurationError` with a range message.

## Agent Subcommand — `OUTLOOK_AGENT_*` env vars

The `agent` subcommand layers a second config surface on top of the core
`OUTLOOK_CLI_*` settings. Its loader (`src/config/agent-config.ts`) enforces
the same precedence as the core loader:

**CLI flag > process env > `.env` file > default (optional rows only).**

`.env` loading happens in `src/commands/agent.ts` BEFORE any env read. Use
`--env-file <path>` to point at a non-default file; the default is
`./.env` in the CWD if present. `override: false` is passed to `dotenv`, so
any value already exported in the shell always wins.

Missing mandatory rows raise `ConfigurationError` (exit 3) per the
project's no-fallback rule; missing provider-specific secrets bubble up as
`ConfigurationError` from inside the provider factory on the same exit
path.

### Global agent controls

| Name | CLI flag | Env var | Default | Purpose |
|---|---|---|---|---|
| Provider | `--provider <name>` | `OUTLOOK_AGENT_PROVIDER` | **none (mandatory)** | Selects which LLM factory runs. One of `openai`, `anthropic`, `google`, `azure-openai`, `azure-anthropic`, `azure-deepseek`. |
| Model | `--model <id>` | `OUTLOOK_AGENT_MODEL` | **none (mandatory)** | Model id (native providers) or deployment name (Azure). For `azure-openai` the deployment is actually supplied via `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT`; `--model` is informational there. |
| Max steps | `--max-steps <n>` | `OUTLOOK_AGENT_MAX_STEPS` | `10` | Hard cap on ReAct iterations. Positive integer. |
| Temperature | `--temperature <t>` | `OUTLOOK_AGENT_TEMPERATURE` | `0` | LLM sampling temperature. Non-negative float. |
| System prompt (inline) | `--system <text>` | `OUTLOOK_AGENT_SYSTEM_PROMPT` | — | Replaces the built-in default prompt verbatim. Mutually exclusive with `OUTLOOK_AGENT_SYSTEM_PROMPT_FILE`. |
| System prompt (file) | `--system-file <path>` | `OUTLOOK_AGENT_SYSTEM_PROMPT_FILE` | — | Reads the prompt from a UTF-8 file. Mutually exclusive with `OUTLOOK_AGENT_SYSTEM_PROMPT`. |
| Tool allowlist | `--tools <csv>` | `OUTLOOK_AGENT_TOOLS` | — (full permitted set) | Comma-separated subset of tool names to expose. Applied AFTER the mutation gate, so listing a mutation tool here without `--allow-mutations` still excludes it. |
| Per-tool byte budget | `--per-tool-budget <bytes>` | `OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES` (alias: `OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES`) | `16384` | Truncation cap on a single tool result injected into the LLM. |
| Allow mutations | `--allow-mutations` | `OUTLOOK_AGENT_ALLOW_MUTATIONS` | `false` | Gates the 3 mutating tools (`create_folder`, `move_mail`, `download_attachments`). |
| Env file | `--env-file <path>` | — | — | Path to a `.env` file loaded before any env read. The loader also reads `./.env` implicitly when this flag is absent. |
| Verbose | `--verbose` | — | `false` | Emits per-step trace lines to stderr. |
| Interactive | `-i, --interactive` | — | `false` | Start the REPL. |

**How to obtain**: these are workflow knobs you set yourself; there is no
upstream issuer. Persist them in `./.env` (for repo defaults), in a team
`.env` file pointed at via `--env-file`, or export them in `~/.zshrc` for
system-wide defaults.

### OpenAI (`--provider openai`)

| Name | Env var | Required? | Default | Purpose / how to obtain |
|---|---|---|---|---|
| API key | `OUTLOOK_AGENT_OPENAI_API_KEY` | yes | — | Project or user API key. Create at https://platform.openai.com/api-keys. |
| Base URL | `OUTLOOK_AGENT_OPENAI_BASE_URL` | no | SDK default | Override for self-hosted proxies or regional gateways. |
| Organization | `OUTLOOK_AGENT_OPENAI_ORG` | no | — | OpenAI org id if your key is scoped to multiple orgs. |

**Storage**: the API key is a bearer credential. Keep it out of the repo —
store it in a user-only `.env` (mode 0600), `keychain`, or the usual
secrets vault. Rotate quarterly.

**Expiration hint** (per CLAUDE.md `<configuration-guide>` rule): OpenAI
keys do not have a server-side expiration, but you can record your own
rotation target in `OUTLOOK_AGENT_OPENAI_API_KEY_EXPIRES_AT` (ISO-8601
date). v1 is advisory only — the CLI does not warn yet.

### Anthropic (`--provider anthropic`)

| Name | Env var | Required? | Default | Purpose |
|---|---|---|---|---|
| API key | `OUTLOOK_AGENT_ANTHROPIC_API_KEY` | yes | — | Create at https://console.anthropic.com/settings/keys. |
| Base URL | `OUTLOOK_AGENT_ANTHROPIC_BASE_URL` | no | SDK default | Gateway / proxy override. |

Expiration hint: `OUTLOOK_AGENT_ANTHROPIC_API_KEY_EXPIRES_AT`.

### Google Gemini (`--provider google`)

| Name | Env var | Required? | Default | Purpose |
|---|---|---|---|---|
| API key | `OUTLOOK_AGENT_GOOGLE_API_KEY` | yes | — | Create at https://aistudio.google.com/app/apikey. |

Expiration hint: `OUTLOOK_AGENT_GOOGLE_API_KEY_EXPIRES_AT`.

### Azure OpenAI (`--provider azure-openai`)

All four rows are required.

| Name | Env var | Required? | Default | Purpose |
|---|---|---|---|---|
| API key | `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY` | yes | — | Cognitive Services key from the Azure portal. |
| Endpoint | `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` | yes | — | e.g. `https://<resource>.openai.azure.com`. |
| API version | `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION` | yes | — | e.g. `2024-10-21`. Must be a version supporting tool calling. |
| Deployment | `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` | yes | — | Deployment name you created in Azure OpenAI Studio. `--model` is informational for this provider. |

**Obtain**: Azure OpenAI resource → "Keys and Endpoint" for the key +
endpoint, Azure OpenAI Studio → "Deployments" for the deployment name.
Pick an API version from the Microsoft Learn compatibility matrix.

Expiration hint: `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY_EXPIRES_AT`.

### Azure AI Foundry — Anthropic (`--provider azure-anthropic`)

Uses the shared Foundry inference block:

| Name | Env var | Required? | Default | Purpose |
|---|---|---|---|---|
| Foundry key | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | yes | — | Inference key for the Foundry resource. |
| Foundry endpoint | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | yes | — | e.g. `https://<resource>.services.ai.azure.com`. The factory appends `/anthropic`. |
| API version | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` | no | — | Informational only. The ChatAnthropic client manages `anthropic-version` itself. |
| Model | `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` | no | — | Deployment name (e.g. `claude-sonnet-4-5`). May also be supplied via `--model`. |

Expiration hint: `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY_EXPIRES_AT`.

### Azure AI Foundry — DeepSeek (`--provider azure-deepseek`)

Same shared Foundry block as Azure Anthropic. The factory appends
`/openai/v1` to the endpoint.

| Name | Env var | Required? | Default | Purpose |
|---|---|---|---|---|
| Foundry key | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | yes | — | Inference key for the Foundry resource. |
| Foundry endpoint | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | yes | — | e.g. `https://<resource>.services.ai.azure.com`. |
| Model | `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` | no | — | Deployment name (e.g. `DeepSeek-V3.2`). Rejected at config-load if it matches the denylist in project-design §5.6 (`DeepSeek-R1`, `DeepSeek-V3.2-Speciale` — no tool-calling support). |

Expiration hint: same Foundry key as the Azure Anthropic section.

