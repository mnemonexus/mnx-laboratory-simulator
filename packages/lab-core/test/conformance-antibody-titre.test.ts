// Antibody titres by indirect ELISA: the donkey anti-goat peroxidase turns over ABTS (green) as well
// as TMB; an immunisation course read by end-point titres; and unblocked wells that collect serum IgG.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const def = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio20-antibody-titre-course.labx.json')) as ExperimentDefinition

describe('the peroxidase conjugate', () => {
  it('turns over ABTS to the green radical and TMB to its blue product', () => {
    for (const [prep, product] of [['bio:abts-substrate', 'bio:abts-radical'], ['bio:tmb-substrate', 'bio:tmb-oxidised']] as const) {
      const w = emptyWorld(1)
      addSupply(w, cat, { id: 'well', label: 'well', container: 'core:microtube-1.5ml', amount: '100 uL', preparation: prep, components: [{ substance: 'bio:donkey-anti-goat-hrp', conc: '0.05 mg/L' }] })
      const k = createKernel(cat, w)
      const r = k.execute({ op: 'core:advance-time', params: { duration: '5 min' } })
      expect(r.ok).toBe(true)
      expect(k.world.containers.well.contents.layers[0].species[product] ?? 0).toBeGreaterThan(1e-12)
    }
  })
})

describe('conformance: an immunisation course by ELISA', () => {
  it('rehearses for several seeds', () => {
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 600000)

  it('blocked like the rest, the last two columns show no extra background', () => {
    const blocked = JSON.parse(JSON.stringify(def)) as ExperimentDefinition
    const steps = blocked.procedure!.steps!
    const block = steps.find((s) => s.id === 'block')!
    const plain = steps.find((s) => s.id === 'diluent-plain')!
    const all = (s: { params?: Record<string, unknown> }) => String(s.params!.into)
    block.params!.into = all(steps.find((s) => s.id === 'coat')!)
    plain.params!.reagent = 'assay'
    expect(compile(blocked, cat, { seed: 1 }).run!.decisions['unblocked-q']).toBe('same')
  }, 300000)
})
