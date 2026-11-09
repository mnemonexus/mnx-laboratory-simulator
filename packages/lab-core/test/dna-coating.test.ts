// A non-specific DNA-binding protein that needs a free end and coats the DNA: closed circles are
// not bound, the shift grows with protein to saturation, and the saturated load scales with length.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, emptyWorld } from '../src/kernel/index.ts'
import { dnaComplexes } from '../src/models/dnabinding.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const P = 'molbio:im9-higam'

/** One 20 µL reaction: 10 µg/mL of the DNA and the protein at `um` µM; what binds. */
function bound(dna: string, um: number) {
  const w = emptyWorld(1)
  const c = addSupply(w, cat, { id: 'r', label: 'r', container: 'core:microtube-0.5ml', amount: '20 uL', preparation: 'molbio:phosphate-100mm-ph7',
    components: [{ substance: dna, conc: '10 ug/mL' }, ...(um > 0 ? [{ substance: P, conc: `${um} uM` }] : [])] })
  return dnaComplexes(cat, c.contents).bound[dna]
}

describe('coating a DNA', () => {
  it('closed circles are not bound; linear DNA is, more as the protein rises', () => {
    expect(bound('molbio:puc-phi600', 8)).toBeUndefined()
    const proteins = [0.25, 1, 2, 8].map((um) => bound('molbio:linear-dna-300bp', um)!.proteinDa / 30500)
    for (let i = 1; i < proteins.length; i++) expect(proteins[i]).toBeGreaterThan(proteins[i - 1])
    // 300 bp holds 12 sites of 25 bp: near saturation at 8 µM.
    expect(proteins[3]).toBeGreaterThan(10.5)
    expect(proteins[3]).toBeLessThanOrEqual(12)
  })

  it('at saturation the load scales with length; at low protein some DNA is still free', () => {
    const n300 = bound('molbio:linear-dna-300bp', 8)!.proteinDa / 30500
    const n900 = bound('molbio:linear-dna-900bp', 8)!.proteinDa / 30500
    expect(n900 / n300).toBeCloseTo(3, 0)
    expect(bound('molbio:linear-dna-300bp', 0.02)!.fraction).toBeLessThan(0.5)
  })
})

describe('conformance: end-binding EMSA', () => {
  const emsa = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio11-end-binding-emsa.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(emsa, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('a protein that needed no end would shift the plasmid too', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const s of p.substances ?? []) if (s.id === P && s.dnaBinding) s.dnaBinding.requiresEnds = false
    const { catalogue: open } = Catalogue.build(packs)
    const r = compile(emsa, open, { seed: 1 })
    expect(r.run!.decisions['ends']).toBe('binds')
  }, 180000)
})
