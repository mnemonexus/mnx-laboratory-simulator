// An enzyme with alternative substrates and a mechanism-based inactivator: PatB (a PLP C-S
// β-lyase) frees thiols from S-substituted cysteines, followed with Ellman's reagent at 412 nm.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const EPS = 14150

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

/** A 1 mL assay in a cuvette: 1 mM DTNB, the given substrates and cycloserine (mM), PatB to 0.125 µM; A412 after each minute. */
function assay(substrates: Record<string, number>, cycloserine = 0, enzymeUM = 0.125, minutes = 5): number[] {
  const w = emptyWorld(1)
  const comps = [{ substance: 'bio:dtnb', conc: '1 mM' }, ...Object.entries(substrates).map(([s, mM]) => ({ substance: `bio:s-${s}-l-cysteine`, conc: `${mM} mM` })),
    ...(cycloserine ? [{ substance: 'bio:l-cycloserine', conc: `${cycloserine} mM` }] : [])]
  addSupply(w, cat, { id: 'cuvette', label: 'cuvette', container: 'core:cuvette-ps-1cm', amount: '950 uL', preparation: 'bio:tris-nacl-ph8', components: comps.map((c) => ({ ...c, conc: c.conc.replace(/^([\d.]+) mM$/, (_, x) => `${(Number(x) * 1000) / 950} mM`) })) })
  addSupply(w, cat, { id: 'patb', label: 'patb', container: 'core:microtube-1.5ml', amount: '200 uL', preparation: 'bio:tris-nacl-ph8', components: [{ substance: 'bio:his-patb', conc: `${enzymeUM * 20} uM` }] })
  const k = createKernel(cat, w)
  if (enzymeUM > 0) run(k, 'core:transfer', { source: 'patb', destination: 'cuvette', volume: '50 uL' })
  // Covered with Parafilm and inverted, as the handout says.
  run(k, 'core:close', { container: 'cuvette', cover: 'parafilm' })
  run(k, 'core:mix', { container: 'cuvette', method: 'invert', cycles: 5 })
  const a = () => {
    const l = k.world.containers.cuvette.contents.layers[0]
    return ((l.species['bio:tnb'] ?? 0) / l.volumeL) * EPS
  }
  const out = [a()]
  for (let m = 0; m < minutes; m++) {
    run(k, 'core:advance-time', { duration: '1 min' })
    out.push(a())
  }
  return out
}

describe('PatB with Ellman detection', () => {
  it('1 mM S-benzyl-L-cysteine at 0.125 µM PatB gives about 0.1 A412 a minute, linear over 5 minutes', () => {
    const a = assay({ benzyl: 1 })
    const first = a[1] - a[0]
    expect(first).toBeGreaterThan(0.08)
    expect(first).toBeLessThan(0.14)
    expect(a[5] - a[4]).toBeGreaterThan(0.9 * first)
  })

  it('the analogues are turned over in order benzyl > allyl > ethyl > methyl, and without enzyme only DTNB\'s slow drift shows', () => {
    const rate = (s: string) => assay({ [s]: 1 }, 0, 0.125, 2)[2] / 2
    const r = ['benzyl', 'allyl', 'ethyl', 'methyl'].map(rate)
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThan(r[i - 1])
    const blank = assay({ benzyl: 1 }, 0, 0, 5)
    expect(blank[5] - blank[0]).toBeGreaterThan(0)
    expect(blank[5] - blank[0]).toBeLessThan(0.01)
  })

  it('alternative substrates compete for the one site: the poor substrate slows the good one', () => {
    const alone = assay({ benzyl: 0.4 }, 0, 0.125, 1)[1]
    const together = assay({ benzyl: 0.4, methyl: 6 }, 0, 0.125, 1)[1]
    const methylAlone = assay({ methyl: 6 }, 0, 0.125, 1)[1]
    // Less than the two alone added together: they share the enzyme.
    expect(together).toBeLessThan(alone + methylAlone - 0.01)
  })

  it('L-cycloserine lowers the initial rate and the trace curves as it inactivates the enzyme', () => {
    const free = assay({ benzyl: 1 })
    const inhibited = assay({ benzyl: 1 }, 1)
    expect(inhibited[1] - inhibited[0]).toBeLessThan(0.8 * (free[1] - free[0]))
    // Inactivation: each minute adds less than the one before, faster than substrate use alone would explain.
    const slowing = (x: number[]) => (x[5] - x[4]) / (x[1] - x[0])
    expect(slowing(inhibited)).toBeLessThan(slowing(free) - 0.15)
  })
})
