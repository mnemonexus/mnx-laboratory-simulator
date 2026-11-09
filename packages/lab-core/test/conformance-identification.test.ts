// Identifying bacteria: spot tests that read organism markers, a selective and differential
// medium, and a key that ties them to the Gram stain (composes staining, plating and growth).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const ident = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro7-identify-unknown.labx.json')) as ExperimentDefinition
const field = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)?.value

/** The definition with a fixed unknown (no variation). */
function withUnknown(contains: Array<{ substance: string; count: string }>): ExperimentDefinition {
  const def = structuredClone(ident)
  def.materials!.samples![0].contains = contains
  delete def.variation!.params
  return def
}

const PROFILES: Array<[string, string, string, string, string]> = [
  // organism, catalase, oxidase, MacConkey, answer
  ['micro:escherichia-coli-k12', 'positive', 'negative', 'pink', 'e-coli'],
  ['micro:pseudomonas-fluorescens', 'positive', 'positive', 'colourless', 'p-fluorescens'],
  ['micro:staphylococcus-aureus-teaching-strain', 'positive', 'negative', 'none', 's-aureus'],
  ['micro:micrococcus-luteus', 'positive', 'positive', 'none', 'm-luteus'],
  ['micro:lactococcus-lactis', 'negative', 'negative', 'none', 'l-lactis'],
]

describe('conformance: identifying an unknown bacterium', () => {
  it('gives each candidate its own profile, and the key identifies it', () => {
    for (const [organism, catalase, oxidase, mac, answer] of PROFILES) {
      const r = compile(withUnknown([{ substance: organism, count: '5e8 cells/mL' }]), catalogue, { seed: 1 })
      expect(r.rehearsal!.ok).toBe(true)
      expect(field(r, 'catalase')).toBe(catalase)
      expect(field(r, 'oxidase')).toBe(oxidase)
      const plate = String(field(r, 'MacConkey'))
      if (mac === 'none') expect(plate).toBe('no colonies')
      else expect(plate).toContain(mac)
      expect(r.run!.decisions.identify).toBe(answer)
    }
  }, 60000)

  it('a mixed culture gives a patchy oxidase test and two kinds of colony', () => {
    const r = compile(withUnknown([{ substance: 'micro:escherichia-coli-k12', count: '3e8 cells/mL' }, { substance: 'micro:pseudomonas-fluorescens', count: '3e8 cells/mL' }]), catalogue, { seed: 1 })
    expect(field(r, 'oxidase')).toBe('patchy')
    const plate = String(field(r, 'MacConkey'))
    expect(plate).toContain('pink')
    expect(plate).toContain('colourless')
  }, 30000)

  it('MacConkey stops Gram-positives: not a single colony', () => {
    const r = compile(withUnknown([{ substance: 'micro:staphylococcus-aureus-teaching-strain', count: '5e8 cells/mL' }]), catalogue, { seed: 1 })
    expect(evaluate("colonies('mac')", runEnv(r.run!))).toBe(0)
  }, 30000)
})
