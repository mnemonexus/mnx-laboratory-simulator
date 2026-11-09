// Lab sessions: the headless runtime a host drives (perform, decide, hint, demonstrate, rewind,
// save, finish).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { LabSession } from '../src/session/session.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const def = (pack: string, file: string) => readJson(join(PACKAGES, pack, 'definitions', file))
const gram = def('pack-microbiology', 'micro1-gram-stain.labx.json')
const drill = def('pack-core', 'drill-balance-rotor.labx.json')
const khp = def('pack-chemistry', 'chem1-naoh-standardisation.labx.json')

function open(input: unknown, options = {}): LabSession {
  const s = LabSession.start(input, catalogue, { seed: 1, ...options })
  if (!s.ok) throw new Error(s.message)
  return s.session
}

describe('lab sessions', () => {
  it('opens with the staged bench and the first step current', () => {
    const s = open(gram)
    const v = s.view()
    expect(v.title).toBe('Gram staining two bacteria')
    expect(v.containers.map((c) => c.id)).toEqual(expect.arrayContaining(['sa', 'ec', 'cv', 'iodine', 'decol', 'saf']))
    expect(v.equipment.map((e) => e.id)).toEqual(expect.arrayContaining(['loop', 'microscope']))
    expect(v.current).toBe('per-culture')
    expect(v.steps[0].status).toBe('current')
    expect(s.guidance().message.length).toBeGreaterThan(0)
  })

  it('demonstrating every step reaches the goals, and the decisions are the learner’s', () => {
    const s = open(gram)
    expect(s.demonstrate().ok).toBe(true)
    expect(s.view().current).toBe('classify')
    s.decide('classify', 'positive', 'sa')
    s.decide('classify', 'positive', 'ec') // wrong
    s.completeStep()
    const { result, mnemonexus } = s.finish()
    expect(result.evidence.find((e) => e.id === 'classify:sa')!.passed).toBe(true)
    expect(result.evidence.find((e) => e.id === 'classify:ec')!.passed).toBe(false)
    expect(mnemonexus).toBeTruthy()
    expect(s.view().finished).toBe(true)
    expect(s.perform('core:rinse', { container: 'sa' }).ok).toBe(false)
  })

  it('actions done by hand are judged: a rotor loaded side by side fails the safety gate', () => {
    const s = open(drill, { context: 'practical-session' })
    const tubes = s.view().containers.filter((c) => c.supply === 's').map((c) => c.id)
    tubes.forEach((t, i) => {
      s.perform('core:close', { container: t })
      expect(s.perform('core:place-in', { container: t, place: 'cfg', position: i + 1 }).ok).toBe(true)
    })
    s.completeStep()
    expect(s.view().current).toBe('spin')
    s.perform('core:centrifuge', { rcf: '12000 [RCF]', duration: '1 min' })
    expect(s.view().incidents.length).toBe(1)
    s.completeStep()
    const { result } = s.finish()
    expect(result.dimensions.find((d) => d.id === 'safety-practice')!.gate).toBe('failed')
  })

  it('a refused action changes nothing and is remembered; rewind undoes the last action exactly', () => {
    const s = open(khp)
    const before = s.view().containers.find((c) => c.id === 'naoh-soln')!.volumeMl
    const refused = s.perform('core:transfer', { source: 'naoh-soln', destination: 'burette', volume: '80 mL', tool: 'pour' })
    expect(refused.ok).toBe(false)
    expect(s.view().lastRefusal?.code).toBe('OVERFLOW')
    expect(s.perform('core:transfer', { source: 'naoh-soln', destination: 'burette', volume: '40 mL', tool: 'pour' }).ok).toBe(true)
    const afterFirst = s.view().containers.find((c) => c.id === 'burette')!.volumeMl
    expect(s.rewind()).toBe(true)
    expect(s.view().containers.find((c) => c.id === 'naoh-soln')!.volumeMl).toBeCloseTo(before, 9)
    // Doing it again gives exactly the same result: the run is a function of the seed and the intents.
    s.perform('core:transfer', { source: 'naoh-soln', destination: 'burette', volume: '40 mL', tool: 'pour' })
    expect(s.view().containers.find((c) => c.id === 'burette')!.volumeMl).toBe(afterFirst)
  })

  it('saves and restores to the same state', () => {
    const s = open(gram)
    s.hint()
    s.demonstrate()
    s.decide('classify', 'negative', 'sa')
    const saved = s.save()
    const r = LabSession.restore(JSON.parse(JSON.stringify(saved)), gram, catalogue)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const a = s.view()
    const b = r.session.view()
    expect(b.containers).toEqual(a.containers)
    expect(b.measurements).toEqual(a.measurements)
    expect(b.current).toBe(a.current)
    expect(r.session.finish().result.evidence.find((e) => e.id === 'classify:sa')!.passed).toBe(false)
  })

  it('lists the operations a host can offer and checks one without doing it', () => {
    const s = open(khp)
    expect(s.operations().map((o) => o.id)).toEqual(expect.arrayContaining(['core:transfer', 'core:weigh', 'core:read-volume']))
    expect(s.check('core:transfer', { source: 'naoh-soln', destination: 'burette', volume: '80 mL', tool: 'pour' })?.code).toBe('OVERFLOW')
    expect(s.view().refusals).toBe(0)
  })

  it('refuses to start a definition that does not validate', () => {
    const r = LabSession.start({ format: 'lab-experiment' }, catalogue)
    expect(r.ok).toBe(false)
  })
})
