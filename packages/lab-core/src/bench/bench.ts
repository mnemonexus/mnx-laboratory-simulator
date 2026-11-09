// Focused bench tools: one piece of glassware and its contents, worked by the simulator's own models,
// without a run, a session or the lab world. A scene names catalogue substances and equipment; every
// number a tool shows or checks (pH, indicator colour, volumes, end points, uncertainty) comes from the
// catalogue facets, the equipment properties and the acid-base solver (models/acidbase.ts), so a bench
// tool and the full practical can never disagree. Hosts use this for small explanations and tasks
// ("acid meets base in a beaker", reading a burette, a dilution, a titration curve).
//
// The pH is the acid-base solver's: the Rust numerics when the host installed them, else the
// TypeScript reference bisection. Answers are never supplied from outside; checks compare a response
// with the engine's value under a tolerance the engine states.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import { layerPH, pKw, visibleColour } from '../models/acidbase.ts'
import { epsilon } from '../models/measurement.ts'
import { parseValue, valueIn } from '../units/quantity.ts'

/** Engine version: bump when any outcome a saved scene shows could change. */
export const BENCH_VERSION = '1.0.0'
/** Checker version: bump when any tolerance or acceptance rule changes. */
export const BENCH_CHECKER_VERSION = '1.0.0'

export interface Portion { substance: string; concentrationM: number; volumeMl: number }
export interface Reagent { substance: string; concentrationM: number }

/** Acid meets base (or any acid-base solutions) in one vessel. */
export interface MixScene { kind: 'mix'; vessel: string; portions: Portion[]; indicator?: string; temperatureC?: number }
/** A titrant from a burette into an analyte in a flask: the curve, the equivalence and the end point. */
export interface TitrationScene { kind: 'titration'; flask: string; analyte: Portion; titrant: Reagent; burette: string; indicator?: string; temperatureC?: number }
/** Reading a burette before and after a delivery. Levels are the true meniscus positions on the scale (0 at the top). */
export interface BuretteScene { kind: 'burette'; burette: string; startMl: number; endMl: number }
/** A pipette of stock made up to the mark in a volumetric flask, optionally repeated (a serial dilution). */
export interface DilutionScene { kind: 'dilution'; stock: Reagent; pipette: string; flask: string; repeats?: number; temperatureC?: number }
export type BenchScene = MixScene | TitrationScene | BuretteScene | DilutionScene
export type BenchKind = BenchScene['kind']

/** What a task may ask, per scene kind. */
export const BENCH_ASKS = {
  mix: ['pH', 'colour', 'acidity'],
  titration: ['start-pH', 'pH-at', 'equivalence-volume', 'equivalence-pH', 'half-equivalence-pH', 'end-point-volume'],
  burette: ['start-reading', 'end-reading', 'titre'],
  dilution: ['concentration', 'dilution-factor', 'percentage-uncertainty', 'pH'],
} as const satisfies Record<BenchKind, readonly string[]>
export type BenchAsk = (typeof BENCH_ASKS)[BenchKind][number]

export interface BenchTask { id: string; ask: BenchAsk; criterionId: string; /** For pH-at: the volume of titrant added (mL). */ atMl?: number }
/** A learner's answer: a number, or a choice for colour and acidity. Anything else is unsupported. */
export interface BenchResponse { value?: number | null; choice?: string | null }

export type BenchAnswer =
  | { type: 'number'; value: number; tolerance: number; unit: string; decimals: number; label: string }
  | { type: 'choice'; value: string; options: string[]; label: string }

export interface BenchIssue { path: string; message: string }

export interface PortionOutcome { substance: string; name: string; mmol: number; pH?: number }
export interface MixOutcome {
  kind: 'mix'; temperatureK: number; totalMl: number; capacityMl?: number; pH?: number; neutralPH: number
  acidity?: 'acidic' | 'neutral' | 'alkaline'; colour?: string; portions: PortionOutcome[]
}
export interface TitrationOutcome {
  kind: 'titration'; temperatureK: number; neutralPH: number; capacityMl: number; resolutionMl: number
  analyte: PortionOutcome; titrantName: string
  /** [mL of titrant added, pH], every 0.25 mL over the burette, plus the equivalence point. */
  curve: Array<[number, number]>
  startPH: number; equivalenceMl: number; equivalencePH: number; halfEquivalencePH: number
  /** pH change from 0.5 mL before to 0.5 mL after the equivalence. */
  jump: number; endPHAtCapacity: number
  indicator?: { substance: string; name: string; startColour: string; endColour: string; endPointMl?: number; endPointErrorMl?: number }
}
export interface BuretteOutcome {
  kind: 'burette'; capacityMl: number; resolutionMl: number; startLevelMl: number; endLevelMl: number
  startReadingMl: number; endReadingMl: number; titreMl: number; readingUncertaintyMl: number; titreUncertaintyMl: number; decimals: number
}
export interface DilutionOutcome {
  kind: 'dilution'; temperatureK: number; stockName: string; stockM: number; pipetteMl: number; pipetteToleranceMl: number; flaskMl: number
  flaskToleranceMl: number; repeats: number; factor: number; concentrationM: number; percentageUncertainty: number
  absoluteUncertaintyM: number; stockPH?: number; pH?: number
}
export type BenchOutcome = MixOutcome | TitrationOutcome | BuretteOutcome | DilutionOutcome

export interface BenchCheck { status: 'correct' | 'incorrect' | 'unsupported'; met: boolean; answer?: BenchAnswer; feedback: string }

/** Indicator dose in the vessel (mol/L): a few drops. Its own acidity is left out of the pH, as for a real few-drop dose. */
const INDICATOR_M = 4e-5
const PH_TOLERANCE = 0.1
const COARSE_ML = 0.05
const FINE_ML = 0.001
const CURVE_ML = 0.25
const ACIDITY_OPTIONS = ['acidic', 'neutral', 'alkaline']

// ---- Catalogue helpers ----

function mlProperty(cat: Catalogue, equipment: string, key: string): number | undefined {
  const v = cat.property(equipment, key)
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return undefined
  try {
    return valueIn(parseValue(v), 'mL')
  } catch {
    return undefined
  }
}

const nameOf = (cat: Catalogue, id: string) => cat.substances.get(id)?.identity.name ?? id
const kelvin = (c: number | undefined) => (c ?? 25) + 273.15
const round = (x: number, decimals: number) => Math.round(x * 10 ** decimals) / 10 ** decimals
const isAcidBase = (cat: Catalogue, id: string) => {
  const def = cat.substances.get(id)
  return !!def?.acidBase && def.identity.class !== 'indicator'
}
const isIndicator = (cat: Catalogue, id: string) => cat.substances.get(id)?.identity.class === 'indicator' && !!cat.substances.get(id)?.acidBase?.forms
const colourBase = (cat: Catalogue) => (s: string, nm: number) => epsilon(cat, s, nm)

function pHOf(cat: Catalogue, species: Record<string, number>, volumeL: number, temperatureK: number): number | undefined {
  const layer: Layer = { volumeL, species }
  return layerPH(cat, layer, temperatureK)
}

function colourOf(cat: Catalogue, species: Record<string, number>, volumeL: number, indicator: string, temperatureK: number): string {
  const layer: Layer = { volumeL, species: { ...species, [indicator]: (species[indicator] ?? 0) + INDICATOR_M * volumeL } }
  return visibleColour(cat, layer, temperatureK, colourBase(cat))
}

function addSpecies(into: Record<string, number>, substance: string, mol: number) {
  into[substance] = (into[substance] ?? 0) + mol
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function portionIssues(cat: Catalogue, p: Portion | Reagent, path: string, needsVolume: boolean): BenchIssue[] {
  const out: BenchIssue[] = []
  if (!cat.substances.get(p.substance)) out.push({ path: `${path}.substance`, message: `${p.substance} is not in the Laboratory Simulator's catalogue.` })
  else if (!isAcidBase(cat, p.substance)) out.push({ path: `${path}.substance`, message: `${nameOf(cat, p.substance)} has no acid-base data in the simulator, so it cannot be used here.` })
  if (!finite(p.concentrationM) || p.concentrationM <= 0 || p.concentrationM > 5) out.push({ path: `${path}.concentrationM`, message: 'Concentration must be above 0 and at most 5 mol/L.' })
  if (needsVolume) {
    const v = (p as Portion).volumeMl
    if (!finite(v) || v <= 0 || v > 250) out.push({ path: `${path}.volumeMl`, message: 'Volume must be above 0 and at most 250 mL.' })
  }
  return out
}

function equipmentIssue(cat: Catalogue, id: string, classId: string, path: string, what: string): BenchIssue[] {
  if (!cat.equipment.get(id)) return [{ path, message: `${id} is not equipment in the Laboratory Simulator's catalogue.` }]
  if (!cat.isA(id, classId)) return [{ path, message: `${cat.equipment.get(id)?.label ?? id} is not ${what}.` }]
  return []
}

function indicatorIssue(cat: Catalogue, id: string | undefined, path: string): BenchIssue[] {
  if (id === undefined) return []
  if (!cat.substances.get(id)) return [{ path, message: `${id} is not in the Laboratory Simulator's catalogue.` }]
  if (!isIndicator(cat, id)) return [{ path, message: `${nameOf(cat, id)} is not an indicator with colours in the simulator.` }]
  return []
}

// ---- Outcomes ----

const outcomeCache = new WeakMap<Catalogue, Map<string, BenchOutcome>>()

/** The engine's outcome for a valid scene. Call benchIssues first; this throws on an invalid scene. */
export function evaluateBench(cat: Catalogue, scene: BenchScene): BenchOutcome {
  let cache = outcomeCache.get(cat)
  if (!cache) outcomeCache.set(cat, (cache = new Map()))
  const key = JSON.stringify(scene)
  const hit = cache.get(key)
  if (hit) return hit
  const out = compute(cat, scene)
  if (cache.size > 200) cache.clear()
  cache.set(key, out)
  return out
}

function compute(cat: Catalogue, scene: BenchScene): BenchOutcome {
  switch (scene.kind) {
    case 'mix':
      return mixOutcome(cat, scene)
    case 'titration':
      return titrationOutcome(cat, scene)
    case 'burette':
      return buretteOutcome(cat, scene)
    case 'dilution':
      return dilutionOutcome(cat, scene)
  }
}

function acidityOf(pH: number, neutral: number): 'acidic' | 'neutral' | 'alkaline' {
  return pH < neutral - 0.5 ? 'acidic' : pH > neutral + 0.5 ? 'alkaline' : 'neutral'
}

function mixOutcome(cat: Catalogue, scene: MixScene): MixOutcome {
  const T = kelvin(scene.temperatureC)
  const species: Record<string, number> = {}
  let totalMl = 0
  const portions: PortionOutcome[] = scene.portions.map((p) => {
    const mol = (p.concentrationM * p.volumeMl) / 1000
    addSpecies(species, p.substance, mol)
    totalMl += p.volumeMl
    return { substance: p.substance, name: nameOf(cat, p.substance), mmol: mol * 1000, pH: pHOf(cat, { [p.substance]: mol }, p.volumeMl / 1000, T) }
  })
  const neutralPH = pKw(T) / 2
  const pH = pHOf(cat, species, totalMl / 1000, T)
  return {
    kind: 'mix', temperatureK: T, totalMl, capacityMl: mlProperty(cat, scene.vessel, 'capacity'), pH, neutralPH,
    acidity: pH === undefined ? undefined : acidityOf(pH, neutralPH),
    colour: scene.indicator ? colourOf(cat, species, totalMl / 1000, scene.indicator, T) : undefined, portions,
  }
}

function titrationSpecies(scene: TitrationScene, ml: number): { species: Record<string, number>; volumeL: number } {
  const species: Record<string, number> = {}
  addSpecies(species, scene.analyte.substance, (scene.analyte.concentrationM * scene.analyte.volumeMl) / 1000)
  if (ml > 0) addSpecies(species, scene.titrant.substance, (scene.titrant.concentrationM * ml) / 1000)
  return { species, volumeL: (scene.analyte.volumeMl + ml) / 1000 }
}

function titrationPH(cat: Catalogue, scene: TitrationScene, ml: number, T: number): number {
  const { species, volumeL } = titrationSpecies(scene, ml)
  return pHOf(cat, species, volumeL, T) ?? NaN
}

function titrationColour(cat: Catalogue, scene: TitrationScene, ml: number, T: number): string {
  const { species, volumeL } = titrationSpecies(scene, ml)
  return colourOf(cat, species, volumeL, scene.indicator!, T)
}

const steepestCache = new WeakMap<Catalogue, Map<string, ReturnType<typeof computeSteepest>>>()

/**
 * The steepest point of the curve: the equivalence, found on the solver's own curve (never by stoichiometry).
 * Memoised per catalogue: checking a scene and evaluating it share one curve, and the indicator (dosed so it does
 * not move the pH) and the flask do not change it. Callers must not mutate the result.
 */
function steepest(cat: Catalogue, scene: TitrationScene, capacityMl: number, T: number) {
  let cache = steepestCache.get(cat)
  if (!cache) steepestCache.set(cat, (cache = new Map()))
  const key = JSON.stringify([scene.analyte, scene.titrant, capacityMl, T])
  const hit = cache.get(key)
  if (hit) return hit
  const out = computeSteepest(cat, scene, capacityMl, T)
  if (cache.size > 100) cache.clear()
  cache.set(key, out)
  return out
}

function computeSteepest(cat: Catalogue, scene: TitrationScene, capacityMl: number, T: number) {
  const n = Math.round(capacityMl / COARSE_ML)
  const coarse: number[] = []
  for (let i = 0; i <= n; i++) coarse.push(titrationPH(cat, scene, i * COARSE_ML, T))
  const slopes = coarse.slice(1).map((p, i) => Math.abs(p - coarse[i]))
  let top = 0
  for (let i = 1; i < slopes.length; i++) if (slopes[i] > slopes[top]) top = i
  // A second end point: another local peak, well away from the first, at least a third as steep.
  let second = 0
  for (let i = 1; i < slopes.length - 1; i++) {
    if (Math.abs(i - top) * COARSE_ML <= 2) continue
    if (slopes[i] >= slopes[i - 1] && slopes[i] >= slopes[i + 1]) second = Math.max(second, slopes[i])
  }
  const lo = Math.max(0, (top - 1) * COARSE_ML)
  const hi = Math.min(capacityMl, (top + 2) * COARSE_ML)
  let best = { at: (top + 0.5) * COARSE_ML, slope: -1 }
  let prev = titrationPH(cat, scene, lo, T)
  for (let v = lo + FINE_ML; v <= hi + 1e-12; v += FINE_ML) {
    const p = titrationPH(cat, scene, v, T)
    if (Math.abs(p - prev) > best.slope) best = { at: v - FINE_ML / 2, slope: Math.abs(p - prev) }
    prev = p
  }
  return { equivalenceMl: round(best.at, 3), coarse, topIndex: top, secondRatio: slopes[top] > 0 ? second / slopes[top] : 0 }
}

function titrationOutcome(cat: Catalogue, scene: TitrationScene): TitrationOutcome {
  const T = kelvin(scene.temperatureC)
  const capacityMl = mlProperty(cat, scene.burette, 'capacity') ?? 50
  const resolutionMl = mlProperty(cat, scene.burette, 'resolution') ?? mlProperty(cat, scene.burette, 'tolerance') ?? 0.05
  const { equivalenceMl, coarse } = steepest(cat, scene, capacityMl, T)
  const curve: Array<[number, number]> = []
  const every = Math.round(CURVE_ML / COARSE_ML)
  for (let i = 0; i < coarse.length; i += every) curve.push([round(i * COARSE_ML, 2), round(coarse[i], 3)])
  const equivalencePH = titrationPH(cat, scene, equivalenceMl, T)
  curve.push([equivalenceMl, round(equivalencePH, 3)])
  curve.sort((a, b) => a[0] - b[0])
  const jump = Math.abs(titrationPH(cat, scene, Math.min(capacityMl, equivalenceMl + 0.5), T) - titrationPH(cat, scene, Math.max(0, equivalenceMl - 0.5), T))
  const analyteMol = (scene.analyte.concentrationM * scene.analyte.volumeMl) / 1000
  const out: TitrationOutcome = {
    kind: 'titration', temperatureK: T, neutralPH: pKw(T) / 2, capacityMl, resolutionMl,
    analyte: { substance: scene.analyte.substance, name: nameOf(cat, scene.analyte.substance), mmol: analyteMol * 1000 },
    titrantName: nameOf(cat, scene.titrant.substance), curve, startPH: coarse[0], equivalenceMl, equivalencePH,
    halfEquivalencePH: titrationPH(cat, scene, equivalenceMl / 2, T), jump, endPHAtCapacity: coarse[coarse.length - 1],
  }
  if (scene.indicator) {
    const startColour = titrationColour(cat, scene, 0, T)
    const endColour = titrationColour(cat, scene, capacityMl, T)
    let endPointMl: number | undefined
    // The first change of colour: scan every 0.25 mL, then bisect to 0.005 mL (colour follows the pH, which only moves one way).
    let before = 0
    for (let v = CURVE_ML; v <= capacityMl + 1e-9; v += CURVE_ML) {
      if (titrationColour(cat, scene, v, T) !== startColour) {
        let lo = before
        let hi = v
        while (hi - lo > 0.005) {
          const mid = (lo + hi) / 2
          if (titrationColour(cat, scene, mid, T) === startColour) lo = mid
          else hi = mid
        }
        endPointMl = round(hi, 3)
        break
      }
      before = v
    }
    out.indicator = {
      substance: scene.indicator, name: nameOf(cat, scene.indicator), startColour, endColour, endPointMl,
      endPointErrorMl: endPointMl === undefined ? undefined : round(endPointMl - equivalenceMl, 3),
    }
  }
  return out
}

function decimalsOf(step: number): number {
  let d = 0
  while (d < 6 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-9) d++
  return d
}

function buretteOutcome(cat: Catalogue, scene: BuretteScene): BuretteOutcome {
  const capacityMl = mlProperty(cat, scene.burette, 'capacity') ?? 50
  const resolutionMl = mlProperty(cat, scene.burette, 'resolution') ?? mlProperty(cat, scene.burette, 'tolerance') ?? 0.05
  const decimals = decimalsOf(resolutionMl)
  // Read to the nearest division, as the kernel's read-volume operation does for a burette (read from the top).
  const read = (level: number) => round(Math.round(level / resolutionMl) * resolutionMl, decimals)
  const startReadingMl = read(scene.startMl)
  const endReadingMl = read(scene.endMl)
  return {
    kind: 'burette', capacityMl, resolutionMl, startLevelMl: scene.startMl, endLevelMl: scene.endMl, startReadingMl, endReadingMl,
    titreMl: round(endReadingMl - startReadingMl, decimals), readingUncertaintyMl: resolutionMl, titreUncertaintyMl: round(2 * resolutionMl, decimals), decimals,
  }
}

function dilutionOutcome(cat: Catalogue, scene: DilutionScene): DilutionOutcome {
  const T = kelvin(scene.temperatureC)
  const pipetteMl = mlProperty(cat, scene.pipette, 'nominal') ?? NaN
  const pipetteToleranceMl = mlProperty(cat, scene.pipette, 'tolerance') ?? 0
  const flaskMl = mlProperty(cat, scene.flask, 'nominal') ?? NaN
  const flaskToleranceMl = mlProperty(cat, scene.flask, 'tolerance') ?? 0
  const repeats = scene.repeats ?? 1
  const factor = (flaskMl / pipetteMl) ** repeats
  const concentrationM = scene.stock.concentrationM / factor
  // Percentage uncertainties add, once per pipette and once per flask, for every step.
  const percentageUncertainty = repeats * (pipetteToleranceMl / pipetteMl + flaskToleranceMl / flaskMl) * 100
  const out: DilutionOutcome = {
    kind: 'dilution', temperatureK: T, stockName: nameOf(cat, scene.stock.substance), stockM: scene.stock.concentrationM, pipetteMl, pipetteToleranceMl,
    flaskMl, flaskToleranceMl, repeats, factor, concentrationM, percentageUncertainty, absoluteUncertaintyM: (concentrationM * percentageUncertainty) / 100,
  }
  if (isAcidBase(cat, scene.stock.substance)) {
    out.stockPH = pHOf(cat, { [scene.stock.substance]: scene.stock.concentrationM }, 1, T)
    out.pH = pHOf(cat, { [scene.stock.substance]: concentrationM }, 1, T)
  }
  return out
}

// ---- Validity ----

/** Everything that stops a scene (and its task) from being a fair, computable bench tool. Empty = valid. */
export function benchIssues(cat: Catalogue, scene: BenchScene, task?: BenchTask): BenchIssue[] {
  const out: BenchIssue[] = []
  const temp = (scene as { temperatureC?: number }).temperatureC
  if (temp !== undefined && (!finite(temp) || temp < 5 || temp > 60)) out.push({ path: 'scene.temperatureC', message: 'Temperature must be between 5 and 60 °C.' })
  switch (scene.kind) {
    case 'mix': {
      out.push(...equipmentIssue(cat, scene.vessel, 'core:container', 'scene.vessel', 'a vessel'))
      if (!Array.isArray(scene.portions) || scene.portions.length < 1 || scene.portions.length > 4) out.push({ path: 'scene.portions', message: 'Use one to four solutions.' })
      else scene.portions.forEach((p, i) => out.push(...portionIssues(cat, p, `scene.portions[${i}]`, true)))
      out.push(...indicatorIssue(cat, scene.indicator, 'scene.indicator'))
      if (out.length) return out
      const o = evaluateBench(cat, scene) as MixOutcome
      if (o.capacityMl !== undefined && o.totalMl > o.capacityMl) out.push({ path: 'scene.portions', message: `${o.totalMl} mL does not fit in the ${o.capacityMl} mL vessel.` })
      if (o.pH === undefined) out.push({ path: 'scene', message: 'The simulator cannot work out a pH for this mixture.' })
      break
    }
    case 'titration': {
      out.push(...equipmentIssue(cat, scene.burette, 'core:burette', 'scene.burette', 'a burette'))
      out.push(...equipmentIssue(cat, scene.flask, 'core:container', 'scene.flask', 'a flask'))
      out.push(...portionIssues(cat, scene.analyte, 'scene.analyte', true), ...portionIssues(cat, scene.titrant, 'scene.titrant', false))
      out.push(...indicatorIssue(cat, scene.indicator, 'scene.indicator'))
      if (out.length) return out
      if (scene.analyte.substance === scene.titrant.substance) return [{ path: 'scene.titrant', message: 'The titrant must differ from the analyte.' }]
      const T = kelvin(scene.temperatureC)
      const neutral = pKw(T) / 2
      const a = pHOf(cat, { [scene.analyte.substance]: scene.analyte.concentrationM }, 1, T) ?? neutral
      const b = pHOf(cat, { [scene.titrant.substance]: scene.titrant.concentrationM }, 1, T) ?? neutral
      if (!((a < neutral - 1 && b > neutral + 1) || (a > neutral + 1 && b < neutral - 1)))
        return [{ path: 'scene.titrant', message: 'One solution must be an acid and the other a base, so the titrant can neutralise the analyte.' }]
      const capacityMl = mlProperty(cat, scene.burette, 'capacity') ?? 50
      const flaskCap = mlProperty(cat, scene.flask, 'capacity')
      if (flaskCap !== undefined && scene.analyte.volumeMl + capacityMl > flaskCap)
        out.push({ path: 'scene.analyte.volumeMl', message: `The flask holds ${flaskCap} mL: the analyte plus a full burette would overflow it.` })
      const { coarse, topIndex, secondRatio } = steepest(cat, scene, capacityMl, T)
      const last = coarse[coarse.length - 1]
      if ((coarse[0] - neutral) * (last - neutral) > 0 || topIndex * COARSE_ML < 1 || topIndex * COARSE_ML > capacityMl - 1)
        out.push({ path: 'scene', message: `The equivalence is not inside the burette's ${capacityMl} mL: use less analyte or a more concentrated titrant.` })
      else if (secondRatio > 1 / 3) out.push({ path: 'scene', message: 'This titration has two end points, so "the" equivalence volume is ambiguous: choose a single-step acid or base.' })
      else {
        const o = evaluateBench(cat, scene) as TitrationOutcome
        if (o.jump < 2 && task && ['equivalence-volume', 'end-point-volume'].includes(task.ask))
          out.push({ path: 'scene', message: `The pH jumps only ${o.jump.toFixed(1)} units at the equivalence, too little for a clear end point.` })
        if (task?.ask === 'end-point-volume' && (!o.indicator || o.indicator.endPointMl === undefined))
          out.push({ path: 'scene.indicator', message: 'The indicator never changes colour over this titration, so there is no end point to read.' })
      }
      break
    }
    case 'burette': {
      out.push(...equipmentIssue(cat, scene.burette, 'core:burette', 'scene.burette', 'a burette'))
      if (out.length) return out
      const capacityMl = mlProperty(cat, scene.burette, 'capacity') ?? 50
      const step = mlProperty(cat, scene.burette, 'resolution') ?? 0.05
      if (!finite(scene.startMl) || scene.startMl < 0 || scene.startMl > capacityMl) out.push({ path: 'scene.startMl', message: `The starting level must be on the scale, 0 to ${capacityMl} mL.` })
      if (!finite(scene.endMl) || scene.endMl < 0 || scene.endMl > capacityMl) out.push({ path: 'scene.endMl', message: `The final level must be on the scale, 0 to ${capacityMl} mL.` })
      if (out.length) return out
      if (scene.endMl <= scene.startMl) out.push({ path: 'scene.endMl', message: 'The level falls as liquid is delivered, so the final reading must be larger than the first.' })
      // A level halfway between two divisions has no fair single reading.
      for (const [key, level] of [['startMl', scene.startMl], ['endMl', scene.endMl]] as const) {
        const frac = level / step - Math.floor(level / step)
        if (Math.abs(frac - 0.5) < 0.2) out.push({ path: `scene.${key}`, message: 'The meniscus sits too close to halfway between two divisions to have one fair reading.' })
      }
      break
    }
    case 'dilution': {
      out.push(...equipmentIssue(cat, scene.pipette, 'core:volumetric-pipette', 'scene.pipette', 'a volumetric pipette'))
      out.push(...equipmentIssue(cat, scene.flask, 'core:volumetric-flask', 'scene.flask', 'a volumetric flask'))
      if (!cat.substances.get(scene.stock.substance)) out.push({ path: 'scene.stock.substance', message: `${scene.stock.substance} is not in the Laboratory Simulator's catalogue.` })
      if (!finite(scene.stock.concentrationM) || scene.stock.concentrationM <= 0 || scene.stock.concentrationM > 20) out.push({ path: 'scene.stock.concentrationM', message: 'Stock concentration must be above 0 and at most 20 mol/L.' })
      const repeats = scene.repeats ?? 1
      if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) out.push({ path: 'scene.repeats', message: 'Repeat the dilution one to three times.' })
      if (out.length) return out
      const o = evaluateBench(cat, scene) as DilutionOutcome
      if (!finite(o.pipetteMl) || !finite(o.flaskMl)) out.push({ path: 'scene', message: 'The pipette or flask has no stated volume in the simulator.' })
      else if (o.pipetteMl >= o.flaskMl) out.push({ path: 'scene.pipette', message: 'The pipette must hold less than the flask, or nothing is diluted.' })
      if (task?.ask === 'pH' && o.pH === undefined) out.push({ path: 'task.ask', message: `${o.stockName} has no acid-base data, so the simulator gives it no pH.` })
      break
    }
    default:
      return [{ path: 'scene.kind', message: 'Unknown bench tool.' }]
  }
  if (task) out.push(...taskIssues(cat, scene, task))
  return out
}

function taskIssues(cat: Catalogue, scene: BenchScene, task: BenchTask): BenchIssue[] {
  const out: BenchIssue[] = []
  const asks = BENCH_ASKS[scene.kind] as readonly string[]
  if (!asks.includes(task.ask)) return [{ path: 'task.ask', message: `A ${scene.kind} tool can ask for: ${asks.join(', ')}.` }]
  if (task.ask === 'colour' && !(scene as MixScene).indicator) out.push({ path: 'task.ask', message: 'Asking for a colour needs an indicator in the beaker.' })
  if (task.ask === 'pH-at') {
    const cap = mlProperty(cat, (scene as TitrationScene).burette, 'capacity') ?? 50
    if (!finite(task.atMl) || task.atMl < 0 || task.atMl > cap) out.push({ path: 'task.atMl', message: `Say how much titrant has been added, 0 to ${cap} mL.` })
  } else if (task.atMl !== undefined) out.push({ path: 'task.atMl', message: 'Only a "pH-at" task takes a volume.' })
  if (out.length || scene.kind !== 'mix' || task.ask !== 'acidity') return out
  const o = evaluateBench(cat, scene) as MixOutcome
  if (o.pH !== undefined && (Math.abs(o.pH - (o.neutralPH - 0.5)) < 0.15 || Math.abs(o.pH - (o.neutralPH + 0.5)) < 0.15))
    out.push({ path: 'scene', message: 'The pH sits on the line between two answers; change an amount so the answer is clear.' })
  return out
}

// ---- Answers and checks ----

const num = (value: number, tolerance: number, unit: string, decimals: number, label: string): BenchAnswer => ({ type: 'number', value, tolerance, unit, decimals, label })

/** The engine's answer to a task, with the tolerance a response is checked against. */
export function benchAnswer(cat: Catalogue, scene: BenchScene, task: BenchTask): BenchAnswer {
  const o = evaluateBench(cat, scene)
  switch (o.kind) {
    case 'mix':
      if (task.ask === 'colour') {
        const options = indicatorColours(cat, (scene as MixScene).indicator!)
        return { type: 'choice', value: o.colour!, options: options.includes(o.colour!) ? options : [...options, o.colour!], label: 'Colour of the mixture' }
      }
      if (task.ask === 'acidity') return { type: 'choice', value: o.acidity!, options: ACIDITY_OPTIONS, label: 'Is the mixture acidic, neutral or alkaline?' }
      return num(o.pH!, PH_TOLERANCE, '', 2, 'pH of the mixture')
    case 'titration': {
      const twoReadings = 2 * o.resolutionMl
      if (task.ask === 'start-pH') return num(o.startPH, PH_TOLERANCE, '', 2, 'pH before any titrant is added')
      if (task.ask === 'pH-at') return num(titrationPH(cat, scene as TitrationScene, task.atMl!, o.temperatureK), PH_TOLERANCE, '', 2, `pH after ${task.atMl} mL of titrant`)
      if (task.ask === 'equivalence-volume') return num(o.equivalenceMl, twoReadings, 'mL', 2, 'Volume of titrant at the equivalence point')
      if (task.ask === 'equivalence-pH') return num(o.equivalencePH, PH_TOLERANCE, '', 2, 'pH at the equivalence point')
      if (task.ask === 'half-equivalence-pH') return num(o.halfEquivalencePH, PH_TOLERANCE, '', 2, 'pH halfway to the equivalence point')
      return num(o.indicator!.endPointMl!, twoReadings, 'mL', 2, 'Volume of titrant when the indicator changes colour')
    }
    case 'burette': {
      const half = o.resolutionMl / 2
      if (task.ask === 'start-reading') return num(o.startReadingMl, half, 'mL', o.decimals, 'First burette reading')
      if (task.ask === 'end-reading') return num(o.endReadingMl, half, 'mL', o.decimals, 'Final burette reading')
      return num(o.titreMl, half, 'mL', o.decimals, 'Titre (volume delivered)')
    }
    case 'dilution':
      if (task.ask === 'concentration') return num(o.concentrationM, Math.max(o.absoluteUncertaintyM, o.concentrationM * 0.005), 'mol/L', 4, 'Concentration after dilution')
      if (task.ask === 'dilution-factor') return num(o.factor, o.factor * 0.005, '', 1, 'Dilution factor')
      if (task.ask === 'percentage-uncertainty') return num(o.percentageUncertainty, Math.max(0.01, o.percentageUncertainty * 0.02), '%', 2, 'Percentage uncertainty in the concentration')
      return num(o.pH!, PH_TOLERANCE, '', 2, 'pH after dilution')
  }
}

/** The colour names an indicator can show, from its forms in the catalogue. */
export function indicatorColours(cat: Catalogue, indicator: string): string[] {
  const forms = cat.substances.get(indicator)?.acidBase?.forms ?? []
  const names = new Set<string>()
  for (const f of forms) if (typeof f.colour === 'string') names.add(f.colour)
  return [...names]
}

const HINTS: Record<BenchAsk, { high: string; low: string; wrong: string }> = {
  'pH': { high: 'Too high.', low: 'Too low.', wrong: 'Work out which reagent is left over after neutralisation, then its concentration in the total volume.' },
  'colour': { high: '', low: '', wrong: 'Find the pH of the mixture first, then which form of the indicator dominates there.' },
  'acidity': { high: '', low: '', wrong: 'Compare the moles of acid and base: whichever is in excess decides it.' },
  'start-pH': { high: 'Too high.', low: 'Too low.', wrong: 'Before any titrant, only the analyte is in the flask: is it strong or weak?' },
  'pH-at': { high: 'Too high.', low: 'Too low.', wrong: 'Find what is left after the titrant added so far has reacted, in the total volume.' },
  'equivalence-volume': { high: 'Too much titrant.', low: 'Too little titrant.', wrong: 'At equivalence, moles of titrant match moles of analyte (mind the ratio).' },
  'equivalence-pH': { high: 'Too high.', low: 'Too low.', wrong: 'At equivalence only the salt is left: does its ion react with water?' },
  'half-equivalence-pH': { high: 'Too high.', low: 'Too low.', wrong: 'Halfway to equivalence, a weak acid and its conjugate base are equal, so pH = pKa.' },
  'end-point-volume': { high: 'Too late.', low: 'Too early.', wrong: 'The end point is where the indicator changes colour, which can differ from the equivalence.' },
  'start-reading': { high: 'Too high.', low: 'Too low.', wrong: 'Read the bottom of the meniscus at eye level; the scale runs downwards from 0.' },
  'end-reading': { high: 'Too high.', low: 'Too low.', wrong: 'Read the bottom of the meniscus at eye level; the scale runs downwards from 0.' },
  'titre': { high: 'Too large.', low: 'Too small.', wrong: 'The titre is the final reading minus the first one.' },
  'concentration': { high: 'Too high.', low: 'Too low.', wrong: 'Each step divides the concentration by flask volume over pipette volume.' },
  'dilution-factor': { high: 'Too large.', low: 'Too small.', wrong: 'The factor is flask volume over pipette volume, for each step.' },
  'percentage-uncertainty': { high: 'Too large.', low: 'Too small.', wrong: 'Add the percentage uncertainty of the pipette and of the flask, for every step.' },
}

function shown(answer: BenchAnswer): string {
  return answer.type === 'choice' ? answer.value : `${answer.value.toFixed(answer.decimals)}${answer.unit ? ` ${answer.unit}` : ''}`
}

/** Checks a response against the engine's answer. Deterministic: the same scene, task and response give the same result. */
export function checkBench(cat: Catalogue, scene: BenchScene, task: BenchTask, response: BenchResponse | null | undefined): BenchCheck {
  const issues = benchIssues(cat, scene, task)
  if (issues.length) return { status: 'unsupported', met: false, feedback: issues[0].message }
  const answer = benchAnswer(cat, scene, task)
  const hint = HINTS[task.ask]
  if (answer.type === 'choice') {
    const choice = typeof response?.choice === 'string' ? response.choice.trim().toLowerCase() : ''
    if (!choice) return { status: 'unsupported', met: false, answer, feedback: `Choose one of: ${answer.options.join(', ')}.` }
    const met = choice === answer.value.toLowerCase()
    return { status: met ? 'correct' : 'incorrect', met, answer, feedback: met ? `Right: ${answer.value}.` : hint.wrong }
  }
  const value = response?.value
  if (!finite(value)) return { status: 'unsupported', met: false, answer, feedback: 'Enter a number.' }
  const met = Math.abs(value - answer.value) <= answer.tolerance + 1e-9
  if (met) return { status: 'correct', met, answer, feedback: `Right: the simulator gives ${shown(answer)}.` }
  return { status: 'incorrect', met, answer, feedback: `${value > answer.value ? hint.high : hint.low} ${hint.wrong}`.trim() }
}

/** Typical wrong beliefs for a task, as responses, worked from the same scene. Only those the checker must reject are returned. */
export function benchWrongBeliefs(cat: Catalogue, scene: BenchScene, task: BenchTask): Array<{ label: string; response: BenchResponse }> {
  if (benchIssues(cat, scene, task).length) return []
  const answer = benchAnswer(cat, scene, task)
  const o = evaluateBench(cat, scene)
  const out: Array<{ label: string; response: BenchResponse }> = []
  const add = (label: string, value: number | undefined) => { if (finite(value)) out.push({ label, response: { value: round(value, 6) } }) }
  if (o.kind === 'mix') {
    if (task.ask === 'pH') {
      add('Mixing an acid with a base always gives pH 7', o.neutralPH)
      for (const p of o.portions) add(`Only the ${p.name} counts`, p.pH)
    } else if (task.ask === 'acidity') for (const c of ACIDITY_OPTIONS) out.push({ label: `Always ${c}`, response: { choice: c } })
    else if (task.ask === 'colour') for (const c of (answer as Extract<BenchAnswer, { type: 'choice' }>).options) out.push({ label: `It turns ${c}`, response: { choice: c } })
  } else if (o.kind === 'titration' && scene.kind === 'titration') {
    if (task.ask === 'equivalence-volume' || task.ask === 'end-point-volume') {
      add('Equal volumes neutralise each other', scene.analyte.volumeMl)
      add('The concentration ratio is used upside down', (scene.analyte.volumeMl * scene.titrant.concentrationM) / scene.analyte.concentrationM)
      add('Confused with the half-equivalence point', o.equivalenceMl / 2)
      add('The total volume in the flask is the titre', scene.analyte.volumeMl + o.equivalenceMl)
      if (task.ask === 'end-point-volume') add('The end point is always the equivalence point', o.equivalenceMl)
    } else if (task.ask === 'equivalence-pH') add('The equivalence point is always pH 7', o.neutralPH)
    else if (task.ask === 'half-equivalence-pH') {
      add('Halfway is always pH 7', o.neutralPH)
      add('Halfway the pH has not changed yet', o.startPH)
    } else if (task.ask === 'start-pH') {
      const c = scene.analyte.concentrationM
      add('Nothing added yet, so it is neutral', o.neutralPH)
      add('Treated as fully dissociated', o.startPH < o.neutralPH ? -Math.log10(c) : 2 * o.neutralPH + Math.log10(c))
      add('The pH is the pKa', cat.substances.get(scene.analyte.substance)?.acidBase?.pKa[0])
    }
    else if (task.ask === 'pH-at') add('The pH has not moved from the start', o.startPH)
  } else if (o.kind === 'burette') {
    if (task.ask === 'titre') {
      add('The final reading is the titre', o.endReadingMl)
      add('The readings are added', o.startReadingMl + o.endReadingMl)
      add('The scale is read from the bottom', (o.capacityMl - o.startReadingMl) - (o.capacityMl - o.endReadingMl))
    } else {
      const reading = task.ask === 'start-reading' ? o.startReadingMl : o.endReadingMl
      add('Read from the top of the meniscus (one division too small)', reading - o.resolutionMl)
      add('Read against the scale upside down', o.capacityMl - reading)
    }
  } else if (o.kind === 'dilution') {
    if (task.ask === 'concentration') {
      add('Multiplied by the dilution factor instead of divided', o.stockM * o.factor)
      if (o.repeats > 1) add('Counted only one step', (o.stockM * o.pipetteMl) / o.flaskMl)
      add('Used the volume of water added, not the final volume', o.stockM * (o.pipetteMl / (o.flaskMl - o.pipetteMl)) ** o.repeats)
    } else if (task.ask === 'dilution-factor') {
      add('Pipette over flask', o.pipetteMl / o.flaskMl)
      if (o.repeats > 1) add('Counted only one step', o.flaskMl / o.pipetteMl)
    } else if (task.ask === 'percentage-uncertainty') {
      add('Only the pipette counts', o.repeats * (o.pipetteToleranceMl / o.pipetteMl) * 100)
      add('Only the flask counts', o.repeats * (o.flaskToleranceMl / o.flaskMl) * 100)
    } else if (task.ask === 'pH') add('Dilution does not change the pH', o.stockPH)
  }
  return out.filter((b) => !checkBench(cat, scene, task, b.response).met)
}
