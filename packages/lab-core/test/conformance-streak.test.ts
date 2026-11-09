// Streak-plate isolation: sectors that thin the cells out, picking a single colony, and checking
// the subculture with a Gram stain (composes plating, growth and staining).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const streak = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro2-streak-isolation.labx.json')) as ExperimentDefinition

function variant(change: (steps: StepDef[], def: ExperimentDefinition) => void): ExperimentDefinition {
  const def = structuredClone(streak)
  change(def.procedure!.steps!, def)
  return def
}

/** Streaking by hand, flaming the loop between sectors or not. */
function byHand(flame: boolean): StepDef[] {
  const s: StepDef[] = [
    { id: 'f0', kind: 'operation', ref: 'core:sterilise', params: { tool: 'loop' } },
    { id: 'inoc', kind: 'operation', ref: 'core:transfer', params: { source: 'mix', destination: 'plate', volume: '10 uL', tool: 'loop' } },
    { id: 's1', kind: 'operation', ref: 'core:streak', params: { plate: 'plate', tool: 'loop', sector: 1 } },
  ]
  for (const k of [2, 3, 4]) {
    if (flame) s.push({ id: `f${k}`, kind: 'operation', ref: 'core:sterilise', params: { tool: 'loop' } })
    s.push({ id: `s${k}`, kind: 'operation', ref: 'core:streak', params: { plate: 'plate', tool: 'loop', sector: k } })
  }
  return s
}

function withHandStreak(flame: boolean): ExperimentDefinition {
  return variant((steps, def) => {
    steps.splice(steps.findIndex((x) => x.id === 'streak'), 1, ...byHand(flame))
    def.equipment!.roles!.push({ id: 'loop', requires: { class: 'core:inoculating-loop-10ul' } })
  })
}

describe('conformance: streak-plate isolation', () => {
  it('rehearses for several seeds: single colonies in the last sector, a pure Gram-positive subculture', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(streak, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      const env = runEnv(r.run!)
      expect(evaluate("organisms('broth')", env)).toEqual(['micro:staphylococcus-aureus-teaching-strain'])
      const display = r.kernel!.world.notebook.find((e) => e.field === 'plate')!.value as string
      expect(display).toMatch(/sector 1: confluent growth/)
      expect(display).toMatch(/sector 4: \d+ separate colonies/)
    }
  }, 30000)

  it('streaked by hand with flaming, it matches the technique', () => {
    const r = compile(withHandStreak(true), catalogue, { seed: 2 })
    expect(r.rehearsal!.goals[0].passed).toBe(true)
  })

  it('without flaming between sectors there are no single colonies, and the pick is a mixture', () => {
    const r = compile(withHandStreak(false), catalogue, { seed: 2 })
    const env = runEnv(r.run!)
    expect(evaluate("isolated('plate')", env)).toBe(0)
    expect((evaluate("organisms('broth')", env) as string[]).length).toBe(2)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
    // The Gram stain of a mixture shows both kinds of cell.
    const seen = r.kernel!.world.measurements.filter((m) => m.kind === 'observation').at(-1)!.display['slide-isolate']
    expect(seen).toMatch(/cocci/)
    expect(seen).toMatch(/rods/)
  })

  it('picking the other kind of colony gives a pure culture of the other organism', () => {
    const def = variant((s) => (s.find((x) => x.id === 'pick')!.params!.appearance = 'off-white'))
    const r = compile(def, catalogue, { seed: 1 })
    const env = runEnv(r.run!)
    expect(evaluate("organisms('broth')", env)).toEqual(['micro:escherichia-coli-k12'])
    expect(r.rehearsal!.goals[0].passed).toBe(false)
    // The reference still reads its own slide correctly.
    expect(r.run!.decisions.classify).toBe('negative')
  })

  it('refuses a pick that no colony matches', () => {
    const def = variant((s) => (s.find((x) => x.id === 'pick')!.params!.appearance = 'blue'))
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.rehearsal!.issues.some((i) => i.message.includes('No separate colony looks "blue"'))).toBe(true)
  })
})
