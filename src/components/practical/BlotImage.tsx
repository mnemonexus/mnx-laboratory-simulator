// A developed Western blot: a pale membrane with a band wherever colour was deposited (darker for
// stronger), the prestained marker in its own colour, and a millimetre ruler from the wells.
// Display only: every position and intensity comes from the session.

const OPACITY: Record<string, number> = { faint: 0.3, clear: 0.6, bright: 0.8, saturated: 0.95 }
/** The membrane's colour for a clean, grey and dark background. */
const MEMBRANE = ['#f1efe8', '#d9d3dd', '#9d90b3']
const LANE = 26
const GAP = 8
const RULER = 30
const TOP = 18
const PX_PER_MM = 2.4

export function BlotImage({ blot, bands }: { blot: { lanes: number[]; lengthMm: number; markerLanes: number[]; background: number }; bands: Array<{ lane: string; positionMm: number; intensity: string }> }) {
  const width = RULER + blot.lanes.length * (LANE + GAP) + GAP
  const height = TOP + blot.lengthMm * PX_PER_MM + 8
  const y = (mm: number) => TOP + mm * PX_PER_MM
  const ticks: number[] = []
  for (let mm = 0; mm <= blot.lengthMm; mm += 10) ticks.push(mm)
  const laneOf = (key: string) => Number(key.split('#').pop())
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', maxWidth: width, display: 'block', marginTop: 6 }}
      role="img"
      aria-label={`Developed blot: ${bands.length} bands in ${blot.lanes.length} lanes`}
      data-testid="blot-image"
    >
      <rect x={RULER} y={TOP - 6} width={width - RULER} height={height - TOP + 6} rx={3} fill={MEMBRANE[blot.background] ?? MEMBRANE[0]} stroke="#d6d2c4" />
      {ticks.map((mm) => (
        <g key={mm}>
          <line x1={RULER - 6} x2={RULER - 1} y1={y(mm)} y2={y(mm)} stroke="var(--muted)" strokeWidth={1} />
          <text x={RULER - 8} y={y(mm) + 3} fontSize={8} textAnchor="end" fill="var(--muted)">
            {mm}
          </text>
        </g>
      ))}
      <text x={RULER - 8} y={9} fontSize={8} textAnchor="end" fill="var(--faint)">
        mm
      </text>
      {blot.lanes.map((lane, i) => {
        const x = RULER + GAP + i * (LANE + GAP)
        const marker = blot.markerLanes.includes(lane)
        return (
          <g key={lane}>
            <text x={x + LANE / 2} y={9} fontSize={8} textAnchor="middle" fill="var(--muted)">
              {lane}
            </text>
            {bands
              .filter((b) => laneOf(b.lane) === lane)
              .map((b, k) => (
                <rect key={k} x={x} y={y(b.positionMm) - 1.5} width={LANE} height={3} rx={1.5} fill={marker ? '#2f6db5' : '#3d2a63'} opacity={marker ? 0.7 : (OPACITY[b.intensity] ?? 0.5)} />
              ))}
          </g>
        )
      })}
    </svg>
  )
}
