// Disc diffusion: an antibiotic spreading from a disc while the lawn grows (Cooper's model). The
// zones follow each organism's MIC, and the standardisation the method insists on matters: a heavier
// inoculum, deeper agar or a late disc each shrink the zones.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const discs = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro8-disc-diffusion.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const zone = (r: Result, key: string) => r.kernel!.world.notebook.find((e) => e.field === `zone-${key}`)?.value as number
const variant = (edit: (d: ExperimentDefinition) => void, seed = 1) => {
  const def = structuredClone(discs)
  edit(def)
  return compile(def, catalogue, { seed })
}
const sample = (d: ExperimentDefinition, id: string) => d.materials!.samples!.find((s) => s.id === id)!
const reference = compile(discs, catalogue, { seed: 1 })

describe('conformance: disc diffusion', () => {
  it('rehearses for several seeds: control zones in range, the isolate resistant to ampicillin only', () => {
    for (const seed of [1, 2, 3]) {
      const r = seed === 1 ? reference : compile(discs, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.classify).toBe('resistant')
      expect(zone(r, 'iso-amp')).toBe(6)
      expect(zone(r, 'iso-kan')).toBeGreaterThan(17)
    }
  }, 120000)

  it('a ten-fold heavier inoculum establishes the lawn sooner, so every zone is smaller', () => {
    const r = variant((d) => (sample(d, 'ec').contains![0].count = '1.5e9 cells/mL'))
    for (const drug of ['amp', 'tet', 'kan', 'chl']) expect(zone(r, `ec-${drug}`)).toBeLessThan(zone(reference, `ec-${drug}`) - 1)
  }, 60000)

  it('deeper agar spreads the drug through more volume: smaller zones; thinner agar, larger', () => {
    const deep = variant((d) => (d.materials!.supplies!.find((s) => s.id === 'p-ec')!.amount = '35 mL'))
    const thin = variant((d) => (d.materials!.supplies!.find((s) => s.id === 'p-ec')!.amount = '15 mL'))
    // The depth sits inside the logarithm, so the effect is a millimetre or two, not more.
    for (const drug of ['amp', 'tet']) {
      expect(zone(deep, `ec-${drug}`)).toBeLessThanOrEqual(zone(reference, `ec-${drug}`))
      expect(zone(thin, `ec-${drug}`)).toBeGreaterThanOrEqual(zone(reference, `ec-${drug}`))
      expect(zone(thin, `ec-${drug}`)).toBeGreaterThan(zone(deep, `ec-${drug}`) + 1)
    }
  }, 60000)

  it('discs put on two hours after seeding (the lawn already growing) leave smaller zones', () => {
    const r = variant((d) => {
      const steps = d.procedure!.steps!
      steps.splice(steps.findIndex((s) => s.id === 'discs'), 0, { id: 'delay', kind: 'offstage', duration: '2 h', title: 'Plates left in the incubator', params: { place: 'incubator', containers: ['p-ec', 'p-sa', 'p-iso'] } } as never)
    })
    expect(zone(r, 'ec-amp')).toBeLessThan(zone(reference, 'ec-amp') - 2)
    expect(zone(r, 'sa-amp')).toBeLessThan(zone(reference, 'sa-amp') - 2)
  }, 60000)

  it('a resistant minority in the culture grows as colonies inside the ampicillin zone', () => {
    const r = variant((d) => {
      sample(d, 'ec').contains!.push({ substance: 'micro:escherichia-coli-k12-ampr', count: '1e6 cells/mL' })
    })
    const zones = r.kernel!.world.measurements.find((m) => m.subject === 'p-ec' && m.unit === 'mm')!
    expect(zones.display['ec-amp']).toMatch(/colonies inside the zone/)
    expect(zones.display['ec-tet']).not.toMatch(/colonies inside/)
    // The lawn's edge is still the susceptible majority's.
    expect(Math.abs(zone(r, 'ec-amp') - zone(reference, 'ec-amp'))).toBeLessThanOrEqual(1)
  }, 60000)

  it('too light an inoculum gives separate colonies, not a lawn: the zones cannot be read', () => {
    const r = variant((d) => (sample(d, 'ec').contains![0].count = '1e4 cells/mL'))
    const zones = r.kernel!.world.measurements.find((m) => m.subject === 'p-ec' && m.unit === 'mm')!
    expect(zones.flags['p-ec']).toContain('no-lawn')
    expect(zone(r, 'ec-amp')).toBeNull()
  }, 60000)
})
