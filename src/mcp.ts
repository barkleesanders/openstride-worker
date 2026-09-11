import { z } from 'zod';
import { planConfigSchema } from './engine';
import { activityInputSchema, dateSchema, workoutPatchSchema } from './store';

const id = z.string().min(1).max(100);
export const toolSchemas = {
  list_plans: z.object({}).strict(),
  get_plan: z.object({ planId: id }).strict(),
  create_plan: planConfigSchema,
  update_workout: z.object({ planId: id, workoutId: id, patch: workoutPatchSchema }).strict(),
  ease_plan: z.object({ planId: id, startDate: dateSchema }).strict(),
  list_activities: z.object({}).strict(),
  log_activity: activityInputSchema,
  export_calendar: z.object({ planId: id }).strict(),
  export_csv: z.object({ planId: id }).strict(),
  strava_status: z.object({}).strict(),
  sync_strava: z.object({}).strict(),
  disconnect_strava: z.object({}).strict(),
};
const descriptions: Record<string, string> = {
  list_plans: 'List the ten most recent running plans.',
  get_plan: 'Read a complete running plan.',
  create_plan: 'Create a running plan using transparent training rules.',
  update_workout: 'Log, skip, or reschedule a workout in a plan.',
  ease_plan:
    'Reduce future planned training by 20 percent and remove intensity. Explicit user choice; the same start date is idempotent.',
  list_activities: 'List the latest 100 activities.',
  log_activity: 'Record a manual activity.',
  export_calendar: 'Export a plan as iCalendar text.',
  export_csv: 'Export a plan as CSV text.',
  strava_status: 'Check whether Strava is configured and connected.',
  sync_strava:
    'Import running activities among the latest 100 Strava activities in the last 90 days.',
  disconnect_strava: 'Forget stored Strava authorization locally. Imported activities remain.',
};
export type ToolName = keyof typeof toolSchemas;
export async function handleMcp(
  raw: unknown,
  call: (name: ToolName, args: unknown) => Promise<unknown>,
) {
  const request = z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.string().max(200), z.number().finite(), z.null()]).optional(),
      method: z.string(),
      params: z.unknown().optional(),
    })
    .safeParse(raw);
  if (!request.success)
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid JSON-RPC request.' },
    };
  const r = request.data;
  if (r.id === undefined) return null;
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: r.id,
    error: { code, message },
  });
  let result: unknown;
  if (r.method === 'initialize') {
    const init = z
      .object({
        protocolVersion: z.string(),
        capabilities: z.object({}).passthrough(),
        clientInfo: z.object({ name: z.string(), version: z.string() }),
      })
      .safeParse(r.params);
    if (!init.success) return fail(-32602, 'Invalid initialize parameters.');
    result = {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'openstride', version: '0.1.0' },
      instructions:
        'Personal running planner. Changes require the runner’s intent. No medical assessment or automatic activity-to-workout matching.',
    };
  } else if (r.method === 'ping') result = {};
  else if (r.method === 'tools/list')
    result = {
      tools: Object.entries(toolSchemas).map(([name, schema]) => ({
        name,
        description: descriptions[name],
        inputSchema: z.toJSONSchema(schema),
      })),
    };
  else if (r.method === 'tools/call') {
    const params = z
      .object({ name: z.string(), arguments: z.unknown().optional() })
      .safeParse(r.params);
    if (!params.success || !Object.hasOwn(toolSchemas, params.data.name))
      return fail(-32602, 'Unknown tool or invalid parameters.');
    const name = params.data.name as ToolName;
    const args = toolSchemas[name].safeParse(params.data.arguments ?? {});
    if (!args.success)
      return fail(
        -32602,
        args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    try {
      result = { content: [{ type: 'text', text: JSON.stringify(await call(name, args.data)) }] };
    } catch {
      console.warn(JSON.stringify({ event: 'mcp_tool_error', tool: name }));
      result = {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Operation failed. Check the plan, inputs, and connection; reload before retrying a change.',
          },
        ],
      };
    }
  } else return fail(-32601, 'Method not found.');
  return { jsonrpc: '2.0', id: r.id, result };
}
