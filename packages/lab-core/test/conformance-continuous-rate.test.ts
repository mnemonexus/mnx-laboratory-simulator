// Rates from a continuous assay: reactions started and mixed in the cuvette and followed as a
// trace. The rate rises with the substrate but less than in proportion (the concentrations are near
// Km), and replicates agree. Invert an uncovered cuvette and half the reaction is on the bench.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const assay = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio16-continuous-rate-assay.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number
const traces = (r: Result) => r.kernel!.world.measurements.filter((m) => m.kind === 'series')

describe('conformance: continuous rate assay', () => {
  it('rehearses for several seeds: rates rise with the substrate, less than in proportion', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(assay, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      const [m8, m4, m2] = ['0.8', '0.4', '0.2'].map((c) => noted(r, `mean-${c}`))
      expect(m8).toBeGreaterThan(m4)
      expect(m4).toBeGreaterThan(m2)
      // Km is 0.5 mM: doubling from 0.4 to 0.8 mM raises the rate by (0.8/1.3)/(0.4/0.9), about 1.38.
      expect(m8 / m4).toBeGreaterThan(1.2)
      expect(m8 / m4).toBeLessThan(1.6)
      // Twelve kinetic traces of 25 reads each, none flagged.
      expect(traces(r).length).toBe(12)
      expect(traces(r).every((m) => m.times!.length === 25 && Object.keys(m.flags).length === 0)).toBe(true)
    }
  }, 240000)

  it('inverting an uncovered cuvette spills half: the beam reads the meniscus and the rates are noise', () => {
    const def = structuredClone(assay)
    const runs = def.procedure!.steps!.find((s) => s.id === 'runs')!
    runs.steps = runs.steps!.filter((s) => s.id !== 'cover')
    const r = compile(def, catalogue, { seed: 1 })
    expect(traces(r).every((m) => Object.values(m.flags).flat().includes('insufficient-volume'))).toBe(true)
    expect(noted(r, 'sd-0.8')).toBeGreaterThan(0.5 * Math.abs(noted(r, 'mean-0.8')))
  }, 120000)
})
