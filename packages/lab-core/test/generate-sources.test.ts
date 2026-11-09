// The generator kit's source verification: quotes must occur in the source, and quantities must
// be stated in their quotes, whatever unit or typography the handbook used.
import { describe, expect, it } from 'vitest'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { normaliseText, numbersIn, quoteStates, verifySources } from '../src/generate/sources.ts'

const handbook = `Practical 3 – Protein assay
Pipette 20 µl of each standard into the wells, then add 200 μl of reagent.
Incubate the plate at 37 °C for 30 minutes, then read the absorbance at 562 nm.
The stock is 2 mg/ml BSA; dilute it 1 in 10 with PBS (0.1 M phosphate).`

const def = (annotations: unknown[]): ExperimentDefinition =>
  ({
    format: 'lab-experiment',
    formatVersion: '0.1',
    id: 'x',
    version: '1.0.0',
    title: 'x',
    procedure: { steps: [{ id: 'inc', kind: 'wait', duration: '30 min', params: { temperature: '37 Cel', volume: '0.2 mL' } }] },
    materials: { supplies: [{ id: 'bsa', contains: [{ substance: 'bio:bovine-serum-albumin', conc: '2.0 mg/mL' }] }] },
    provenance: { sources: [{ id: 'hb', kind: 'handbook', title: 'Practical 3' }], annotations },
  }) as unknown as ExperimentDefinition

describe('source verification', () => {
  it('folds typography: µ and μ, dashes, spacing and case', () => {
    expect(normaliseText('Pipette  20 µl\nof EACH – standard')).toBe('pipette 20 ul of each - standard')
  })

  it('reads numbers with their units, including ambiguous ones', () => {
    const n = numbersIn('read at 562 nm after 30 minutes')
    expect(n.map((x) => x.value)).toEqual([562, 30])
    // "nm": nanometres or nanomolar; both readings are kept.
    expect(n[0].alternatives.length).toBe(2)
  })

  it('finds a quantity in its quote in any compatible unit', () => {
    expect(quoteStates('add 200 μl of reagent', '0.2 mL')).toBe(true)
    expect(quoteStates('Incubate the plate at 37 °C for 30 minutes', '30 min')).toBe(true)
    expect(quoteStates('Incubate the plate at 37 °C for 30 minutes', '37 Cel')).toBe(true)
    expect(quoteStates('Incubate the plate at 37 °C for 30 minutes', '45 min')).toBe(false)
    expect(quoteStates('The stock is 2 mg/ml BSA', '2.0 mg/mL')).toBe(true)
  })

  it('verifies explicit details against the source and reports what it cannot support', () => {
    const r = verifySources(
      def([
        { path: '/procedure/steps/0/duration', class: 'source-explicit', source: 'hb', quote: 'Incubate the plate at 37 °C for 30 minutes' },
        { path: '/procedure/steps/0/params/volume', class: 'source-explicit', source: 'hb', quote: 'add 200 μl of reagent' },
        { path: '/materials/supplies/0/contains/0/conc', class: 'source-explicit', source: 'hb', quote: 'The stock is 5 mg/ml BSA' },
        { path: '/procedure/steps/0/params/temperature', class: 'source-explicit', source: 'hb', quote: 'add 200 μl of reagent' },
        { path: '/procedure/steps/3', class: 'general-knowledge' },
        { path: '/procedure/steps/0', class: 'source-explicit' },
      ]),
      { hb: handbook },
    )
    const codes = r.findings.map((f) => f.code)
    expect(r.verified).toBe(2)
    expect(codes).toContain('ED-VS-QUOTE-NOT-FOUND')
    expect(codes).toContain('ED-VS-VALUE-NOT-IN-QUOTE')
    expect(codes).toContain('ED-VS-PATH-NOT-FOUND')
    expect(codes).toContain('ED-VS-NO-QUOTE')
    expect(r.counts['source-explicit']).toBe(5)
  })
})

describe('percentages', () => {
  it('reads a percentage of a solid as w/v', () => {
    expect(quoteStates('10 µl of 5% bromophenol blue', '50 g/L')).toBe(true)
    expect(quoteStates('10 µl of 5% bromophenol blue', '5 g/L')).toBe(false)
  })
})

describe('ranges', () => {
  it('reads "10-15 seconds" as a range, not a negative number', () => {
    expect(numbersIn('Centrifuge 10-15 seconds').map((n) => n.value)).toEqual([10, 15])
    expect(quoteStates('Centrifuge 10-15 seconds', '15 s')).toBe(true)
    expect(numbersIn('cool to -20 °C')[0].value).toBe(-20)
    // A spaced dash after a number is still a range ("3 -5 minutes").
    expect(numbersIn('run for 3 -5 minutes').map((n) => n.value)).toEqual([3, 5])
  })

  it('closes a stray space after a decimal point', () => {
    expect(quoteStates('To each aseptically add 0. 9 ml of Ringer', '0.9 mL')).toBe(true)
  })

  it('reads small numbers written as words', () => {
    expect(quoteStates('count one of the 4 outer corner squares', 1)).toBe(true)
    expect(quoteStates('Repeat this three or four times', 3)).toBe(true)
    expect(numbersIn('someone weighed it').length).toBe(0)
  })
})
