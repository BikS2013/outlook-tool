// src/agent/tools/move-mail-tool.ts
//
// LangChain tool wrapper around `commands/move-mail.run()`. See
// project-design.md §6.10 (mutation-gated).

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as moveMail from '../../commands/move-mail';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  messageIds: z.array(z.string().min(1)).min(1),
  to: z.string().min(1),
  firstMatch: z.boolean().optional(),
  continueOnError: z.boolean().optional(),
});

export const createMoveMailTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await moveMail.run(deps, input.messageIds, {
          to: input.to,
          firstMatch: input.firstMatch,
          continueOnError: input.continueOnError,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'move_mail',
      description:
        '[MUTATING] Move messages to a destination folder (alias, path, or id). Returns NEW ids per moved message — source ids become invalid after the move.',
      schema,
    },
  );
