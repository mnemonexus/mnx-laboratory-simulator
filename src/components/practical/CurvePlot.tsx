// Curves an instrument drew against an axis: a real-time PCR's signal per cycle with its threshold,
// or a melt curve's −dF/dT per degree with its peaks. One line per well, coloured by the well's
// role (the table above lists every value). Display only: every number comes from the session.
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useTheme } from '../../theme'

type Curves = { axis: { label: string; unit: string; values: number[] }; signal: string; series: Record<string, number[]>; threshold?: number; peaks?: Record<string, number[]> }
type Well = { id: string; label?: string; role?: string; position?: string }

/** Roles in a fixed order, each with its categorical slot (validated all-pairs, light and dark). */
const GROUPS = [
  { role: 'standard', name: 'Standards', light: '#2a78d6', dark: '#3987e5' },
  { role: 'unknown', name: 'Unknowns', light: '#eb6834', dark: '#d95926' },
  { role: 'blank', name: 'Controls', light: '#1baf7a', dark: '#199e70' },
  { role: 'other', name: 'Other', light: '#898781', dark: '#898781' },
]
const W = 480
const H = 230
const M = { left: 44, right: 14, top: 14, bottom: 34 }

function niceStep(span: number, target: number): number {
  const raw = span / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag
}

function ticks(lo: number, hi: number, target: number): number[] {
  const step = niceStep(hi - lo || 1, target)
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)))
  return out
}

const axisName = (a: Curves['axis']) => (a.unit && a.unit !== '1' ? `${a.label} (${a.unit === 'Cel' ? '°C' : a.unit})` : a.label)
const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3))
/** Tick labels with just the decimals their step needs (0, 0.5, 1.0). */
const tickText = (v: number, all: number[]) => v.toFixed(Math.max(0, -Math.floor(Math.log10(Math.abs(all[1] - all[0]) || 1))))

export function CurvePlot({ curves, wells, display }: { curves: Curves; wells: Well[]; display: Record<string, string> }) {
  const { mode } = useTheme()
  const [hover, setHover] = useState<{ i: number; well: string } | null>(null)
  const xs = curves.axis.values
  const ids = Object.keys(curves.series).filter((id) => curves.series[id].length === xs.length)
  const groupOf = (id: string) => {
    const role = wells.find((w) => w.id === id)?.role
    return GROUPS.find((g) => g.role === role) ?? GROUPS[GROUPS.length - 1]
  }
  const colour = (id: string) => (mode === 'dark' ? groupOf(id).dark : groupOf(id).light)
  // A well by its position (B8); anything else by its label.
  const nameOf = (id: string) => {
    const w = wells.find((x) => x.id === id)
    return w?.position ?? w?.label ?? id
  }

  const { x, y, yTicks, xTicks } = useMemo(() => {
    const all = ids.flatMap((id) => curves.series[id])
    const yLo = Math.min(0, ...all)
    const yHi = Math.max(curves.threshold ?? 0, ...all) * 1.05 || 1
    const xLo = xs[0]
    const xHi = xs[xs.length - 1]
    return {
      x: (v: number) => M.left + ((v - xLo) / (xHi - xLo || 1)) * (W - M.left - M.right),
      y: (v: number) => H - M.bottom - ((v - yLo) / (yHi - yLo)) * (H - M.top - M.bottom),
      yTicks: ticks(yLo, yHi, 4),
      xTicks: ticks(xLo, xHi, 6),
    }
  }, [curves, ids.join(' '), xs])

  // Distinct peaks across wells, labelled once each (to the nearest half degree).
  const peakLabels = useMemo(() => {
    const seen: number[] = []
    for (const id of ids) for (const p of curves.peaks?.[id] ?? []) if (!seen.some((s) => Math.abs(s - p) < 1)) seen.push(p)
    return seen.sort((a, b) => a - b)
  }, [curves, ids.join(' ')])

  if (ids.length === 0 || xs.length < 2) return null
  const present = GROUPS.filter((g) => ids.some((id) => groupOf(id) === g))
  const path = (id: string) => curves.series[id].map((v, i) => `${i ? 'L' : 'M'}${x(xs[i]).toFixed(1)} ${y(v).toFixed(1)}`).join('')

  const nearestWell = (i: number, py: number) => {
    let best = ids[0]
    for (const id of ids) if (Math.abs(y(curves.series[id][i]) - py) < Math.abs(y(curves.series[best][i]) - py)) best = id
    return best
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    const py = ((e.clientY - box.top) / box.height) * H
    let i = 0
    for (let k = 1; k < xs.length; k++) if (Math.abs(x(xs[k]) - px) < Math.abs(x(xs[i]) - px)) i = k
    setHover({ i, well: nearestWell(i, py) })
  }
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const h = hover ?? { i: 0, well: ids[0] }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      setHover({ ...h, i: Math.max(0, Math.min(xs.length - 1, h.i + (e.key === 'ArrowRight' ? 1 : -1))) })
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const k = ids.indexOf(h.well)
      setHover({ ...h, well: ids[(k + (e.key === 'ArrowDown' ? 1 : ids.length - 1)) % ids.length] })
    } else if (e.key === 'Escape') setHover(null)
  }

  const order = hover ? [...ids.filter((id) => id !== hover.well), hover.well] : ids
  // The readout sits beside the crosshair, on the side away from it, and away from the point vertically.
  const tip = hover
    ? {
        side: x(xs[hover.i]) > W / 2 ? { right: `${(1 - (x(xs[hover.i]) - 8) / W) * 100}%` } : { left: `${((x(xs[hover.i]) + 8) / W) * 100}%` },
        top: y(curves.series[hover.well][hover.i]) < (M.top + H - M.bottom) / 2 ? `${((H - M.bottom - 44) / H) * 100}%` : `${(M.top / H) * 100}%`,
      }
    : undefined
  return (
    <figure className="mt-1.5" style={{ margin: 0 }} data-testid="curve-plot">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)]" aria-hidden="true">
        {present.map((g) => (
          <span key={g.role} className="inline-flex items-center gap-1">
            <svg width="14" height="6"><line x1="1" x2="13" y1="3" y2="3" stroke={mode === 'dark' ? g.dark : g.light} strokeWidth="2" strokeLinecap="round" /></svg>
            {g.name} ({ids.filter((id) => groupOf(id) === g).length})
          </span>
        ))}
      </div>
      <div style={{ position: 'relative', maxWidth: W }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', display: 'block', outline: 'none' }}
          role="img"
          tabIndex={0}
          aria-label={`${curves.signal} against ${axisName(curves.axis)} for ${ids.length} wells; the values are in the table above. Arrow keys move the readout.`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={M.left - 6} y={y(v) + 3} fontSize={9} textAnchor="end" fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {tickText(v, yTicks)}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={`x${v}`} x={x(v)} y={H - M.bottom + 13} fontSize={9} textAnchor="middle" fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {v}
            </text>
          ))}
          <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke="var(--line-strong)" strokeWidth={1} />
          <text x={(M.left + W - M.right) / 2} y={H - 4} fontSize={10} textAnchor="middle" fill="var(--muted)">
            {axisName(curves.axis)}
          </text>
          <text transform={`translate(11 ${(M.top + H - M.bottom) / 2}) rotate(-90)`} fontSize={10} textAnchor="middle" fill="var(--muted)">
            {curves.signal}
          </text>
          {curves.threshold !== undefined ? (
            <g>
              <line x1={M.left} x2={W - M.right} y1={y(curves.threshold)} y2={y(curves.threshold)} stroke="var(--muted)" strokeWidth={1} />
              <text x={M.left + 4} y={y(curves.threshold) - 4} fontSize={9} textAnchor="start" fill="var(--muted)">
                threshold {curves.threshold}
              </text>
            </g>
          ) : null}
          {peakLabels.map((p) => (
            <text key={`p${p}`} x={x(p)} y={M.top + 2} fontSize={9} textAnchor="middle" fill="var(--muted)">
              {p.toFixed(1)} °C
            </text>
          ))}
          {order.map((id) => (
            <path
              key={id}
              d={path(id)}
              fill="none"
              stroke={colour(id)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={hover && hover.well !== id ? 0.3 : 1}
            />
          ))}
          {hover ? (
            <g pointerEvents="none">
              <line x1={x(xs[hover.i])} x2={x(xs[hover.i])} y1={M.top} y2={H - M.bottom} stroke="var(--muted)" strokeWidth={1} />
              <circle cx={x(xs[hover.i])} cy={y(curves.series[hover.well][hover.i])} r={4} fill={colour(hover.well)} stroke="var(--surface-solid)" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
        {hover ? (
          <div
            className="ui-panel-solid text-[11px] px-2 py-1"
            style={{ position: 'absolute', top: tip!.top, ...tip!.side, pointerEvents: 'none', whiteSpace: 'nowrap' }}
            role="status"
          >
            <div className="font-semibold" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {curves.signal} {fmt(curves.series[hover.well][hover.i])}
            </div>
            <div className="text-[var(--muted)]">
              {nameOf(hover.well)} · {groupOf(hover.well).name.replace(/s$/, '').toLowerCase()} · {curves.axis.label} {xs[hover.i]}
              {display[hover.well] ? ` · ${display[hover.well]}` : ''}
            </div>
          </div>
        ) : null}
      </div>
    </figure>
  )
}
