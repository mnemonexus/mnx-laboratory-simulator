// The add-on's practical runtime, headless: bundled content, the store the panels read, saving
// and resuming through the host, and the review.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { catalogue, practicals } from './content'
import { PracticalRuntime } from './practical'
import { toLabState } from './present'

function memoryHost() {
  const store = new Map<string, string>()
  return { store, load: async (k: string) => store.get(k) ?? null, save: async (k: string, v: string) => void store.set(k, v) }
}

describe('practical runtime', () => {
  it('bundles every curated definition and a catalogue without problems', () => {
    expect(catalogue().problems).toEqual([])
    expect(practicals().length).toBeGreaterThanOrEqual(12)
    expect(practicals().every((p) => p.title && p.contexts.length > 0)).toBe(true)
  })

  it('the bundled content is up to date (run npm run content)', () => {
    expect(() => execFileSync(process.execPath, ['scripts/runtime/content.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })

  it('runs a practical through the store: refusals are state, not errors; demonstrations advance', () => {
    const rt = new PracticalRuntime(memoryHost())
    let notified = 0
    rt.subscribe(() => notified++)
    expect(rt.start('bio1-bca-protein-assay', 'practical-session', 7)).toBe(true)
    const s0 = rt.getSnapshot()
    expect(s0.phase).toBe('running')
    expect(s0.view!.steps[0].status).toBe('current')
    expect(rt.perform('core:transfer', { source: 'pbs', destination: 'bsa-stock', volume: '5 mL' })).toBe(false)
    expect(rt.getSnapshot().view!.lastRefusal).toBeTruthy()
    expect(rt.getSnapshot().error).toBeUndefined()
    rt.demonstrate()
    expect(rt.getSnapshot().view!.steps[0].status).toBe('done')
    expect(notified).toBeGreaterThan(2)
    // The 3D bridge sees the plate and the stocks.
    const lab = toLabState(rt.getSnapshot().view!)
    expect(lab.rack.length).toBeGreaterThan(0)
    rt.finish()
    expect(rt.getSnapshot().phase).toBe('review')
    expect(rt.getSnapshot().result!.objectives.some((o) => !o.met)).toBe(true)
  })

  it('saves after each action and resumes where it left off', async () => {
    const host = memoryHost()
    const a = new PracticalRuntime(host)
    a.start('micro1-gram-stain', 'practical-session', 3)
    a.demonstrate()
    await Promise.resolve()
    expect(host.store.get('practical')).toBeTruthy()
    const b = new PracticalRuntime(host)
    await b.findSaved()
    expect(b.getSnapshot().saved?.entryId).toBe('micro1-gram-stain')
    expect(await b.resume()).toBe(true)
    expect(b.getSnapshot().view!.measurements).toEqual(a.getSnapshot().view!.measurements)
    expect(b.getSnapshot().view!.current).toBe('classify')
  })

  it('reports a start failure instead of throwing', () => {
    const rt = new PracticalRuntime()
    expect(rt.start('no-such-practical')).toBe(false)
    expect(rt.getSnapshot().error).toMatch(/No practical/)
  })
})
