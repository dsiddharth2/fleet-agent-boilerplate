import * as z from 'zod/v4';
import { runDemo } from '../workflows/demo/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';

// Routable workflows. To expose a new tool, append an entry here — no changes to
// server.mjs or http.mjs are needed. `description` is read by the connected
// model when it decides which tool to call, so write it for that reader.
export const defaultRegistry = [
  {
    name: 'demo',
    description:
      'Runs the demo workflow end to end on a pooled worker: the dummy python ' +
      'command, the transform, and an agent smoke test. Choose this to run the ' +
      'demo workflow or to verify that Fleet plumbing works. Queues when every ' +
      'worker is busy. Spends LLM tokens and can take a minute.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ fleetApi, pool, signal, reportPhase }) {
      const result = await runDemo({ fleetApi, pool, signal, reportPhase });
      return `demo workflow completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'inspect-members',
    description:
      "Reports on this repo's worker pool: which workers are busy and since when, " +
      'and what is in each work folder. Choose this to check pool health or to see ' +
      'what a worker has been doing. Read-only, takes no worker, and spends no LLM tokens.',
    inputSchema: z.object({
      workers: z
        .array(z.number().int().positive())
        .optional()
        .describe('Worker numbers to inspect, e.g. [1, 2]. Defaults to every worker in the pool.'),
      includeFiles: z
        .boolean()
        .optional()
        .describe('Include a listing of top-level entries in each work folder.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args, signal, reportPhase }) {
      return await runInspectMembers({
        fleetApi,
        workers: args.workers,
        includeFiles: args.includeFiles,
        signal,
        reportPhase,
      });
    },
  },
];
