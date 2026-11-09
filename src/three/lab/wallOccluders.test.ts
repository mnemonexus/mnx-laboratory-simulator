import { describe, expect, it } from 'vitest'
import { wallOccluders } from './architecture'
import { ZONES, ZONE_IDS, zoneWalls } from './layout'

/** Same test as the baker's `Grid.inside`: strictly within a box. */
function inside(boxes: number[], x: number, y: number, z: number) {
  for (let i = 0; i < boxes.length; i += 6) {
    if (x > boxes[i] && x < boxes[i + 3] && y > boxes[i + 1] && y < boxes[i + 4] && z > boxes[i + 2] && z < boxes[i + 5]) return true
  }
  return false
}

describe('wall occluders for the light bake', () => {
  it('never cover a wall face, slanted walls included, but still block behind it', () => {
    let slanted = 0
    for (const id of ZONE_IDS) {
      const walls = zoneWalls(ZONES[id])
      const boxes = wallOccluders(walls, ZONES[id].ceiling)
      for (const w of walls) {
        if (Math.abs(w.t[0]) < 0.999 && Math.abs(w.t[1]) < 0.999) slanted++
        for (let s = 0.05; s < w.length - 0.05; s += 0.037) {
          const x = w.a[0] + w.t[0] * s
          const z = w.a[1] + w.t[1] * s
          // the baker probes 1 cm in front of a texel
          expect(inside(boxes, x + w.n[0] * 0.01, 1.2, z + w.n[1] * 0.01), `${id} face at ${s.toFixed(2)}`).toBe(false)
          // straight walls are boxed 0–12 cm behind the face, slanted runs 8–20 cm
          expect(inside(boxes, x - w.n[0] * 0.1, 1.2, z - w.n[1] * 0.1), `${id} behind at ${s.toFixed(2)}`).toBe(true)
        }
      }
    }
    // the hexagonal hub and angled corridors exercise the slanted path
    expect(slanted).toBeGreaterThan(0)
  })
})
