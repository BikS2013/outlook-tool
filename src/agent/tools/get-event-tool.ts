// src/agent/tools/get-event-tool.ts
//
// LangChain tool wrapper around `commands/get-event.run()`. See
// project-design.md §6.8.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as getEvent from '../../commands/get-event';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  id: z.string().min(1),
  body: z.enum(['html', 'text', 'none']).optional(),
});

export const createGetEventTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await getEvent.run(deps, input.id, { body: input.body });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'get_event',
      description:
        'Retrieve a single Outlook calendar event by id. Use body=none to skip the body.',
      schema,
    },
  );
