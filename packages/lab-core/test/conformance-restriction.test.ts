// Restriction digestion and mapping: enzymes cut the sites a plasmid declares, need Mg²⁺ (so a
// buffer, and EDTA stops them), unfold above their Tm, and a partial digest shows extra bands.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { cutShare, piecesOf, siteKey } from '../src/models/digestion.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const mapping = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio3-restriction-mapping.labx.json')) as ExperimentDefinition
const PBR = 'molbio:pbr322-plasmid'

function variant(change: (steps: StepDef[]) => void): ExperimentDefinition {
  const def = structuredClone(mapping)
  change(def.procedure!.steps!)
  return def
}
const setupSteps = (s: StepDef[]) => s.find((x) => x.id === 'setup')!.steps!

describe('conformance: restriction mapping of pBR322', () => {
  it('rehearses for several seeds: complete digests, distances within 10 %, the sites on opposite sides', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(mapping, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.map).toBe('opposite')
    }
  }, 30000)

  it('without the buffer there is no Mg²⁺: the digests look like uncut plasmid', () => {
    const def = variant((s) => {
      const setup = setupSteps(s)
      setup.splice(setup.findIndex((x) => x.id === 'add-buffer'), 1)
    })
    const r = compile(def, catalogue, { seed: 1 })
    const env = runEnv(r.run!)
    expect(evaluate(`cutShare('eb', '${PBR}', 'molbio:ecori')`, env) as number).toBeLessThan(0.01)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
  })

  it('a one-minute digest is mostly partial: the double-digest lanes show extra, longer bands', () => {
    // A flicked tube is only partly mixed, so how soon the enzyme meets the DNA varies from run to
    // run: most one-minute digests are partial, though a lucky mix can nearly finish.
    const def = variant((s) => (s.find((x) => x.id === 'digest')!.params!.duration = '1 min'))
    let partial = 0
    for (const seed of [1, 2, 3]) {
      const env = runEnv(compile(def, catalogue, { seed }).run!)
      const share = evaluate(`cutShare('eb', '${PBR}', 'molbio:ecori')`, env) as number
      if (share > 0.2 && share < 0.95) {
        partial++
        expect((evaluate("bandsIn('gel/A4')", env) as unknown[]).length).toBeGreaterThan(2)
      }
    }
    expect(partial).toBeGreaterThanOrEqual(2)
  }, 60000)
})

describe('restriction digestion', () => {
  /** A 20 µL digest of 1 µg pBR322 in 1× buffer, with extra components, kept at a temperature. */
  function tube(extra: Array<{ substance: string; conc: string }>, temperature = '37 Cel') {
    const w = emptyWorld(1)
    addPlace(w, catalogue, 'bath', 'core:water-bath', undefined, temperature)
    addSupply(w, catalogue, {
      id: 't', label: 'Digest', container: 'core:microtube-1.5ml', amount: '20 uL', place: 'bath',
      components: [{ substance: PBR, conc: '50 mg/L' }, { substance: 'core:tris', conc: '50 mM' }, { substance: 'core:magnesium-chloride', conc: '10 mM' }, ...extra],
    })
    w.containers.t.contents.temperatureK = w.places.bath.temperatureK
    return createKernel(catalogue, w)
  }
  const share = (k: ReturnType<typeof tube>, enzyme?: string) => cutShare(catalogue, k.world.containers.t.contents, PBR, enzyme)!

  it('20 U of EcoRI cuts 1 µg completely within minutes at 37 °C, and only its own site', () => {
    const k = tube([{ substance: 'molbio:ecori', conc: '1 mg/L' }])
    k.execute({ op: 'core:advance-time', params: { duration: '10 min' } })
    expect(share(k, 'molbio:ecori')).toBeGreaterThan(0.99)
    expect(share(k, 'molbio:bamhi')).toBe(0)
  })

  it('works more slowly in the cold and not at all once EDTA has taken up the Mg²⁺', () => {
    const cold = tube([{ substance: 'molbio:ecori', conc: '0.05 mg/L' }], '4 Cel')
    const warm = tube([{ substance: 'molbio:ecori', conc: '0.05 mg/L' }])
    for (const k of [cold, warm]) k.execute({ op: 'core:advance-time', params: { duration: '5 min' } })
    expect(share(cold)).toBeLessThan(share(warm) * 0.3)
    const stopped = tube([{ substance: 'molbio:ecori', conc: '1 mg/L' }, { substance: 'core:edta', conc: '12 mM' }])
    stopped.execute({ op: 'core:advance-time', params: { duration: '60 min' } })
    expect(share(stopped)).toBe(0)
  })

  it('EcoRI is heat-inactivated at 65 °C; BamHI is not', () => {
    for (const [enzyme, survives] of [['molbio:ecori', false], ['molbio:bamhi', true]] as const) {
      const k = tube([{ substance: enzyme, conc: '1 mg/L' }, { substance: 'core:edta', conc: '20 mM' }], '65 Cel')
      k.execute({ op: 'core:advance-time', params: { duration: '20 min' } })
      const l = k.world.containers.t.contents.layers[0]
      const left = (l.active?.[enzyme] ?? l.species[enzyme]) / l.species[enzyme]
      if (survives) expect(left).toBeGreaterThan(0.6)
      else expect(left).toBeLessThan(0.01)
    }
  })

  it('partial digests conserve mass and give the expected pieces', () => {
    const mol = 1e-12
    const ngTotal = mol * 4361 * 650 * 1e9
    for (const p of [0, 0.3, 0.7, 1]) {
      const cut = { [siteKey(PBR, 'molbio:ecori', 4359)]: p * mol, [siteKey(PBR, 'molbio:bamhi', 375)]: p * mol }
      const pieces = piecesOf(catalogue, PBR, mol, cut)
      expect(pieces.reduce((a, x) => a + x.ng, 0)).toBeCloseTo(ngTotal, 6)
      const forms = new Set(pieces.map((x) => x.form))
      if (p === 0) expect([...forms].sort()).toEqual(['open-circle', 'supercoiled'])
      if (p === 1) expect(pieces.map((x) => x.bp).sort((a, b) => a - b)).toEqual([377, 3984])
      if (p > 0 && p < 1) expect(pieces.some((x) => x.bp === 4361 && x.form === 'linear')).toBe(true)
    }
  })
})
