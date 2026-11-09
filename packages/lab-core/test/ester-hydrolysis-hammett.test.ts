// Base-catalysed hydrolysis of 4-nitrophenyl benzoates: a reaction that goes as [OH⁻] from the pH,
// a first-order fit of a kinetic trace, and a Hammett study whose ρ comes from the simulated rates.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { fitFirstOrder } from '../src/analysis/analysis.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { createRng } from '../src/rng/rng.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

describe('a first-order fit', () => {
  it('recovers k, the end value and the amplitude from a noisy rise', () => {
    const rng = createRng('fit')
    const t = Array.from({ length: 61 }, (_, i) => i * 5)
    const y = t.map((x) => 0.5 - 0.48 * Math.exp(-0.012 * x) + rng.normal(0, 0.003))
    const f = fitFirstOrder(t, y)
    expect(f.k).toBeCloseTo(0.012, 3)
    expect(f.b).toBeCloseTo(0.5, 1)
    expect(f.c).toBeCloseTo(0.48, 1)
    expect(f.seK).toBeLessThan(0.001)
    expect(f.r2).toBeGreaterThan(0.99)
  })
})

describe('hydroxide-catalysed hydrolysis', () => {
  /** 4-Nitrophenolate released (mol/L) after `s` seconds from 30 µM ester with the given NaOH. */
  function released(naohM: number, s: number) {
    const w = emptyWorld(1)
    addSupply(w, cat, { id: 'c', label: 'c', container: 'core:cuvette-ps-macro-1cm', amount: '3 mL', preparation: 'chem:acetone-water-50',
      components: [{ substance: 'chem:4-nitrophenyl-benzoate', conc: '30 uM' }, ...(naohM > 0 ? [{ substance: 'core:sodium-hydroxide', conc: `${naohM} M` }] : [])] })
    const k = createKernel(cat, w)
    k.execute({ op: 'core:advance-time', params: { duration: `${s} s` } })
    const l = k.world.containers.c.contents.layers[0]
    return (l.species['bio:p-nitrophenol'] ?? 0) / l.volumeL
  }

  it('goes as [OH⁻]: ten times the base, ten times the initial rate; none at neutral pH', () => {
    const slow = released(0.001, 20)
    const fast = released(0.01, 20)
    expect(fast / slow).toBeGreaterThan(8)
    expect(fast / slow).toBeLessThan(11)
    expect(released(0, 600)).toBeLessThan(1e-9)
    // About 0.6 M⁻¹ s⁻¹: at 10 mM, kobs 0.006 s⁻¹, so a fifth of the ester in about 40 s.
    expect(released(0.01, 40) / 30e-6).toBeGreaterThan(0.17)
    expect(released(0.01, 40) / 30e-6).toBeLessThan(0.25)
  })
})

describe('conformance: a Hammett plot from ester hydrolysis', () => {
  const def = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem15-hammett-ester-hydrolysis.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 900000)

  it('esters that all reacted alike would give ρ near zero', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const m of p.models ?? []) if (m.id.startsWith('chem:nbe-hydrolysis') && m.reaction) m.reaction.k = 0.6
    const { catalogue: flat } = Catalogue.build(packs)
    expect(compile(def, flat, { seed: 1 }).run!.decisions['sign']).toBe('no-charge')
  }, 600000)
})
