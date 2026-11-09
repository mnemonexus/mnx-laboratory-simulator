// Resistance mutations by PCR-RFLP: one that creates a restriction site (a chloramphenicol target
// locus, PvuII) and one that destroys it (gyrA Ser83Leu, HinfI), where a failed digest would look
// resistant unless a sensitive reference is cut alongside.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { digestPieces } from '../src/models/digestion.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const gyra = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio9-gyra-rflp.labx.json')) as ExperimentDefinition

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

describe('conformance: gyrA PCR-RFLP', () => {
  it('rehearses for several seeds: every genotype read, the reference cut', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(gyra, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('without the enzyme every isolate looks resistant, and only the uncut reference gives it away', () => {
    const def = structuredClone(gyra)
    const digests = def.procedure!.steps!.find((s) => s.id === 'digests')!
    digests.steps = digests.steps!.filter((s) => s.id !== 'd-enzyme')
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions['genotype:1']).toBe('s83l')
    expect(r.rehearsal!.expectedObservations.find((e) => e.id === 'e-ref')!.passed).toBe(false)
  }, 180000)
})

describe('a mutation that creates a site', () => {
  it('PvuII cuts the resistance allele of the chloramphenicol target locus into 700 and 450 bp, and not the wild type', () => {
    const w = emptyWorld(1)
    addPlace(w, catalogue, 'cycler', 'core:thermal-cycler-96-tube')
    for (const [id, dna] of [['wt', 'molbio:ecoli-gdna-cm-wt'], ['r', 'molbio:ecoli-gdna-cm-r']]) {
      addSupply(w, catalogue, {
        id, label: id, container: 'core:pcr-tube-0.2ml', amount: '15 uL', preparation: 'molbio:pcr-master-mix-2x',
        components: [{ substance: 'molbio:cm-target-forward-primer', conc: '0.5 uM' }, { substance: 'molbio:cm-target-reverse-primer', conc: '0.5 uM' }, { substance: dna, conc: '0.7 ng/uL' }],
      })
    }
    addSupply(w, catalogue, { id: 'pvuii', label: 'PvuII', container: 'core:microtube-1.5ml', amount: '10 uL', preparation: 'molbio:pvuii-10u' })
    addSupply(w, catalogue, { id: 'buffer', label: 'buffer', container: 'core:microtube-1.5ml', amount: '50 uL', preparation: 'molbio:restriction-buffer-10x' })
    const k = createKernel(catalogue, w)
    for (const id of ['wt', 'r']) run(k, 'core:place-in', { container: id, place: 'cycler' })
    run(k, 'core:thermocycle', { cycler: 'cycler', cycles: 35, annealTemperature: '58 Cel', extendTemperature: '68 Cel', extendTime: '90 s' })
    run(k, 'core:set-environment', { device: 'cycler', temperature: '37 Cel' })
    for (const id of ['wt', 'r']) {
      run(k, 'core:open', { container: id })
      run(k, 'core:transfer', { source: 'pvuii', destination: id, volume: '1 uL' })
      run(k, 'core:transfer', { source: 'buffer', destination: id, volume: '1.7 uL' })
      run(k, 'core:mix', { container: id, method: 'pipette-mix', cycles: 3 })
    }
    run(k, 'core:advance-time', { duration: '45 min' })
    const big = (id: string, s: string) => digestPieces(catalogue, k.world.containers[id].contents, s).filter((p) => p.ng > 5).map((p) => p.bp).sort((a, b) => b - a)
    expect(big('r', 'molbio:cm-target-amplicon-r')).toEqual([700, 450])
    expect(big('wt', 'molbio:cm-target-amplicon-wt')).toEqual([1150])
  })
})
