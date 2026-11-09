// The part of the catalogue the bench tools need: their substances and glassware, plus everything
// those entries refer to (equipment parents, ions, conjugates, waste streams). Hosts that run the
// bench tools without the whole lab embed this slice; the tests prove it gives the same answers as
// the full catalogue.
import type { PackContent } from '../catalogue/types.ts'

/** Acids, bases and indicators a bench scene may name. */
export const BENCH_SUBSTANCES = [
  'core:water',
  'core:hydrochloric-acid', 'core:nitric-acid', 'core:sulfuric-acid',
  'core:sodium-hydroxide', 'core:potassium-hydroxide', 'core:lithium-hydroxide',
  'core:acetic-acid', 'core:sodium-acetate', 'core:potassium-acetate',
  'core:ammonia', 'core:ammonium-chloride',
  'core:potassium-hydrogen-phthalate', 'core:sodium-carbonate', 'core:sodium-bicarbonate', 'core:citric-acid',
  'core:phenolphthalein', 'core:methyl-orange', 'core:bromothymol-blue', 'core:litmus', 'core:universal-indicator',
  'chem:benzoic-acid', 'chem:triethylamine', 'chem:triethylammonium-chloride',
] as const

/** Glassware a bench scene may name. */
export const BENCH_EQUIPMENT = [
  'core:beaker-100ml', 'core:beaker-250ml', 'core:conical-flask-100ml', 'core:conical-flask-250ml',
  'core:burette-50ml-class-a',
  'core:volumetric-pipette-10ml', 'core:volumetric-pipette-25ml', 'core:volumetric-pipette-50ml',
  'core:volumetric-flask-25ml', 'core:volumetric-flask-50ml', 'core:volumetric-flask-100ml', 'core:volumetric-flask-250ml',
] as const

type Entry = { id: string; parent?: string }

function strings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') out.add(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      strings(v, out)
    }
  }
}

/** Packs cut down to the bench entries and their references. Pack manifests are kept whole. */
export function benchPackSlice(packs: readonly PackContent[], keep: { substances?: readonly string[]; equipment?: readonly string[] } = {}): PackContent[] {
  const allSubstances = new Map<string, Entry>()
  const allEquipment = new Map<string, Entry>()
  for (const p of packs) {
    for (const s of (p.substances ?? []) as Entry[]) allSubstances.set(s.id, s)
    for (const e of (p.equipment ?? []) as Entry[]) allEquipment.set(e.id, e)
  }
  const substances = new Set<string>()
  const queue = [...(keep.substances ?? BENCH_SUBSTANCES)]
  while (queue.length) {
    const id = queue.pop()!
    if (substances.has(id) || !allSubstances.has(id)) continue
    substances.add(id)
    const refs = new Set<string>()
    strings(allSubstances.get(id), refs)
    for (const r of refs) if (allSubstances.has(r) && !substances.has(r)) queue.push(r)
  }
  const equipment = new Set<string>()
  for (const id of keep.equipment ?? BENCH_EQUIPMENT) {
    for (let at: string | undefined = id; at && !equipment.has(at) && allEquipment.has(at); at = allEquipment.get(at)!.parent) equipment.add(at)
  }
  return packs.map((p) => {
    const out: Record<string, unknown> = { pack: p.pack }
    const subs = ((p.substances ?? []) as Entry[]).filter((s) => substances.has(s.id))
    const eq = ((p.equipment ?? []) as Entry[]).filter((e) => equipment.has(e.id))
    if (subs.length) out.substances = subs
    if (eq.length) out.equipment = eq
    return out as unknown as PackContent
  })
}
