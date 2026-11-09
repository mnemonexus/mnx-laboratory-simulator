// Ion exchange on a charged gel-filtration matrix: ionic strength from a buffer's ions, a protein
// held at low salt below its pI and released by a salt step, an anion pushed out of the pores, the
// plain size-exclusion columns untouched; and the colour a solution shows.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { ionicStrength } from '../src/models/acidbase.ts'
import { perceivedColour } from '../src/models/measurement.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

describe('ionic strength', () => {
  it('counts each ion by its charge squared', () => {
    const I = (components: Array<{ substance: string; conc: string }>, preparation?: string) => {
      const w = emptyWorld(1)
      const c = addSupply(w, cat, { id: 'b', label: 'b', container: 'core:conical-tube-50ml', amount: '10 mL', ...(preparation ? { preparation } : {}), components })
      return ionicStrength(cat, c.contents.layers[0], 298)
    }
    expect(I([{ substance: 'core:sodium-chloride', conc: '150 mM' }])).toBeCloseTo(0.15, 3)
    expect(I([{ substance: 'core:magnesium-chloride', conc: '100 mM' }])).toBeCloseTo(0.3, 3)
    expect(I([], 'bio:koac-0.1m-ph6')).toBeCloseTo(0.1, 2)
    expect(I([], 'bio:koac-1m-ph6')).toBeCloseTo(1, 1)
    // Carbonate is a dianion: 1 M of the pH 11 buffer is about 2.6 M.
    expect(I([], 'bio:carbonate-1m-ph11')).toBeGreaterThan(2.3)
  })
})

describe('a CM-Sephadex column', () => {
  const MIX = [{ substance: 'bio:blue-dextran', conc: '2 mg/mL' }, { substance: 'bio:cytochrome-c', conc: '3 mg/mL' }, { substance: 'bio:dnp-glycine', conc: '0.5 mg/mL' }]
  /** Where each solute leaves (mL of buffer after loading, the centre of its band), switching buffers after `switchMl`. */
  function centres(first: string, then?: string, switchMl = 99, column = 'core:cm-sephadex-pasteur-column') {
    const w = emptyWorld(1)
    addSupply(w, cat, { id: 'mix', label: 'mix', container: 'core:microtube-1.5ml', amount: '0.5 mL', preparation: 'core:water-deionised', components: MIX })
    for (const [id, prep] of [['a', first], ['b', then ?? first]]) addSupply(w, cat, { id, label: id, container: 'core:conical-tube-50ml', amount: '45 mL', preparation: prep })
    const k = createKernel(cat, w)
    run(k, 'core:fetch', { equipment: column, id: 'col' })
    run(k, 'core:fetch', { equipment: 'core:beaker-100ml', id: 'waste' })
    run(k, 'core:elute', { column: 'col', buffer: 'a', into: 'waste', volume: '1 mL' })
    run(k, 'core:transfer', { source: 'mix', destination: 'col', volume: '200 uL' })
    const out: Record<string, number> = {}
    const seen: Record<string, number> = {}
    for (let i = 0; i < 60; i++) {
      run(k, 'core:fetch', { equipment: 'core:microtube-1.5ml', id: `f${i}` })
      run(k, 'core:elute', { column: 'col', buffer: (i + 1) * 0.25 > switchMl ? 'b' : 'a', into: `f${i}`, volume: '0.25 mL' })
      for (const [s, n] of Object.entries(k.world.containers[`f${i}`].contents.layers[0].species)) {
        if (!MIX.some((m) => m.substance === s)) continue
        out[s] = (out[s] ?? 0) + n * (i + 0.5) * 0.25
        seen[s] = (seen[s] ?? 0) + n
      }
    }
    // A solute of which less than 1 % came off has no centre.
    const total = (s: string) => k.world.containers.col.contents.column!.loaded[s]
    return Object.fromEntries(Object.entries(out).map(([s, v]) => [s.split(':')[1], seen[s] > 0.01 * total(s) ? v / seen[s] : NaN]))
  }

  it('sieves by size in a strong buffer: largest first', () => {
    const c = centres('bio:carbonate-1m-ph11')
    expect(c['blue-dextran']).toBeLessThan(c['cytochrome-c'])
    expect(c['cytochrome-c']).toBeLessThan(c['dnp-glycine'])
  })

  it('holds cytochrome c in a weak buffer below its pI, until a salt step releases it about a bed volume later', () => {
    const held = centres('bio:koac-0.1m-ph6')
    expect(held['cytochrome-c']).toBeNaN()
    const stepped = centres('bio:koac-0.1m-ph6', 'bio:koac-1m-ph6', 4)
    expect(stepped['cytochrome-c']).toBeGreaterThan(5)
    expect(stepped['cytochrome-c']).toBeLessThan(7.5)
    // The anion is pushed out of the beads' pores at low salt: it leaves sooner than by size alone.
    expect(stepped['dnp-glycine']).toBeLessThan(centres('bio:carbonate-1m-ph11')['dnp-glycine'] - 0.3)
  })

  it('above its pI the protein is not held, even at low salt', () => {
    const c = centres('bio:carbonate-0.05m-ph11')
    expect(c['cytochrome-c']).toBeLessThan(2)
  })
})

describe('the colour of a solution', () => {
  const colour = (components: Array<{ substance: string; conc: string }>, preparation = 'core:water-deionised') => {
    const w = emptyWorld(1)
    return perceivedColour(cat, addSupply(w, cat, { id: 't', label: 't', container: 'core:microtube-1.5ml', amount: '1 mL', preparation, components }))
  }
  it('names what a tube of it looks like', () => {
    expect(colour([])).toBeUndefined()
    expect(colour([{ substance: 'bio:blue-dextran', conc: '0.5 mg/mL' }])).toMatch(/blue/)
    expect(colour([{ substance: 'bio:dnp-glycine', conc: '0.1 mg/mL' }])).toMatch(/yellow/)
    expect(colour([{ substance: 'bio:cytochrome-c', conc: '1 mg/mL' }])).toMatch(/red|orange/)
    expect(colour([{ substance: 'bio:blue-dextran', conc: '1 mg/mL' }, { substance: 'bio:cytochrome-c', conc: '1 mg/mL' }])).toMatch(/brown/)
  })

  it('shows in the visual inspection of a tube', () => {
    const w = emptyWorld(1)
    addEquipment(w, cat, 'eye', 'core:visual-inspection')
    addSupply(w, cat, { id: 't', label: 't', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised', components: [{ substance: 'bio:dnp-glycine', conc: '0.1 mg/mL' }] })
    addSupply(w, cat, { id: 'w', label: 'w', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised' })
    const k = createKernel(cat, w)
    expect((run(k, 'core:measure', { instrument: 'eye', subject: 't' }).outputs as { appearance: string }).appearance).toMatch(/^clear, .*yellow/)
    expect((run(k, 'core:measure', { instrument: 'eye', subject: 'w' }).outputs as { appearance: string }).appearance).toBe('clear')
  })
})

describe('conformance: charge, salt and pH on a cation exchanger', () => {
  const def = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio21-charge-salt-and-ph-columns.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('a protein with an acidic pI would run straight through at pH 6', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const s of p.substances ?? []) if (s.id === 'bio:cytochrome-c' && s.protein) s.protein.pI = 5
    const { catalogue: acidic } = Catalogue.build(packs)
    expect(compile(def, acidic, { seed: 1 }).run!.decisions['step-q']).toBe('size')
  }, 300000)
})
