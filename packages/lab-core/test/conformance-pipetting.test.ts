// Pipetting: ranges, viscous liquids and reverse pipetting. A 50 % glycerol solution lags in the
// tip, so forward pipetting delivers short; reverse pipetting does not. A pipette refuses a
// volume outside its range.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { viscosityMPaS } from '../src/models/viscosity.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const pip = readJson(join(PACKAGES, 'pack-core', 'definitions', 'core-pipetting-competency.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number

describe('viscosity', () => {
  it('50 % (v/v) glycerol is several times thicker than water; water is 1 mPa·s', () => {
    const glycerolMol = (0.5 * 1261) / 92.09
    const eta = viscosityMPaS(catalogue, { volumeL: 1, species: { 'core:glycerol': glycerolMol } })
    expect(eta).toBeGreaterThan(6)
    expect(eta).toBeLessThan(10)
    expect(viscosityMPaS(catalogue, { volumeL: 1, species: {} })).toBe(1)
  })
})

describe('conformance: pipetting competency', () => {
  it('rehearses for several seeds: forward glycerol short, reverse accurate, the test within 1 %', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(pip, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(noted(r, 'glycerol-error-%-forward')).toBeLessThan(-2.5)
      expect(Math.abs(noted(r, 'glycerol-error-%-reverse'))).toBeLessThan(1)
    }
  }, 120000)

  it('forward-pipetting the glycerol in the test leaves the mixture outside 1 %', () => {
    const def = structuredClone(pip)
    const test = def.procedure!.steps!.find((s) => s.id === 'test')!
    delete (test.steps!.find((s) => s.id === 't-add-g')!.params as Record<string, unknown>).mode
    const r = compile(def, catalogue, { seed: 1 })
    expect(noted(r, 'test-error-%')).toBeLessThan(-1)
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-test')!.passed).toBe(false)
  }, 60000)

  it('a P20 refuses 150 µL', () => {
    const def = structuredClone(pip)
    const choosing = def.procedure!.steps!.find((s) => s.id === 'choosing')!
    choosing.forEach = { var: 'x', in: "=[['p20', 150]]" }
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.validation.findings.some((f) => f.code === 'ED-V4-STEP-REFUSED' && /range/.test(f.message))).toBe(true)
  }, 60000)
})
