// PCR-RFLP genotyping: allele-specific PCR products, a restriction site present in one allele
// only, and a gel that must resolve 177 from 221 bp (composes PCR, digestion and electrophoresis).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const rflp = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio4-pcr-rflp-genotyping.labx.json')) as ExperimentDefinition
const bands = (r: ReturnType<typeof compile>, lane: string) => (evaluate(`bandsIn('${lane}')`, runEnv(r.run!)) as unknown[]).length

describe('conformance: PCR-RFLP genotyping', () => {
  it('rehearses for several seeds: heterozygote, non-taster and taster called correctly', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(rflp, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions).toMatchObject({ 'genotype:a': 'pa', 'genotype:b': 'aa', 'genotype:c': 'pp' })
    }
  }, 60000)

  it('on a 1 % gel, a run long enough to part 177 from 221 bp sends the 44 bp piece off the end: the heterozygote is misread', () => {
    const def = structuredClone(rflp)
    def.equipment!.roles!.find((r) => r.id === 'gel')!.requires = { class: 'core:agarose-gel-1pct' }
    const gel = def.procedure!.steps!.find((s) => s.id === 'electrophoresis')!
    gel.params = { ...gel.params, duration: '90 min' }
    const r = compile(def, catalogue, { seed: 1 })
    expect(bands(r, 'gel/A3')).toBeLessThan(3)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
  }, 30000)

  it('without the enzyme every product stays 221 bp, so everyone looks like a non-taster', () => {
    const def = structuredClone(rflp)
    const digests = def.procedure!.steps!.find((s) => s.id === 'digests')!
    digests.steps!.find((s) => s.id === 'digest-enzyme')!.params!.source = 'water'
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions).toMatchObject({ 'genotype:a': 'aa', 'genotype:b': 'aa', 'genotype:c': 'aa' })
  }, 30000)
})
