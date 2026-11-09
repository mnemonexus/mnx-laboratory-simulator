// Genetics operations (models/genetics.ts): flies of a true-breeding strain into a vial, flies moved
// from one vial to a fresh one (the progeny once they have emerged, of a phenotype if asked), and the
// flies in a vial etherised and scored under a hand lens.
import { type OpContext, type OpImpl, type OpResult, refId } from './kernel.ts'
import { type Container, type MeasurementRecord } from './state.ts'
import { geneticsOf, genotypeKey, phenotype, sexOf, strainGenotype } from '../models/genetics.ts'

type Params = Record<string, unknown>

function count(ctx: OpContext, value: unknown, name: string): number {
  const n = value === undefined || value === null ? 0 : Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 500) ctx.refuse('BAD-COUNT', `${name} must be a whole number from 0 to 500`)
  return n
}

function vial(ctx: OpContext, ref: unknown, role: string): Container {
  const c = ctx.container(ref, role)
  if (ctx.cat.property(c.equipment, 'flies') !== true) ctx.refuse('NOT-A-VIAL', `${c.label} is not a vial for flies`)
  return c
}

/** Tip flies of a true-breeding strain (females as virgins) into a vial. */
function addFlies(ctx: OpContext, p: Params): OpResult {
  const strainId = refId(p.strain) ?? ''
  const strain = ctx.cat.substances.get(strainId)?.strain
  if (!strain) ctx.refuse('NOT-A-STRAIN', `${strainId} is not a strain of flies`)
  const g = geneticsOf(ctx.cat, strain.species)
  if (!g) ctx.refuse('NO-GENETICS', `${strain.species} has no genetics declared`)
  const c = vial(ctx, p.destination, 'destination')
  if (c.contents.flies && c.contents.flies.species !== strain.species) ctx.refuse('MIXED-SPECIES', `${c.label} holds another species`)
  const females = count(ctx, p.females, 'females')
  const males = count(ctx, p.males, 'males')
  if (females + males === 0) ctx.refuse('NO-FLIES', 'Add at least one fly')
  const f = (c.contents.flies ??= { species: strain.species, adults: {} })
  for (const [sex, n] of [['female', females], ['male', males]] as const) {
    if (!n) continue
    const key = genotypeKey(sex, strainGenotype(g, strain.alleles, sex))
    f.adults[key] = (f.adults[key] ?? 0) + n
  }
  return { facts: { females, males } }
}

/**
 * Move flies to another vial as its adults: the progeny if they have emerged, otherwise the adults;
 * chosen at random, of one phenotype if `phenotype` is given.
 */
function transferFlies(ctx: OpContext, p: Params): OpResult {
  const src = vial(ctx, p.source, 'source')
  const dst = vial(ctx, p.destination, 'destination')
  if (src.id === dst.id) ctx.refuse('SAME-VIAL', 'Move the flies to another vial')
  const f = src.contents.flies
  if (!f) ctx.refuse('NO-FLIES', `${src.label} has no flies`)
  const g = geneticsOf(ctx.cat, f.species)!
  if (dst.contents.flies && dst.contents.flies.species !== f.species) ctx.refuse('MIXED-SPECIES', `${dst.label} holds another species`)
  const from = f.progeny && Object.keys(f.progeny).length ? f.progeny : f.adults
  const want = p.phenotype === undefined || p.phenotype === null ? undefined : String(p.phenotype)
  const d = (dst.contents.flies ??= { species: f.species, adults: {} })
  const rng = ctx.rng('flies')
  const moved: Record<string, number> = { female: 0, male: 0 }
  for (const sex of ['female', 'male'] as const) {
    let n = count(ctx, p[sex === 'female' ? 'females' : 'males'], sex === 'female' ? 'females' : 'males')
    const pool = Object.entries(from).filter(([k, c]) => c > 0 && sexOf(k) === sex && (!want || phenotype(g, k) === want))
    let left = pool.reduce((a, [, c]) => a + c, 0)
    if (n > left) ctx.refuse('NOT-ENOUGH', `${src.label} has only ${left} ${want ? `${want} ` : ''}${sex === 'female' ? 'females' : 'males'}`)
    // Pick one fly at a time at random from those left.
    for (; n > 0; n--) {
      let u = rng.next() * left
      const hit = pool.find(([k]) => (u -= from[k]) < 0) ?? pool[pool.length - 1]
      from[hit[0]] -= 1
      d.adults[hit[0]] = (d.adults[hit[0]] ?? 0) + 1
      left -= 1
      moved[sex] += 1
    }
  }
  return { facts: moved }
}

/** Etherise the flies in a vial (its progeny if they have emerged) and count them by phenotype and sex. */
export function scoreFlies(ctx: OpContext, id: string, c: Container): OpResult {
  const f = c.contents.flies
  if (!f) ctx.refuse('NO-FLIES', `${c.label} has no flies to score`)
  const g = geneticsOf(ctx.cat, f.species)!
  const flies = f.progeny && Object.keys(f.progeny).length ? f.progeny : f.adults
  const counts: Record<string, number> = {}
  const females: Record<string, number> = {}
  const males: Record<string, number> = {}
  for (const [k, n] of Object.entries(flies)) {
    if (!(n > 0)) continue
    const ph = phenotype(g, k)
    counts[ph] = (counts[ph] ?? 0) + n
    const bySex = sexOf(k) === 'female' ? females : males
    bySex[ph] = (bySex[ph] ?? 0) + n
  }
  const total = Object.values(counts).reduce((a, n) => a + n, 0)
  const list = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([ph, n]) => `${n} ${ph}`).join(', ')
  const text = total === 0 ? 'no flies' : `females: ${list(females) || 'none'}; males: ${list(males) || 'none'}`
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { scored: f.progeny ? 'progeny' : 'adults' },
    subject: c.id,
    kind: 'array',
    quantity: 'count',
    unit: 'flies',
    values: counts,
    display: { [c.id]: text },
    flags: {},
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, counts, females, males, total, appearance: text }, facts: { record: record.id, total } }
}

export const GENETICS_OPERATIONS: Record<string, OpImpl> = {
  'core:add-flies': addFlies,
  'core:transfer-flies': transferFlies,
}
