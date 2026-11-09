// Conformance experiment: the BCA practical runs entirely from its definition (roadmap F1 exit).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { createKernel } from '../src/kernel/index.ts'
import { parseValue } from '../src/units/quantity.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import type { CalibrationResult, StoredFit } from '../src/kernel/ops-data.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const bca = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio1-bca-protein-assay.labx.json')) as ExperimentDefinition

const truthOf = (r: ReturnType<typeof compile>, sample: string) => {
  const s = r.definition!.materials!.samples!.find((x) => x.id === sample)!
  return parseValue(String(s.contains![0].conc)).si
}
const results = (r: ReturnType<typeof compile>, step: string) => (r.run!.outputs[step]?.results ?? []) as CalibrationResult[]

describe('conformance: BCA protein assay', () => {
  it('validates at V1–V3 without findings', () => {
    const r = compile(bca, catalogue, { rehearse: false })
    expect(r.validation.findings.filter((f) => f.severity !== 'info')).toEqual([])
    expect(r.coverage!.verdict).toBe('fully-supported')
  })

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`rehearses to the right answers (seed ${seed})`, () => {
      const r = compile(bca, catalogue, { seed })
      expect(r.rehearsal!.issues).toEqual([])
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.refusals).toBe(0)
      expect(r.rehearsal!.decisions['range-check']).toBe('dilute')
      expect(r.rehearsal!.validity).toBe('valid')
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.rehearsal!.quality.filter((q) => !q.passed)).toEqual([])
      const u1 = results(r, 'analyse').find((x) => x.group === 'u1')!
      expect(u1.inRange).toBe(true)
      expect(Math.abs(u1.x - truthOf(r, 'u1')) / truthOf(r, 'u1')).toBeLessThan(0.05)
      const u2first = results(r, 'analyse').find((x) => x.group === 'u2')!
      expect(u2first.inRange).toBe(false)
      const u2 = results(r, 'ra').find((x) => x.group === 'u2-diluted')!
      expect(u2.inRange).toBe(true)
      expect(u2.factor).toBe(4)
      expect(Math.abs(u2.x - truthOf(r, 'u2')) / truthOf(r, 'u2')).toBeLessThan(0.05)
      // Copper waste went to the heavy-metal stream.
      expect(r.kernel!.world.disposals.every((d) => d.stream === 'core:chemical-waste.heavy-metal')).toBe(true)
      expect(r.kernel!.world.disposals.length).toBe(2)
    })
  }

  it('is deterministic per seed and replays from its event log', () => {
    const a = compile(bca, catalogue, { seed: 11 })
    const b = compile(bca, catalogue, { seed: 11 })
    expect(a.kernel!.world).toEqual(b.kernel!.world)
    expect(a.rehearsal!.sampled).toEqual(b.rehearsal!.sampled)
    const replay = createKernel(catalogue, a.world!, a.kernel!.options)
    for (const intent of a.kernel!.log()) expect(replay.execute(intent).ok).toBe(true)
    expect(replay.world).toEqual(a.kernel!.world)
    const c = compile(bca, catalogue, { seed: 12 })
    expect(c.rehearsal!.sampled).not.toEqual(a.rehearsal!.sampled)
  }, 120000)

  it('without blanks, the validity verdict is capped', () => {
    const noBlanks = structuredClone(bca)
    const map = noBlanks.procedure!.steps!.find((s) => s.id === 'plate-map')!
    map.params!.blanks = 0
    const rmap = noBlanks.procedure!.steps!.find((s) => s.id === 'rework')!.steps!.find((s) => s.id === 'rmap')!
    rmap.params!.blanks = 0
    const r = compile(noBlanks, catalogue, { seed: 2 })
    expect(r.rehearsal!.validity).toBe('partially-interpretable')
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-valid')!.passed).toBe(false)
  })

  it('an old working reagent flattens the curve, and the standards still calibrate it out', () => {
    const fresh = compile(bca, catalogue, { seed: 4, realism: 'ideal' })
    const old = structuredClone(bca)
    old.variation!.faults![0].probability = 1
    const aged = compile(old, catalogue, { seed: 4, realism: 'ideal' })
    expect(aged.rehearsal!.sampled['fault:f-old-reagent']).toBe(true)
    const slope = (r: ReturnType<typeof compile>) => (r.run!.outputs.analyse.fit as StoredFit).params.b
    expect(slope(aged) / slope(fresh)).toBeGreaterThan(0.5)
    expect(slope(aged) / slope(fresh)).toBeLessThan(0.75)
    const u1 = results(aged, 'analyse').find((x) => x.group === 'u1')!
    expect(Math.abs(u1.x - truthOf(aged, 'u1')) / truthOf(aged, 'u1')).toBeLessThan(0.05)
  })
})
