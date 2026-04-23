// src/agent/tools/get-mail-tool.ts
//
// LangChain tool wrapper around `commands/get-mail.run()`. See
// project-design.md §6.3.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as getMail from '../../commands/get-mail';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  id: z.string().min(1),
  body: z.enum(['html', 'text', 'none']).optional(),
});

export const createGetMailTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await getMail.run(deps, input.id, { body: input.body });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'get_mail',
      description:
        'Retrieve one Outlook email by id, including body and attachment metadata. Use body=none to skip the body.',
      schema,
    },
  );
