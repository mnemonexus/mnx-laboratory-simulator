// Microbiology: populations, a loop that carries cells until it is flamed, smears, the Gram
// stain as a retention model, and microscope observations (spec example 2).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { assess } from '../src/assess/assess.ts'
import { createKernel } from '../src/kernel/index.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import type { World } from '../src/kernel/state.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const gram = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro1-gram-stain.labx.json')) as ExperimentDefinition

/** The definition with the per-culture steps changed. */
function variant(change: (steps: StepDef[]) => void): ExperimentDefinition {
  const def = structuredClone(gram)
  change(def.procedure!.steps![0]!.steps!)
  return def
}

const stainStep = (steps: StepDef[]) => steps.find((s) => s.id === 'stain')!

function seen(world: World, slide: string): string {
  return world.measurements.filter((m) => m.kind === 'observation' && m.subject === slide).at(-1)?.display[slide] ?? ''
}

describe('conformance: Gram stain', () => {
  it('rehearses for several seeds: purple cocci, pink rods, both classified', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(gram, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      const w = r.kernel!.world
      expect(seen(w, 'slide-sa')).toBe('purple cocci in clusters')
      expect(seen(w, 'slide-ec')).toBe('pink rods')
      expect(r.run!.decisions).toEqual({ 'classify:sa': 'positive', 'classify:ec': 'negative' })
    }
  })

  it('the observation never names the organism', () => {
    const r = compile(gram, catalogue, { seed: 1 })
    const obs = r.kernel!.world.measurements.filter((m) => m.kind === 'observation')
    expect(obs).toHaveLength(2)
    expect(JSON.stringify(obs)).not.toMatch(/aureus|coli|positive|negative/i)
  })

  it('over-decolourising turns Gram-positive cells pink', () => {
    const r = compile(variant((s) => (stainStep(s).params!.decolouriseTime = '60 s')), catalogue, { seed: 1 })
    expect(seen(r.kernel!.world, 'slide-sa')).toBe('pink cocci in clusters')
    expect(r.rehearsal!.quality.find((q) => q.path === 'per-culture[0]/stain' && q.criterion === 'true-colour')!.passed).toBe(false)
  })

  it('under-decolourising leaves Gram-negative cells purple', () => {
    const r = compile(variant((s) => (stainStep(s).params!.decolouriseTime = '1 s')), catalogue, { seed: 1 })
    expect(seen(r.kernel!.world, 'slide-ec')).toBe('purple rods')
    expect(seen(r.kernel!.world, 'slide-sa')).toBe('purple cocci in clusters')
  })

  it('leaving out the iodine makes every cell lose the crystal violet', () => {
    const staged = compile(gram, catalogue, { seed: 1, rehearse: false })
    const k = createKernel(catalogue, staged.world!)
    k.execute({ op: 'core:fetch', params: { equipment: 'core:microscope-slide', id: 's1' } })
    k.execute({ op: 'core:transfer', params: { source: 'sa', destination: 's1', volume: '10 uL', tool: 'loop' } })
    k.execute({ op: 'core:dry', params: { container: 's1', method: 'heat' } })
    for (const [reagent, t] of [['cv', '60 s'], ['decol', '10 s'], ['saf', '45 s']]) {
      expect(k.execute({ op: 'core:flood', params: { container: 's1', reagent, duration: t } }).ok).toBe(true)
      k.execute({ op: 'core:rinse', params: { container: 's1' } })
    }
    k.execute({ op: 'core:measure', params: { instrument: 'microscope', subject: 's1' } })
    expect(seen(k.world, 's1')).toBe('pink cocci in clusters')
  })

  it('a smear that is not heat-fixed washes off', () => {
    const r = compile(variant((s) => s.splice(s.findIndex((x) => x.id === 'fix'), 1)), catalogue, { seed: 1 })
    expect(seen(r.kernel!.world, 'slide-sa')).toBe('nothing visible')
    expect(r.rehearsal!.expectedObservations.find((o) => o.id === 'e-purple')!.passed).toBe(false)
  })

  it('an unflamed loop carries the first culture into the second culture and onto its slide', () => {
    const staged = compile(gram, catalogue, { seed: 2, rehearse: false })
    const k = createKernel(catalogue, staged.world!)
    for (const s of ['slide-a', 'slide-b']) k.execute({ op: 'core:fetch', params: { equipment: 'core:microscope-slide', id: s } })
    expect(k.execute({ op: 'core:transfer', params: { source: 'sa', destination: 'slide-a', volume: '10 uL', tool: 'loop' } }).ok).toBe(true)
    expect(k.execute({ op: 'core:transfer', params: { source: 'ec', destination: 'slide-b', volume: '10 uL', tool: 'loop' } }).ok).toBe(true)
    const culture = k.world.containers.ec.contents.layers.flatMap((l) => Object.keys(l.populations ?? {}))
    expect(culture).toContain('micro:staphylococcus-aureus-teaching-strain')
    k.execute({ op: 'core:dry', params: { container: 'slide-b', method: 'heat' } })
    expect(Object.keys(k.world.containers['slide-b'].contents.film!)).toHaveLength(2)
    k.execute({ op: 'core:measure', params: { instrument: 'microscope', subject: 'slide-b' } })
    expect(seen(k.world, 'slide-b')).toMatch(/cocci/)
    expect(seen(k.world, 'slide-b')).toMatch(/rods/)

    // Flaming between cultures keeps them apart.
    const clean = createKernel(catalogue, compile(gram, catalogue, { seed: 2, rehearse: false }).world!)
    for (const s of ['slide-a', 'slide-b']) clean.execute({ op: 'core:fetch', params: { equipment: 'core:microscope-slide', id: s } })
    clean.execute({ op: 'core:transfer', params: { source: 'sa', destination: 'slide-a', volume: '10 uL', tool: 'loop' } })
    const flame = clean.execute({ op: 'core:sterilise', params: { tool: 'loop' } })
    expect(flame.ok && flame.event.facts.hadFilm).toBe(true)
    clean.execute({ op: 'core:transfer', params: { source: 'ec', destination: 'slide-b', volume: '10 uL', tool: 'loop' } })
    clean.execute({ op: 'core:dry', params: { container: 'slide-b', method: 'heat' } })
    expect(Object.keys(clean.world.containers['slide-b'].contents.film!)).toEqual(['micro:escherichia-coli-k12'])
  })

  it('the kernel refuses to flame a pipette and a loop transfer of the wrong volume', () => {
    const k = createKernel(catalogue, compile(gram, catalogue, { seed: 1, rehearse: false }).world!)
    expect(k.execute({ op: 'core:sterilise', params: { tool: 'p20' } })).toMatchObject({ ok: false, refusal: { code: 'NOT-A-LOOP' } })
    k.execute({ op: 'core:fetch', params: { equipment: 'core:microscope-slide', id: 's1' } })
    expect(k.execute({ op: 'core:transfer', params: { source: 'sa', destination: 's1', volume: '50 uL', tool: 'loop' } })).toMatchObject({ ok: false, refusal: { code: 'FIXED-VOLUME' } })
  })

  it('decisions are judged per culture', () => {
    const r = compile(gram, catalogue, { seed: 1, choices: { 'classify:sa': 'negative' } })
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-class')!.passed).toBe(false)
    const result = assess(r.run!, { quality: r.rehearsal!.quality, context: 'practical-session' })
    expect(result.evidence.find((e) => e.id === 'classify:sa')!.passed).toBe(false)
    expect(result.evidence.find((e) => e.id === 'classify:ec')!.passed).toBe(true)
    expect(result.objectives.find((o) => o.id === 'o-id')!.met).toBe(false)
  })
})
