// Animal choice (E15): 100 animals in a choice chamber settle in the ratio e^(2·preference) between
// the sides: woodlice about 92 % on the humid side and 88 % in the dark, fruit flies about 83 % in
// the light; with both sides alike they stay about even.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

/** The share of 100 animals on side 2 after 15 minutes (the mean of the last five minutes' counts). */
function share(organism: string, side1: Record<string, string>, side2: Record<string, string>): number {
  const w = emptyWorld(7)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, number>
  }
  run('core:fetch', { equipment: 'core:choice-chamber', id: 'c', label: 'c' })
  run('core:set-chamber', { chamber: 'c', side: 1, ...side1 })
  run('core:set-chamber', { chamber: 'c', side: 2, ...side2 })
  run('core:add-animals', { organism, chamber: 'c', count: 100 })
  run('core:advance-time', { duration: '10 min' })
  let sum = 0
  for (let i = 0; i < 5; i++) {
    run('core:advance-time', { duration: '1 min' })
    sum += run('core:measure', { instrument: 'eye', subject: 'c' }).side2
  }
  return sum / 500
}

describe('choice chamber', () => {
  it('woodlice gather in the humid and the dark sides', () => {
    expect(share('bio:woodlice', { humidity: 'dry', light: 'dark' }, { humidity: 'humid', light: 'dark' })).toBeGreaterThan(0.85)
    expect(share('bio:woodlice', { humidity: 'humid', light: 'light' }, { humidity: 'humid', light: 'dark' })).toBeGreaterThan(0.8)
  })

  it('fruit flies move to the light, and animals with no choice stay about even', () => {
    expect(share('bio:drosophila-melanogaster', { humidity: 'humid', light: 'light' }, { humidity: 'humid', light: 'dark' })).toBeLessThan(0.25)
    expect(Math.abs(share('bio:woodlice', { humidity: 'humid', light: 'dark' }, { humidity: 'humid', light: 'dark' }) - 0.5)).toBeLessThan(0.12)
  })
})
