// src/agent/tools/get-thread-tool.ts
//
// LangChain tool wrapper around `commands/get-thread.run()`. See
// project-design.md §6.4.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as getThread from '../../commands/get-thread';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  idOrConv: z.string().min(1),
  body: z.enum(['html', 'text', 'none']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createGetThreadTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await getThread.run(deps, input.idOrConv, {
          body: input.body,
          order: input.order,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'get_thread',
      description:
        'Retrieve every message in the conversation thread that a message id belongs to. Accepts a message id or "conv:<rawConversationId>" to skip the initial resolve hop.',
      schema,
    },
  );
