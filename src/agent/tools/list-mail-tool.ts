// src/agent/tools/list-mail-tool.ts
//
// LangChain tool wrapper around `commands/list-mail.run()`. See
// project-design.md §6.2.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as listMail from '../../commands/list-mail';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  folder: z.string().optional(),
  folderId: z.string().optional(),
  folderParent: z.string().optional(),
  top: z.number().int().positive().optional(),
  select: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  justCount: z.boolean().optional(),
});

export const createListMailTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await listMail.run(deps, {
          folder: input.folder,
          folderId: input.folderId,
          folderParent: input.folderParent,
          top: input.top,
          select: input.select,
          from: input.from,
          to: input.to,
          justCount: input.justCount,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'list_mail',
      description:
        'List recent Outlook messages in a folder (alias, path, or id). Folder defaults to Inbox. Supports ISO or keyword date window (e.g. "now", "now - 7d"). Set justCount=true for just the count.',
      schema,
    },
  );
