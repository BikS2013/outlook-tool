// src/agent/tools/list-calendar-tool.ts
//
// LangChain tool wrapper around `commands/list-calendar.run()`. See
// project-design.md §6.7.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as listCalendar from '../../commands/list-calendar';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  tz: z.string().optional(),
});

export const createListCalendarTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await listCalendar.run(deps, {
          from: input.from,
          to: input.to,
          tz: input.tz,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'list_calendar',
      description:
        'List calendar events between a start and end datetime. from/to accept ISO8601 or keywords like "now" / "now + 7d".',
      schema,
    },
  );
