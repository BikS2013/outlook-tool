// src/agent/tools/download-attachments-tool.ts
//
// LangChain tool wrapper around `commands/download-attachments.run()`. See
// project-design.md §6.11 (mutation-gated).
//
// Safety note — `outDir` is REQUIRED (no hidden-default filesystem writes).
// This mirrors the CLI surface which requires `--out`.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as downloadAttachments from '../../commands/download-attachments';

import { truncateToolResult } from './truncate';
import { handleToolError, type ToolAdapterFactory } from './types';

const schema = z.object({
  id: z.string().min(1),
  outDir: z.string().min(1),
  overwrite: z.boolean().optional(),
  includeInline: z.boolean().optional(),
});

export const createDownloadAttachmentsTool: ToolAdapterFactory = (deps, cfg) =>
  tool(
    async (input) => {
      try {
        const result = await downloadAttachments.run(deps, input.id, {
          out: input.outDir,
          overwrite: input.overwrite,
          includeInline: input.includeInline,
        });
        return truncateToolResult(result, cfg.perToolBudgetBytes);
      } catch (err) {
        return handleToolError(err);
      }
    },
    {
      name: 'download_attachments',
      description:
        '[MUTATING] Download file attachments of a message into a local directory (outDir is required). Byte content is never returned — only saved/skipped metadata.',
      schema,
    },
  );
