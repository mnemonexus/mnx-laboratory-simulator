import React, { useState } from 'react'
import { ThreeLabScene } from './ThreeLabScene'

interface ChromatographyStationProps {
  onSelectStation: (s: string) => void
}

export const ChromatographyStation: React.FC<ChromatographyStationProps> = ({
  onSelectStation: _onSelectStation,
}) => {
  const [activeTab, setActiveTab] = useState<'chromatogram' | 'run' | 'fractions' | 'analysis'>('chromatogram')
  const [isRunning, setIsRunning] = useState<boolean>(true)
  const [selectedFractions, setSelectedFractions] = useState<number[]>([15, 16, 17, 18])

  // Filters
  const [showA280, setShowA280] = useState(true)
  const [showConductivity, setShowConductivity] = useState(true)
  const [showGradient, setShowGradient] = useState(false)
  const [showCollected, setShowCollected] = useState(true)

  // Fraction tubes numbered 12 to 21
  const fractions = [
    { num: 12, volPct: 20, peak: false },
    { num: 13, volPct: 35, peak: false },
    { num: 14, volPct: 60, peak: false },
    { num: 15, volPct: 90, peak: true },
    { num: 16, volPct: 100, peak: true },
    { num: 17, volPct: 95, peak: true },
    { num: 18, volPct: 75, peak: true },
    { num: 19, volPct: 40, peak: false },
    { num: 20, volPct: 25, peak: false },
    { num: 21, volPct: 15, peak: false },
  ]

  const toggleFraction = (num: number) => {
    if (selectedFractions.includes(num)) {
      setSelectedFractions(selectedFractions.filter((f) => f !== num))
    } else {
      setSelectedFractions([...selectedFractions, num].sort((a, b) => a - b))
    }
  }

  // Dual axis SVG chromatogram
  const svgW = 600
  const svgH = 260
  const pad = { left: 50, right: 50, top: 25, bottom: 35 }
  const plotW = svgW - pad.left - pad.right
  const plotH = svgH - pad.top - pad.bottom

  const xMax = 45 // Elution volume (mL)
  const yUVMax = 280 // A280 (mAU)
  const yCondMax = 100 // Conductivity (mS/cm)

  const sx = (x: number) => pad.left + (x / xMax) * plotW
  const syUV = (y: number) => pad.top + plotH - (y / yUVMax) * plotH
  const syCond = (y: number) => pad.top + plotH - (y / yCondMax) * plotH

  // Generate UV 280 peak curve: baseline + peak 1 at 16mL + peak 2 at 32mL
  const uvPoints: { x: number; y: number }[] = []
  for (let x = 0; x <= 45; x += 0.5) {
    const peak1 = 230 * Math.exp(-Math.pow(x - 16, 2) / 10)
    const peak2 = 140 * Math.exp(-Math.pow(x - 32, 2) / 8)
    const voidPeak = 70 * Math.exp(-Math.pow(x - 8, 2) / 4)
    const baseline = 8 + x * 0.2
    uvPoints.push({ x, y: baseline + peak1 + peak2 + voidPeak })
  }

  const uvPathD = uvPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x)} ${syUV(p.y)}`).join(' ')

  // Conductivity linear gradient from 10 to 40 mL
  const condPathD = `M ${sx(0)} ${syCond(5)} L ${sx(10)} ${syCond(5)} L ${sx(40)} ${syCond(85)} L ${sx(45)} ${syCond(85)}`

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Top Header bar matching Mockup 1 panel 6 & Mockup 2 panel 6 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-[var(--ok)]">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">
              Size Exclusion Chromatography
            </h1>
            <p className="text-[11px] text-[var(--muted)]">ÄKTA pure workstation — Fraction separation profile</p>
          </div>
        </div>

        {/* Tab Pills: Run | Chromatogram | Fractions | Analysis */}
        <div className="flex items-center gap-1 bg-[var(--bg-2)] p-1 rounded-xl border border-[var(--line)]">
          {(['run', 'chromatogram', 'fractions', 'analysis'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3.5 py-1 rounded-lg text-xs font-medium capitalize transition-all ${
                activeTab === tab
                  ? 'bg-[var(--ink)] text-[var(--bg)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Main Chromatography Content */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Run Status Card (matching Mockup 2 panel 6) */}
          <div className="lg:col-span-4 ui-panel p-5 space-y-4">
            <div className="border-b border-[var(--line)] pb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Run in progress...</h2>
                <p className="text-[11px] text-[var(--muted)]">Superdex 200 Increase 10/300 GL</p>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-[var(--ok)] border border-emerald-500/30 animate-pulse">
                12 / 40 min
              </span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between p-2 rounded-lg bg-[var(--surface-solid)] border border-[var(--line)]">
                <span className="text-[var(--muted)]">Flow rate</span>
                <span className="text-[var(--ink)] font-bold">1.0 mL/min</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-[var(--surface-solid)] border border-[var(--line)]">
                <span className="text-[var(--muted)]">Buffer A</span>
                <span className="text-[var(--ink)]">20 mM Tris, pH 8.0</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-[var(--surface-solid)] border border-[var(--line)]">
                <span className="text-[var(--muted)]">Buffer B</span>
                <span className="text-[var(--ink)]">20 mM Tris, 1 M NaCl</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-[var(--surface-solid)] border border-[var(--line)]">
                <span className="text-[var(--muted)]">Gradient</span>
                <span className="text-[var(--warn)]">0 – 100% B (40 min)</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-[var(--surface-solid)] border border-[var(--line)]">
                <span className="text-[var(--muted)]">Fraction volume</span>
                <span className="text-[var(--ink)] font-bold">1.0 mL</span>
              </div>
            </div>

            <button
              onClick={() => setIsRunning(!isRunning)}
              className="w-full py-2.5 rounded-xl border border-[var(--danger)]/40 bg-red-500/10 hover:bg-red-500/20 text-[var(--danger)] font-semibold text-xs transition-colors flex items-center justify-center gap-2"
            >
              <span>{isRunning ? '⏹ Stop Run' : '▶ Resume Run'}</span>
            </button>
          </div>

          {/* Right: Dual Axis Chromatogram (matching Mockup 1 & 2 panel 6) */}
          <div className="lg:col-span-8 ui-panel p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
              <div className="flex items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--accent)] font-medium">
                  <input
                    type="checkbox"
                    checked={showA280}
                    onChange={(e) => setShowA280(e.target.checked)}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent)] inline-block" />
                  <span>UV (280 nm)</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--warn)] font-medium">
                  <input
                    type="checkbox"
                    checked={showConductivity}
                    onChange={(e) => setShowConductivity(e.target.checked)}
                    className="accent-amber-500 rounded"
                  />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
                  <span>Conductivity</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={showGradient}
                    onChange={(e) => setShowGradient(e.target.checked)}
                    className="accent-slate-500 rounded"
                  />
                  <span>Gradient %B</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={showCollected}
                    onChange={(e) => setShowCollected(e.target.checked)}
                    className="accent-slate-500 rounded"
                  />
                  <span>Collected fractions</span>
                </label>
              </div>

              <button className="px-3 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 text-xs font-semibold hover:bg-[var(--accent-soft)] transition-colors">
                Collect Fraction
              </button>
            </div>

            {/* Chromatogram SVG Plot */}
            <div className="relative w-full rounded-xl bg-[var(--bg-2)] p-2 border border-[var(--line)]">
              <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-auto">
                {/* Horizontal Grid */}
                {[0, 50, 100, 150, 200, 250].map((val) => (
                  <g key={`y-${val}`}>
                    <line
                      x1={pad.left}
                      y1={syUV(val)}
                      x2={pad.left + plotW}
                      y2={syUV(val)}
                      stroke="#1e293b"
                      strokeDasharray="2 3"
                    />
                    <text
                      x={pad.left - 8}
                      y={syUV(val) + 3}
                      textAnchor="end"
                      fill="#60a5fa"
                      fontSize="9"
                      fontFamily="monospace"
                    >
                      {val}
                    </text>
                  </g>
                ))}

                {/* Right Axis Conductivity Numbers */}
                {[0, 20, 40, 60, 80, 100].map((val) => (
                  <text
                    key={`c-${val}`}
                    x={pad.left + plotW + 8}
                    y={syCond(val) + 3}
                    textAnchor="start"
                    fill="#fbbf24"
                    fontSize="9"
                    fontFamily="monospace"
                  >
                    {val}
                  </text>
                ))}

                {/* X Axis Elution Volume Numbers */}
                {[0, 10, 20, 30, 40].map((val) => (
                  <g key={`x-${val}`}>
                    <line
                      x1={sx(val)}
                      y1={pad.top}
                      x2={sx(val)}
                      y2={pad.top + plotH}
                      stroke="#1e293b"
                      strokeDasharray="2 3"
                    />
                    <text
                      x={sx(val)}
                      y={pad.top + plotH + 16}
                      textAnchor="middle"
                      fill="#94a3b8"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      {val}
                    </text>
                  </g>
                ))}

                {/* Highlight Pooled Fraction Band (Fractions 15-18 = ~15 to ~19 mL) */}
                {showCollected && (
                  <rect
                    x={sx(14.5)}
                    y={pad.top}
                    width={sx(18.5) - sx(14.5)}
                    height={plotH}
                    fill="#3b82f6"
                    opacity="0.12"
                  />
                )}

                {/* Conductivity Line (Orange) */}
                {showConductivity && (
                  <path
                    d={condPathD}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                )}

                {/* UV 280 nm Absorbance Curve (Blue) */}
                {showA280 && (
                  <path
                    d={uvPathD}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                )}

                {/* Axis Labels */}
                <text
                  x={pad.left + plotW / 2}
                  y={svgH - 6}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="11"
                  fontWeight="500"
                >
                  Elution volume (mL)
                </text>
                <text
                  x={14}
                  y={pad.top + plotH / 2}
                  textAnchor="middle"
                  fill="#38bdf8"
                  fontSize="10"
                  fontWeight="500"
                  transform={`rotate(-90 14 ${pad.top + plotH / 2})`}
                >
                  Absorbance (mAU)
                </text>
                <text
                  x={svgW - 12}
                  y={pad.top + plotH / 2}
                  textAnchor="middle"
                  fill="#fbbf24"
                  fontSize="10"
                  fontWeight="500"
                  transform={`rotate(90 ${svgW - 12} ${pad.top + plotH / 2})`}
                >
                  Conductivity (mS/cm)
                </text>
              </svg>
            </div>
          </div>
        </div>

        {/* Bottom Section: Real 3D Fraction Collector Rack + fraction selection */}
        <div className="ui-panel p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Fraction Collection Rack</h2>
              <p className="text-[11px] text-[var(--muted)]">
                Click tubes to select & pool target enzyme peak (Fractions 15–18)
              </p>
            </div>

            <div className="px-4 py-2 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-xs text-[var(--accent)] font-mono">
              Selected: <strong>{selectedFractions.join(', ')}</strong> ({selectedFractions.length * 1.0} mL pooled)
            </div>
          </div>

          <div className="relative h-[24rem] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-2)] shadow-inner">
            <ThreeLabScene
              variant="chromatography"
              fractions={fractions.map((f) => ({
                num: f.num,
                fill01: f.volPct / 100,
                color: selectedFractions.includes(f.num)
                  ? f.num === 16
                    ? '#0f4da8'
                    : '#2f86d8'
                  : f.peak
                    ? '#8ec5f0'
                    : '#d3e2f2',
                selected: selectedFractions.includes(f.num),
              }))}
            />
            <div className="absolute left-4 bottom-4 px-4 py-2 rounded-xl bg-[var(--bg-2)]/85 border border-[var(--line)] text-[11px] text-[var(--ink)] shadow-xl">
              Fractions 15–18 are visibly enriched under the UV peak. Rotate the 3D rack and compare with the chromatogram above.
            </div>
          </div>

          {/* Compact fraction buttons remain as precise controls. */}
          <div className="relative p-5 rounded-xl bg-[var(--bg-2)] border border-[var(--line)] flex items-center justify-center gap-4 sm:gap-6 overflow-x-auto">
            {fractions.map((tube) => {
              const isSelected = selectedFractions.includes(tube.num)
              return (
                <button
                  key={tube.num}
                  onClick={() => toggleFraction(tube.num)}
                  className={`flex flex-col items-center group transition-all ${
                    isSelected ? 'scale-105' : 'opacity-70 hover:opacity-100'
                  }`}
                >
                  {/* Glass Fraction Tube */}
                  <div
                    className={`relative w-8 sm:w-10 h-28 rounded-b-xl border flex flex-col justify-end p-0.5 shadow-xl transition-all ${
                      isSelected
                        ? 'border-[var(--accent)] ring-2 ring-blue-500/40 bg-[var(--accent-soft)]'
                        : 'border-slate-600 bg-[var(--bg-2)]'
                    }`}
                  >
                    {/* Liquid fill */}
                    <div
                      className={`w-full rounded-b-lg transition-all duration-300 ${
                        tube.peak ? 'bg-cyan-400/80' : 'bg-slate-400/40'
                      }`}
                      style={{ height: `${tube.volPct}%` }}
                    />

                    {/* Meniscus highlight */}
                    <div className="w-full h-1 bg-white/30 rounded-t" />
                  </div>

                  {/* Tube number label */}
                  <span
                    className={`mt-2 font-mono text-xs px-2 py-0.5 rounded font-bold transition-all ${
                      isSelected
                        ? 'bg-[var(--ink)] text-[var(--bg)]'
                        : 'text-[var(--muted)] bg-[var(--bg-2)]'
                    }`}
                  >
                    {tube.num}
                  </span>
                </button>
              )
            })}

            {/* Guidance Tooltip Banner floating over tubes (matching mockup) */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-[var(--surface-solid)]/90 border border-[var(--line)] text-[11px] text-[var(--muted)] pointer-events-none shadow-lg">
              Select the fractions to keep based on the chromatogram.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
