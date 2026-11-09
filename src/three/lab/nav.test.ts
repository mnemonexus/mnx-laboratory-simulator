import { expect, it } from 'vitest'
import { Nav } from './nav'
import { DOORS } from './layout'

it('lets a reflection probe see on through leafless openings, never past doors', () => {
  const nav = new Nav([])
  // a room behind ordinary doors sees only itself
  expect([...nav.seenThroughOpenings('main')]).toEqual(['main'])
  // the commons opens onto the hall, the core street and X06, and on through them
  const commons = nav.seenThroughOpenings('X05')
  for (const zone of ['X05', 'hall', 'X03', 'X06', 'X02', 'C01'] as const) expect(commons.has(zone)).toBe(true)
  // every room it adds is joined by an opening to a room already seen
  for (const zone of commons) {
    if (zone === 'X05') continue
    expect(DOORS.some((d) => d.kind === 'opening' && ((d.a === zone && commons.has(d.b)) || (d.b === zone && commons.has(d.a))))).toBe(true)
  }
})
