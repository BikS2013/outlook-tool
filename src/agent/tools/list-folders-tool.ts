// src/agent/tools/list-folders-tool.ts
//
// LangChain tool wrapper around `commands/list-folders.run()`. See
// project-design.md §6.5.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as listFolders from '../../commands/list-folders';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  parent: z.string().optional(),
  top: z.number().int().positive().optional(),
  recursive: z.boolean().optional(),
  includeHidden: z.boolean().optional(),
  firstMatch: z.boolean().optional(),
});

export const createListFoldersTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await listFolders.run(deps, {
          parent: input.parent,
          top: input.top,
          recursive: input.recursive,
          includeHidden: input.includeHidden,
          firstMatch: input.firstMatch,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'list_folders',
      description:
        'Enumerate mail folders under a parent (alias, path, or id). recursive=true walks the full sub-tree. Defaults to top-level folders under MsgFolderRoot.',
      schema,
    },
  );
