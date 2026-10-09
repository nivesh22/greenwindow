import { z } from 'zod'
import { DEVICES_DATA as devicesJson } from './devices.js'
import { defineTool, type ToolCtx } from './registry.js'

const deviceSchema = z.object({
  id: z.string(),
  category: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  kw: z.number().positive().optional(),
  tdp_w: z.number().positive().optional(),
  typical_hours: z.number().positive().nullable().optional(),
  source: z.string().min(1),
  assumed: z.literal(true),
})
const tableSchema = z.object({
  version: z.literal(1),
  pue_default: z.number().positive(),
  gpu_host_overhead_kw_per_8: z.number().nonnegative(),
  devices: z.array(deviceSchema),
})
export const DEVICES = tableSchema.parse(devicesJson)

const STOP = new Set(['my', 'the', 'a', 'an', 'of', 'for', 'to', 'i', 'want', 'run', 'nvidia', 'geforce'])

/** Lowercase tokens, letters and digits split apart ("7kw" -> "7", "kw"), light plural stripping, stop words dropped. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
}

type Device = z.infer<typeof deviceSchema>

/** Share of the query's tokens found in the device's name/aliases/id; the best alias or the name wins. */
export function score(query: string, d: Device): number {
  const q = tokens(query)
  if (q.length === 0) return 0
  let best = 0
  for (const text of [d.name, d.id, ...d.aliases]) {
    const t = new Set(tokens(text))
    const hit = q.filter((x) => t.has(x)).length / q.length
    // Prefer the tighter text on ties so "h100 pcie" picks the PCIe card over SXM.
    const tight = hit > 0 ? hit - t.size * 0.001 : 0
    best = Math.max(best, tight)
  }
  return best
}

function rank(query: string, pool: Device[]): Device[] {
  return pool
    .map((d) => ({ d, s: score(query, d) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.d)
}

const matchSchema = z.object({
  id: z.string(),
  name: z.string(),
  kw: z.number(),
  typical_hours: z.number().nullable(),
  source: z.string(),
  /** false only for the signed-in user's own saved device (P3 profile), which is not an assumption. */
  assumed: z.boolean(),
})

/** The signed-in user's saved devices that match the query (best first), as lookup matches. */
async function savedMatches(ctx: ToolCtx, query: string): Promise<z.infer<typeof matchSchema>[]> {
  if (!ctx.users || !ctx.userId || ctx.isAnonymous) return []
  let devices
  try {
    devices = await ctx.users.listDevices(ctx.userId)
  } catch {
    return [] // memory is best effort; fall back to the typical values
  }
  const q = tokens(query)
  if (q.length === 0) return []
  return devices
    .map((d) => {
      const t = new Set(tokens(d.name))
      return { d, s: q.filter((x) => t.has(x)).length / q.length }
    })
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ d }) => ({ id: `saved:${d.id}`, name: d.name, kw: d.kw, typical_hours: d.typicalHours, source: 'your saved device', assumed: false }))
}

export const lookupDevice = defineTool({
  name: 'lookup_device',
  description:
    'Looks up typical power draw (kW) and run length for a household device or a GPU/server, so you can fill in power_kw and duration_h. ' +
    'Pass either {query} (e.g. "dishwasher", "EV charger") or {gpu:{type,count}} (e.g. H100 x 8). All figures are assumed typical values with a stated source; ' +
    'tell the user they are assumptions and let them override. For a signed-in user, their own saved devices come first with ' +
    'assumed: false and source "your saved device": use those values and do not call them assumptions.',
  input: z.strictObject({
    query: z.string().min(1).max(100).optional(),
    gpu: z.strictObject({ type: z.string().min(1).max(60), count: z.number().int().min(1).max(1024) }).optional(),
  }).refine((v) => (v.query === undefined) !== (v.gpu === undefined), { message: 'Provide exactly one of query or gpu.' }),
  output: z.object({ matches: z.array(matchSchema) }),
  auth: 'anon',
  sideEffect: false,
  phase: 'P1',
  intents: 'all',
  statusText: 'Looking up the device…',
  async handler(ctx, input) {
    const pue = DEVICES.pue_default
    if (input.gpu) {
      const { type, count } = input.gpu
      const matches = rank(type, DEVICES.devices.filter((d) => d.category === 'gpu')).map((d) => {
        const kw = (count * (d.tdp_w ?? 0) * pue) / 1000 + DEVICES.gpu_host_overhead_kw_per_8 * Math.ceil(count / 8)
        return {
          id: d.id,
          name: `${count} x ${d.name}`,
          kw,
          typical_hours: null,
          source: `${d.source}; PUE ${pue} and ${DEVICES.gpu_host_overhead_kw_per_8} kW host overhead per 8 GPUs (assumed)`,
          assumed: true as const,
        }
      })
      return { matches }
    }
    const saved = await savedMatches(ctx, input.query ?? '')
    const typical = rank(input.query ?? '', DEVICES.devices).map((d) => ({
      id: d.id,
      name: d.category === 'gpu' ? `${d.name} (1 GPU, including PUE ${pue})` : d.name,
      kw: d.category === 'gpu' ? ((d.tdp_w ?? 0) * pue) / 1000 : (d.kw ?? 0),
      typical_hours: d.typical_hours ?? null,
      source: d.source,
      assumed: true as const,
    }))
    return { matches: [...saved, ...typical].slice(0, 3) }
  },
})
