// Variants (format §23): one definition yields several practicals, each a complete definition.
import { describe, expect, it } from 'vitest'
import { expandDefinition } from '../src/format/variants.ts'

const base = {
  format: 'lab-experiment',
  formatVersion: '0.1',
  id: 'chem-titration',
  version: '1.0.0',
  title: 'A titration',
  context: { keywords: ['titration'], curricula: ['A level'] },
  parameters: {
    acid: { default: 'core:hydrochloric-acid' },
    volume: { default: '25 mL' },
    lots: { default: [1, 2] },
  },
  materials: { supplies: [{ id: 'acid', preparation: '{{acid}}', amount: '{{volume}}', label: 'Acid ({{volume}})' }] },
  procedure: { steps: [{ id: 's', kind: 'operation', ref: 'core:record', params: { field: 'n', value: '{{lots}}', expr: "=first(recorded('{{acid}}'))" } }] },
  variants: [
    { id: 'chem-titration-vinegar', title: 'Vinegar', values: { acid: 'chem:vinegar', volume: '10 mL' }, keywords: ['vinegar'], curricula: ['GCSE'] },
    { id: 'chem-titration-default-volume', title: 'Default volume', values: { acid: 'chem:other' } },
  ],
}

describe('definition variants', () => {
  it('yields the definition with its defaults, then each variant', () => {
    const { definitions, problems } = expandDefinition(base)
    expect(problems).toEqual([])
    expect(definitions.map((d) => d.id)).toEqual(['chem-titration', 'chem-titration-vinegar', 'chem-titration-default-volume'])
    const [d0, d1, d2] = definitions.map((d) => d.json as unknown as typeof base)
    expect(d0.materials.supplies[0]).toEqual({ id: 'acid', preparation: 'core:hydrochloric-acid', amount: '25 mL', label: 'Acid (25 mL)' })
    expect(d1.materials.supplies[0]).toEqual({ id: 'acid', preparation: 'chem:vinegar', amount: '10 mL', label: 'Acid (10 mL)' })
    expect(d1.title).toBe('Vinegar')
    // Keywords add to the definition's own; curricula replace them.
    expect(d1.context).toEqual({ keywords: ['titration', 'vinegar'], curricula: ['GCSE'] })
    expect(d2.context).toEqual({ keywords: ['titration'], curricula: ['A level'] })
    expect(d2.materials.supplies[0].amount).toBe('25 mL')
    // A whole-string placeholder takes the value itself; inside a string, its text.
    expect(d0.procedure.steps[0].params).toEqual({ field: 'n', value: [1, 2], expr: "=first(recorded('core:hydrochloric-acid'))" })
    // The expanded definitions carry no parameters or variants of their own.
    for (const d of [d0, d1, d2]) expect('variants' in d || 'parameters' in d).toBe(false)
  })

  it('leaves a definition without variants unchanged', () => {
    const plain = { ...base, parameters: undefined, variants: undefined }
    delete (plain as Record<string, unknown>).parameters
    delete (plain as Record<string, unknown>).variants
    const { definitions } = expandDefinition(plain)
    expect(definitions).toHaveLength(1)
    expect(definitions[0].json).toBe(plain)
  })

  it('reports unknown parameters, duplicate ids and missing defaults', () => {
    const bad = {
      ...base,
      parameters: { acid: { default: 'x' }, broken: {} },
      materials: { supplies: [{ id: 'acid', preparation: '{{nosuch}}' }] },
      variants: [
        { id: 'chem-titration', title: 'Same id as the base' },
        { id: 'chem-titration-b', title: 'B', values: { nothere: 1 } },
      ],
    }
    const messages = expandDefinition(bad).problems.map((p) => `${p.path} ${p.message}`)
    expect(messages).toContain('/parameters/broken A parameter needs a default')
    expect(messages).toContain('/materials/supplies/0/preparation Unknown parameter "nosuch"')
    expect(messages).toContain('/variants/0/id Duplicate id "chem-titration"')
    expect(messages).toContain('/variants/1/values/nothere Unknown parameter "nothere"')
  })
})
