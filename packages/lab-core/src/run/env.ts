// The run environment: functions that expressions in definitions and techniques can call,
// answered from the running kernel (format spec §15.2: state, selection, data and event queries).
// The reference agent (rehearsal) and the runtime share it, so goals, criteria and techniques
// mean the same thing in both.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { type Env, evaluate, type Fn, idOf, isIdRef, isQuantity, isRecord, makeEnv, truthy, type Value } from '../expr/evaluate.ts'
import type { ExperimentDefinition, ValidityVerdict } from '../format/types.ts'
import { VALIDITY_VERDICTS } from '../format/types.ts'
import type { Kernel } from '../kernel/kernel.ts'
import { contentsMassKg, massConcentration, molarConc, molarMass } from '../kernel/materials.ts'
import type { CalibrationResult } from '../kernel/ops-data.ts'
import { type Container, homogeneity, liquidVolume, meanLayer } from '../kernel/state.ts'
import { isQuantityString, parseValue, type Quantity, q } from '../units/quantity.ts'
import { layerPH, visibleColour } from '../models/acidbase.ts'
import { appearance, epsilon } from '../models/measurement.ts'
import { rotorImbalanceG } from '../kernel/ops-bench.ts'
import { cellColour, cellsPerField } from '../models/staining.ts'
import { baseOrganism, coloniesOn, isolatedSector } from '../models/growth.ts'
import { cutShare } from '../models/digestion.ts'

export interface RunContext {
  kernel: Kernel
  cat: Catalogue
  def: ExperimentDefinition
  /** Definition-level equipment roles → instance, place or container ids. */
  roles: Record<string, string>
  /** Outputs of definition-level steps, by step id. */
  outputs: Record<string, Record<string, unknown>>
  /** Choices made at decision steps. */
  decisions: Record<string, string>
}

/** Function names the run environment provides (for static checks of expressions). */
export const RUN_FUNCTIONS = [
  'labelConc', 'labelOf', 'homogeneity', 'conc', 'massConc', 'amount', 'volume', 'temperature', 'truth', 'pH', 'colour', 'precipitateColour', 'recorded',
  'samples', 'wells', 'containers', 'containersWith', 'disposals', 'wasteStreamFor', 'adjustable',
  'reading', 'readings', 'reported', 'extrapolated', 'fit', 'decision', 'validity', 'used', 'events', 'before', 'rotorImbalance', 'incidents',
  'trace', 'gramClass', 'stainColour', 'organisms', 'mass', 'purity', 'undissolved', 'colonies', 'fluorescent', 'strains', 'isolated', 'bandsIn', 'ladderSizes', 'amplified', 'pelleted', 'equipmentOf', 'weight', 'cells', 'cutShare', 'tlcSpots', 'solventFront', 'blotBands', 'bandVolumes', 'seen', 'lensOil',
] as const

/** Map a material id of the definition to a catalogue substance id. */
export function substanceId(def: ExperimentDefinition, id: string): string {
  const local = def.materials?.substances?.find((s) => s.id === id)
  if (local?.ref) return local.ref
  return id
}

function isProtein(cat: Catalogue, substance: string): boolean {
  const cls = cat.substances.get(substance)?.identity.class
  return cls === 'protein' || cls === 'enzyme'
}

/** A concentration as a quantity: mass basis for proteins (mg/mL), molar otherwise (mM). */
/** Strains with cells in a container: suspended, dried on a slide, or on an agar surface. */
function strainsIn(c: Container): string[] {
  const keys = [
    ...Object.entries(meanLayer(c.contents).populations ?? {}).filter(([, p]) => p.count > 0).map(([k]) => k),
    ...Object.keys(c.contents.film ?? {}),
    ...Object.entries(c.contents.surface ?? {}).filter(([, s]) => s.count > 0).map(([k]) => k),
  ]
  return [...new Set(keys)]
}

/** Solid plus dissolved amount of a substance in a container (mol). */
function totalMol(c: Container, substance: string): number {
  return (c.contents.solid[substance] ?? 0) + c.contents.layers.reduce((a, l) => a + (l.species[substance] ?? 0) + (l.particles?.[substance] ?? 0), 0)
}

/** The substances present as solid or solute (the solvent is implicit; water is not matter here). */
function matterIn(c: Container): string[] {
  const out = new Set<string>()
  for (const [s, n] of Object.entries(c.contents.solid)) if (n > 0) out.add(s)
  for (const l of c.contents.layers) {
    for (const [s, n] of Object.entries(l.species)) if (n > 0) out.add(s)
    for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0) out.add(s)
  }
  out.delete('core:water')
  return [...out]
}

function concQuantity(cat: Catalogue, substance: string, c: Container): Quantity {
  if (isProtein(cat, substance)) {
    const m = meanLayer(c.contents)
    return q(massConcentration(cat, substance, m.species[substance] ?? 0, liquidVolume(c.contents)), 'mg/mL')
  }
  return q(molarConc(c.contents, substance) * 1000, 'mM')
}

export interface ScopeInfo {
  /** Path prefix of the current technique invocation: events() looks only inside it. */
  path?: string
}

export function runFunctions(run: RunContext, scope: ScopeInfo = {}): Record<string, Fn> {
  const { kernel, cat, def } = run
  const world = () => kernel.world
  const container = (ref: Value): Container | undefined => {
    const id = idOf(ref)
    return id ? world().containers[id] : undefined
  }
  const supplies = () => [...(def.materials?.supplies ?? []), ...(def.materials?.samples ?? [])]
  const recordOf = (stepRef: Value) => {
    const id = idOf(stepRef)
    const out = id ? run.outputs[id] : undefined
    const recId = out ? (out.reading ?? out.record) : undefined
    return world().measurements.find((m) => m.id === recId)
  }
  const wellValues = (stepRef: Value): Array<{ well: Container; value: number }> => {
    const rec = recordOf(stepRef)
    if (!rec?.values) return []
    return Object.entries(rec.values).map(([id, value]) => ({ well: world().containers[id], value })).filter((x) => x.well)
  }
  const fromSample = (c: Container, sample: string) => (c.origins ?? []).includes(sample) || c.id === sample

  const fns: Record<string, Fn> = {
    labelConc: ([c, s]) => {
      const box = container(c)
      if (!box?.labelled || box.labelled.components.length === 0) throw new Error(`${idOf(c)} has no labelled concentration`)
      const sub = s === null || s === undefined || isIdRef(s) ? undefined : substanceId(def, String(idOf(s)))
      const comp = sub ? box.labelled.components.find((x) => x.substance === sub) : box.labelled.components[0]
      if (!comp) throw new Error(`${box.label} does not list ${sub}`)
      return parseValue(comp.text)
    },
    labelOf: ([c]) => {
      const box = container(c)
      return box ? (box.userLabel ?? box.label) : String(idOf(c))
    },
    homogeneity: ([c]) => {
      const box = container(c)
      return box ? homogeneity(box.contents) : 1
    },
    conc: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      return concQuantity(cat, substanceId(def, String(idOf(s))), box)
    },
    massConc: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      const sub = substanceId(def, String(idOf(s)))
      return q(massConcentration(cat, sub, meanLayer(box.contents).species[sub] ?? 0, liquidVolume(box.contents)), 'mg/mL')
    },
    amount: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      const sub = substanceId(def, String(idOf(s)))
      return q((meanLayer(box.contents).species[sub] ?? 0) * 1e6, 'umol')
    },
    volume: ([c]) => {
      const box = container(c)
      return box ? q(liquidVolume(box.contents) * 1e6, 'uL') : null
    },
    temperature: ([c]) => {
      const box = container(c)
      return box ? q(box.contents.temperatureK, 'K') : null
    },
    /** The true pH of a container's liquid (the solver's value, not a meter reading). */
    pH: ([c]) => {
      const box = container(c)
      if (!box) return null
      const v = layerPH(cat, meanLayer(box.contents), box.contents.temperatureK)
      return v === undefined ? null : v
    },
    /** The colour an observer sees: "colourless", "pink", "purple" … */
    colour: ([c]) => {
      const box = container(c)
      if (!box) return null
      return visibleColour(cat, meanLayer(box.contents), box.contents.temperatureK, (s, nm) => epsilon(cat, s, nm))
    },
    /** precipitateColour(c): the colour of the solid in it, suspended or settled ("white", "pale orange" …), or "none". */
    precipitateColour: ([c]) => {
      const box = container(c)
      if (!box) return null
      return appearance(cat, box, Number(cat.property(box.equipment, 'pathCm') ?? 1.5))?.precipitate?.name ?? 'none'
    },
    /** recorded(field): the values written to the notebook under a field, oldest first. */
    recorded: ([field]) =>
      world()
        .notebook.filter((e) => e.field === String(idOf(field)))
        .map((e) => (typeof e.value === 'string' && isQuantityString(e.value) ? (parseValue(e.value) as Value) : (e.value as Value))),
    /** truth('conc', sample, substance): the hidden true concentration. */
    truth: ([property, sample, s]) => {
      const what = idOf(property)
      const box = container(sample)
      if (!box) return null
      const sub = substanceId(def, String(idOf(s)))
      if (what === 'conc') return concQuantity(cat, sub, box)
      // mass and amount: what the supply held when it was staged.
      if (what === 'mass' || what === 'amount') {
        const n = box.initial?.[sub] ?? totalMol(box, sub)
        return what === 'amount' ? q(n, 'mol') : q(n * (molarMass(cat, sub) ?? 0), 'g')
      }
      throw new Error(`truth() knows "conc", "mass" and "amount"`)
    },
    /** mass(c) or mass(c, substance): solid and dissolved matter (no solvent). */
    mass: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      const subs = s === undefined ? matterIn(box) : [substanceId(def, String(idOf(s)))]
      const g = subs.reduce((a, x) => a + totalMol(box, x) * (molarMass(cat, x) ?? 0), 0)
      return q(g, 'g')
    },
    /** purity(c, substance): its mass fraction of the solid and dissolved matter in c (as if dried). */
    purity: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      const sub = substanceId(def, String(idOf(s)))
      const grams = (x: string) => totalMol(box, x) * (molarMass(cat, x) ?? 0)
      const all = matterIn(box).reduce((a, x) => a + grams(x), 0)
      return all > 0 ? grams(sub) / all : 0
    },
    /** undissolved(c) or undissolved(c, substance): solid still present, settled or suspended. */
    undissolved: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      const susp = (x: string) => box.contents.layers.reduce((a, l) => a + (l.particles?.[x] ?? 0), 0)
      const all = new Set([...Object.keys(box.contents.solid), ...box.contents.layers.flatMap((l) => Object.keys(l.particles ?? {}))])
      const subs = s === undefined ? [...all] : [substanceId(def, String(idOf(s)))]
      const g = subs.reduce((a, x) => a + ((box.contents.solid[x] ?? 0) + susp(x)) * (molarMass(cat, x) ?? 0), 0)
      return q(g, 'g')
    },
    /** cells(c) or cells(c, 'viable'): cells per mL in a container (hidden truth). */
    cells: ([c, which]) => {
      const box = container(c)
      const v = box ? liquidVolume(box.contents) : 0
      if (!box || v <= 0) return null
      const pops = Object.values(meanLayer(box.contents).populations ?? {})
      const n = pops.reduce((a, p) => a + (idOf(which) === 'viable' ? p.viable : p.count), 0)
      return n / (v * 1000)
    },
    /** What a container's contents weigh (g), as a balance would show with the container tared. */
    weight: ([c]) => {
      const box = container(c)
      return box ? q(contentsMassKg(cat, box.contents) * 1000, 'g') : null
    },
    /** The catalogue equipment a container is (to fetch a matching one, such as a balance tube). */
    equipmentOf: ([c]) => container(c)?.equipment ?? null,
    /** pelleted(c, substance): what is in the pellet (settled solid), g. */
    pelleted: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      const x = substanceId(def, String(idOf(s)))
      return q((box.contents.solid[x] ?? 0) * (molarMass(cat, x) ?? 0), 'g')
    },
    /** The definition's supplies and samples; a counted sample lists each of its containers. */
    samples: (_a, named) =>
      supplies()
        .filter((s) => named.role === undefined || s.role === named.role)
        .flatMap((s) => {
          const instances = Object.values(world().containers).filter((c) => c.supply === s.id && c.id !== s.id)
          if (instances.length > 0 && !world().containers[s.id]) return instances.map((c) => ({ id: c.id, role: s.role ?? null, label: c.label }))
          return [{ id: s.id, role: s.role ?? null, label: s.label }]
        }),
    // Evidence is historical: wells still count after their plate was disposed of.
    wells: (_a, named) =>
      Object.values(world().containers)
        .filter((c) => c.kind === 'well' && (c.role !== undefined || liquidVolume(c.contents) > 0) && (named.role === undefined || c.role === named.role))
        .map((c) => ({ id: c.id, role: c.role ?? null, position: c.position ?? null, plate: c.plate ?? null, discarded: c.discarded === true })),
    containers: (_a, named) =>
      Object.values(world().containers)
        .filter((c) => !c.discarded && c.kind !== 'well')
        .filter((c) => named.label === undefined || c.label === named.label || c.userLabel === named.label)
        .map((c) => ({ id: c.id, label: c.label, userLabel: c.userLabel ?? null, role: c.role ?? null })),
    /** Containers (plates rather than their wells) holding a material, excluding the supplies themselves. */
    containersWith: ([m]) => {
      const material = String(idOf(m))
      const out = new Set<string>()
      for (const c of Object.values(world().containers)) {
        if (c.discarded || c.supply || !(c.origins ?? []).includes(material)) continue
        if (liquidVolume(c.contents) <= 0) continue
        out.add(c.kind === 'well' && c.plate ? c.plate : c.id)
      }
      return [...out]
    },
    disposals: (_a, named) =>
      world()
        .disposals.filter((d) => named.material === undefined || d.materials.includes(String(idOf(named.material))))
        .map((d) => ({ container: d.container, stream: d.stream, materials: d.materials, event: d.event })),
    /** The stream the definition declares for a material, else its components' hazard facets. */
    wasteStreamFor: ([m]) => {
      const material = String(idOf(m))
      const declared = def.materials?.waste?.find((w) => (w.accepts ?? []).includes(material))
      if (declared) return declared.stream
      const supply = supplies().find((s) => s.id === material)
      const subs = [
        ...(supply?.contains ?? []).map((c) => substanceId(def, c.substance)),
        ...(supply?.preparation ? (cat.preparations.get(supply.preparation)?.components ?? []).map((c) => c.substance) : []),
      ]
      for (const s of subs) {
        const stream = cat.substances.get(s)?.hazard?.wasteStream
        if (stream) return stream
      }
      return 'core:aqueous-waste'
    },
    adjustable: ([p]) => world().places[String(idOf(p))]?.adjustable === true,
    /** reading(step, sample): mean reading of the wells holding that sample in a step's plate read. */
    reading: ([step, sample]) => {
      const id = String(idOf(sample))
      const xs = wellValues(step).filter((x) => fromSample(x.well, id) && x.well.role !== 'blank').map((x) => x.value)
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    },
    /** trace(step, container?): a kinetic read's times (s) and values ({ t, a }), for the container (default the first read). */
    trace: ([step, c]) => {
      const rec = recordOf(step)
      if (!rec?.times || !rec.series) return null
      const key = c === undefined || c === null ? Object.keys(rec.series)[0] : String(idOf(c))
      const a = rec.series[key]
      return a ? { t: [...rec.times], a: [...a] } : null
    },
    /** readings(step, role=…): the readings of wells with a role. */
    readings: ([step], named) =>
      wellValues(step)
        .filter((x) => named.role === undefined || x.well.role === named.role)
        .map((x) => x.value),
    /** reported('conc', sample): an explicitly reported value, else the latest in-range calibrated result. */
    reported: ([quantity, sample]) => {
      const id = String(idOf(sample))
      const explicit = [...world().notebook].reverse().find((e) => e.field === `report:${idOf(quantity)}:${id}`)
      if (explicit) return typeof explicit.value === 'string' && isQuantityString(explicit.value) ? parseValue(explicit.value) : (explicit.value as Value)
      const results: CalibrationResult[] = []
      for (const out of Object.values(run.outputs)) {
        const rs = out.results
        if (Array.isArray(rs)) for (const r of rs as CalibrationResult[]) if (r.item && fromSampleId(world().containers[r.item], id)) results.push(r)
      }
      const pick = [...results].reverse().find((r) => r.inRange) ?? results[results.length - 1]
      if (!pick || !pick.unit) return pick ? pick.x : null
      return q(pick.x, pick.unit)
    },
    /** extrapolated(sample): the result reported for a sample was read from outside the calibrated range. */
    extrapolated: ([sample]) => {
      const id = String(idOf(sample))
      const results: CalibrationResult[] = []
      for (const out of Object.values(run.outputs)) {
        const rs = out.results
        if (Array.isArray(rs)) for (const r of rs as CalibrationResult[]) if (r.item && fromSampleId(world().containers[r.item], id)) results.push(r)
      }
      if (results.length === 0) return false
      // The reported value is the latest in-range result if there is one.
      return !results.some((r) => r.inRange)
    },
    /** seen(step, 'shape'): how a step's look down a microscope showed a structure ('clearly', 'faintly', 'as specks'), or null. */
    seen: ([step, shape]) => {
      const id = run.outputs[String(idOf(step))]?.record
      const rec = world().measurements.find((m) => m.id === id)
      const f = rec?.features?.find((x) => x.shape.includes(String(idOf(shape))))
      return f?.seen ?? null
    },
    /** lensOil(microscope): the objectives with immersion oil left on them. */
    lensOil: ([m]) => {
      const e = world().equipment[String(idOf(m))]
      return e?.state.kind === 'instrument' ? [...(e.state.microscope?.oiled ?? [])] : []
    },
    /** rotorImbalance(centrifuge): the out-of-balance load of the rotor, as a mass. */
    rotorImbalance: ([c]) => q(rotorImbalanceG({ world: world(), cat }, String(idOf(c))), 'g'),
    /** incidents(kind=…): incidents so far, newest last. */
    incidents: (_a, named) =>
      world()
        .incidents.filter((i) => named.kind === undefined || i.kind === named.kind)
        .map((i) => ({ kind: i.kind, severity: i.severity, message: i.message, event: i.event })),
    fit: ([step]) => {
      const out = run.outputs[String(idOf(step))]
      return (out?.fit ?? null) as Value
    },
    /** decision(step) or decision(step, item) for a decision taken once per item. */
    decision: ([step, item]) => run.decisions[item === undefined ? String(idOf(step)) : `${idOf(step)}:${idOf(item)}`] ?? null,
    /** The organisms in a container (suspension or slide), by id. */
    organisms: ([c]) => {
      const box = container(c)
      if (!box) return []
      return [...new Set(strainsIn(box).map(baseOrganism))]
    },
    /** Strains (organism, plus "+plasmid" for transformants) in a container, a slide or on a plate. */
    strains: ([c]) => {
      const box = container(c)
      return box ? strainsIn(box) : []
    },
    /** Visible colonies on an agar plate (all strains). */
    colonies: ([c]) => {
      const box = container(c)
      return box ? coloniesOn(cat, box.contents).reduce((a, v) => a + v.colonies, 0) : null
    },
    /** Separate colonies in the most dilute sector of a streak plate that has any (0 if none). */
    isolated: ([c]) => {
      const box = container(c)
      if (!box) return null
      const views = coloniesOn(cat, box.contents)
      const i = isolatedSector(views)
      return i < 0 ? 0 : views.reduce((a, v) => a + (v.bySector?.[i] ?? 0), 0)
    },
    /** Band positions (mm, nearest the well first) in a gel lane, from the latest image of that gel. */
    bandsIn: ([lane]) => {
      const id = String(idOf(lane))
      const rec = [...world().measurements].reverse().find((m) => m.bands && m.subject === world().containers[id]?.plate)
      return rec ? rec.bands!.filter((b) => b.lane === id).map((b) => q(b.positionMm, 'mm')).sort((a, b) => a.si - b.si) : []
    },
    /** bandVolumes(lane): the integrated signal of each band in a gel lane (nearest the well first), from the latest image of that gel. */
    bandVolumes: ([lane]) => {
      const id = String(idOf(lane))
      const rec = [...world().measurements].reverse().find((m) => m.bands && m.subject === world().containers[id]?.plate)
      return rec ? rec.bands!.filter((b) => b.lane === id).sort((a, b) => a.positionMm - b.positionMm).map((b) => b.volume ?? 0) : []
    },
    /** A ladder's sizes, largest first (bp for DNA, kDa for proteins), as on its data sheet. */
    ladderSizes: ([s]) => {
      const sub = cat.substances.get(substanceId(def, String(idOf(s))))
      const sizes = sub?.dna?.fragments?.map((f) => f.bp) ?? sub?.protein?.ladder?.map((f) => f.kDa) ?? []
      return [...sizes].sort((a, b) => b - a)
    },
    /** Copies of a PCR product in a tube (hidden truth). */
    amplified: ([c, s]) => {
      const box = container(c)
      if (!box) return null
      return totalMol(box, substanceId(def, String(idOf(s)))) * 6.022e23
    },
    /** tlcSpots(plate, lane): spot positions (mm from the origin, nearest first) in the latest UV view of a TLC plate. */
    tlcSpots: ([plate, lane]) => {
      const id = String(idOf(plate))
      const key = `${id}#${Number(lane)}`
      const rec = [...world().measurements].reverse().find((m) => m.subject === id && m.bands && m.settings.frontMm !== undefined)
      return rec ? rec.bands!.filter((b) => b.lane === key).map((b) => q(b.positionMm, 'mm')).sort((a, b) => a.si - b.si) : []
    },
    /** blotBands(membrane, lane): band positions (mm, nearest the wells first) in the latest developed image of a blot. */
    blotBands: ([membrane, lane]) => {
      const id = String(idOf(membrane))
      const key = `${id}#${Number(lane)}`
      const rec = [...world().measurements].reverse().find((m) => m.subject === id && m.settings.blot !== undefined)
      return rec ? rec.bands!.filter((b) => b.lane === key).map((b) => q(b.positionMm, 'mm')).sort((a, b) => a.si - b.si) : []
    },
    /** solventFront(plate): how far the solvent front ran (mm from the origin), as the latest UV view of the plate shows it. */
    solventFront: ([plate]) => {
      const id = String(idOf(plate))
      const rec = [...world().measurements].reverse().find((m) => m.subject === id && m.settings.frontMm !== undefined)
      return rec ? q(Number(rec.settings.frontMm), 'mm') : null
    },
    /** cutShare(c, dna, enzyme?): the share of a DNA's restriction sites in c that are cut (all its sites, or one enzyme's), 0..1 (hidden truth). */
    cutShare: ([c, s, e]) => {
      const box = container(c)
      if (!box) return null
      return cutShare(cat, box.contents, substanceId(def, String(idOf(s))), e === undefined ? undefined : substanceId(def, String(idOf(e))))
    },
    /** Whether any colonies on a plate glow under UV. */
    fluorescent: ([c]) => {
      const box = container(c)
      return box ? coloniesOn(cat, box.contents).some((v) => v.fluorescent && v.colonies > 0) : null
    },
    /** The true Gram class of the organism in a culture or on a slide (hidden truth). */
    gramClass: ([c]) => {
      const box = container(c)
      if (!box) return null
      const orgs = strainsIn(box).map(baseOrganism)
      return orgs.length ? (cat.substances.get(orgs[0])?.organism?.gram ?? null) : null
    },
    /** The colour of the stained cells on a slide, as a microscope would show it. */
    stainColour: ([c]) => {
      const box = container(c)
      const cells = Object.values(box?.contents.film ?? {}).filter((x) => cellsPerField(x.count) >= 0.5)
      if (!cells.length) return 'none'
      return cellColour(cells.reduce((a, b) => (b.count > a.count ? b : a)))
    },
    validity: () => validity(run),
    /** used(thing, step): whether a data step used it (blank subtraction with blanks present). */
    used: ([thing, step]) => {
      const out = run.outputs[String(idOf(step))]
      if (!out) return false
      if (idOf(thing) === 'blank') return events(run, String(idOf(step))).some((e) => e.op === 'core:transform' && Number(e.blankCount ?? 0) > 0)
      return String(idOf(thing)) in out
    },
    /** events(op=…, step=…): facts of events inside the current technique invocation. */
    events: (_a, named) =>
      events(run, scope.path).filter(
        (e) => (named.op === undefined || e.op === idOf(named.op)) && (named.step === undefined || e.localStep === idOf(named.step)),
      ) as unknown as Value[],
    before: ([a, b]) => {
      const first = (id: string) => kernel.events.find((e) => (e.path ?? '').split('/')[0] === id)?.index ?? Infinity
      return first(String(idOf(a))) < first(String(idOf(b)))
    },
  }
  return fns

  function fromSampleId(c: Container | undefined, id: string): boolean {
    return !!c && ((c.origins ?? []).includes(id) || c.id === id)
  }
}

interface EventView {
  index: number
  op: string
  path: string
  localStep: string
  [fact: string]: unknown
}

function events(run: RunContext, prefix?: string): EventView[] {
  return run.kernel.events
    .filter((e) => !prefix || e.path === prefix || (e.path ?? '').startsWith(`${prefix}/`))
    .map((e) => {
      const segs = (e.path ?? '').split('/')
      const localStep = (segs[segs.length - 1] ?? '').replace(/\[\d+\]$/, '')
      return { index: e.index, op: e.op, path: e.path ?? '', localStep, ...e.facts }
    })
}

/** The validity verdict: the worst cap among the definition's validity rules that apply (format §11). */
export function validity(run: RunContext): ValidityVerdict {
  let worst = 0
  const env = runEnv(run)
  for (const rule of run.def.assessment?.validity ?? []) {
    let applies = false
    try {
      applies = truthy(evaluateSafe(rule.when, env))
    } catch {
      applies = false
    }
    if (applies) worst = Math.max(worst, VALIDITY_VERDICTS.indexOf(rule.cap))
  }
  return VALIDITY_VERDICTS[worst]
}


function evaluateSafe(expr: string, env: Env): Value {
  return evaluate(expr, env)
}

/** The environment for definition-level expressions: materials, roles, step outputs, run functions. */
export function runEnv(run: RunContext, extra: Record<string, Value> = {}, scope: ScopeInfo = {}): Env {
  const vars: Record<string, Value> = {}
  for (const [id, out] of Object.entries(run.outputs)) vars[id] = { id, out } as Value
  for (const [role, id] of Object.entries(run.roles)) vars[role] = id
  return makeEnv({ ...vars, ...extra }, runFunctions(run, scope))
}

export function isValue(v: unknown): v is Value {
  return v === null || ['number', 'string', 'boolean'].includes(typeof v) || Array.isArray(v) || isQuantity(v) || isRecord(v) || isIdRef(v)
}
