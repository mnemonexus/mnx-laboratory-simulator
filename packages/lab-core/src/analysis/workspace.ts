// Presentation-independent preparation of learner data. Only displayed readings are used;
// a saturated/qualitative display is never replaced with a hidden measurement value.
import { parseValue, valueIn, type Quantity } from '../units/quantity.ts'
import { sameDim } from '../units/units.ts'
import type { StoredFit } from '../kernel/ops-data.ts'

export interface AnalysisItem {
  kind: 'analysis'
  operation: string
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
}

export function isAnalysisItem(value: unknown): value is AnalysisItem {
  if (!value || typeof value !== 'object') return false
  const a = value as AnalysisItem
  return a.kind === 'analysis' && typeof a.operation === 'string' && !!a.inputs && typeof a.inputs === 'object' && !!a.outputs && typeof a.outputs === 'object'
}

export function displayedQuantity(text: string): Quantity | null {
  try {
    const v = parseValue(text)
    return Number.isFinite(v.si) ? v : null
  } catch {
    return null
  }
}

export interface CalibrationRow { subject: string; display: string; x: string; flags: string[] }

/** Validate both axes, retaining quantities and the exact source displays for lineage. */
export function calibrationInput(rows: CalibrationRow[], measurement: string, xLabel: string): Record<string, unknown> {
  const selected = rows.filter((r) => r.x.trim())
  if (selected.length < 2) throw new Error('Enter X values for at least two standards.')
  const axis = (texts: string[], name: string): Quantity[] => {
    const values = texts.map((text) => {
      const value = displayedQuantity(text)
      if (!value) throw new Error(`${name}: "${text}" is not a numeric reading.`)
      return value
    })
    if (values.some((q) => !sameDim(q.dim, values[0].dim) || q.kind !== values[0].kind)) throw new Error(`${name} values must use compatible units.`)
    return values
  }
  const x = axis(selected.map((r) => r.x), 'X')
  const y = axis(selected.map((r) => r.display), 'Y')
  if (new Set(x.map((q) => q.si)).size < 2) throw new Error('Standards need at least two different X values.')
  return { x, y, sources: selected.map(({ subject, display, flags }) => ({ measurement, subject, display, flags })), xLabel }
}

export function calibrationPlot(item: AnalysisItem): { points: Array<{ x: number; y: number; residual: number }>; fit: StoredFit; xLabel: string; yLabel: string } | null {
  if (item.operation !== 'core:fit' || !Array.isArray(item.inputs.x) || !Array.isArray(item.inputs.y)) return null
  const quantity = (v: unknown): Quantity | null => typeof v === 'string' ? displayedQuantity(v) : v && typeof v === 'object' && 'si' in v ? v as Quantity : null
  const xs = item.inputs.x.map(quantity)
  const ys = item.inputs.y.map(quantity)
  const fit = item.outputs.fit as StoredFit | undefined
  if (!fit || !xs.length || xs.length !== ys.length || xs.some((q) => !q) || ys.some((q) => !q)) return null
  const number = (q: Quantity, first: Quantity) => first.unit ? valueIn(q, first.unit) : q.si
  const firstX = xs[0]!, firstY = ys[0]!
  const points = xs.map((q, i) => ({ x: number(q!, firstX), y: number(ys[i]!, firstY), residual: fit.residuals[i] }))
  return { points, fit, xLabel: `${String(item.inputs.xLabel || 'X')}${firstX.unit ? ` (${firstX.unit})` : ''}`, yLabel: `Reading${firstY.unit ? ` (${firstY.unit})` : ''}` }
}

export function interpolationInput(item: AnalysisItem, display: string, factor: string, source: { measurement: string; subject: string; flags?: string[] }): Record<string, unknown> {
  const plot = calibrationPlot(item)
  if (!plot || Math.abs(plot.fit.params.slope) < Number.EPSILON) throw new Error('This calibration cannot be inverted.')
  const reading = displayedQuantity(display)
  const raw = (item.inputs.y as unknown[])[0]
  const unit = typeof raw === 'string' ? parseValue(raw) : raw as Quantity
  if (!reading || !sameDim(reading.dim, unit.dim) || reading.kind !== unit.kind) throw new Error('Choose a numeric reading with the calibration’s Y units.')
  const dilution = Number(factor)
  if (!factor.trim() || !Number.isFinite(dilution) || dilution <= 0) throw new Error('Dilution factor must be greater than zero.')
  const y = unit.unit ? valueIn(reading, unit.unit) : reading.si
  return { fit: plot.fit, points: [y], factor: dilution, sources: [{ ...source, display }], calibration: item }
}
