// Proteins in cells: an organism's proteome and a plasmid's inducible protein, released when the
// cells burst (boiled in sample buffer), so an induced culture shows its overexpressed band.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const STRAIN = 'micro:escherichia-coli-bl21-patb'
const PATB = 'bio:his-patb'
const ugOf = (k: Kernel, id: string, s: string) => k.world.containers[id].contents.layers.reduce((a, l) => a + (l.species[s] ?? 0), 0) * 88000 * 1e6

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function world() {
  const w = emptyWorld(1)
  addPlace(w, cat, 'block', 'core:heating-block')
  addPlace(w, cat, 'shaker', 'core:incubator')
  for (const [id, iptg] of [['uninduced', false], ['induced', true]] as const) {
    addSupply(w, cat, { id, label: id, container: 'core:conical-flask-100ml', amount: '20 mL', preparation: 'micro:lb-broth-sterile',
      ...(iptg ? { components: [{ substance: 'molbio:iptg', conc: '1 mM' }] } : {}), populations: [{ substance: STRAIN, perL: 1e12 }] })
  }
  addSupply(w, cat, { id: 'ld', label: 'ld', container: 'core:microtube-1.5ml', amount: '100 uL', preparation: 'bio:sds-sample-buffer-2x' })
  const k = createKernel(cat, w)
  run(k, 'core:set-environment', { device: 'block', temperature: '95 Cel' })
  run(k, 'core:set-environment', { device: 'shaker', temperature: '37 Cel' })
  return k
}

describe('protein expression', () => {
  it('a culture staged with IPTG is induced; boiled in sample buffer its cells release a strong band, the uninduced a trace', () => {
    const k = world()
    for (const id of ['uninduced', 'induced']) {
      run(k, 'core:fetch', { equipment: 'core:microtube-1.5ml', id: `t-${id}` })
      run(k, 'core:transfer', { source: id, destination: `t-${id}`, volume: '100 uL' })
      run(k, 'core:transfer', { source: 'ld', destination: `t-${id}`, volume: '20 uL' })
      run(k, 'core:close', { container: `t-${id}` })
      run(k, 'core:place-in', { container: `t-${id}`, place: 'block' })
    }
    run(k, 'core:advance-time', { duration: '10 min' })
    // 10⁸ cells × 40 fg = 4 µg of PatB induced; 1 % of that leaks without IPTG.
    expect(ugOf(k, 't-induced', PATB)).toBeGreaterThan(3)
    expect(ugOf(k, 't-induced', PATB)).toBeLessThan(5)
    expect(ugOf(k, 't-uninduced', PATB)).toBeLessThan(0.1)
    // The host proteins come out of both alike (within the pipetting of the 100 µL).
    const host = (id: string) => k.world.containers[id].contents.layers.reduce((a, l) => a + (l.species['bio:ecoli-host-protein-45k'] ?? 0), 0) * 45000 * 1e6
    expect(Math.abs(host('t-uninduced') / host('t-induced') - 1)).toBeLessThan(0.1)
    expect(host('t-induced')).toBeGreaterThan(3)
  })

  it('IPTG added to a growing culture builds the protein up over a few hours', () => {
    const w = emptyWorld(1)
    addPlace(w, cat, 'shaker', 'core:incubator')
    addSupply(w, cat, { id: 'culture', label: 'culture', container: 'core:conical-flask-100ml', amount: '20 mL', preparation: 'micro:lb-broth-sterile', populations: [{ substance: STRAIN, perL: 1e11 }] })
    addSupply(w, cat, { id: 'iptg', label: 'iptg', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised', components: [{ substance: 'molbio:iptg', conc: '100 mM' }] })
    const k = createKernel(cat, w)
    run(k, 'core:set-environment', { device: 'shaker', temperature: '37 Cel' })
    run(k, 'core:place-in', { container: 'culture', place: 'shaker' })
    const induced = () => Object.values(k.world.containers.culture.contents.layers[0].populations ?? {})[0].induced ?? 0
    expect(induced()).toBe(0)
    run(k, 'core:transfer', { source: 'iptg', destination: 'culture', volume: '200 uL' })
    run(k, 'core:advance-time', { duration: '1 h' })
    const oneHour = induced()
    run(k, 'core:advance-time', { duration: '2 h' })
    expect(oneHour).toBeGreaterThan(0.3)
    expect(oneHour).toBeLessThan(0.8)
    expect(induced()).toBeGreaterThan(0.85)
  })
})
