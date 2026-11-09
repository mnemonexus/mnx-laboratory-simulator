// SDS-PAGE: proteins in SDS run by the mass of their chains (LDH gives its 35 kDa subunit, not the
// 140 kDa tetramer), sized against a protein marker; without SDS they do not resolve.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { proteinMobility } from '../src/models/electrophoresis.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const sds = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio6-sds-page-subunits.labx.json')) as ExperimentDefinition
const bands = (r: ReturnType<typeof compile>, lane: string) => (evaluate(`bandsIn('${lane}')`, runEnv(r.run!)) as unknown[]).length
const kDa = (r: ReturnType<typeof compile>, what: string) => r.kernel!.world.notebook.find((e) => e.field === `kDa-${what}`)?.value as number | undefined

describe('conformance: subunit masses by SDS-PAGE', () => {
  it('rehearses for several seeds: chain masses within 10 %, LDH a tetramer', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(sds, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs(kDa(r, 'bsa')! / 66.43 - 1)).toBeLessThan(0.1)
      expect(Math.abs(kDa(r, 'lysozyme')! / 14.3 - 1)).toBeLessThan(0.1)
      expect(r.run!.decisions.subunits).toBe('tetramer')
    }
  }, 30000)

  it('without SDS in the sample buffer the proteins do not resolve; the marker still does', () => {
    const def = structuredClone(sds)
    const buffer = def.materials!.supplies!.find((s) => s.id === 'buffer')!
    delete buffer.preparation
    Object.assign(buffer, { label: 'Glycerol and dye only', solvent: 'core:water', contains: [{ substance: 'core:glycerol', conc: '252 g/L' }, { substance: 'core:bromophenol-blue', conc: '0.2 g/L' }] })
    const r = compile(def, catalogue, { seed: 1 })
    expect(bands(r, 'gel/A1')).toBe(10)
    for (const lane of ['gel/A2', 'gel/A3', 'gel/A4', 'gel/A5']) expect(bands(r, lane)).toBe(0)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
  })

  it('run too long, the smallest protein and marker bands run off the bottom', () => {
    const def = structuredClone(sds)
    def.procedure!.steps!.find((s) => s.id === 'electrophoresis')!.params!.duration = '70 min'
    const r = compile(def, catalogue, { seed: 1 })
    expect(bands(r, 'gel/A4')).toBe(0)
    expect(bands(r, 'gel/A1')).toBeLessThan(10)
  })

  it('mobility falls with chain mass, and denser gels slow everything', () => {
    expect(proteinMobility(14.3, 12)).toBeGreaterThan(proteinMobility(35, 12))
    expect(proteinMobility(35, 12)).toBeGreaterThan(proteinMobility(66, 12))
    expect(proteinMobility(35, 15)).toBeLessThan(proteinMobility(35, 12))
  })
})
