// Opt-in diagnostics. Preallocated storage keeps capture allocations out of the frame loop.
// CPU submission timings are NOT GPU timings or scientific simulation timings.
export const FRAME_COLUMNS = ['timestampMs', 'rafIntervalMs', 'frameCpuMs', 'drawCpuMs', 'renderIntervalMs', 'drawCalls', 'triangles'] as const
const WIDTH = FRAME_COLUMNS.length

/** Nearest-rank percentiles; null means there was no observation. */
export function distribution(values: number[]) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
  return { count: sorted.length, min: sorted[0], median: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted[sorted.length - 1] }
}

export class FrameCapture {
  private readonly data: Float64Array
  private count = 0
  private dropped = 0
  private lastCallback: number | null = null
  private lastRender: number | null = null

  readonly capacity: number
  constructor(capacity = 12000) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 60000) throw new Error('Frame capacity must be 1..60000')
    this.capacity = capacity
    this.data = new Float64Array(capacity * WIDTH)
  }

  record(now: number, cpuMs: number, rendered: boolean, drawMs: number, calls: number, triangles: number) {
    if (this.count === this.capacity) { this.dropped++; return }
    const at = this.count++ * WIDTH
    this.data[at] = now
    this.data[at + 1] = this.lastCallback === null ? -1 : now - this.lastCallback
    this.data[at + 2] = cpuMs
    this.data[at + 3] = rendered ? drawMs : -1
    this.data[at + 4] = rendered && this.lastRender !== null ? now - this.lastRender : -1
    this.data[at + 5] = rendered ? calls : -1
    this.data[at + 6] = rendered ? triangles : -1
    this.lastCallback = now
    if (rendered) this.lastRender = now
  }

  finish() {
    const rows: number[][] = []
    const columns: number[][] = Array.from({ length: WIDTH }, () => [])
    const updateCpu: number[] = []
    let renderedFrames = 0
    for (let i = 0; i < this.count; i++) {
      const row = Array.from(this.data.subarray(i * WIDTH, (i + 1) * WIDTH))
      rows.push(row)
      row.forEach((value, column) => { if (value >= 0) columns[column].push(value) })
      const rendered = row[3] >= 0
      if (rendered) renderedFrames++
      updateCpu.push(Math.max(0, row[2] - (rendered ? row[3] : 0)))
    }
    return {
      schema: 'lab-frame-capture/1', columns: FRAME_COLUMNS, missingValue: -1,
      retainedCallbacks: this.count, renderedFrames, idleOrCappedCallbacks: this.count - renderedFrames,
      droppedCallbacks: this.dropped, truncated: this.dropped > 0,
      summary: {
        rafIntervalMs: distribution(columns[1]), frameCpuMs: distribution(columns[2]),
        updateCpuMs: distribution(updateCpu), drawCpuMs: distribution(columns[3]),
        renderIntervalMs: distribution(columns[4]), drawCalls: distribution(columns[5]), triangles: distribution(columns[6]),
        gpuMs: null, scienceMs: null,
      }, rows,
    }
  }
}
