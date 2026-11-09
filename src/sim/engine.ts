// Simulation core: transfers, mixing, instrument models, kinetics.
// 100% pure + deterministic. Designed to run inside a Web Worker;
// the renderer NEVER imports this — it only receives VisualState.
import type { LabState, NoteKind, ReaderSettings, Sample } from './model'
import { jitter, mixHex, parseWell, uL, wellId } from './rng'
import type { PipetteDef, ReagentDef } from '../content/catalog'
import { PIPETTES } from '../content/catalog'

export const INSTRUMENT = {
  absorbance: { noiseSD: 0.0025, offsetSD: 0.0018, max: 3.0 },
  kinetics: { noiseSD: 0.0022, offsetSD: 0.0015, max: 3.0 },
} as const

export interface EngineMsg {
  kind: NoteKind
  text: string
}

function michaelisRate(S: number, activity: number, Vmax = 52, Km = 180): number {
  return ((Vmax * activity) * S) / (Km + S)
}

/** Raw instrument signal for a well. Deterministic per (plate, well, λ, t). */
export function wellSignal(
  state: LabState,
  r: number,
  c: number,
  settings: ReaderSettings,
  mode: 'endpoint' | 'kinetics' = 'endpoint',
  tSec = 0,
  vmax = 52,
  km = 180,
): number {
  const well = state.plate.wells[r][c]
  if (!well) return NaN
  const seed = `${state.plate.label}-${wellId(r, c)}-${settings.wavelength}-${tSec}`
  const inst = mode === 'kinetics' ? INSTRUMENT.kinetics : INSTRUMENT.absorbance
  const offset = jitter(seed + ':off', inst.offsetSD)
  let sig = 0
  if (well.enzyme) {
    const v0 = michaelisRate(well.concentration, well.activity ?? 1, vmax, km)
    const A0 = 0.65 * (well.activity ?? 1) * Math.min(1, well.concentration / 50)
    const consumed = Math.min(A0, ((v0 * tSec) / (0.0018 * well.volume)) * (well.activity ?? 1))
    sig = A0 - consumed
  } else {
    const eps =
      settings.wavelength === 595 ? 0.00412 : settings.wavelength === 562 ? 0.000721 : settings.wavelength === 280 ? 0.0021 : settings.wavelength === 340 ? 0.0006 : 0.0011
    sig = well.concentration * eps * (well.activity ?? 1)
  }
  sig += offset
  sig = Math.max(0, Math.min(inst.max, sig + jitter(seed + ':n', inst.noiseSD)))
  return sig
}

export interface TransferOpts {
  source: string
  dest: string
  vol: number
  pipette: string
  newTip: boolean
  discard?: boolean
}

export function transfer(state: LabState, o: TransferOpts): { next: LabState; messages: EngineMsg[]; ok: boolean } {
  const s: LabState = {
    ...state,
    samples: { ...state.samples },
    plate: { ...state.plate, wells: state.plate.wells.map((row) => [...row]) },
    log: [...state.log],
    notes: [...state.notes],
  }
  const msgs: EngineMsg[] = []
  const push = (kind: NoteKind, text: string) => {
    msgs.push({ kind, text })
    s.notes.push({ time: s.clock, kind, text })
  }
  const p: PipetteDef | undefined = PIPETTES.find((x) => x.id === o.pipette)
  if (!p) {
    push('warning', `Unknown pipette ${o.pipette}.`)
    return { next: s, messages: msgs, ok: false }
  }
  if (!(o.vol >= p.min && o.vol <= p.max)) {
    push('warning', `${p.id} cannot deliver ${uL(o.vol)} — range is ${uL(p.min)}–${uL(p.max)}.`)
    return { next: s, messages: msgs, ok: false }
  }
  const src = s.samples[o.source]
  if (!src || src.volume < o.vol - 1e-9) {
    push('warning', `Only ${uL(src?.volume ?? 0)} of ${src?.name ?? o.source} remains — insufficient for ${uL(o.vol)}.`)
    return { next: s, messages: msgs, ok: false }
  }
  if (!o.newTip && state.tipContaminated && !o.discard) {
    push('warning', `Tip reused (carries ${state.tipContaminated}). Trace carryover contaminates the destination.`)
    const contam = s.samples[state.tipContaminated]
    if (contam && contam.concentration > 0 && o.dest !== 'waste') {
      const target = wellOf(s, o.dest) ?? s.samples[o.dest]
      if (target) {
        const mixV = target.volume + o.vol
        target.concentration = (target.concentration * target.volume + contam.concentration * 0.05 * o.vol) / mixV
        target.volume = mixV
        target.history.push(`carryover from tip (${state.tipContaminated})`)
      }
    }
  }
  const edgeErr = o.vol <= p.min * 1.2 || o.vol >= p.max * 0.9 ? 0.02 : 0.005
  const actualVol = o.vol * (1 + jitter(`pip-${o.source}-${o.dest}-${o.vol}`, edgeErr))

  if (o.discard || o.dest === 'waste') {
    src.volume = Math.max(0, src.volume - actualVol)
    src.history.push(`discarded ${uL(o.vol)} (waste)`)
    s.waste += actualVol
    push('action', `Discarded ${uL(o.vol)} of ${src.name} to waste.`)
    s.tipContaminated = o.newTip ? null : o.source
    s.tipNew = o.newTip
    s.pipette = o.pipette
    return { next: s, messages: msgs, ok: true }
  }

  const isWell = o.dest.startsWith(state.plate.label + '!')
  let d: Sample | null = null
  if (isWell) {
    const [r, c] = parseWell(o.dest.slice(state.plate.label.length + 1))
    if (!s.plate.wells[r][c]) {
      s.plate.wells[r][c] = {
        id: o.dest,
        name: `Well ${wellId(r, c)}`,
        volume: 0,
        capacity: 400,
        concentration: 0,
        color: src.color,
        enzyme: src.enzyme,
        substrate: src.substrate,
        activity: 1,
        history: [],
      }
    }
    d = s.plate.wells[r][c]
  } else {
    d = s.samples[o.dest] ?? null
    if (!d) {
      push('warning', `Destination ${o.dest} not found.`)
      return { next: s, messages: msgs, ok: false }
    }
  }
  if (d!) {
    const mixV = d!.volume + actualVol
    const actMass =
      (d!.activity ?? 1) * d!.concentration * d!.volume + (src.activity ?? 1) * src.concentration * actualVol
    d!.concentration = mixV > 0 ? (d!.concentration * d!.volume + src.concentration * actualVol) / mixV : 0
    d!.activity = d!.concentration > 0 ? actMass / (d!.concentration * mixV) : 0
    d!.color = mixHex(d!.color, src.color, d!.volume, actualVol)
    d!.volume = mixV
    if (src.enzyme) d!.enzyme = true
    d!.history.push(`+${uL(o.vol)} ${src.name}`)
    src.volume = Math.max(0, src.volume - actualVol)
    src.history.push(`-${uL(o.vol)} → ${d!.name}`)
    push('action', `Transferred ${uL(o.vol)} ${src.name} → ${d!.name} (${p.id}${o.newTip ? ', fresh tip' : ', reused tip'}).`)
  }
  s.tipContaminated = o.newTip ? null : o.source
  s.tipNew = o.newTip
  s.pipette = o.pipette
  s.log = [...s.log, `${o.source}→${o.dest}:${o.vol}µL/${o.pipette}`]
  return { next: s, messages: msgs, ok: true }
}

function wellOf(s: LabState, dest: string): Sample | null {
  if (!dest.startsWith(s.plate.label + '!')) return null
  const [r, c] = parseWell(dest.slice(s.plate.label.length + 1))
  return s.plate.wells[r]?.[c] ?? null
}

export interface ReadResult {
  next: LabState
  values: Record<string, number>
  saturated: number
}

export function readPlate(state: LabState, settings: ReaderSettings, wlLabel: string): ReadResult {
  const next: LabState = { ...state, notes: [...state.notes], measurements: [...state.measurements] }
  const values: Record<string, number> = {}
  let n = 0
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 12; c++) {
      const w = next.plate.wells[r][c]
      if (!w) continue
      const id = wellId(r, c)
      if (settings.blank) {
        const [br, bc] = parseWell(settings.blank)
        const b = wellSignal(next, br, bc, settings, 'endpoint')
        values[id] = Math.max(0, wellSignal(next, r, c, settings, 'endpoint') - b)
      } else values[id] = wellSignal(next, r, c, settings, 'endpoint')
      n++
    }
  const raw = !settings.blank
  next.measurements.push({ time: next.clock, plate: state.plate.label, settings: wlLabel, blank: settings.blank, values, raw })
  next.blankUsed = settings.blank || null
  next.notes.push({
    time: next.clock,
    kind: 'measurement',
    text: `Plate read · ${wlLabel} · ${n} wells · ${raw ? 'RAW — no blank' : `blank ${settings.blank}`}.`,
  })
  if (raw)
    next.notes.push({ time: next.clock, kind: 'warning', text: 'No blank well designated. Signals include background.' })
  const saturated = Object.values(values).filter((v) => v > 2).length
  if (saturated > 0)
    next.notes.push({ time: next.clock, kind: 'warning', text: `${saturated} well(s) exceed A=2.0 — outside reliable range.` })
  return { next, values, saturated }
}

export interface KineticsResult {
  next: LabState
  key: string
  wells: string[]
}

export function runKinetics(
  state: LabState,
  settings: ReaderSettings,
  vmax = 52,
  km = 180,
): KineticsResult {
  const next: LabState = { ...state, notes: [...state.notes], timeCourses: { ...state.timeCourses } }
  const times = Array.from({ length: 41 }, (_, i) => i * 15)
  const key = `${state.plate.label}·${settings.wavelength}nm·${Math.floor(next.clock)}s`
  const wells: string[] = []
  const pts = times.map((t) => {
    const values: Record<string, number> = {}
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 12; c++) {
        const w = next.plate.wells[r][c]
        if (w && w.enzyme) {
          const id = wellId(r, c)
          values[id] = wellSignal(next, r, c, settings, 'kinetics', t, vmax, km)
          if (t === 0) wells.push(id)
        }
      }
    let blank = 0
    if (settings.blank) {
      const [br, bc] = parseWell(settings.blank)
      blank = wellSignal(next, br, bc, settings, 'kinetics', t, vmax, km)
    }
    return { t, blank, values }
  })
  next.timeCourses[key] = pts
  next.clock += 600
  next.notes.push({ time: next.clock, kind: 'measurement', text: `Kinetic run complete · 10 min · ${wells.length} traces · ${settings.blank ? 'blank-corrected' : 'raw'}.` })
  return { next, key, wells }
}

export function makeLab(plateLabel: string, reagents: ReagentDef[], stockVolume = 2000): LabState {
  const samples: Record<string, Sample> = {}
  const rack: string[] = []
  for (const r of reagents) {
    samples[r.id] = {
      id: r.id,
      name: r.name,
      volume: r.volume ?? stockVolume,
      capacity: r.volume ?? stockVolume,
      concentration: r.conc,
      color: r.color,
      activity: r.activity,
      enzyme: r.kind === 'protein',
      substrate: r.kind === 'substrate',
      stock: true,
      degraded: r.degraded,
      description: r.hint,
      history: ['reagent stock on bench'],
    }
    rack.push(r.id)
  }
  return {
    samples,
    rack,
    plate: { label: plateLabel, wells: Array.from({ length: 8 }, () => Array.from({ length: 12 }, () => null)) },
    waste: 0,
    clock: 0,
    notes: [{ time: 0, kind: 'system', text: 'Lab session started. Stocks at room temperature.' }],
    pipette: 'P200',
    tipNew: true,
    tipContaminated: null,
    measurements: [],
    timeCourses: {},
    blankUsed: null,
    done: false,
    log: [],
    flags: {},
  }
}

export function fitLinear(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 }
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0,
    sxx = 0,
    syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = my - slope * mx
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2 }
}

export function fitMichaelis(S: number[], v: number[]): { Vmax: number; Km: number } {
  let Vmax = Math.max(...v) * 2 || 1
  let Km = Math.min(...S.filter((s) => s > 0)) || 50
  for (let iter = 0; iter < 300; iter++) {
    let dV = 0,
      dK = 0,
      dVV = 0,
      dKK = 0,
      dVK = 0
    for (let i = 0; i < S.length; i++) {
      if (S[i] <= 0) continue
      const f = (Vmax * S[i]) / (Km + S[i])
      const r = v[i] - f
      const dVd = S[i] / (Km + S[i])
      const dKd = (-Vmax * S[i]) / (Km + S[i]) ** 2
      dV += r * dVd
      dK += r * dKd
      dVV += dVd * dVd
      dKK += dKd * dKd
      dVK += dVd * dKd
    }
    const det = dVV * dKK - dVK * dVK
    if (Math.abs(det) < 1e-12) break
    const dVmax = (dV * dKK - dK * dVK) / det
    const dKm = (dK * dVV - dV * dVK) / det
    Vmax += dVmax
    Km += dKm
    if (Vmax <= 0) Vmax = Math.max(...v) * 2
    if (Km <= 0) Km = 1
    if (Math.abs(dVmax) < 1e-6 && Math.abs(dKm) < 1e-6) break
  }
  return { Vmax, Km }
}

export function trueRate(S: number, Vmax: number, Km: number): number {
  return (Vmax * S) / (Km + S)
}
