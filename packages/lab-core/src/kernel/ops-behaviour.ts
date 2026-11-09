// Choice-chamber operations (models/behaviour.ts): set each side's conditions, put animals in the
// middle, and count them on each side.
import { type OpContext, type OpImpl, type OpResult, refId } from './kernel.ts'
import { type Chamber, type Container, type MeasurementRecord } from './state.ts'

type Params = Record<string, unknown>

function chamberOf(ctx: OpContext, ref: unknown): { c: Container; chamber: Chamber } {
  const c = ctx.container(ref, 'chamber')
  if (ctx.cat.property(c.equipment, 'choiceChamber') !== true) ctx.refuse('NOT-A-CHAMBER', `${c.label} is not a choice chamber`)
  const chamber = (c.contents.chamber ??= { sides: [{}, {}], animals: {} })
  return { c, chamber }
}

/** Set one side: silica gel (dry) or damp paper (humid) under the gauze, a black cover (dark) or none (light). */
function setChamber(ctx: OpContext, p: Params): OpResult {
  const { chamber } = chamberOf(ctx, p.chamber)
  const side = Number(p.side)
  if (side !== 1 && side !== 2) ctx.refuse('BAD-SIDE', 'A choice chamber has sides 1 and 2')
  const s = chamber.sides[side - 1]
  if (p.humidity !== undefined) s.humidity = p.humidity === 'humid' ? 'humid' : 'dry'
  if (p.light !== undefined) s.light = p.light === 'dark' ? 'dark' : 'light'
  return { facts: { side, ...s } }
}

/** Put animals in through the centre hole: they land on either side at random. */
function addAnimals(ctx: OpContext, p: Params): OpResult {
  const { chamber } = chamberOf(ctx, p.chamber)
  const organism = refId(p.organism) ?? ''
  if (!ctx.cat.substances.get(organism)?.taxis) ctx.refuse('NOT-AN-ANIMAL', `${organism} is not an animal for a choice chamber`)
  const n = Number(p.count)
  if (!Number.isInteger(n) || n < 1 || n > 100) ctx.refuse('BAD-COUNT', 'Put in 1 to 100 animals')
  const left = ctx.rng('chamber').binomial(n, 0.5)
  const counts = (chamber.animals[organism] ??= [0, 0])
  counts[0] += left
  counts[1] += n - left
  return { facts: { side1: left, side2: n - left } }
}

/** Count the animals on each side of a choice chamber. */
export function countChamberAnimals(ctx: OpContext, id: string, c: Container): OpResult {
  const chamber = c.contents.chamber!
  const side1: Record<string, number> = {}
  const side2: Record<string, number> = {}
  for (const [organism, [a, b]] of Object.entries(chamber.animals)) {
    const name = ctx.cat.substances.get(organism)?.identity.name ?? organism
    side1[name] = a
    side2[name] = b
  }
  const total1 = Object.values(side1).reduce((x, y) => x + y, 0)
  const total2 = Object.values(side2).reduce((x, y) => x + y, 0)
  const text = `side 1: ${total1}, side 2: ${total2}`
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'array',
    quantity: 'count',
    unit: 'animals',
    values: { 'side 1': total1, 'side 2': total2 },
    display: { [c.id]: text },
    flags: {},
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, side1: total1, side2: total2, appearance: text }, facts: { record: record.id } }
}

export const BEHAVIOUR_OPERATIONS: Record<string, OpImpl> = {
  'core:set-chamber': setChamber,
  'core:add-animals': addAnimals,
}
