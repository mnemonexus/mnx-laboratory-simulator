import React, { useState } from 'react'
import type { LabState } from '../sim/model'
import { WAVELENGTHS } from '../content/catalog'
import { ThreeLabScene } from './ThreeLabScene'

interface MicroplateReaderStationProps {
  lab: LabState
  onReadPlate: (settings: { wavelength: number; blank: string }) => void
  onRunKinetics: (settings: { wavelength: number; blank: string }) => void
  onSelectStation: (s: string) => void
}

export const MicroplateReaderStation: React.FC<MicroplateReaderStationProps> = ({
  lab,
  onReadPlate,
  onRunKinetics,
  onSelectStation,
}) => {
  const [activeTab, setActiveTab] = useState<'setup' | 'layout' | 'run' | 'results'>('setup')
  const [measurementType, setMeasurementType] = useState<'Absorbance' | 'Fluorescence' | 'Luminescence'>('Absorbance')
  const [wavelength, setWavelength] = useState<number>(562)
  const [readMode, setReadMode] = useState<'Endpoint' | 'Kinetic'>('Endpoint')
  const [shaking, setShaking] = useState<string>('Linear (medium)')
  const [temperature, setTemperature] = useState<string>('37 °C')
  const [readHeight] = useState<string>('Automatic')
  const [blankWell, setBlankWell] = useState<string>('A1')
  const [isReading, setIsReading] = useState<boolean>(false)
  const [scanProgress, setScanProgress] = useState<number>(0)

  const handleStartRead = () => {
    setIsReading(true)
    setScanProgress(0)

    const interval = setInterval(() => {
      setScanProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval)
          setIsReading(false)
          if (readMode === 'Kinetic') {
            onRunKinetics({ wavelength, blank: blankWell })
          } else {
            onReadPlate({ wavelength, blank: blankWell })
          }
          setActiveTab('results')
          return 100
        }
        return prev + 12
      })
    }, 180)
  }

  const lastMeasurement = lab.measurements[lab.measurements.length - 1]

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Header bar matching Mockup 1 panel 3 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)]">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">Measure Plate</h1>
            <p className="text-[11px] text-[var(--muted)]">Microplate Reader (BioSim PR-960 / CLARIOstar)</p>
          </div>
        </div>

        {/* Tab Pills (matching Mockup 1: Setup | Plate Layout | Run | Results) */}
        <div className="flex items-center gap-1 bg-[var(--bg-2)] p-1 rounded-xl border border-[var(--line)]">
          <button
            onClick={() => setActiveTab('setup')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'setup'
                ? 'bg-[var(--ink)] text-[var(--bg)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Setup
          </button>
          <button
            onClick={() => setActiveTab('layout')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'layout'
                ? 'bg-[var(--ink)] text-[var(--bg)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Plate Layout
          </button>
          <button
            onClick={() => setActiveTab('run')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'run'
                ? 'bg-[var(--ink)] text-[var(--bg)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Run
          </button>
          <button
            onClick={() => setActiveTab('results')}
            className={`px-3.5 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'results'
                ? 'bg-[var(--ink)] text-[var(--bg)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Results
          </button>
        </div>

        <button
          onClick={() => onSelectStation('analysis')}
          className="px-3.5 py-1.5 rounded-lg bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 text-xs font-medium flex items-center gap-1.5 transition-colors"
        >
          <span>View Data Analysis</span>
          <span>→</span>
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Photorealistic Plate Reader Instrument with Motorized Tray */}
        <div className="lg:col-span-7 flex flex-col items-center">
          <div className="relative w-full rounded-2xl overflow-hidden border border-[var(--line)]/80 shadow-2xl bg-[var(--surface-solid)] group">
            <div className="relative h-[26rem] sm:h-[32rem] w-full overflow-hidden bg-[var(--surface-solid)]">
              <ThreeLabScene variant="reader" lab={lab} reading={isReading} wavelength={wavelength} />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0c1426]/45 via-transparent to-black/10 pointer-events-none" />

              {/* Glowing LCD Instrument Touchscreen Overlay (matching Mockup) */}
              <div className="absolute right-8 top-12 w-44 rounded-xl bg-[var(--bg-2)]/90 border border-[var(--line)] p-3 shadow-2xl backdrop-blur-md">
                <div className="text-[10px] uppercase font-mono text-[var(--muted)]">BioSim PR-960</div>
                <div className="text-[var(--ok)] font-bold text-sm mt-1 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  Ready
                </div>
                <div className="text-[10px] text-[var(--muted)] space-y-0.5 mt-1.5 font-mono">
                  <div>✓ Plate detected</div>
                  <div>✓ Method: {wavelength} nm</div>
                  <div>✓ Temp: {temperature}</div>
                </div>

                <button
                  onClick={handleStartRead}
                  disabled={isReading}
                  className="mt-2.5 w-full py-1.5 rounded-lg ui-btn-solid transition-all shadow-md active:scale-95"
                >
                  {isReading ? 'Reading…' : 'Start'}
                </button>
              </div>

              {/* Laser Scanning Animation Overlay during Read */}
              {isReading && (
                <div
                  className="absolute inset-x-12 bottom-16 h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_15px_#22d3ee] transition-all duration-200"
                  style={{ bottom: `${16 + (scanProgress / 100) * 20}%` }}
                />
              )}

              {/* Brand Watermark on Machine */}
              <div className="absolute left-6 top-8 text-[var(--muted)] font-bold tracking-widest text-xs opacity-60 font-mono">
                CLARIOstar <span className="text-[9px] font-normal text-[var(--faint)]">BMG LABTECH</span>
              </div>
            </div>

            {/* Read Progress Bar if Running */}
            {isReading && (
              <div className="p-3 bg-[var(--surface-solid)] border-t border-[var(--line)] flex items-center justify-between text-xs text-[var(--muted)]">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                  <span>Optical read in progress ({scanProgress}% complete)...</span>
                </div>
                <div className="w-32 bg-[var(--bg-2)] h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-cyan-400 h-full rounded-full transition-all duration-200"
                    style={{ width: `${scanProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Setup Settings Card (exact match from Mockup 1 panel 3) */}
        <div className="lg:col-span-5 ui-panel p-5 space-y-4">
          <div className="border-b border-[var(--line)] pb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Method Configuration</h2>
              <p className="text-[11px] text-[var(--muted)]">Spectrophotometric protocol parameters</p>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30">
              PR-960
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            {/* Measurement Type */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Measurement type</label>
              <select
                value={measurementType}
                onChange={(e) => setMeasurementType(e.target.value as unknown as 'Absorbance' | 'Fluorescence' | 'Luminescence')}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)]"
              >
                <option value="Absorbance">Absorbance</option>
                <option value="Fluorescence">Fluorescence</option>
                <option value="Luminescence">Luminescence</option>
              </select>
            </div>

            {/* Shaking */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Shaking</label>
              <select
                value={shaking}
                onChange={(e) => setShaking(e.target.value)}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)]"
              >
                <option value="Linear (medium)">Linear (medium)</option>
                <option value="Orbital (fast)">Orbital (fast)</option>
                <option value="None">None</option>
              </select>
            </div>

            {/* Wavelength */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Wavelength (nm)</label>
              <select
                value={wavelength}
                onChange={(e) => setWavelength(parseInt(e.target.value))}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono"
              >
                {WAVELENGTHS.map((w) => (
                  <option key={w.nm} value={w.nm}>
                    {w.nm} nm ({w.short})
                  </option>
                ))}
              </select>
            </div>

            {/* Temperature */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Temperature</label>
              <select
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono"
              >
                <option value="37 °C">37 °C</option>
                <option value="25 °C">25 °C</option>
                <option value="Ambient">Ambient</option>
              </select>
            </div>

            {/* Read Mode */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Read mode</label>
              <select
                value={readMode}
                onChange={(e) => setReadMode(e.target.value as 'Endpoint' | 'Kinetic')}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)]"
              >
                <option value="Endpoint">Endpoint</option>
                <option value="Kinetic">Kinetic (Time course)</option>
              </select>
            </div>

            {/* Read Height */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Read height</label>
              <input
                type="text"
                readOnly
                value={readHeight}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--muted)] cursor-not-allowed font-mono"
              />
            </div>

            {/* Reference blank well */}
            <div className="col-span-2 space-y-1">
              <label className="text-[var(--muted)] font-medium">Blank reference well</label>
              <input
                type="text"
                value={blankWell}
                onChange={(e) => setBlankWell(e.target.value.toUpperCase())}
                placeholder="e.g. A1"
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono"
              />
              <span className="text-[10px] text-[var(--faint)]">
                Signals will be automatically background-corrected against well {blankWell}.
              </span>
            </div>
          </div>

          {/* Big Action Button (matching Run Plate / Measure Plate in mockup) */}
          <button
            onClick={handleStartRead}
            disabled={isReading}
            className="w-full py-3.5 rounded-xl ui-btn-solid transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
          >
            <svg className="w-4 h-4 text-[var(--ink)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
            </svg>
            <span>{readMode === 'Kinetic' ? 'Run Kinetic Assay (10 min)' : 'Run Plate'}</span>
          </button>

          {/* Quick status of last read */}
          {lastMeasurement && (
            <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--line)] text-[11px] text-[var(--muted)] flex items-center justify-between">
              <span>Last read recorded ({lastMeasurement.settings})</span>
              <button
                onClick={() => onSelectStation('analysis')}
                className="text-[var(--accent)] font-semibold hover:underline"
              >
                Inspect Data →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
