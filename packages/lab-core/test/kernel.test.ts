import { describe, expect, it } from 'vitest'
import { loadAllPacks, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import type { OperationDecl } from '../src/catalogue/types.ts'
import {
  addContainer,
  addEquipment,
  addPlace,
  addSupply,
  clone,
  createKernel,
  emptyWorld,
  homogeneity,
  type Kernel,
  liquidVolume,
  massConcentration,
  meanLayer,
  molarConc,
  OPERATIONS,
  type World,
} from '../src/kernel/index.ts'
import { PACKAGES } from '../../../apps/cli/fs-packs.ts'
import { join } from 'node:path'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(seed = 1): World {
  const w = emptyWorld(seed)
  addSupply(w, cat, { id: 'bsa', label: 'BSA 2.0 mg/mL', container: 'core:microtube-2ml', amount: '1.5 mL', components: [{ substance: 'bio:bovine-serum-albumin', conc: '2.0 mg/mL' }] })
  addSupply(w, cat, { id: 'pbs', label: 'PBS', container: 'core:reagent-bottle-50ml', amount: '50 mL', preparation: 'core:pbs-1x' })
  addSupply(w, cat, { id: 'wr', label: 'BCA working reagent', container: 'core:reagent-bottle-50ml', amount: '40 mL', preparation: 'bio:bca-working-reagent' })
  for (const [id, model] of [['p20', 'core:micropipette-p20'], ['p200', 'core:micropipette-p200'], ['p1000', 'core:micropipette-p1000'], ['reader', 'bio:plate-reader.generic'], ['spec', 'core:spectrophotometer.visible-single-beam'], ['balance', 'core:balance-4dp']]) {
    addEquipment(w, cat, id, model)
  }
  addPlace(w, cat, 'incubator', 'core:incubator')
  for (let i = 1; i <= 6; i++) addContainer(w, cat, { id: `t${i}`, equipment: 'core:microtube-1.5ml', label: `Tube ${i}` })
  addContainer(w, cat, { id: 'plate', equipment: 'core:microplate-96', label: 'Plate' })
  return w
}

function pipette(k: Kernel, tool: string, source: string, destination: string, volume: string, newTip = true) {
  if (newTip) {
    if ((k.world.equipment[tool].state as { tip: unknown }).tip) k.execute({ op: 'core:eject-tip', params: { pipette: tool } })
    expect(k.execute({ op: 'core:attach-tip', params: { pipette: tool } }).ok).toBe(true)
  }
  const r = k.execute({ op: 'core:transfer', params: { source, destination, volume, tool } })
  if (!r.ok) throw new Error(r.refusal.message)
  return r
}

const mgPerMl = (w: World, id: string, s = 'bio:bovine-serum-albumin') => {
  const c = w.containers[id].contents
  const m = meanLayer(c)
  return massConcentration(cat, s, m.species[s] ?? 0, liquidVolume(c))
}

describe('operations', () => {
  it('every declared operation is implemented and every implementation declared', () => {
    const declared = (readJson(join(PACKAGES, 'pack-core', 'catalogue', 'operations.json')) as OperationDecl[]).map((o) => o.id).sort()
    expect(Object.keys(OPERATIONS).sort()).toEqual(declared)
  })
})

describe('kernel: transfers', () => {
  it('delivers close to the requested volume and dilutes correctly', () => {
    const k = createKernel(cat, bench())
    pipette(k, 'p1000', 'pbs', 't1', '450 uL')
    pipette(k, 'p200', 'bsa', 't1', '50 uL')
    k.execute({ op: 'core:mix', params: { container: 't1', method: 'vortex' } })
    const v = liquidVolume(k.world.containers.t1.contents)
    expect(v).toBeGreaterThan(495e-6)
    expect(v).toBeLessThan(505e-6)
    expect(mgPerMl(k.world, 't1')).toBeGreaterThan(0.19)
    expect(mgPerMl(k.world, 't1')).toBeLessThan(0.21)
  })

  it('refuses only the physically impossible, and leaves no partial state', () => {
    const k = createKernel(cat, bench())
    const before = clone(k.world)
    expect(k.execute({ op: 'core:transfer', params: { source: 'bsa', destination: 't1', volume: '50 uL', tool: 'p200' } })).toMatchObject({ ok: false, refusal: { code: 'NO-TIP' } })
    k.execute({ op: 'core:attach-tip', params: { pipette: 'p20' } })
    const afterTip = clone(k.world)
    expect(k.execute({ op: 'core:transfer', params: { source: 'bsa', destination: 't1', volume: '150 uL', tool: 'p20' } })).toMatchObject({ ok: false, refusal: { code: 'OUT-OF-RANGE' } })
    expect(k.world).toEqual(afterTip)
    expect(k.execute({ op: 'core:attach-tip', params: { pipette: 'p20' } })).toMatchObject({ ok: false, refusal: { code: 'TIP-ATTACHED' } })
    expect(k.execute({ op: 'core:transfer', params: { source: 't1', destination: 't2', volume: '10 uL', tool: 'p20' } })).toMatchObject({ ok: false, refusal: { code: 'NOT-ENOUGH' } })
    expect(k.attempts.length).toBe(4)
    expect(before.containers.bsa).toEqual(k.world.containers.bsa)
  })

  it('refuses to overfill a well', () => {
    const k = createKernel(cat, bench())
    pipette(k, 'p1000', 'pbs', 'plate/A1', '300 uL')
    k.execute({ op: 'core:eject-tip', params: { pipette: 'p1000' } })
    k.execute({ op: 'core:attach-tip', params: { pipette: 'p200' } })
    expect(k.execute({ op: 'core:transfer', params: { source: 'pbs', destination: 'plate/A1', volume: '100 uL', tool: 'p200' } })).toMatchObject({ ok: false, refusal: { code: 'OVERFLOW' } })
  })

  it('is deterministic per seed and replays exactly', () => {
    const run = (seed: number) => {
      const k = createKernel(cat, bench(seed))
      pipette(k, 'p200', 'pbs', 't1', '100 uL')
      pipette(k, 'p200', 'pbs', 't2', '100 uL')
      return k
    }
    const a = run(7)
    const b = run(7)
    const c = run(8)
    expect(a.world).toEqual(b.world)
    expect(liquidVolume(a.world.containers.t1.contents)).not.toBe(liquidVolume(c.world.containers.t1.contents))
    // Replicates differ within one run (seeded per event).
    expect(liquidVolume(a.world.containers.t1.contents)).not.toBe(liquidVolume(a.world.containers.t2.contents))
    const replay = createKernel(cat, bench(7))
    for (const intent of a.log()) replay.execute(intent)
    expect(replay.world).toEqual(a.world)
  })
})

describe('kernel: consequences', () => {
  it('a reused tip carries analyte into the next tube and back into a stock', () => {
    const k = createKernel(cat, bench())
    pipette(k, 'p200', 'bsa', 't1', '100 uL')
    // Same tip into the PBS bottle and on into a "blank".
    const r = k.execute({ op: 'core:transfer', params: { source: 'pbs', destination: 't2', volume: '100 uL', tool: 'p200' } })
    expect(r.ok && r.event.facts.tipFresh).toBe(false)
    expect(mgPerMl(k.world, 't2')).toBeGreaterThan(0)
    expect(molarConc(k.world.containers.pbs.contents, 'bio:bovine-serum-albumin')).toBeGreaterThan(0)
    expect(k.world.provenance.some((e) => e.kind === 'carryover' && e.to === 'pbs')).toBe(true)
  })

  it('an unmixed tube is layered and gives a biased sample until mixed', () => {
    const k = createKernel(cat, bench())
    pipette(k, 'p200', 'bsa', 't1', '100 uL')
    pipette(k, 'p1000', 'pbs', 't1', '900 uL')
    expect(homogeneity(k.world.containers.t1.contents)).toBeLessThan(0.5)
    // Sampling from the top of the unmixed tube draws mostly buffer.
    pipette(k, 'p200', 't1', 't2', '100 uL')
    expect(mgPerMl(k.world, 't2')).toBeLessThan(0.1)
    k.execute({ op: 'core:mix', params: { container: 't1', method: 'vortex' } })
    pipette(k, 'p200', 't1', 't3', '100 uL')
    // The first draw took mostly buffer, so the mixed remainder is more concentrated than 0.2 mg/mL.
    expect(mgPerMl(k.world, 't3')).toBeGreaterThan(0.205)
    expect(mgPerMl(k.world, 't3')).toBeLessThan(0.235)
  })

  it('develops BCA colour graded with protein, faster at 37 °C than on the bench', () => {
    const k = createKernel(cat, bench(), { noise: 0, handlingError: 0 })
    const stds = ['0 mg/mL', '0.5 mg/mL', '1.0 mg/mL', '2.0 mg/mL']
    const wells = ['A1', 'A2', 'A3', 'A4']
    // Standards made by hand, 100 µL each.
    stds.forEach((target, i) => {
      const sv = (Number(target.split(' ')[0]) / 2) * 100
      if (100 - sv > 0) pipette(k, 'p200', 'pbs', `t${i + 1}`, `${100 - sv} uL`)
      if (sv > 0) pipette(k, 'p200', 'bsa', `t${i + 1}`, `${sv} uL`)
      k.execute({ op: 'core:mix', params: { container: `t${i + 1}` } })
      pipette(k, 'p200', `t${i + 1}`, `plate/${wells[i]}`, '25 uL')
      pipette(k, 'p200', `t${i + 1}`, `plate/B${i + 1}`, '25 uL')
    })
    for (const r of ['A', 'B']) for (let c = 1; c <= 4; c++) pipette(k, 'p200', 'wr', `plate/${r}${c}`, '200 uL')
    // Row A at 37 °C for 30 min; row B stays on the bench: the plate moves as a whole, so read B first.
    k.execute({ op: 'core:advance-time', params: { duration: '30 min' } })
    const benchRead = k.execute({ op: 'core:measure', params: { instrument: 'reader', subject: 'plate', wavelength: '562 nm' } })
    expect(benchRead.ok).toBe(true)
    k.execute({ op: 'core:place-in', params: { container: 'plate', place: 'incubator' } })
    k.execute({ op: 'core:advance-time', params: { duration: '30 min' } })
    const warm = k.execute({ op: 'core:measure', params: { instrument: 'reader', subject: 'plate', wavelength: '562 nm' } })
    if (!warm.ok || !benchRead.ok) throw new Error('read failed')
    const rec = (id: unknown) => k.world.measurements.find((m) => m.id === id)!
    const a = wells.map((w) => rec(warm.outputs.record).values![`plate/${w}`])
    const rt = wells.map((w) => rec(benchRead.outputs.record).values![`plate/${w}`])
    // Monotonic, blank about 0.1, top standard well above 1.
    expect(a[0]).toBeGreaterThan(0.06)
    expect(a[0]).toBeLessThan(0.15)
    expect(a[1]).toBeGreaterThan(a[0])
    expect(a[2]).toBeGreaterThan(a[1])
    expect(a[3]).toBeGreaterThan(1.0)
    // Mild curvature: the top step is smaller than proportional.
    expect((a[3] - a[0]) / (a[2] - a[0])).toBeLessThan(1.98)
    expect((a[3] - a[0]) / (a[2] - a[0])).toBeGreaterThan(1.6)
    // 30 min at room temperature develops less colour than 30 + 30 min with 37 °C.
    expect(rt[3]).toBeLessThan(a[3])
  })

  it('shows OVER when the absorbance is beyond the reader', () => {
    const w = bench()
    addSupply(w, cat, { id: 'dye', label: 'Dye', container: 'core:microtube-2ml', amount: '1 mL', components: [{ substance: 'bio:bca-cu-complex', conc: '5 mM' }] })
    const k = createKernel(cat, w)
    pipette(k, 'p200', 'dye', 'plate/H12', '200 uL')
    const r = k.execute({ op: 'core:measure', params: { instrument: 'reader', subject: 'plate', wavelength: '562 nm' } })
    if (!r.ok) throw new Error(r.refusal.message)
    const m = k.world.measurements.at(-1)!
    expect(m.display['plate/H12']).toBe('OVER')
    expect(m.flags['plate/H12']).toContain('saturated')
  })

  it('refuses wavelengths outside the instrument and non-cuvettes in a spectrophotometer', () => {
    const k = createKernel(cat, bench())
    expect(k.execute({ op: 'core:measure', params: { instrument: 'spec', subject: 't1', wavelength: '562 nm' } })).toMatchObject({ ok: false, refusal: { code: 'NOT-A-CUVETTE' } })
    expect(k.execute({ op: 'core:measure', params: { instrument: 'spec', subject: 't1', wavelength: '280 nm' } })).toMatchObject({ ok: false, refusal: { code: 'WAVELENGTH' } })
  })
})

describe('kernel: enzymes and time', () => {
  function ldhWorld(activity = 1) {
    const w = bench()
    addSupply(w, cat, { id: 'nadh', label: 'NADH 10 mM', container: 'core:microtube-2ml', amount: '1 mL', preparation: 'bio:nadh-stock-10mm' })
    addSupply(w, cat, { id: 'pyr', label: 'Pyruvate 100 mM', container: 'core:microtube-2ml', amount: '1 mL', preparation: 'bio:pyruvate-stock-100mm' })
    addSupply(w, cat, { id: 'ldh', label: 'LDH', container: 'core:microtube-1.5ml', amount: '0.5 mL', components: [{ substance: 'bio:ldh', conc: '2 ug/mL' }], activityFactor: activity })
    return w
  }

  it('NADH falls at 340 nm at a rate set by the enzyme', () => {
    const run = (activity: number) => {
      const k = createKernel(cat, ldhWorld(activity), { noise: 0, handlingError: 0 })
      pipette(k, 'p200', 'pbs', 'plate/A1', '170 uL')
      pipette(k, 'p20', 'nadh', 'plate/A1', '4 uL')
      pipette(k, 'p20', 'pyr', 'plate/A1', '6 uL')
      pipette(k, 'p20', 'ldh', 'plate/A1', '20 uL')
      k.execute({ op: 'core:mix', params: { container: 'plate', method: 'shake' } })
      const r = k.execute({ op: 'core:measure', params: { instrument: 'reader', subject: 'plate', wavelength: '340 nm', mode: 'kinetic', interval: '30 s', duration: '5 min' } })
      if (!r.ok) throw new Error(r.refusal.message)
      return k.world.measurements.at(-1)!.series!['plate/A1']
    }
    const full = run(1)
    const half = run(0.5)
    expect(full[0]).toBeGreaterThan(full[full.length - 1])
    const d1 = full[0] - full[4]
    const d2 = half[0] - half[4]
    expect(d1 / d2).toBeGreaterThan(1.7)
    expect(d1 / d2).toBeLessThan(2.3)
  })

  it('an enzyme left at 37 °C loses activity, not protein', () => {
    const k = createKernel(cat, ldhWorld())
    k.execute({ op: 'core:place-in', params: { container: 'ldh', place: 'incubator' } })
    k.execute({ op: 'core:advance-time', params: { duration: '6 h' } })
    const layer = meanLayer(k.world.containers.ldh.contents)
    const total = layer.species['bio:ldh']
    const active = layer.active?.['bio:ldh'] ?? total
    expect(active / total).toBeGreaterThan(0.4)
    expect(active / total).toBeLessThan(0.6)
  })
})

describe('kernel: weighing and volumetric work', () => {
  it('weighs by difference and makes up to the mark', () => {
    const w = bench()
    addSupply(w, cat, { id: 'khp', label: 'KHP', container: 'core:reagent-bottle-50ml', amount: '20 g', solid: 'core:potassium-hydrogen-phthalate' })
    addContainer(w, cat, { id: 'boat', equipment: 'core:weighing-boat' })
    addContainer(w, cat, { id: 'flask', equipment: 'core:volumetric-flask-100ml' })
    addSupply(w, cat, { id: 'water', label: 'Deionised water', container: 'core:reagent-bottle-1l', amount: '1 L', preparation: 'core:water-deionised' })
    const k = createKernel(cat, w)
    k.execute({ op: 'core:place-in', params: { container: 'boat', place: 'balance' } })
    k.execute({ op: 'core:tare', params: { balance: 'balance' } })
    k.execute({ op: 'core:add-solid', params: { substance: 'khp', destination: 'boat', mass: '0.5 g' } })
    const r = k.execute({ op: 'core:weigh', params: { balance: 'balance' } })
    if (!r.ok) throw new Error('weigh failed')
    const grams = Number(r.event.facts.valueG)
    expect(grams).toBeGreaterThan(0.4)
    expect(grams).toBeLessThan(0.6)
    // The reading is to 0.1 mg and close to the truth.
    const truthG = (k.world.containers.boat.contents.solid['core:potassium-hydrogen-phthalate'] ?? 0) * 204.22
    expect(Math.abs(grams - truthG)).toBeLessThan(0.0006)
    // Transfer the solid by pouring the boat's contents is not modelled yet: weigh straight into the flask instead.
    k.execute({ op: 'core:add-solid', params: { substance: 'khp', destination: 'flask', mass: '0.5 g' } })
    expect(k.execute({ op: 'core:make-up-to-mark', params: { container: 'flask', solvent: 'water' } }).ok).toBe(true)
    k.execute({ op: 'core:close', params: { container: 'flask' } })
    k.execute({ op: 'core:mix', params: { container: 'flask', method: 'invert', cycles: 10 } })
    const v = liquidVolume(k.world.containers.flask.contents)
    expect(Math.abs(v - 0.1)).toBeLessThanOrEqual(0.0001)
    expect(Object.values(k.world.containers.flask.contents.solid).every((n) => n < 1e-12)).toBe(true)
  })

  it('inverting an open flask spills it', () => {
    const w = bench()
    addContainer(w, cat, { id: 'flask', equipment: 'core:volumetric-flask-100ml' })
    addSupply(w, cat, { id: 'water', label: 'Deionised water', container: 'core:reagent-bottle-1l', amount: '1 L', preparation: 'core:water-deionised' })
    const k = createKernel(cat, w)
    k.execute({ op: 'core:make-up-to-mark', params: { container: 'flask', solvent: 'water' } })
    const r = k.execute({ op: 'core:mix', params: { container: 'flask', method: 'invert' } })
    expect(r.ok && r.event.facts.spilledL).toBeGreaterThan(0.01)
  })

  it('making up to the mark blends the temperature of the flask with the solvent', () => {
    const w = bench()
    addContainer(w, cat, { id: 'flask', equipment: 'core:volumetric-flask-25ml' })
    addSupply(w, cat, { id: 'stock', label: 'Iced stock', container: 'core:microtube-2ml', amount: '1 mL', components: [{ substance: 'bio:pnpp', conc: '50 mM' }] })
    addSupply(w, cat, { id: 'water', label: 'Deionised water', container: 'core:reagent-bottle-1l', amount: '1 L', preparation: 'core:water-deionised' })
    w.containers.stock.contents.temperatureK = 273.15
    const room = w.containers.water.contents.temperatureK
    const k = createKernel(cat, w)
    pipette(k, 'p1000', 'stock', 'flask', '500 uL')
    expect(k.execute({ op: 'core:make-up-to-mark', params: { container: 'flask', solvent: 'water' } }).ok).toBe(true)
    // 0.5 mL from ice made up with 24.5 mL at room temperature: not the stock's 0 °C.
    expect(Math.abs(k.world.containers.flask.contents.temperatureK - (273.15 * 0.5 + room * 24.5) / 25)).toBeLessThan(0.05)
  })

  it('pouring it all across leaves only a film on the walls, and takes no tool', () => {
    const w = bench()
    addContainer(w, cat, { id: 'flask', equipment: 'core:volumetric-flask-25ml' })
    addContainer(w, cat, { id: 'conical', equipment: 'core:conical-flask-100ml' })
    addSupply(w, cat, { id: 'water', label: 'Deionised water', container: 'core:reagent-bottle-1l', amount: '1 L', preparation: 'core:water-deionised' })
    const k = createKernel(cat, w)
    k.execute({ op: 'core:make-up-to-mark', params: { container: 'flask', solvent: 'water' } })
    const before = liquidVolume(k.world.containers.flask.contents)
    expect(k.execute({ op: 'core:transfer', params: { source: 'flask', destination: 'conical', all: true } }).ok).toBe(true)
    const left = liquidVolume(k.world.containers.flask.contents)
    expect(left).toBeGreaterThan(0.1e-3)
    expect(left).toBeLessThan(0.3e-3)
    expect(liquidVolume(k.world.containers.conical.contents)).toBeCloseTo(before - left, 9)
    expect(k.execute({ op: 'core:transfer', params: { source: 'conical', destination: 'flask', all: true, tool: 'p1000' } }).ok).toBe(false)
    expect(k.execute({ op: 'core:transfer', params: { source: 'conical', destination: 'flask' } }).ok).toBe(false)
  })

  it('a cuvette has no cap of its own, but Parafilm seals it for inversion', () => {
    const w = bench()
    addContainer(w, cat, { id: 'cuv', equipment: 'core:cuvette-ps-macro-1cm' })
    addSupply(w, cat, { id: 'water', label: 'Deionised water', container: 'core:reagent-bottle-1l', amount: '1 L', preparation: 'core:water-deionised' })
    const k = createKernel(cat, w)
    expect(k.execute({ op: 'core:transfer', params: { source: 'water', destination: 'cuv', volume: '3 mL', tool: 'pour' } }).ok).toBe(true)
    const refused = k.execute({ op: 'core:close', params: { container: 'cuv' } })
    expect(!refused.ok && refused.refusal.code).toBe('NO-CLOSURE')
    expect(k.execute({ op: 'core:close', params: { container: 'cuv', cover: 'parafilm' } }).ok).toBe(true)
    const r = k.execute({ op: 'core:mix', params: { container: 'cuv', method: 'invert', cycles: 5 } })
    expect(r.ok && r.event.facts.spilledL).toBe(0)
  })
})
