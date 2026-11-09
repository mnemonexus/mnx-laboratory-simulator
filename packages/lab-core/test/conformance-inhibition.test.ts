// Enzyme inhibition types: the same practical classifies whatever kind of inhibitor the catalogue
// declares, because the decision is read from the learner's own fitted Km and Vmax.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const packs = loadAllPacks()
const { catalogue } = Catalogue.build(packs)
const inhibition = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio10-enzyme-inhibition.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value as number

/** The packs with oxamate redeclared as another kind of inhibitor of LDH. */
function catalogueWith(type: string) {
  const copy = structuredClone(packs)
  for (const p of copy) for (const s of p.substances ?? []) if (s.id === 'bio:ldh') s.enzyme!.inhibitors!['bio:oxamate'] = { type: type as 'competitive', ki: '0.04 mM' }
  return Catalogue.build(copy).catalogue
}

describe('conformance: enzyme inhibition', () => {
  it('rehearses for several seeds: oxamate raises Km and leaves Vmax, so it is competitive', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(inhibition, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.run!.decisions.type).toBe('competitive')
      expect(value(r, 'Km-oxamate') / value(r, 'Km-none')).toBeGreaterThan(2.5)
    }
  }, 60000)

  it('reads a non-competitive inhibitor from the same design: Vmax falls, Km stays', () => {
    const r = compile(inhibition, catalogueWith('noncompetitive'), { seed: 1 })
    expect(r.run!.decisions.type).toBe('noncompetitive')
    expect(value(r, 'Vmax-oxamate') / value(r, 'Vmax-none')).toBeLessThan(0.4)
  }, 30000)

  it('reads an uncompetitive inhibitor: both fall', () => {
    const r = compile(inhibition, catalogueWith('uncompetitive'), { seed: 1 })
    expect(r.run!.decisions.type).toBe('uncompetitive')
  }, 30000)
})
