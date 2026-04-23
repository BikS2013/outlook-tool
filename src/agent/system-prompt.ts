// src/agent/system-prompt.ts
//
// Default system prompt for the LangGraph agent plus the loader that picks
// between inline text, a file, and the built-in default.
//
// Normative references:
//   - docs/design/project-design.md §11  (verbatim prompt text)
//   - docs/design/investigation-langgraph-agent.md §5
//
// Exports:
//   - DEFAULT_SYSTEM_PROMPT — single-string default (already has
//     the MUTATIONS_DISABLED clause substituted in, as §11 specifies that
//     mutations are OFF by default).
//   - loadSystemPrompt(inline, filePath) — returns the effective prompt
//     string, with strict mutual-exclusion and file-not-found semantics.
//
// This module is intentionally side-effect free (no I/O at load time).

import { existsSync, readFileSync } from 'node:fs';
import { ConfigurationError } from '../config/errors';

// --- UsageError (mirrors the ad-hoc class used in src/commands/list-mail.ts).
// We import lazily via `require` to avoid a circular import between the
// agent module tree and the command tree.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UsageError } = require('../commands/list-mail') as {
  UsageError: new (msg: string) => Error;
};

/**
 * Verbatim from design §11 plus the MUTATIONS_DISABLED clause substituted in
 * (the safer default — mutation tools are omitted from the catalog unless
 * `--allow-mutations` is explicitly set, per ADR-4).
 */
export const DEFAULT_SYSTEM_PROMPT: string = `You are an Outlook assistant embedded in the outlook-cli tool. You have access to tools that read the user's Outlook mailbox, calendar, and folder tree. Your job is to answer questions and fulfill tasks by calling these tools and reporting what you observe.

TOOL USE RULES:
- Always use tools to retrieve information. Never invent message content, sender names, email addresses, timestamps, subject lines, folder names, or event details. If you do not know something, call a tool to find out.
- Prefer the smallest, most specific tool call. If you only need one email, do not list 100. If you need to locate a folder, use find_folder before list_folders.
- Always cite the exact Id field (message Id, event Id, folder Id) when you reference a specific item in your reply. The user may need it for follow-up actions.
- If a tool returns an error, report the error to the user clearly. Do not retry the same failing call more than once without changing the input parameters.
- Respect the --max-steps budget. If you are close to the limit, summarize what you have found rather than making more tool calls.

SENSITIVE DATA:
- Do not repeat raw email body content verbatim unless the user explicitly asks for the full text. Summarize instead.
- Do not include API keys, authentication tokens, passwords, or other credentials in your replies, even if they appear in tool outputs (they should not, but treat them as confidential if they do).
- Never echo message bodies, attachments, or tool-result payloads into human-visible logs.

MUTATION OPERATIONS:
The tools create_folder, move_mail, and download_attachments are NOT available in this session unless the CLI was invoked with --allow-mutations. Before executing any mutating tool when enabled, confirm the intended action with the user in plain language: state exactly what will be created, moved, or downloaded, and ask for explicit confirmation. Do not execute a mutating tool based on an ambiguous or overly broad instruction.

When in doubt, ask a clarifying question rather than taking an irreversible action.
`;

/**
 * Resolve the effective system prompt string.
 *
 * Precedence (CLI layer has already normalized these):
 *   1. `inline`       — verbatim text via --system / OUTLOOK_AGENT_SYSTEM_PROMPT
 *   2. `filePath`     — read UTF-8 file contents via --system-file / *_FILE
 *   3. DEFAULT_SYSTEM_PROMPT.
 *
 * `inline` and `filePath` are mutually exclusive. Passing both is a
 * `UsageError` (defense-in-depth; `loadAgentConfig` already rejects this).
 *
 * A missing `filePath` raises `ConfigurationError` — the user EXPLICITLY
 * asked for the file by passing the flag, so we do not silently fall back
 * (per the project's no-fallback rule).
 */
export function loadSystemPrompt(
  inline: string | null,
  filePath: string | null,
): string {
  if (inline != null && filePath != null) {
    throw new UsageError(
      'agent: --system and --system-file are mutually exclusive',
    );
  }
  if (inline != null) {
    return inline.trim();
  }
  if (filePath != null) {
    if (!existsSync(filePath)) {
      throw new ConfigurationError(
        'systemPromptFile',
        ['--system-file', 'OUTLOOK_AGENT_SYSTEM_PROMPT_FILE'],
        `cannot be read: ${filePath}`,
      );
    }
    try {
      return readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new ConfigurationError(
        'systemPromptFile',
        ['--system-file', 'OUTLOOK_AGENT_SYSTEM_PROMPT_FILE'],
        `cannot be read: ${filePath} (${(err as NodeJS.ErrnoException).code ?? 'IO'})`,
      );
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}
