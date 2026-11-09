// A gel image drawn from the imager's record: one lane per well, a band at each reported
// position (brighter for a stronger band) and a millimetre ruler to read positions against.
// Display only: every position and intensity comes from the session.

const BRIGHTNESS: Record<string, number> = { faint: 0.3, clear: 0.55, bright: 0.8, saturated: 1 }
const LANE = 26
const GAP = 8
const RULER = 30
const TOP = 18
const PX_PER_MM = 2.4

/** Lane number from a well id ("gel/A3" → 3). */
const laneNumber = (well: string) => well.match(/(\d+)$/)?.[1] ?? well

export function GelImage({ gel, bands }: { gel: { lanes: string[]; lengthMm: number }; bands: Array<{ lane: string; positionMm: number; intensity: string }> }) {
  const lanes = gel.lanes
  const width = RULER + lanes.length * (LANE + GAP) + GAP
  const height = TOP + gel.lengthMm * PX_PER_MM + 8
  const y = (mm: number) => TOP + mm * PX_PER_MM
  const ticks: number[] = []
  for (let mm = 0; mm <= gel.lengthMm; mm += 10) ticks.push(mm)
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', maxWidth: width, display: 'block', marginTop: 6 }}
      role="img"
      aria-label={`Gel image: ${bands.length} bands in ${lanes.length} lanes`}
      data-testid="gel-image"
    >
      <rect x={RULER} y={TOP - 6} width={width - RULER} height={height - TOP + 6} rx={3} fill="#16191d" />
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
      {lanes.map((well, i) => {
        const x = RULER + GAP + i * (LANE + GAP)
        return (
          <g key={well}>
            <text x={x + LANE / 2} y={9} fontSize={8} textAnchor="middle" fill="var(--muted)">
              {laneNumber(well)}
            </text>
            <rect x={x + 2} y={y(0) - 3} width={LANE - 4} height={3} rx={1} fill="#2b3036" />
            {bands
              .filter((b) => b.lane === well)
              .map((b, k) => (
                <rect key={k} x={x} y={y(b.positionMm) - 1.5} width={LANE} height={3} rx={1.5} fill="#e9eef2" opacity={BRIGHTNESS[b.intensity] ?? 0.5} />
              ))}
          </g>
        )
      })}
    </svg>
  )
}
