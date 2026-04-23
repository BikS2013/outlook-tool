// src/agent/tools/find-folder-tool.ts
//
// LangChain tool wrapper around `commands/find-folder.run()`. See
// project-design.md §6.6.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as findFolder from '../../commands/find-folder';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  spec: z.string().min(1),
  anchor: z.string().optional(),
  firstMatch: z.boolean().optional(),
});

export const createFindFolderTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await findFolder.run(deps, input.spec, {
          anchor: input.anchor,
          firstMatch: input.firstMatch,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'find_folder',
      description:
        'Resolve a folder query (well-known alias, display-name path, or id:<raw>) to a single folder object with its id and metadata.',
      schema,
    },
  );
