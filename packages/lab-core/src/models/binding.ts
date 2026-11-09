// Surfaces and binding (contracts adsorption.surface and binding.affinity, T2): what an ELISA
// rests on. A high-binding vessel adsorbs proteins from its liquid until its wetted wall is full
// (so a blocking protein takes the space other proteins would have used). Antibodies bind their
// targets on the wall with on and off rates, so a bound antibody stays through washes and can
// itself be bound (a secondary antibody recognises a tag of the primary). What is on the wall
// keeps working: a bound enzyme acts on the liquid above it.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Container, Species } from '../kernel/state.ts'
import { liquidVolume } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

/** Adsorption time constant at 37 °C (s), slowing twofold every 10 °C below. */
const ADSORB_TAU_37 = 1200
const K0 = 273.15

interface Antibody {
  id: string
  /** A substance id, or "tag:<name>" for anything carrying that tag. */
  target: string
  kon: number
  koff: number
}

interface Params {
  antibodies: Antibody[]
  tags: Map<string, Set<string>>
  proteins: Set<string>
  molarMassG: Map<string, number>
}

const cache = new WeakMap<Catalogue, Params>()

function params(cat: Catalogue): Params {
  const hit = cache.get(cat)
  if (hit) return hit
  const antibodies: Antibody[] = []
  const tags = new Map<string, Set<string>>()
  const proteins = new Set<string>()
  const molarMassG = new Map<string, number>()
  for (const s of cat.substances.values()) {
    if (s.physical?.molarMass) molarMassG.set(s.id, parseValue(s.physical.molarMass).si * 1000)
    if (s.protein || s.identity.class === 'protein' || s.identity.class === 'enzyme') proteins.add(s.id)
    for (const t of s.tags ?? []) {
      const set = tags.get(t) ?? new Set<string>()
      set.add(s.id)
      tags.set(t, set)
    }
    if (s.antibody) {
      const kon = s.antibody.kon ?? 1e5
      // Kd in mol/L: koff = kon × Kd.
      const kd = parseValue(s.antibody.kd).si / 1000
      antibodies.push({ id: s.id, target: s.antibody.target, kon, koff: kon * kd })
    }
  }
  const out = { antibodies, tags, proteins, molarMassG }
  cache.set(cat, out)
  return out
}

/** Wetted wall area (m²) of a well or tube holding a volume: its bottom and the wall up to the liquid's height. */
export function wettedArea(c: Container, volumeL: number): number {
  const bottom = c.areaM2 ?? 3.2e-5
  const height = (volumeL / 1000) / bottom
  return bottom + 2 * Math.sqrt(Math.PI * bottom) * height
}

/** The wall's protein capacity (kg/m²): high-binding plates declare one; ordinary plastic does not bind. */
export function bindingCapacity(cat: Catalogue, c: Container): number | undefined {
  const text = cat.property(c.equipment, 'bindingCapacity')
  return text === undefined ? undefined : parseValue(String(text)).si
}

/**
 * One step of adsorption and binding in a vessel. `capacityKgPerM2` is its wall's protein capacity
 * (kg/m²); proteins dissolved in its (bottom) liquid adsorb in proportion to their mass while the
 * wall has room, and antibodies in the liquid bind their targets on the wall.
 */
export function surfaceStep(cat: Catalogue, c: Container, capacityKgPerM2: number, T: number, dt: number): void {
  const layers = c.contents.layers
  if (layers.length === 0) return
  const layer = layers[layers.length - 1]
  const v = layer.volumeL
  if (!(v > 0)) return
  const p = params(cat)
  const wall = (c.contents.adsorbed ??= {})
  const mass = (s: string, n: number) => n * (p.molarMassG.get(s) ?? 50000)
  // Adsorption: the wall's free capacity is shared by the proteins in proportion to their mass.
  // A membrane has a fixed area; a well is wetted as far as the liquid reaches.
  const sheet = cat.property(c.equipment, 'surfaceAreaCm2')
  const areaM2 = sheet !== undefined ? Number(sheet) * 1e-4 : wettedArea(c, liquidVolume(c.contents))
  const capacityG = capacityKgPerM2 * 1000 * areaM2
  const usedG = Object.entries(wall).reduce((a, [s, n]) => a + mass(s, n), 0)
  const free = Math.max(0, 1 - usedG / capacityG)
  if (free > 0) {
    const rate = (1 / ADSORB_TAU_37) * Math.pow(2, (T - (37 + K0)) / 10)
    const dissolvedG = Object.entries(layer.species).reduce((a, [s, n]) => a + (p.proteins.has(s) && n > 0 ? mass(s, n) : 0), 0)
    if (dissolvedG > 0) {
      // Take at most what fits: the free capacity, approached exponentially.
      const takeG = Math.min(dissolvedG * (1 - Math.exp(-rate * dt * free)), free * capacityG)
      for (const [s, n] of Object.entries(layer.species)) {
        if (!p.proteins.has(s) || !(n > 0)) continue
        const share = mass(s, n) / dissolvedG
        const mol = (takeG * share) / (p.molarMassG.get(s) ?? 50000)
        layer.species[s] = n - mol
        wall[s] = (wall[s] ?? 0) + mol
      }
    }
  }
  // Specific binding to targets on the wall: d(bound)/dt = kon [A] (sites free) − koff bound.
  for (const ab of p.antibodies) {
    const dissolved = layer.species[ab.id] ?? 0
    const bound = boundOf(wall, ab.id)
    if (!(dissolved > 0) && !(bound > 0)) continue
    const targets = targetsOf(p, ab.target)
    let sites = 0
    for (const t of targets) sites += wall[t] ?? 0
    // Sites already taken by any antibody aimed at the same target.
    let taken = 0
    for (const other of p.antibodies) if (other.target === ab.target) taken += boundOf(wall, other.id)
    const freeSites = Math.max(0, sites - taken)
    const conc = dissolved / v
    let net = (ab.kon * conc * freeSites - ab.koff * bound) * dt
    net = Math.max(-bound, Math.min(net, dissolved, freeSites))
    if (net === 0) continue
    layer.species[ab.id] = dissolved - net
    wall[boundKey(ab.id)] = bound + net
  }
}

/** Antibodies bound through their binding site are kept apart from those stuck to bare plastic. */
export const boundKey = (antibody: string) => `${antibody}@bound`
const boundOf = (wall: Species, antibody: string) => wall[boundKey(antibody)] ?? 0

/** Antibodies the catalogue declares: what each binds and its rates. */
export function antibodiesOf(cat: Catalogue): ReadonlyArray<{ id: string; target: string; kon: number; koff: number }> {
  return params(cat).antibodies
}

/** Whether a substance (or an antibody bound as "id@bound") is what an antibody's target names. */
export function matchesTarget(cat: Catalogue, target: string, key: string): boolean {
  const base = key.endsWith('@bound') ? key.slice(0, -'@bound'.length) : key
  if (!target.startsWith('tag:')) return base === target
  return params(cat).tags.get(target.slice(4))?.has(base) === true
}

function targetsOf(p: Params, target: string): string[] {
  if (!target.startsWith('tag:')) return [target, boundKey(target)]
  const ids = [...(p.tags.get(target.slice(4)) ?? [])]
  return [...ids, ...ids.map(boundKey)]
}

/** Total of a substance on a wall (adsorbed to plastic and bound through its binding site), mol. */
export function onWall(c: Container, substance: string): number {
  const wall = c.contents.adsorbed ?? {}
  return (wall[substance] ?? 0) + (wall[boundKey(substance)] ?? 0)
}
