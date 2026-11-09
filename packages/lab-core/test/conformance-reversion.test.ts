// Conformance: the reversion (Ames) test with two tester strains, two coded compounds and a dose
// series. Consequences: a compound acting by the other kind of mutation is classified the other
// way; top agar without its trace of histidine leaves the mutagens nothing to act on.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const def = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro17-reversion-mutagens.labx.json')) as ExperimentDefinition

describe('conformance: reversion test', () => {
  it('rehearses for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 600000)

  it('a compound that caused frameshifts would revert TA1538 instead', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const s of p.substances ?? []) if (s.id === 'micro:sodium-azide' && s.mutagen) s.mutagen.potency = { frameshift: 5e-8 }
    const { catalogue: swapped } = Catalogue.build(packs)
    const r = compile(def, swapped, { seed: 1 })
    expect(r.run!.decisions['what-y']).toBe('frameshift')
  }, 300000)

  it('without histidine in the top agar the cells cannot divide, and nothing is induced', () => {
    const plain = JSON.parse(JSON.stringify(def).replaceAll('micro:minimal-top-agar', 'micro:soft-agar')) as ExperimentDefinition
    const r = compile(plain, cat, { seed: 1 })
    expect(r.run!.decisions['what-x']).toBe('neither')
    expect(r.run!.decisions['what-y']).toBe('neither')
  }, 300000)
})
