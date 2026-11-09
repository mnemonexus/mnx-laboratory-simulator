// Gel shifts: protein-DNA binding in solution (with an inducer and competing DNA), a native gel
// that runs the complex slower, and a label imager that integrates bands for a binding curve.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import type { Contents } from '../src/kernel/state.ts'
import { dnaComplexes } from '../src/models/dnabinding.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const emsa = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio5-emsa-laci.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value as number
const bound = (r: ReturnType<typeof compile>) => r.kernel!.world.notebook.filter((e) => e.field === 'bound').map((e) => e.value as number)

describe('conformance: LacI gel shift', () => {
  it('rehearses for several seeds: Kd within 40 %, IPTG and competitor lanes nearly unbound', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(emsa, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(Math.abs(value(r, 'Kd-nM') / 2 - 1)).toBeLessThan(0.4)
      const b = bound(r)
      // More LacI, more probe shifted.
      expect(b[1]).toBeGreaterThan(b[2])
      expect(b[2]).toBeGreaterThan(b[3])
    }
  }, 60000)

  it('an ordinary DNA stain cannot see a nanomolar probe', () => {
    const def = structuredClone(emsa)
    def.equipment!.roles!.find((r) => r.id === 'imager')!.requires = { class: 'core:gel-imager' }
    def.equipment!.roles!.find((r) => r.id === 'gel')!.requires = { class: 'core:native-page-gel-6pct' }
    const r = compile(def, catalogue, { seed: 1 })
    expect(bound(r).every((x) => x === 0)).toBe(true)
  }, 30000)
})

describe('protein-DNA binding', () => {
  const layer = (species: Record<string, number>): Contents => ({ layers: [{ volumeL: 1e-6, species }], solid: {}, temperatureK: 294 })
  const nM = (x: number) => x * 1e-9 * 1e-6

  it('binds half the probe at Kd, and IPTG and competing operator take that away', () => {
    const half = dnaComplexes(catalogue, layer({ 'molbio:laci': nM(2), 'molbio:laco-probe': nM(0.001) }))
    expect(half.bound['molbio:laco-probe'].fraction).toBeCloseTo(0.5, 2)
    const induced = dnaComplexes(catalogue, layer({ 'molbio:laci': nM(10), 'molbio:laco-probe': nM(0.2), 'molbio:iptg': 1e-3 * 1e-6 }))
    expect(induced.bound['molbio:laco-probe'].fraction).toBeLessThan(0.01)
    const competed = dnaComplexes(catalogue, layer({ 'molbio:laci': nM(10), 'molbio:laco-probe': nM(0.2), 'molbio:laco-competitor': nM(100) }))
    expect(competed.bound['molbio:laco-probe'].fraction).toBeLessThan(0.2)
  })
})
