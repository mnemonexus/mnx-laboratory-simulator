// Functional-group tests through the kernel (E9): bromine adds to an alkene but not an alkane;
// acidified dichromate (named by its chromium(VI) carrier, rate ∝ [H⁺]) turns green with primary and
// secondary alcohols but not a tertiary one; an aldehyde gives silver with Tollens' reagent and a
// ketone does not; CH₃CO– compounds give yellow iodoform and methanol does not; phenol turns iron(III)
// chloride violet.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

const REAGENTS: Record<string, Array<[string, string]>> = {
  bromine: [['chem:bromine', '0.01 mol/L']],
  dichromate: [['aq:potassium-dichromate', '0.05 mol/L'], ['core:sulfuric-acid', '1 mol/L']],
  tollens: [['aq:silver-nitrate', '0.05 mol/L'], ['aq:ammonia', '2.0 mol/L']],
  iodine: [['core:iodine', '0.1 mol/L'], ['core:potassium-iodide', '0.3 mol/L']],
  naoh: [['aq:sodium-hydroxide', '2 mol/L']],
  fecl3: [['aq:iron-iii-chloride', '0.01 mol/L']],
}

/** 1 mL of a sample with reagents added in turn, optionally warmed; what the eye sees. */
function test(sample: Array<[string, string]>, reagents: Array<[string, number]>, opts: { warmC?: number; minutes?: number; solvent?: string } = {}): string {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  addPlace(w, cat, 'bath', 'core:water-bath')
  addSupply(w, cat, { id: 'sample', label: 'sample', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: sample.map(([substance, conc]) => ({ substance, conc })), ...(opts.solvent ? { solvent: opts.solvent } : {}) })
  for (const [id, parts] of Object.entries(REAGENTS)) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '50 mL', components: parts.map(([substance, conc]) => ({ substance, conc })) })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  run('core:fetch', { equipment: 'core:test-tube', id: 't', label: 't' })
  run('core:transfer', { source: 'sample', destination: 't', volume: '1 mL' })
  for (const [r, mL] of reagents) {
    run('core:transfer', { source: r, destination: 't', volume: `${mL} mL` })
    run('core:mix', { container: 't', method: 'shake', cycles: 5 })
  }
  if (opts.warmC) {
    run('core:set-environment', { device: 'bath', temperature: `${opts.warmC} Cel` })
    run('core:place-in', { container: 't', place: 'bath' })
  }
  run('core:advance-time', { duration: `${opts.minutes ?? 1} min` })
  return run('core:measure', { instrument: 'eye', subject: 't' }).appearance
}

describe('functional-group tests', () => {
  it('bromine water: decolourised by an alkene, not an alkane', () => {
    expect(test([['chem:cyclohexene', '811 g/L']], [['bromine', 2]], { solvent: 'chem:cyclohexene' })).not.toMatch(/orange/)
    expect(test([['chem:cyclohexane', '779 g/L']], [['bromine', 2]], { solvent: 'chem:cyclohexane' })).toMatch(/orange/)
  })

  it('acidified dichromate: green with primary and secondary alcohols, unchanged with a tertiary one', () => {
    expect(test([['core:ethanol', '1 mol/L']], [['dichromate', 2]], { warmC: 60, minutes: 5 })).toMatch(/green/)
    expect(test([['chem:propan-2-ol', '1 mol/L']], [['dichromate', 2]], { warmC: 60, minutes: 5 })).toMatch(/green/)
    expect(test([['chem:2-methylpropan-2-ol', '1 mol/L']], [['dichromate', 2]], { warmC: 60, minutes: 5 })).not.toMatch(/green/)
  })

  it('Tollens: silver from an aldehyde, nothing from a ketone', () => {
    expect(test([['chem:ethanal', '0.5 mol/L']], [['tollens', 2]], { minutes: 5 })).toMatch(/grey precipitate/)
    expect(test([['chem:propanone', '0.5 mol/L']], [['tollens', 2]], { minutes: 5 })).not.toMatch(/precipitate/)
  })

  it('iodoform: yellow from ethanol and propanone, none from methanol', () => {
    expect(test([['core:ethanol', '1 mol/L']], [['iodine', 2], ['naoh', 1]], { warmC: 60, minutes: 5 })).toMatch(/yellow precipitate/)
    expect(test([['chem:propanone', '0.5 mol/L']], [['iodine', 2], ['naoh', 1]], { warmC: 60, minutes: 5 })).toMatch(/yellow precipitate/)
    expect(test([['chem:methanol', '1 mol/L']], [['iodine', 2], ['naoh', 1]], { warmC: 60, minutes: 5 })).not.toMatch(/precipitate/)
  })

  it('iron(III) chloride: violet with phenol, not with ethanol', () => {
    expect(test([['chem:phenol', '0.1 mol/L']], [['fecl3', 0.1]])).toMatch(/violet/)
    expect(test([['core:ethanol', '1 mol/L']], [['fecl3', 0.1]])).not.toMatch(/violet/)
  })
})
