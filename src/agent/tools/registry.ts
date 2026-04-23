// src/agent/tools/registry.ts
//
// Build the tool catalog for a given (deps, cfg) pair. Applies the mutation
// gate BEFORE the `toolsAllowlist` filter (design §6, plan-003 Phase D).

import type { StructuredToolInterface } from '@langchain/core/tools';

import { createAuthCheckTool } from './auth-check-tool';
import { createListMailTool } from './list-mail-tool';
import { createGetMailTool } from './get-mail-tool';
import { createGetThreadTool } from './get-thread-tool';
import { createListFoldersTool } from './list-folders-tool';
import { createFindFolderTool } from './find-folder-tool';
import { createListCalendarTool } from './list-calendar-tool';
import { createGetEventTool } from './get-event-tool';
import { createCreateFolderTool } from './create-folder-tool';
import { createMoveMailTool } from './move-mail-tool';
import { createDownloadAttachmentsTool } from './download-attachments-tool';

import type { AgentConfig, AgentDeps } from './types';

/**
 * Assemble the LLM-visible tool catalog:
 *   1. Always include the 8 read-only tools.
 *   2. Include the 3 mutation tools iff `cfg.allowMutations === true`.
 *   3. If `cfg.toolsAllowlist` is a non-null array, keep only tools whose
 *      `.name` is in the allowlist (applied AFTER the mutation gate, so a
 *      mutation tool name in the allowlist is still excluded when mutations
 *      are disabled — safer per plan-003 §5 Risks).
 */
export function buildToolCatalog(
  deps: AgentDeps,
  cfg: AgentConfig,
): StructuredToolInterface[] {
  const readOnly: StructuredToolInterface[] = [
    createAuthCheckTool(deps, cfg),
    createListMailTool(deps, cfg),
    createGetMailTool(deps, cfg),
    createGetThreadTool(deps, cfg),
    createListFoldersTool(deps, cfg),
    createFindFolderTool(deps, cfg),
    createListCalendarTool(deps, cfg),
    createGetEventTool(deps, cfg),
  ];

  const mutating: StructuredToolInterface[] = cfg.allowMutations
    ? [
        createCreateFolderTool(deps, cfg),
        createMoveMailTool(deps, cfg),
        createDownloadAttachmentsTool(deps, cfg),
      ]
    : [];

  let catalog: StructuredToolInterface[] = [...readOnly, ...mutating];

  if (cfg.toolsAllowlist !== null && cfg.toolsAllowlist !== undefined) {
    const allowed = new Set<string>(cfg.toolsAllowlist);
    catalog = catalog.filter((t) => allowed.has(t.name));
  }

  return catalog;
}
