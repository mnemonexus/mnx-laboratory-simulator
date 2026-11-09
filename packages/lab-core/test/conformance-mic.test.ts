// The MIC of ampicillin by broth microdilution: a pharmacodynamic antibiotic model (slower growth
// below the MIC, killing above it), two-fold dilutions in a plate, turbidity and a breakpoint.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const mic = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro6-mic-broth-dilution.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)!.value as number
const ampIn = (r: ReturnType<typeof compile>, well: string) => {
  const l = r.kernel!.world.containers[well].contents.layers[0]
  // mg per litre is µg per mL.
  return ((l.species['micro:ampicillin'] ?? 0) * 349.41 * 1000) / l.volumeL
}

describe('conformance: MIC by broth microdilution', () => {
  it('rehearses for several seeds: K-12 within one dilution of 4 µg/mL, strain B resistant', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(mic, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect([2, 4, 8]).toContain(value(r, 'MIC-A'))
      expect(value(r, 'MIC-B')).toBe(256)
      expect(r.run!.decisions.classify).toBe('resistant')
    }
  }, 300000)

  it('without mixing each well, the series is not two-fold', () => {
    const def = structuredClone(mic)
    const rows = def.procedure!.steps!.find((s) => s.id === 'rows')!
    const series = rows.steps!.find((s) => s.id === 'series')!
    series.steps = series.steps!.filter((s) => s.id !== 'mix')
    const good = compile(mic, catalogue, { seed: 1 })
    const bad = compile(def, catalogue, { seed: 1 })
    expect(ampIn(good, 'plate/A5') / 8).toBeCloseTo(1, 1)
    expect(Math.abs(ampIn(bad, 'plate/A5') / 8 - 1)).toBeGreaterThan(0.2)
  }, 180000)
})

describe('antibiotic pharmacodynamics', () => {
  function broth(ampUgPerMl: number, organism = 'micro:escherichia-coli-k12') {
    const w = emptyWorld(1)
    addPlace(w, catalogue, 'inc', 'core:incubator', undefined, '37 Cel')
    addSupply(w, catalogue, { id: 'b', label: 'Broth', container: 'core:conical-tube-15ml', amount: '10 mL', place: 'inc',
      components: [{ substance: 'micro:lb-nutrients', conc: '15 g/L' }, { substance: 'micro:ampicillin', conc: `${ampUgPerMl} mg/L` }],
      populations: [{ substance: organism, perL: 1e9 }] })
    w.containers.b.contents.temperatureK = w.places.inc.temperatureK
    const k = createKernel(catalogue, w)
    k.execute({ op: 'core:advance-time', params: { duration: '2 h' } })
    return k.world.containers.b.contents.layers[0].populations![organism].viable / 10 / 1e6
  }

  it('slows growth below the MIC, holds it near the MIC, and kills above it', () => {
    const none = broth(0)
    const half = broth(2)
    const at = broth(4)
    const double = broth(8)
    expect(none).toBeGreaterThan(50)
    expect(half).toBeLessThan(none)
    expect(half).toBeGreaterThan(1)
    expect(at).toBeGreaterThan(0.5)
    expect(at).toBeLessThan(2)
    expect(double).toBeLessThan(0.5)
  })

  it('a strain with the resistance marker grows as if there were no drug', () => {
    expect(broth(128, 'micro:escherichia-coli-k12-ampr')).toBeCloseTo(broth(0), 0)
  })
})
