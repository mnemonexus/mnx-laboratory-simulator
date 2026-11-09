// Light microscopy (contract microscopy, T2; scientific simulation §3.1): what a compound
// microscope shows of a slide, from its optics and how it has been set up. Objective and eyepiece
// give the magnification, and the field number the field of view. The finest detail seen is the
// coarser of the objective's resolution (0.61 λ / NA; an oil objective has its full NA only through
// oil) and what the eye can pick out at that magnification. Contrast is the specimen's (absorbing:
// stained, pigmented or inked; transparent: living and unstained) under the illumination (bright
// field, or phase contrast through the annulus that matches the objective's phase ring). What is
// seen is described, never named.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Container, FixedCells, ViewFlag } from '../kernel/state.ts'
import type { Rng } from '../rng/rng.ts'
import { parseValue } from '../units/index.ts'
import { baseOrganism, cellSizeUm } from './growth.ts'
import { cellColour } from './staining.ts'
import { plasmolysedShare } from './tissue.ts'

export interface ObjectiveSpec {
  id: string
  magnification: number
  na: number
  /** Free working distance, mm. Under about 1 mm, coarse focusing drives the lens into the slide. */
  workingDistanceMm: number
  oil: boolean
  /** The condenser annulus that matches this objective's phase ring (ph1, ph2, ph3), if it has one. */
  phase?: string
}

/** Typical achromat objectives, by the id a microscope's `objectives` property lists. */
const OBJECTIVES: Record<string, Omit<ObjectiveSpec, 'id'>> = {
  '4x': { magnification: 4, na: 0.1, workingDistanceMm: 30, oil: false },
  '10x': { magnification: 10, na: 0.25, workingDistanceMm: 7, oil: false, phase: 'ph1' },
  '20x': { magnification: 20, na: 0.4, workingDistanceMm: 3, oil: false, phase: 'ph1' },
  '40x': { magnification: 40, na: 0.65, workingDistanceMm: 0.6, oil: false, phase: 'ph2' },
  '60x': { magnification: 60, na: 0.8, workingDistanceMm: 0.3, oil: false, phase: 'ph2' },
  '100x-oil': { magnification: 100, na: 1.25, workingDistanceMm: 0.2, oil: true, phase: 'ph3' },
}

const WAVELENGTH_UM = 0.55
/** The eye picks out about 0.1 mm in the image at reading distance. */
const EYE_LIMIT_UM = 100
/** A smear covers about 1 cm²; a drop under a 22 mm coverslip spreads over its 484 mm². */
const SMEAR_AREA_MM2 = 100
const COVERSLIP_AREA_MM2 = 484
/** A letter written small with a marker pen. */
const INK_MARK_UM = 1500

export function objectiveIds(cat: Catalogue, microscope: string): string[] {
  return String(cat.property(microscope, 'objectives') ?? '4x 10x 40x 100x-oil').split(/\s+/).filter(Boolean)
}

export function illuminations(cat: Catalogue, microscope: string): string[] {
  return String(cat.property(microscope, 'illumination') ?? 'brightfield').split(/\s+/).filter(Boolean)
}

export function objectiveSpec(cat: Catalogue, microscope: string, id: string): ObjectiveSpec | undefined {
  if (!objectiveIds(cat, microscope).includes(id)) return undefined
  const base = OBJECTIVES[id] ?? { magnification: Number.parseFloat(id) || 10, na: 0.25, workingDistanceMm: 5, oil: id.includes('oil') }
  return { id, ...base }
}

/** How a microscope is set up for one look at a slide. */
export interface Setup {
  objective: ObjectiveSpec
  illumination: string
  /** Lamp output, as a fraction of full. */
  lamp: number
  condenserAdjusted: boolean
  focus: 'none' | 'near' | 'sharp'
  /** Oil between the slide and the objective. */
  oilOnSlide: boolean
  /** A dry objective carrying immersion oil on its front lens. */
  lensOiled: boolean
  cracked: boolean
}

export interface Optics {
  magnification: number
  fieldOfViewMm: number
  /** The finest detail that can be told apart, µm. */
  resolutionUm: number
  /** Contrast score (0 nothing, 1 faint, 2 clear, 3 strong) for each kind of specimen. */
  contrast: { absorbing: number; transparent: number }
  flags: ViewFlag[]
  /** Nothing at all can be seen (no light, nothing in focus). */
  blank?: string
}

/** Lamp needed for a good image: more at higher power, more again through a phase annulus. */
function lampNeeded(magnification: number, phase: boolean): number {
  const need = 0.3 + (0.35 * Math.log10(Math.max(1, magnification) / 4)) / Math.log10(25)
  return phase ? need * 1.4 : need
}

export function optics(cat: Catalogue, microscope: string, s: Setup): Optics {
  const o = s.objective
  const eyepiece = Number(cat.property(microscope, 'eyepiece') ?? 10)
  const fieldNumber = Number(cat.property(microscope, 'fieldNumber') ?? 18)
  const magnification = o.magnification * eyepiece
  const fieldOfViewMm = fieldNumber / o.magnification
  const flags: ViewFlag[] = []
  let resolution = Math.max((0.61 * WAVELENGTH_UM) / o.na, EYE_LIMIT_UM / magnification)
  const phase = s.illumination !== 'brightfield'
  const matched = phase && o.phase === s.illumination
  let absorbing = !phase ? 3 : matched ? 2 : 1
  let transparent = !phase ? 1 : matched ? 3 : 1
  if (phase && !matched) flags.push('annulus-mismatch')
  if (!s.condenserAdjusted) {
    resolution *= 1.25
    flags.push('uneven-illumination')
  }
  if (o.oil && !s.oilOnSlide) {
    // Through air an oil objective loses most of its aperture and images through a haze.
    resolution *= 3
    absorbing -= 1
    transparent -= 1
    flags.push('no-oil')
  }
  if (!o.oil && s.lensOiled) {
    resolution *= 4
    absorbing -= 1
    transparent -= 1
    flags.push('oil-on-lens')
  }
  if (s.cracked) {
    absorbing -= 1
    transparent -= 1
    flags.push('cracked-slide')
  }
  const brightness = s.lamp / lampNeeded(o.magnification, phase)
  if (brightness < 0.4) {
    absorbing -= 2
    transparent -= 2
    flags.push('too-dark')
  } else if (brightness < 0.8) {
    absorbing -= 1
    transparent -= 1
    flags.push('dim')
  } else if (brightness > 2.5) {
    // Too much light washes out what little contrast an unstained specimen has in bright field.
    if (!phase) transparent -= 1
    flags.push('glare')
  }
  if (s.focus === 'none') flags.push('out-of-focus')
  else if (s.focus === 'near' && o.magnification >= 40) {
    // Parfocal objectives arrive nearly in focus; at high power the fine knob is still needed.
    resolution *= 2.5
    flags.push('out-of-focus')
  }
  const out: Optics = { magnification, fieldOfViewMm, resolutionUm: resolution, contrast: { absorbing: Math.max(0, absorbing), transparent: Math.max(0, transparent) }, flags }
  if (s.lamp <= 0.02) out.blank = 'dark: the lamp is off'
  else if (s.focus === 'none') out.blank = 'a blur: nothing is in focus'
  return out
}

/** Something on a slide that can be seen. */
export interface Structure {
  label: string
  sizeUm: number
  contrast: 'absorbing' | 'transparent'
  colour: string
  arrangement: string
  /** Per mm² of slide; undefined for a single object in the middle of the slide. */
  perMm2?: number
  /** Writing: seen upside down and back to front. */
  text?: boolean
  /** How long one is (µm, the mean), and how much they differ (a share): what a graticule measures. */
  lengthUm?: number
  spread?: number
  /** A ruled scale (a stage micrometer): the length of one division, µm. */
  divisionUm?: number
}

export interface FieldFeature {
  shape: string
  arrangement: string
  colour: string
  abundance: 'none' | 'one' | 'few' | 'many'
  seen?: 'clearly' | 'faintly' | 'as specks'
  note?: string
  /** How many are in this field of view (when they are few enough to count). */
  count?: number
}

/** Above this many in a field nobody counts them one by one. */
const COUNTABLE = 400

/** Everything on a slide: a fixed smear, a wet mount, a mounted specimen, ink in the middle. */
export function structuresOn(cat: Catalogue, slide: Container): Structure[] {
  const out: Structure[] = []
  for (const [organism, cells] of Object.entries((slide.contents.film ?? {}) as Record<string, FixedCells>)) {
    const o = cat.substances.get(baseOrganism(organism))?.organism
    const colour = cellColour(cells)
    out.push({
      label: o?.morphology ?? 'cells',
      sizeUm: cellSizeUm(cat, organism),
      contrast: colour === 'colourless' ? 'transparent' : 'absorbing',
      colour,
      arrangement: o?.arrangement ?? 'single',
      perMm2: cells.count / SMEAR_AREA_MM2,
    })
  }
  for (const layer of slide.contents.layers) {
    for (const [organism, pop] of Object.entries(layer.populations ?? {})) {
      const o = cat.substances.get(baseOrganism(organism))?.organism
      out.push({
        label: o?.morphology ?? 'cells',
        sizeUm: cellSizeUm(cat, organism),
        contrast: 'transparent',
        colour: 'colourless',
        arrangement: o?.arrangement ?? 'single',
        perMm2: pop.count / COVERSLIP_AREA_MM2,
      })
    }
  }
  // A prepared slide's specimen, and specimens mounted on a slide by hand (a wet mount: a strip of
  // onion epidermis, cheek cells), whose structures take up any stain in the mounting liquid.
  const specimen = cat.property(slide.equipment, 'specimen')
  const mounted = Object.entries(slide.contents.solid).filter(([s, n]) => n > 0 && cat.substances.get(s)?.specimen).map(([s]) => s)
  const stains = new Set(slide.contents.layers.flatMap((l) => Object.entries(l.species).filter(([, n]) => n > 0).map(([s]) => s)))
  for (const id of [...(typeof specimen === 'string' ? [specimen] : []), ...mounted]) {
    // Living tissue in the mounting liquid: its cells plasmolyse where the liquid's water potential is low enough.
    const plasmolysed = st0(cat, id) ? plasmolysedShare(cat, id, slide) : 0
    for (const st of cat.substances.get(id)?.specimen?.structures ?? []) {
      const share = st.state === 'plasmolysed' ? plasmolysed : st.state === 'turgid' ? 1 - plasmolysed : 1
      if (st.state && !(share > 0)) continue
      const stain = Object.entries(st.stains ?? {}).find(([s]) => stains.has(s))
      out.push({
        label: st.label,
        sizeUm: parseValue(st.size).si * 1e6,
        contrast: stain ? 'absorbing' : st.contrast,
        colour: stain ? stain[1] : (st.colour ?? (st.contrast === 'transparent' ? 'colourless' : 'dark')),
        arrangement: st.arrangement ?? 'single',
        perMm2: st.density !== undefined ? st.density * share : undefined,
        text: st.text,
        lengthUm: (st.length ? parseValue(st.length).si : parseValue(st.size).si) * 1e6,
        ...(st.spread !== undefined ? { spread: st.spread } : {}),
        ...(st.division ? { divisionUm: parseValue(st.division).si * 1e6 } : {}),
      })
    }
  }
  for (const mark of slide.marks ?? []) {
    out.push({ label: `handwritten "${mark}"`, sizeUm: INK_MARK_UM, contrast: 'absorbing', colour: 'black', arrangement: 'single', text: true })
  }
  return out
}

/** Whether a specimen is living tissue (it has a tissue facet). */
function st0(cat: Catalogue, id: string): boolean {
  return !!cat.substances.get(id)?.tissue
}

/** What one look shows: each structure that can be made out, and how well. */
export function viewField(structures: Structure[], o: Optics, rng?: Rng): FieldFeature[] {
  if (o.blank) return []
  const fieldUm = o.fieldOfViewMm * 1000
  const area = Math.PI * (o.fieldOfViewMm / 2) ** 2
  const out: FieldFeature[] = []
  for (const s of structures) {
    const c = o.contrast[s.contrast]
    if (c <= 0) continue
    const d = o.resolutionUm
    let seen: FieldFeature['seen']
    if (s.sizeUm >= 2 * d) seen = c >= 2 ? 'clearly' : 'faintly'
    else if (s.sizeUm >= 0.5 * d && c >= 2) seen = 'as specks'
    else continue
    let abundance: FieldFeature['abundance'] = 'one'
    let count: number | undefined
    if (s.perMm2 !== undefined) {
      const perField = s.perMm2 * area
      // Countable: how many happen to be in this field (Poisson about the mean).
      if (rng && perField <= COUNTABLE) count = rng.poisson(perField)
      // None in this field (counted), or fewer than one in two fields: not seen in this look.
      if (count === 0 || (count === undefined && perField < 0.5)) continue
      abundance = perField >= 20 ? 'many' : 'few'
    }
    const notes: string[] = []
    if (s.text) notes.push('upside down and back to front')
    if (s.sizeUm > 0.8 * fieldUm) notes.push('larger than the field: only part of it is in view')
    out.push({ shape: s.label, arrangement: s.arrangement, colour: s.colour, abundance, seen, ...(notes.length ? { note: notes.join('; ') } : {}), ...(count !== undefined ? { count } : {}) })
  }
  const rank = { many: 0, one: 1, few: 2, none: 3 }
  return out.sort((a, b) => rank[a.abundance] - rank[b.abundance])
}

export function describeFeature(f: FieldFeature): string {
  // "cocci in clusters", but "yeast, single and budding".
  const arrangement = !f.arrangement || f.arrangement === 'single' ? '' : /^(single|budding|scattered)/.test(f.arrangement) ? `, ${f.arrangement}` : ` in ${f.arrangement}`
  const colour = f.shape.includes(f.colour) ? '' : `${f.colour} `
  const what = `${f.count !== undefined ? `${f.count} ` : f.abundance === 'few' ? 'a few ' : ''}${colour}${f.shape}${arrangement}`
  const how = f.seen === 'as specks' ? ' (only as specks)' : f.seen === 'faintly' ? ' (faint)' : ''
  return `${what}${how}${f.note ? `, ${f.note}` : ''}`
}

/**
 * An eyepiece graticule: a scale of `divisions` ruled across `spanMm` in the eyepiece's focal plane,
 * where the objective forms its image. One division covers spanMm / divisions ÷ the objective's
 * true magnification on the slide; nominal magnifications are within a few per cent of the truth
 * (ISO 8039 allows ±5 %), which is why a graticule is calibrated for each objective against a
 * stage micrometer rather than worked out.
 */
export interface Graticule {
  divisions: number
  /** Length on the slide of one division, µm, with the objective in place. */
  umPerDivision: number
}

export interface GraticuleReading {
  /** Structures lined up against the scale: one of each that shows its form, in eyepiece divisions (to half a division). */
  measured: Array<[string, number]>
  /** A stage micrometer lined up with the scale: so many eyepiece divisions span so many of its divisions. */
  calibration?: { eyepiece: number; stage: number }
  /** Structures longer than the whole scale. */
  tooLong: string[]
}

/** Read to the nearest half division, with the small misalignment of lining up by eye. */
function readHalf(x: number, rng: Rng, noise: number): number {
  return Math.max(0.5, Math.round(2 * (x + rng.normal(0, 0.3 * noise))) / 2)
}

/**
 * Line the graticule up against what one look shows. A cell is measured along its longest axis: one
 * of them, drawn from how much they differ. A ruled scale (stage micrometer) is matched to the
 * graticule from coinciding zero lines: the shorter of the two scales is read against the other.
 */
export function readGraticule(structures: Structure[], features: FieldFeature[], g: Graticule, rng: Rng, noise: number): GraticuleReading {
  const out: GraticuleReading = { measured: [], tooLong: [] }
  for (const f of features) {
    if (f.seen !== 'clearly' && f.seen !== 'faintly') continue
    const s = structures.find((x) => x.label === f.shape)
    if (!s) continue
    if (s.divisionUm) {
      const scaleUm = s.lengthUm ?? s.sizeUm
      const graticuleUm = g.divisions * g.umPerDivision
      out.calibration =
        graticuleUm <= scaleUm
          ? { eyepiece: g.divisions, stage: readHalf(graticuleUm / s.divisionUm, rng, noise) }
          : { eyepiece: readHalf(scaleUm / g.umPerDivision, rng, noise), stage: Math.round(scaleUm / s.divisionUm) }
      continue
    }
    const mean = s.lengthUm ?? s.sizeUm
    const one = mean * Math.max(0.4, 1 + (s.spread ?? 0.15) * rng.normal())
    const divisions = one / g.umPerDivision
    if (divisions > g.divisions) out.tooLong.push(s.label)
    else out.measured.push([s.label, readHalf(divisions, rng, noise)])
  }
  return out
}
