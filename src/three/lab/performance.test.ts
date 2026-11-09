import { describe, expect, it } from 'vitest'
import { distribution, FrameCapture } from './performance'

describe('performance evidence', () => {
  it('reports nearest-rank tails, preserves zero and does not invent empty observations', () => {
    expect(distribution([])).toBeNull()
    expect(distribution(Array.from({ length: 100 }, (_, i) => i))).toEqual({ count: 100, min: 0, median: 49, p95: 94, p99: 98, max: 99 })
  })
  it('distinguishes render cadence, callback cadence, idle frames and CPU work', () => {
    const capture = new FrameCapture()
    capture.record(100, 10, true, 7, 120, 4000)
    capture.record(116, 1, false, 7, 120, 4000)
    capture.record(133, 9, true, 6, 122, 4100)
    const report = capture.finish()
    expect(report.renderedFrames).toBe(2)
    expect(report.summary.renderIntervalMs?.median).toBe(33)
    expect(report.summary.rafIntervalMs?.max).toBe(17)
    expect(report.summary.drawCpuMs?.count).toBe(2)
    expect(report.summary.updateCpuMs?.median).toBe(3)
    expect(report.summary.drawCalls?.min).toBe(120)
    expect(report.rows[0][4]).toBe(-1)
    expect(report.rows[1][3]).toBe(-1)
    expect(report.summary.gpuMs).toBeNull()
    expect(report.summary.scienceMs).toBeNull()
  })
  it('bounds memory and marks incomplete evidence', () => {
    const capture = new FrameCapture(1)
    capture.record(0, 0, false, 0, 0, 0)
    capture.record(10, 2, true, 1, 1, 1)
    expect(capture.finish()).toMatchObject({ retainedCallbacks: 1, renderedFrames: 0, droppedCallbacks: 1, truncated: true })
    expect(capture.finish().summary.drawCpuMs).toBeNull()
    for (const capacity of [0, 1.5, 60001, NaN]) expect(() => new FrameCapture(capacity)).toThrow()
  })
})
