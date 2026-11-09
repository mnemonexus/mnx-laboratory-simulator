import React, { useState } from 'react'
import type { LabState } from '../sim/model'

interface DataAnalysisStationProps {
  lab: LabState
  onSelectStation: (s: string) => void
}

export const DataAnalysisStation: React.FC<DataAnalysisStationProps> = ({
  lab: _lab,
  onSelectStation,
}) => {
  const [activeTab, setActiveTab] = useState<'graph' | 'data' | 'analysis' | 'notes'>('graph')
  const [subTab, setSubTab] = useState<'standard' | 'unknowns' | 'kinetics' | 'custom'>('standard')
  const [showStandards, setShowStandards] = useState(true)
  const [showUnknowns, setShowUnknowns] = useState(true)
  const [showBlank, setShowBlank] = useState(true)
  const [showErrorBars, setShowErrorBars] = useState(false)

  // Interactive unknown calculator
  const [calcAbs, setCalcAbs] = useState<number>(0.682)

  // Curve parameters: y = 0.721x + 0.012
  const slope = 0.721
  const intercept = 0.012
  const rSquared = 0.998

  const calcConcentration = ((calcAbs - intercept) / slope).toFixed(2)

  // Standard points (mg/mL, Abs)
  const standardsData = [
    { conc: 0.0, abs: 0.012 },
    { conc: 0.25, abs: 0.192 },
    { conc: 0.5, abs: 0.375 },
    { conc: 1.0, abs: 0.735 },
    { conc: 1.5, abs: 1.095 },
    { conc: 2.0, abs: 1.455 },
  ]

  // Unknown points (conc, abs, label, dilution, final, saturated)
  const unknownsData = [
    { sample: 'U1', abs: 0.312, conc: 0.62, dilution: 5, final: 3.10, saturated: false },
    { sample: 'U2', abs: 0.845, conc: 1.73, dilution: 10, final: 17.3, saturated: true },
    { sample: 'U3', abs: 0.220, conc: 0.43, dilution: 5, final: 2.15, saturated: false },
    { sample: 'U4', abs: 0.530, conc: 1.07, dilution: 5, final: 5.35, saturated: false },
  ]

  // SVG dimensions
  const svgWidth = 560
  const svgHeight = 280
  const pad = { left: 45, right: 30, top: 30, bottom: 40 }
  const plotW = svgWidth - pad.left - pad.right
  const plotH = svgHeight - pad.top - pad.bottom

  const xMax = 2.2
  const yMax = 1.6

  const scaleX = (x: number) => pad.left + (x / xMax) * plotW
  const scaleY = (y: number) => pad.top + plotH - (y / yMax) * plotH

  // Regression line coordinates
  const lineX1 = scaleX(0.0)
  const lineY1 = scaleY(intercept)
  const lineX2 = scaleX(2.0)
  const lineY2 = scaleY(slope * 2.0 + intercept)

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Top Header Bar matching Mockup 1 panel 4 & Mockup 2 panel 4 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)]">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">
              Results – Protein Standard Curve
            </h1>
            <p className="text-[11px] text-[var(--muted)]">Visualise, analyse and interpret your experimental results</p>
          </div>
        </div>

        {/* Primary Tabs */}
        <div className="flex items-center gap-1 bg-[var(--bg-2)] p-1 rounded-xl border border-[var(--line)]">
          <button
            onClick={() => setActiveTab('data')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'data' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Data
          </button>
          <button
            onClick={() => setActiveTab('graph')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'graph' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Graph
          </button>
          <button
            onClick={() => setActiveTab('analysis')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'analysis' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Analysis
          </button>
          <button
            onClick={() => setActiveTab('notes')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'notes' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Notes
          </button>
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-lg bg-[var(--bg-2)] hover:bg-[var(--line)] border border-[var(--line)] text-[var(--ink)] text-xs font-medium flex items-center gap-1.5 transition-colors">
            <svg className="w-3.5 h-3.5 text-[var(--muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <span>Save Figure</span>
          </button>
          <button className="px-3 py-1.5 rounded-lg bg-[var(--bg-2)] hover:bg-[var(--line)] border border-[var(--line)] text-[var(--ink)] text-xs font-medium flex items-center gap-1.5 transition-colors">
            <svg className="w-3.5 h-3.5 text-[var(--muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span>Export Data</span>
          </button>
          <button
            onClick={() => onSelectStation('sample-prep')}
            className="px-3.5 py-1.5 rounded-lg ui-btn-solid transition-all flex items-center gap-1.5"
          >
            <span>Go back to lab</span>
          </button>
        </div>
      </div>

      {/* Main Analysis Body */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* Top Split: Graph Card & Curve Fit Card */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Main Graph Card */}
          <div className="lg:col-span-8 ui-panel p-5 space-y-3">
            {/* Sub-tabs & Legend Checkboxes */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
              <div className="flex items-center gap-1 bg-[var(--surface-solid)] p-1 rounded-lg border border-[var(--line)] text-xs">
                <button
                  onClick={() => setSubTab('standard')}
                  className={`px-3 py-1 rounded-md font-medium transition-all ${
                    subTab === 'standard' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  Standard Curve
                </button>
                <button
                  onClick={() => setSubTab('unknowns')}
                  className={`px-3 py-1 rounded-md font-medium transition-all ${
                    subTab === 'unknowns' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  Unknowns
                </button>
                <button
                  onClick={() => setSubTab('kinetics')}
                  className={`px-3 py-1 rounded-md font-medium transition-all ${
                    subTab === 'kinetics' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  Kinetics
                </button>
                <button
                  onClick={() => setSubTab('custom')}
                  className={`px-3 py-1 rounded-md font-medium transition-all ${
                    subTab === 'custom' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  Custom Plot
                </button>
              </div>

              {/* Legend & Toggles */}
              <div className="flex items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={showStandards}
                    onChange={(e) => setShowStandards(e.target.checked)}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent)] inline-block" />
                  <span>Standards</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={showUnknowns}
                    onChange={(e) => setShowUnknowns(e.target.checked)}
                    className="accent-amber-500 rounded"
                  />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
                  <span>Unknowns</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={showBlank}
                    onChange={(e) => setShowBlank(e.target.checked)}
                    className="accent-slate-500 rounded"
                  />
                  <span>Blank</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={showErrorBars}
                    onChange={(e) => setShowErrorBars(e.target.checked)}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span>Show error bars</span>
                </label>
              </div>
            </div>

            {/* Interactive SVG Scientific Graph (matching Mockup 1 panel 4) */}
            <div className="relative w-full rounded-xl bg-[var(--bg-2)] p-2 border border-[var(--line)] overflow-hidden">
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto">
                {/* Background Grid Lines */}
                {[0, 0.5, 1.0, 1.5, 2.0].map((xVal) => (
                  <g key={`x-${xVal}`}>
                    <line
                      x1={scaleX(xVal)}
                      y1={pad.top}
                      x2={scaleX(xVal)}
                      y2={pad.top + plotH}
                      stroke="#1e293b"
                      strokeDasharray="2 3"
                    />
                    <text
                      x={scaleX(xVal)}
                      y={pad.top + plotH + 18}
                      textAnchor="middle"
                      fill="#64748b"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      {xVal.toFixed(1)}
                    </text>
                  </g>
                ))}

                {[0, 0.4, 0.8, 1.2, 1.6].map((yVal) => (
                  <g key={`y-${yVal}`}>
                    <line
                      x1={pad.left}
                      y1={scaleY(yVal)}
                      x2={pad.left + plotW}
                      y2={scaleY(yVal)}
                      stroke="#1e293b"
                      strokeDasharray="2 3"
                    />
                    <text
                      x={pad.left - 8}
                      y={scaleY(yVal) + 3}
                      textAnchor="end"
                      fill="#64748b"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      {yVal.toFixed(1)}
                    </text>
                  </g>
                ))}

                {/* Regression Trendline */}
                <line
                  x1={lineX1}
                  y1={lineY1}
                  x2={lineX2}
                  y2={lineY2}
                  stroke="#3b82f6"
                  strokeWidth="2"
                />

                {/* Mathematical Equation Label on Graph */}
                <text
                  x={scaleX(1.4)}
                  y={scaleY(0.4)}
                  fill="#94a3b8"
                  fontSize="12"
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  y = 0.721x + 0.012
                </text>
                <text
                  x={scaleX(1.4)}
                  y={scaleY(0.28)}
                  fill="#94a3b8"
                  fontSize="12"
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  R² = 0.998
                </text>

                {/* Standard points (blue circles) */}
                {showStandards &&
                  standardsData.map((pt, i) => (
                    <circle
                      key={`std-${i}`}
                      cx={scaleX(pt.conc)}
                      cy={scaleY(pt.abs)}
                      r="5"
                      fill="#3b82f6"
                      stroke="#0f172a"
                      strokeWidth="1.5"
                    />
                  ))}

                {/* Unknown points (orange circles) */}
                {showUnknowns &&
                  unknownsData.map((u, i) => (
                    <circle
                      key={`unk-${i}`}
                      cx={scaleX(u.conc)}
                      cy={scaleY(u.abs)}
                      r="5.5"
                      fill="#f59e0b"
                      stroke="#0f172a"
                      strokeWidth="1.5"
                    />
                  ))}

                {/* Axis Labels */}
                <text
                  x={pad.left + plotW / 2}
                  y={svgHeight - 6}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="11"
                  fontWeight="500"
                >
                  Protein concentration (mg/mL)
                </text>
                <text
                  x={14}
                  y={pad.top + plotH / 2}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="11"
                  fontWeight="500"
                  transform={`rotate(-90 14 ${pad.top + plotH / 2})`}
                >
                  Absorbance (562 nm)
                </text>
              </svg>
            </div>
          </div>

          {/* Right Card: Curve Fit Metrics & Unknown Calculator */}
          <div className="lg:col-span-4 ui-panel p-5 space-y-4">
            <div>
              <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Curve Fit</h2>
              <div className="text-xs font-mono text-[var(--accent)] mt-0.5">Linear (y = mx + c)</div>
            </div>

            <div className="p-3 bg-[var(--bg-2)] rounded-xl border border-[var(--line)] text-xs font-mono space-y-2">
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Slope (m)</span>
                <span className="text-[var(--ink)] font-bold">{slope}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Intercept (c)</span>
                <span className="text-[var(--ink)] font-bold">{intercept}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">R²</span>
                <span className="text-[var(--ok)] font-bold">{rSquared}</span>
              </div>
            </div>

            {/* Interactive Unknown Interpolator (matching mockup) */}
            <div className="pt-2 border-t border-[var(--line)] space-y-3">
              <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
                Determine unknown concentration
              </h3>

              <div className="space-y-1.5">
                <label className="text-[11px] text-[var(--muted)]">Absorbance</label>
                <input
                  type="number"
                  step="0.001"
                  value={calcAbs}
                  onChange={(e) => setCalcAbs(parseFloat(e.target.value) || 0)}
                  className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono text-sm font-bold"
                />
              </div>

              <div className="p-3 bg-[var(--accent-soft)] rounded-xl border border-[var(--accent)]/30 flex items-center justify-between">
                <span className="text-xs text-[var(--accent)] font-medium">Concentration</span>
                <span className="text-sm font-mono font-bold text-[var(--ink)]">
                  {calcConcentration} mg/mL
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Section: Unknown samples table (matching Mockup 1 panel 4) */}
        <div className="ui-panel p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Unknown samples</h2>
              <p className="text-[11px] text-[var(--muted)]">Quantification table with dilution-factor correction</p>
            </div>
            <span className="text-xs text-[var(--muted)] font-mono">4 samples tested</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[var(--bg-2)] text-[var(--muted)] uppercase text-[10px] tracking-wider border-b border-[var(--line)]">
                <tr>
                  <th className="px-4 py-3">Sample</th>
                  <th className="px-4 py-3">Absorbance</th>
                  <th className="px-4 py-3">Concentration (mg/mL)</th>
                  <th className="px-4 py-3">Dilution factor</th>
                  <th className="px-4 py-3">Final (mg/mL)</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {unknownsData.map((row) => (
                  <tr
                    key={row.sample}
                    className={`hover:bg-[var(--bg-2)]/40 transition-colors ${
                      row.saturated ? 'bg-amber-500/5 text-[var(--warn)]' : 'text-[var(--muted)]'
                    }`}
                  >
                    <td className="px-4 py-3 font-bold text-[var(--ink)]">{row.sample}</td>
                    <td className="px-4 py-3">{row.abs.toFixed(3)}</td>
                    <td className="px-4 py-3">{row.conc.toFixed(2)}</td>
                    <td className="px-4 py-3">{row.dilution}</td>
                    <td className={`px-4 py-3 font-bold ${row.saturated ? 'text-[var(--warn)]' : 'text-[var(--ink)]'}`}>
                      {row.final.toFixed(2)} {row.saturated && '!'}
                    </td>
                    <td className="px-4 py-3">
                      {row.saturated ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-amber-500/20 text-[var(--warn)] border border-[var(--warn)]/30">
                          <span>⚠️ Saturation warning</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-[var(--ok)] border border-emerald-500/30">
                          <span>✓ In validated range</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Saturated Sample Warning Banner (exact match from Mockup 1 panel 4) */}
          <div className="p-4 rounded-xl bg-amber-950/40 border border-[var(--warn)]/35 text-xs text-[var(--warn)] flex items-start gap-3">
            <span className="text-base leading-none">⚠️</span>
            <div className="space-y-0.5">
              <span className="font-semibold text-[var(--ink)]">
                Sample U2 is outside the validated range.
              </span>
              <p className="text-[var(--warn)]/90 text-[11px]">
                The absorbance of sample U2 lies above the linear calibration limit (A &gt; 0.8).
                Consider diluting 1:20 and re-measuring to avoid saturation artifacts.
              </p>
            </div>
            <button
              onClick={() => onSelectStation('sample-prep')}
              className="ml-auto px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-[var(--ink)] font-medium text-xs whitespace-nowrap transition-colors"
            >
              Dilute at Bench →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
