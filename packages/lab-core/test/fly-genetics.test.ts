// Mendelian genetics of fruit flies (E15): a monohybrid F2 gives 3 : 1; a dihybrid F2 of unlinked
// genes 9 : 3 : 3 : 1; a test cross of F1 females for black and vestigial (18.5 cM apart) gives about
// 18 % recombinants, and none from F1 males (no crossing over in males); white eyes, on the X, give
// different results in reciprocal crosses.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function lab(seed = 1) {
  const w = emptyWorld(seed)
  addEquipment(w, cat, 'lens', 'core:hand-lens')
  addPlace(w, cat, 'incubator', 'core:incubator', undefined, '25 Cel')
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, unknown>
  }
  const vial = (id: string) => {
    run('core:fetch', { equipment: 'core:fly-vial', id, label: id })
    run('core:place-in', { container: id, place: 'incubator' })
  }
  const score = (id: string) => run('core:measure', { instrument: 'lens', subject: id }) as { counts: Record<string, number>; females: Record<string, number>; males: Record<string, number>; total: number }
  return { run, vial, score }
}

describe('fruit fly genetics', () => {
  it('a monohybrid cross gives all wild type in F1 and about 3 : 1 in F2', () => {
    const { run, vial, score } = lab()
    vial('p')
    run('core:add-flies', { strain: 'bio:dros-vestigial', destination: 'p', females: 5 })
    run('core:add-flies', { strain: 'bio:dros-wild-type', destination: 'p', males: 5 })
    run('core:advance-time', { duration: '11 d' })
    const f1 = score('p')
    expect(Object.keys(f1.counts)).toEqual(['wild type'])
    vial('f1')
    run('core:transfer-flies', { source: 'p', destination: 'f1', females: 10, males: 10 })
    run('core:advance-time', { duration: '11 d' })
    const f2 = score('f1')
    const ratio = f2.counts['wild type'] / f2.counts['vestigial wings']
    expect(f2.total).toBeGreaterThan(400)
    expect(ratio).toBeGreaterThan(2.5)
    expect(ratio).toBeLessThan(3.6)
  })

  it('a dihybrid cross of unlinked genes gives about 9 : 3 : 3 : 1', () => {
    const { run, vial, score } = lab(2)
    vial('p')
    run('core:add-flies', { strain: 'bio:dros-vestigial-ebony', destination: 'p', females: 5 })
    run('core:add-flies', { strain: 'bio:dros-wild-type', destination: 'p', males: 5 })
    run('core:advance-time', { duration: '11 d' })
    vial('f1')
    run('core:transfer-flies', { source: 'p', destination: 'f1', females: 20, males: 20 })
    run('core:advance-time', { duration: '11 d' })
    const c = score('f1').counts
    const total = Object.values(c).reduce((a, n) => a + n, 0)
    expect(c['wild type'] / total).toBeCloseTo(9 / 16, 1)
    expect(c['vestigial wings, ebony body'] / total).toBeCloseTo(1 / 16, 1)
  })

  it('linked genes: F1 females test-crossed give about 18 % recombinants; F1 males none', () => {
    const recombinants = (f1Sex: 'female' | 'male') => {
      const { run, vial, score } = lab(3)
      vial('p')
      run('core:add-flies', { strain: 'bio:dros-black-vestigial', destination: 'p', females: 5 })
      run('core:add-flies', { strain: 'bio:dros-wild-type', destination: 'p', males: 5 })
      run('core:advance-time', { duration: '11 d' })
      vial('tc')
      run('core:transfer-flies', { source: 'p', destination: 'tc', females: f1Sex === 'female' ? 20 : 0, males: f1Sex === 'male' ? 20 : 0 })
      run('core:add-flies', { strain: 'bio:dros-black-vestigial', destination: 'tc', females: f1Sex === 'male' ? 20 : 0, males: f1Sex === 'female' ? 20 : 0 })
      run('core:advance-time', { duration: '11 d' })
      const c = score('tc').counts
      const total = Object.values(c).reduce((a, n) => a + n, 0)
      return ((c['black body'] ?? 0) + (c['vestigial wings'] ?? 0)) / total
    }
    const rf = recombinants('female')
    expect(rf).toBeGreaterThan(0.13)
    expect(rf).toBeLessThan(0.24)
    expect(recombinants('male')).toBe(0)
  })

  it('white eyes are sex-linked: reciprocal crosses differ', () => {
    const f1 = (mother: string, father: string) => {
      const { run, vial, score } = lab(4)
      vial('p')
      run('core:add-flies', { strain: mother, destination: 'p', females: 5 })
      run('core:add-flies', { strain: father, destination: 'p', males: 5 })
      run('core:advance-time', { duration: '11 d' })
      return score('p')
    }
    // White-eyed mothers: all sons white-eyed, all daughters red-eyed.
    const a = f1('bio:dros-white', 'bio:dros-wild-type')
    expect(Object.keys(a.males)).toEqual(['white eyes'])
    expect(Object.keys(a.females)).toEqual(['wild type'])
    // White-eyed fathers: everyone red-eyed.
    const b = f1('bio:dros-wild-type', 'bio:dros-white')
    expect(Object.keys(b.counts)).toEqual(['wild type'])
  })
})
