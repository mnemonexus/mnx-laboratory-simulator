import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import {
  benchAnswer, benchIssues, benchPackSlice, benchWrongBeliefs, checkBench, createBench, evaluateBench,
  type BenchScene, type BenchTask, type TitrationOutcome, type MixOutcome, type BuretteOutcome, type DilutionOutcome,
} from '../src/bench/index.ts'

const packs = loadAllPacks()
const { catalogue: cat } = Catalogue.build(packs)

const strong: BenchScene = {
  kind: 'titration', flask: 'core:conical-flask-250ml', burette: 'core:burette-50ml-class-a', indicator: 'core:phenolphthalein',
  analyte: { substance: 'core:hydrochloric-acid', concentrationM: 0.1, volumeMl: 25 }, titrant: { substance: 'core:sodium-hydroxide', concentrationM: 0.1 },
}
const weak: BenchScene = { ...strong, analyte: { substance: 'core:acetic-acid', concentrationM: 0.1, volumeMl: 25 } }
const mix: BenchScene = {
  kind: 'mix', vessel: 'core:beaker-100ml', indicator: 'core:universal-indicator',
  portions: [{ substance: 'core:hydrochloric-acid', concentrationM: 0.1, volumeMl: 20 }, { substance: 'core:sodium-hydroxide', concentrationM: 0.1, volumeMl: 10 }],
}
const burette: BenchScene = { kind: 'burette', burette: 'core:burette-50ml-class-a', startMl: 0.6, endMl: 24.41 }
const dilution: BenchScene = { kind: 'dilution', stock: { substance: 'core:hydrochloric-acid', concentrationM: 1 }, pipette: 'core:volumetric-pipette-25ml', flask: 'core:volumetric-flask-250ml' }
const task = (ask: BenchTask['ask'], extra: Partial<BenchTask> = {}): BenchTask => ({ id: ask, ask, criterionId: ask, ...extra })

describe('bench tools (focused lab science)', () => {
  it('a strong acid-strong base titration: equivalence from the solver curve, pH 7 there, phenolphthalein turns just after', () => {
    expect(benchIssues(cat, strong)).toEqual([])
    const o = evaluateBench(cat, strong) as TitrationOutcome
    expect(o.startPH).toBeCloseTo(1, 1)
    expect(o.equivalenceMl).toBeCloseTo(25, 1)
    expect(o.equivalencePH).toBeCloseTo(7, 0)
    expect(o.jump).toBeGreaterThan(4)
    expect(o.indicator?.startColour).toBe('colourless')
    expect(o.indicator?.endColour).toBe('pink')
    expect(Math.abs(o.indicator!.endPointErrorMl!)).toBeLessThan(0.1)
  })

  it('a weak acid: pH at half-equivalence is the pKa, the equivalence is alkaline', () => {
    const o = evaluateBench(cat, weak) as TitrationOutcome
    expect(o.halfEquivalencePH).toBeCloseTo(4.76, 1)
    expect(o.equivalenceMl).toBeCloseTo(25, 1)
    expect(o.equivalencePH).toBeGreaterThan(8)
    expect(o.equivalencePH).toBeLessThan(9.5)
  })

  it('methyl orange changes early for a weak acid', () => {
    const o = evaluateBench(cat, { ...weak, indicator: 'core:methyl-orange' } as BenchScene) as TitrationOutcome
    expect(o.indicator!.endPointMl!).toBeLessThan(o.equivalenceMl - 5)
  })

  it('acid meets base: excess acid left in the total volume', () => {
    const o = evaluateBench(cat, mix) as MixOutcome
    // 1 mmol of acid left in 30 mL: [H+] = 0.0333 mol/L, pH 1.48
    expect(o.pH).toBeCloseTo(1.48, 1)
    expect(o.acidity).toBe('acidic')
    expect(typeof o.colour).toBe('string')
    expect(o.colour).not.toBe('colourless')
  })

  it('reads a burette to the nearest division', () => {
    expect(benchIssues(cat, burette)).toEqual([])
    const o = evaluateBench(cat, burette) as BuretteOutcome
    expect(o.startReadingMl).toBe(0.6)
    expect(o.endReadingMl).toBe(24.4)
    expect(o.titreMl).toBe(23.8)
    expect(o.titreUncertaintyMl).toBe(0.1)
    expect(benchIssues(cat, { ...burette, endMl: 24.425 } as BenchScene).map((i) => i.path)).toEqual(['scene.endMl'])
  })

  it('a dilution: concentration, factor, percentage uncertainty from the glassware tolerances, and the new pH', () => {
    const o = evaluateBench(cat, dilution) as DilutionOutcome
    expect(o.factor).toBeCloseTo(10, 6)
    expect(o.concentrationM).toBeCloseTo(0.1, 6)
    expect(o.percentageUncertainty).toBeCloseTo(0.18, 3)
    expect(o.pH).toBeCloseTo(1, 1)
    const serial = evaluateBench(cat, { ...dilution, repeats: 2 } as BenchScene) as DilutionOutcome
    expect(serial.concentrationM).toBeCloseTo(0.01, 6)
    expect(serial.percentageUncertainty).toBeCloseTo(0.36, 3)
  })

  it('rejects unfair or impossible scenes in plain words', () => {
    const tooMuch = { ...strong, analyte: { ...(strong as { analyte: object }).analyte, concentrationM: 0.5 } } as BenchScene
    expect(benchIssues(cat, tooMuch)[0].message).toMatch(/not inside the burette/)
    const twoAcids = { ...strong, titrant: { substance: 'core:acetic-acid', concentrationM: 0.1 } } as BenchScene
    expect(benchIssues(cat, twoAcids)[0].message).toMatch(/acid and the other a base/)
    expect(benchIssues(cat, { ...strong, burette: 'core:beaker-250ml' } as BenchScene)[0].message).toMatch(/not a burette/)
    expect(benchIssues(cat, mix, task('titre'))[0].path).toBe('task.ask')
  })

  it('checks answers deterministically, with engine tolerances; blank answers earn nothing; wrong beliefs fail', () => {
    const cases: Array<[BenchScene, BenchTask]> = [
      [strong, task('equivalence-volume')], [strong, task('start-pH')], [strong, task('pH-at', { atMl: 10 })], [weak, task('half-equivalence-pH')],
      [weak, task('equivalence-pH')], [strong, task('end-point-volume')], [mix, task('pH')], [mix, task('acidity')], [mix, task('colour')],
      [burette, task('titre')], [burette, task('start-reading')], [burette, task('end-reading')], [dilution, task('concentration')],
      [dilution, task('dilution-factor')], [dilution, task('percentage-uncertainty')], [dilution, task('pH')],
    ]
    for (const [scene, t] of cases) {
      expect(benchIssues(cat, scene, t), t.ask).toEqual([])
      const answer = benchAnswer(cat, scene, t)
      const right = answer.type === 'choice' ? { choice: answer.value } : { value: answer.value }
      expect(checkBench(cat, scene, t, right).status, t.ask).toBe('correct')
      expect(checkBench(cat, scene, t, {}).status, t.ask).toBe('unsupported')
      expect(checkBench(cat, scene, t, {}).met).toBe(false)
      const wrong = benchWrongBeliefs(cat, scene, t)
      expect(wrong.length, `${t.ask} has a wrong belief`).toBeGreaterThan(0)
      for (const w of wrong) expect(checkBench(cat, scene, t, w.response).status, `${t.ask}: ${w.label}`).toBe('incorrect')
      if (answer.type === 'number') expect(checkBench(cat, scene, t, { value: answer.value + answer.tolerance * 3 + 0.01 }).met).toBe(false)
    }
  })

  it('the embedded slice gives the same answers as the whole catalogue', () => {
    const slice = benchPackSlice(packs)
    const bench = createBench(slice)
    expect(bench.substances.length).toBeGreaterThan(15)
    for (const scene of [strong, weak, mix, burette, dilution, { ...weak, indicator: 'core:methyl-orange' } as BenchScene]) expect(bench.evaluate(scene)).toEqual(evaluateBench(cat, scene))
    const size = JSON.stringify(slice).length
    expect(size).toBeLessThan(200_000)
  })
})
