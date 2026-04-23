// src/agent/tools/create-folder-tool.ts
//
// LangChain tool wrapper around `commands/create-folder.run()`. See
// project-design.md §6.9 (mutation-gated).
//
// Agent-specific default: `idempotent: true` (differs from the CLI default
// per design §12 Unit 4 + codebase-scan §12 note) so the LLM's re-runs do
// not accidentally exit 6 on a pre-existing folder.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as createFolder from '../../commands/create-folder';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  pathOrName: z.string().min(1),
  parent: z.string().optional(),
  createParents: z.boolean().optional(),
  idempotent: z.boolean().default(true),
});

export const createCreateFolderTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await createFolder.run(deps, input.pathOrName, {
          parent: input.parent,
          createParents: input.createParents,
          idempotent: input.idempotent,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'create_folder',
      description:
        '[MUTATING] Create an Outlook mail folder (optionally nested under --parent). Idempotent by default: a pre-existing folder is returned rather than an error.',
      schema,
    },
  );
