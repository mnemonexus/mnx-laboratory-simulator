// A TLC plate as it looks under 254 nm light: the indicator glows and compounds show as dark
// spots, with the pencilled origin, the solvent front and a millimetre ruler from the origin.
// Display only: every position comes from the session.

const OPACITY: Record<string, number> = { faint: 0.35, clear: 0.6, dark: 0.85 }
const LANE = 22
const RULER = 30
const TOP = 14
const PX_PER_MM = 3

export function TlcImage({ tlc, bands }: { tlc: { lanes: number; lengthMm: number; originMm: number; frontMm: number }; bands: Array<{ lane: string; positionMm: number; intensity: string }> }) {
  const width = RULER + tlc.lanes * LANE + 10
  const height = TOP + tlc.lengthMm * PX_PER_MM + 6
  // Distances are from the origin, which sits originMm above the plate's bottom edge.
  const y = (fromOrigin: number) => TOP + (tlc.lengthMm - tlc.originMm - fromOrigin) * PX_PER_MM
  const ticks: number[] = []
  for (let mm = 0; mm <= tlc.lengthMm - tlc.originMm; mm += 10) ticks.push(mm)
  const laneOf = (key: string) => Number(key.split('#').pop())
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', maxWidth: width * 1.4, display: 'block', marginTop: 6 }}
      role="img"
      aria-label={`TLC plate under 254 nm light: ${bands.length} spots, solvent front at ${tlc.frontMm} mm`}
      data-testid="tlc-image"
    >
      <rect x={RULER} y={TOP} width={width - RULER - 6} height={tlc.lengthMm * PX_PER_MM} rx={2} fill="#bfe3c4" />
      <line x1={RULER} x2={width - 6} y1={y(0)} y2={y(0)} stroke="#55635a" strokeWidth={0.8} strokeDasharray="3 2" />
      <line x1={RULER} x2={width - 6} y1={y(tlc.frontMm)} y2={y(tlc.frontMm)} stroke="#3b6fb0" strokeWidth={0.8} />
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
      {Array.from({ length: tlc.lanes }, (_, i) => i + 1).map((lane) => {
        const cx = RULER + 5 + (lane - 0.5) * LANE
        return (
          <g key={lane}>
            <text x={cx} y={9} fontSize={8} textAnchor="middle" fill="var(--muted)">
              {lane}
            </text>
            {bands
              .filter((b) => laneOf(b.lane) === lane)
              .map((b, k) => (
                <ellipse key={k} cx={cx} cy={y(b.positionMm)} rx={6} ry={4} fill="#2a2140" opacity={OPACITY[b.intensity] ?? 0.5} />
              ))}
          </g>
        )
      })}
    </svg>
  )
}
