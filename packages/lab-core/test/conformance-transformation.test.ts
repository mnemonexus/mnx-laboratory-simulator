// Growth, genotypes, transformation and plating (spec example 5): the pGLO practical.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const pglo = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio1-pglo-transformation.labx.json')) as ExperimentDefinition
const PLATES = ['plate-lb', 'plate-minus-amp', 'plate-plus-amp', 'plate-plus-ara']

function variant(change: (steps: StepDef[], def: ExperimentDefinition) => void): ExperimentDefinition {
  const def = structuredClone(pglo)
  change(def.procedure!.steps!, def)
  return def
}
const step = (steps: StepDef[], id: string) => steps.find((s) => s.id === id)!

function run(def: ExperimentDefinition, seed = 1) {
  const r = compile(def, catalogue, { seed })
  const env = runEnv(r.run!)
  const colonies = Object.fromEntries(PLATES.map((p) => [p, evaluate(`colonies('${p}')`, env) as number]))
  return { r, env, colonies }
}

describe('conformance: pGLO transformation', () => {
  it('rehearses for several seeds: lawn, clean negative control, ~10³ transformants per µg, glow only with arabinose', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { r, colonies } = run(pglo, seed)
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(colonies['plate-lb']).toBeGreaterThan(5000)
      expect(colonies['plate-minus-amp']).toBe(0)
      for (const p of ['plate-plus-amp', 'plate-plus-ara']) {
        expect(colonies[p]).toBeGreaterThan(80)
        expect(colonies[p]).toBeLessThan(400)
      }
      expect(r.run!.decisions.controls).toBe('selection')
    }
  }, 180000)

  it('the heat shock has an optimum: much shorter or longer shocks give far fewer transformants', () => {
    const ref = run(pglo).colonies['plate-plus-amp']
    const short = run(variant((s) => (step(s, 'shock').params!.duration = '5 s'))).colonies['plate-plus-amp']
    const long = run(variant((s) => (step(s, 'shock').params!.duration = '5 min'))).colonies['plate-plus-amp']
    expect(short).toBeLessThan(ref * 0.25)
    expect(long).toBeLessThan(ref * 0.5)
  })

  it('skipping the incubation on ice leaves little DNA bound', () => {
    const ref = run(pglo).colonies['plate-plus-amp']
    const rushed = run(variant((s) => s.splice(s.findIndex((x) => x.id === 'ice-incubation'), 1))).colonies['plate-plus-amp']
    expect(rushed).toBeLessThan(ref * 0.5)
  })

  it('an unsterilised spreader carries transformants onto the negative control', () => {
    // Spread the +pGLO amp plate first, then the −pGLO amp plate, without flaming in between.
    const def = variant((s) => {
      const plating = step(s, 'plating')
      plating.forEach = { var: 'pair', in: "=[['plus', 'plate-plus-amp'], ['minus', 'plate-minus-amp'], ['minus', 'plate-lb'], ['plus', 'plate-plus-ara']]" }
      plating.steps = [
        { id: 'drop', kind: 'operation', ref: 'core:transfer', params: { source: '=pair[0]', destination: '=pair[1]', volume: '100 uL' } },
        { id: 'spread', kind: 'operation', ref: 'core:spread', params: { plate: '=pair[1]', tool: 'spreader' } },
      ]
    })
    def.equipment!.roles!.push({ id: 'spreader', requires: { class: 'core:cell-spreader' } })
    const { r, colonies } = run(def)
    expect(colonies['plate-minus-amp']).toBeGreaterThan(0)
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-controls')!.passed).toBe(false)
    expect(r.run!.decisions.controls).toBe('contaminated')
  })

  it('an unspread plate cannot be counted properly', () => {
    const def = variant((s) => {
      const plating = step(s, 'plating')
      plating.steps = [{ id: 'drop', kind: 'operation', ref: 'core:transfer', params: { source: '=pair[0]', destination: '=pair[1]', volume: '100 uL' } }]
    })
    const { r } = run(def)
    const rec = r.kernel!.world.measurements.find((m) => m.quantity === 'count' && m.subject === 'plate-plus-amp')!
    expect(rec.flags['plate-plus-amp']).toContain('unspread')
  })

  it('a contaminated broth puts a second kind of colony on the non-selective plate only', () => {
    const def = structuredClone(pglo)
    def.variation = { ...(def.variation ?? {}), faults: [{ id: 'f', probability: 1, apply: { supply: 'lb', truth: { contains: [{ substance: 'micro:bacillus-subtilis', count: '200 CFU/mL' }] } } }] }
    const { env, colonies } = run(def)
    expect(evaluate("strains('plate-lb')", env)).toContain('micro:bacillus-subtilis')
    expect(colonies['plate-minus-amp']).toBe(0)
  })
})

describe('growth in liquid', () => {
  function broth(extra: Array<{ substance: string; conc: string }> = [], temperature = '37 Cel') {
    const w = emptyWorld(1)
    addPlace(w, catalogue, 'inc', 'core:incubator', undefined, temperature)
    addSupply(w, catalogue, { id: 'b', label: 'Broth', container: 'core:conical-tube-15ml', amount: '10 mL', components: [{ substance: 'micro:lb-nutrients', conc: '15 g/L' }, ...extra], populations: [{ substance: 'micro:escherichia-coli-k12', perL: 1e9 }], place: 'inc' })
    w.containers.b.contents.temperatureK = w.places.inc.temperatureK
    return createKernel(catalogue, w)
  }
  const perMl = (k: ReturnType<typeof broth>) => (k.world.containers.b.contents.layers[0].populations!['micro:escherichia-coli-k12'].viable / 10)

  it('doubles about every 20 min at 37 °C and levels off near 2 × 10⁹ per mL', () => {
    const k = broth()
    k.execute({ op: 'core:advance-time', params: { duration: '60 min' } })
    expect(perMl(k) / 1e6).toBeGreaterThan(6)
    expect(perMl(k) / 1e6).toBeLessThan(9)
    k.execute({ op: 'core:advance-time', params: { duration: '24 h' } })
    expect(perMl(k)).toBeGreaterThan(1.8e9)
    expect(perMl(k)).toBeLessThanOrEqual(2e9 * 1.001)
  })

  it('does not grow in the cold, and ampicillin kills cells without the resistance marker', () => {
    const cold = broth([], '4 Cel')
    cold.execute({ op: 'core:advance-time', params: { duration: '2 h' } })
    expect(perMl(cold)).toBeCloseTo(1e6, -3)
    const amp = broth([{ substance: 'micro:ampicillin', conc: '100 mg/L' }])
    amp.execute({ op: 'core:advance-time', params: { duration: '4 h' } })
    expect(perMl(amp)).toBeLessThan(1e4)
  })
})
