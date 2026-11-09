// A centrifugation step in a purification: salting out with ammonium sulfate, a fine precipitate
// that stays suspended until it is spun, a balanced rotor, and recovery checked at 280 nm.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const def0 = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio4-ammonium-sulfate-precipitation.labx.json')) as ExperimentDefinition
const BSA = 'bio:bovine-serum-albumin'

function variant(change: (steps: StepDef[]) => void): ExperimentDefinition {
  const def = structuredClone(def0)
  change(def.procedure!.steps!)
  return def
}
const step = (steps: StepDef[], id: string) => steps.find((s) => s.id === id)!

function recovery(def: ExperimentDefinition, seed = 1) {
  const r = compile(def, catalogue, { seed })
  const env = runEnv(r.run!)
  const mg = (e: string) => (evaluate(e, env) as unknown as { si: number }).si * 1e6
  return { r, pellet: (mg(`mass('ppt', '${BSA}')`) + mg(`mass('c-pellet', '${BSA}')`)) / 2.5, sup: mg(`mass('sup', '${BSA}')`) / 2.5 }
}

describe('conformance: ammonium sulfate precipitation', () => {
  it('rehearses for several seeds: most protein in the pellet, little in the supernatant', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { r, pellet, sup } = recovery(def0, seed)
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(pellet).toBeGreaterThan(0.85)
      expect(sup).toBeLessThan(0.1)
    }
  })

  it('without the spin, the precipitate leaves with the "supernatant"', () => {
    const { pellet, sup } = recovery(variant((s) => s.splice(s.findIndex((x) => x.id === 'spin'), 1)))
    expect(pellet).toBeLessThan(0.2)
    expect(sup).toBeGreaterThan(0.75)
  })

  it('too gentle a spin leaves most of it suspended', () => {
    const { pellet } = recovery(variant((s) => Object.assign(step(s, 'spin').params!, { rcf: '1000 [RCF]', duration: '1 min' })))
    expect(pellet).toBeLessThan(0.5)
  })

  it('too little ammonium sulfate leaves the protein in solution', () => {
    // 333 µL of saturated solution to 500 µL is 40 % saturation.
    const { pellet } = recovery(variant((s) => (step(s, 'precipitate').params!.volume = '333 uL')))
    expect(pellet).toBeLessThan(0.3)
  })

  it('a balance tube of water by volume does not balance a dense salt solution', () => {
    const { r, pellet } = recovery(variant((s) => (step(s, 'load').params!.by = 'volume')))
    expect(r.kernel!.world.incidents.some((i) => i.kind === 'mechanical')).toBe(true)
    expect(pellet).toBeLessThan(0.2)
  })

  it('salting out: soluble in buffer, out of solution at high salt, back in when the salt is diluted', () => {
    const w = emptyWorld(1)
    addSupply(w, catalogue, { id: 't', label: 'BSA', container: 'core:conical-tube-15ml', amount: '1 mL', components: [{ substance: BSA, conc: '5 mg/mL' }] })
    addSupply(w, catalogue, { id: 'as', label: 'AS', container: 'core:conical-tube-15ml', amount: '10 mL', preparation: 'core:ammonium-sulfate-saturated' })
    addSupply(w, catalogue, { id: 'buf', label: 'Buffer', container: 'core:conical-tube-50ml', amount: '40 mL', preparation: 'core:pbs-1x' })
    const k = createKernel(catalogue, w)
    const suspendedMg = () => k.world.containers.t.contents.layers.reduce((a, l) => a + (l.particles?.[BSA] ?? 0), 0) * 66430 * 1000
    k.execute({ op: 'core:mix', params: { container: 't', method: 'vortex' } })
    expect(suspendedMg()).toBe(0)
    k.execute({ op: 'core:transfer', params: { source: 'as', destination: 't', volume: '3 mL', tool: 'pour' } })
    k.execute({ op: 'core:mix', params: { container: 't', method: 'vortex' } })
    expect(suspendedMg()).toBeGreaterThan(4.5)
    k.execute({ op: 'core:transfer', params: { source: 'buf', destination: 't', volume: '10 mL', tool: 'pour' } })
    k.execute({ op: 'core:mix', params: { container: 't', method: 'vortex' } })
    expect(suspendedMg()).toBeLessThan(0.01)
  })
})
