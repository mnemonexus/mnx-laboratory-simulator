import { describe, expect, it } from 'vitest'
import { outlineWalls } from './lighting'
import { polygonContains } from './layout'

describe('outlineWalls', () => {
  it('leaves a room that fills its box to the box', () => {
    expect(outlineWalls([[0, 0], [4, 0], [4, 3], [0, 3]])).toEqual([])
  })

  for (const [order, outline] of [
    ['one winding', [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]]],
    ['the other', [[0, 3], [1, 3], [1, 1], [4, 1], [4, 0], [0, 0]]],
  ] as const) {
    it(`points every wall of an L outward (${order})`, () => {
      const poly = outline as unknown as [number, number][]
      const walls = outlineWalls(poly)
      expect(walls).toHaveLength(poly.length)
      for (const [edge, run] of walls) {
        // the wall's midpoint, a step out and a step in
        const mx = edge.x + run.x * run.z / 2
        const mz = edge.y + run.y * run.z / 2
        expect(polygonContains(poly, mx + edge.z * 0.05, mz + edge.w * 0.05)).toBe(false)
        expect(polygonContains(poly, mx - edge.z * 0.05, mz - edge.w * 0.05)).toBe(true)
        expect(run.z).toBeGreaterThan(0)
      }
    })
  }
})
