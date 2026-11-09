// PCR and agarose gel electrophoresis: amplification from the program and the reagents, bands
// placed by length, sizing against a ladder with the ordinary fit and interpolate operations.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { mobility } from '../src/models/electrophoresis.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const pcr = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio2-pcr-gel.labx.json')) as ExperimentDefinition

function variant(change: (steps: StepDef[], def: ExperimentDefinition) => void): ExperimentDefinition {
  const def = structuredClone(pcr)
  change(def.procedure!.steps!, def)
  return def
}
const step = (steps: StepDef[], id: string) => steps.find((s) => s.id === id)!

function run(def: ExperimentDefinition, seed = 1) {
  const r = compile(def, catalogue, { seed })
  const env = runEnv(r.run!)
  const bands = (lane: string) => (evaluate(`map(bandsIn('${lane}'), value(it, 'mm'))`, env) as number[])
  const image = r.kernel!.world.measurements.find((m) => m.bands)
  return { r, env, bands, image }
}

describe('conformance: PCR and gel', () => {
  it('rehearses for several seeds and sizes the product within 5 %', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { r } = run(pcr, seed)
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      const size = (r.kernel!.world.notebook.find((e) => e.field === 'band-size')!.value as number[])[0]
      expect(Math.abs(size / 720 - 1)).toBeLessThan(0.05)
      expect(r.run!.decisions.verdict).toBe('worked')
    }
  })

  it('annealing well above the primers’ Tm gives no product', () => {
    const { r, bands } = run(variant((s) => (step(s, 'amplify').params!.annealTemperature = '70 Cel')))
    expect(bands('gel/A2')).toEqual([])
    expect(r.run!.decisions.verdict).toBe('failed')
  })

  it('annealing far too cold makes primer-dimers, even without template', () => {
    const { bands } = run(variant((s) => (step(s, 'amplify').params!.annealTemperature = '42 Cel')))
    const ntc = bands('gel/A3')
    expect(ntc.length).toBe(1)
    // A 50 bp band runs near the front, far below the 720 bp product.
    expect(ntc[0]).toBeGreaterThan(55)
  })

  it('a carried-over product contaminates the no-template control', () => {
    const def = structuredClone(pcr)
    def.variation = { ...(def.variation ?? {}), faults: [{ id: 'carry-over', probability: 1, apply: { supply: 'water', truth: { contains: [{ substance: 'molbio:gfp-amplicon', conc: '0.000001 ng/uL' }] } } }] }
    const { r, bands } = run(def)
    expect(bands('gel/A3').length).toBe(1)
    expect(Math.abs(bands('gel/A3')[0] - bands('gel/A2')[0])).toBeLessThan(1)
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-clean')!.passed).toBe(false)
    expect(r.run!.decisions.verdict).toBe('contaminated')
  })

  it('without loading dye the samples float out of the wells', () => {
    const { image } = run(variant((s) => s.splice(s.findIndex((x) => x.id === 'add-dye'), 1)))
    const lane2 = image!.bands!.filter((b) => b.lane === 'gel/A2')
    expect(lane2.every((b) => b.intensity === 'faint' || b.intensity === 'clear')).toBe(true)
    // The ladder comes in its own dye and is unaffected.
    expect(image!.bands!.filter((b) => b.lane === 'gel/A1').length).toBe(12)
  })

  it('leads the wrong way round run everything out of the wells; too long a run loses the small bands', () => {
    const reversed = run(variant((s) => (step(s, 'electrophoresis').params!.voltage = -100)))
    expect(reversed.image!.bands).toEqual([])
    const overrun = run(variant((s) => (step(s, 'electrophoresis').params!.duration = '120 min')))
    expect(overrun.bands('gel/A1').length).toBeLessThan(12)
  })

  it('too short an extension makes too little product to see', () => {
    const { bands, env } = run(variant((s) => (step(s, 'amplify').params!.extendTime = '5 s')))
    expect(bands('gel/A2')).toEqual([])
    expect(evaluate("amplified('pcr', 'molbio:gfp-amplicon')", env) as number).toBeGreaterThan(0)
  })

  it('mobility falls with the log of length, and a 2 % gel resolves small fragments better', () => {
    expect(mobility(100, 1)).toBeGreaterThan(mobility(1000, 1))
    expect(mobility(1000, 1)).toBeGreaterThan(mobility(10000, 1))
    const spread = (pct: number) => mobility(100, pct) - mobility(200, pct)
    expect(spread(2)).toBeGreaterThan(spread(1))
  })
})
