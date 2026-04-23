// src/agent/tools/auth-check-tool.ts
//
// LangChain tool wrapper around `commands/auth-check.run()`. See
// project-design.md §6.1.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as authCheck from '../../commands/auth-check';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({});

export const createAuthCheckTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async () => {
      try {
        const result = await authCheck.run(deps);
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'auth_check',
      description:
        'Verify the current Outlook session is accepted without opening a browser. Call before other tools if a call returns an auth error.',
      schema,
    },
  );
