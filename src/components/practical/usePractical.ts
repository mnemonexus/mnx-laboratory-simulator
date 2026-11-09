// React access to the practical runtime: one runtime for the whole app (it outlives navigation),
// read through useSyncExternalStore.
import { createContext, useContext, useSyncExternalStore } from 'react'
import { format, isQuantity } from '../../../packages/lab-core/src/index.ts'
import type { PracticalRuntime, PracticalState } from '../../runtime/practical'

export const PracticalCtx = createContext<PracticalRuntime | null>(null)

export function usePracticalRuntime(): PracticalRuntime {
  const rt = useContext(PracticalCtx)
  if (!rt) throw new Error('PracticalCtx is missing')
  return rt
}

export function usePractical(): [PracticalState, PracticalRuntime] {
  const rt = usePracticalRuntime()
  const state = useSyncExternalStore(rt.subscribe, rt.getSnapshot, rt.getSnapshot)
  return [state, rt]
}

/** A value from the core as text (quantities, lists, records). */
export function show(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(5)))
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.map(show).join(', ')
  if (isQuantity(value)) return format(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
