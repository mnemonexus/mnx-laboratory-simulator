// Animal choice (contract organism.taxis, T1): animals in a two-sided choice chamber wander between
// the sides at random, leaving a side faster the less they like it. Each animal leaves its side at a
// rate k·exp(−(A_here − A_there)/2), where a side's attractiveness A sums the animal's preferences for
// its conditions (humid over dry, dark over light), so the numbers settle with the sides in the ratio
// exp(A₁ − A₂), a minute or two after they are put in. Counts are of individual animals, drawn at
// random each step, so a small group gives noisy results.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Chamber } from '../kernel/state.ts'
import { createRng } from '../rng/rng.ts'

/** How often an animal indifferent to the sides crosses over (per second). */
const CROSSING_PER_S = 1 / 60

function attractiveness(pref: { humid?: number; dark?: number }, side: Chamber['sides'][number]): number {
  return (pref.humid ?? 0) * (side.humidity === 'humid' ? 1 : side.humidity === 'dry' ? -1 : 0) + (pref.dark ?? 0) * (side.light === 'dark' ? 1 : side.light === 'light' ? -1 : 0)
}

/** Time passing in a choice chamber: each animal may cross to the other side. */
export function wander(cat: Catalogue, seed: number, chamberId: string, chamber: Chamber, nowS: number, dt: number): void {
  const rng = createRng(`${seed}|wander|${chamberId}|${Math.round(nowS)}`)
  for (const [organism, counts] of Object.entries(chamber.animals)) {
    const pref = cat.substances.get(organism)?.taxis ?? {}
    const a = chamber.sides.map((s) => attractiveness(pref, s))
    const leave = [0, 1].map((i) => rng.binomial(counts[i], 1 - Math.exp(-CROSSING_PER_S * Math.exp(-(a[i] - a[1 - i]) / 2) * dt)))
    counts[0] += leave[1] - leave[0]
    counts[1] += leave[0] - leave[1]
  }
}
