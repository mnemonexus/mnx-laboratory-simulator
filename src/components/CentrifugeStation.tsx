import React, { useState } from 'react'
import { ThreeLabScene } from './ThreeLabScene'

interface CentrifugeStationProps {
  onSelectStation: (s: string) => void
}

export const CentrifugeStation: React.FC<CentrifugeStationProps> = ({
  onSelectStation: _onSelectStation,
}) => {
  const [activeTab, setActiveTab] = useState<'setup' | 'samples' | 'run' | 'results'>('setup')
  const [rotor, setRotor] = useState<string>('FA-45-24-11')
  const [speedMode, setSpeedMode] = useState<'RPM' | 'RCF'>('RPM')
  const [speed, setSpeed] = useState<number>(14000)
  const [duration, setDuration] = useState<number>(10)
  const [temperature, setTemperature] = useState<string>('4 °C')
  const [brake, setBrake] = useState<string>('Normal')
  const [isRunning, setIsRunning] = useState<boolean>(false)
  const [remainingTime, setRemainingTime] = useState<number>(10)

  // Rotor balance check: 24 positions
  // Evenly spaced tube pairs loaded at position 1 and 13, 7 and 19
  const [tubesLoaded, setTubesLoaded] = useState<boolean[]>(
    Array.from({ length: 24 }, (_, i) => i === 0 || i === 12 || i === 6 || i === 18)
  )

  const isBalanced = (() => {
    // Check if every loaded tube has an opposing tube 12 positions away
    for (let i = 0; i < 24; i++) {
      if (tubesLoaded[i] && !tubesLoaded[(i + 12) % 24]) return false
    }
    return tubesLoaded.filter(Boolean).length >= 2
  })()

  const toggleTube = (idx: number) => {
    const next = [...tubesLoaded]
    next[idx] = !next[idx]
    setTubesLoaded(next)
  }

  const handleStartCentrifuge = () => {
    if (!isBalanced) return
    setIsRunning(true)
    setRemainingTime(duration)

    const interval = setInterval(() => {
      setRemainingTime((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          setIsRunning(false)
          setActiveTab('results')
          return 0
        }
        return prev - 1
      })
    }, 800)
  }

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Header bar matching Mockup 1 panel 5 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">Centrifugation</h1>
            <p className="text-[11px] text-[var(--muted)]">Eppendorf 5424R Refrigerated Microcentrifuge</p>
          </div>
        </div>

        {/* Tab Pills: Setup | Samples | Run | Results */}
        <div className="flex items-center gap-1 bg-[var(--bg-2)] p-1 rounded-xl border border-[var(--line)]">
          {(['setup', 'samples', 'run', 'results'] as const).map((tab) => (
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

      {/* Main Centrifuge Split */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Photorealistic Open Centrifuge with 24-position Rotor */}
        <div className="lg:col-span-7 flex flex-col items-center">
          <div className="relative w-full rounded-2xl overflow-hidden border border-[var(--line)]/80 shadow-2xl bg-[var(--surface-solid)] group">
            <div className="relative h-[26rem] sm:h-[32rem] w-full overflow-hidden bg-[var(--surface-solid)]">
              <ThreeLabScene
                variant="centrifuge"
                spinning={isRunning}
                rpm={speed}
                rotorLoaded={tubesLoaded}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0c1426]/40 via-transparent to-black/10 pointer-events-none" />

              {/* Centrifuge Brand Label */}
              <div className="absolute left-6 bottom-6 text-[var(--muted)] font-bold tracking-widest text-sm font-mono flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent)]" />
                <span>eppendorf</span>
                <span className="text-[var(--faint)] font-normal text-xs">Centrifuge 5424 R</span>
              </div>

              {/* Running Status Badge */}
              {isRunning && (
                <div className="absolute right-6 top-6 px-4 py-2 rounded-xl bg-[var(--bg-2)]/90 border border-[var(--accent)]/35 shadow-2xl text-xs font-mono text-[var(--accent)] flex items-center gap-2.5 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
                  <span>Spinning at {speed.toLocaleString()} RPM ({remainingTime} min remaining)</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: Controls Card (matching Mockup 1 panel 5) */}
        <div className="lg:col-span-5 ui-panel p-5 space-y-4">
          <div className="border-b border-[var(--line)] pb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Rotor & Parameters</h2>
              <p className="text-[11px] text-[var(--muted)]">Configure separation conditions</p>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30">
              24 × 1.5/2.0 mL
            </span>
          </div>

          <div className="space-y-3 text-xs">
            {/* Rotor selector */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Rotor</label>
              <select
                value={rotor}
                onChange={(e) => setRotor(e.target.value)}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono"
              >
                <option value="FA-45-24-11">FA-45-24-11 (Fixed-angle, 24-place)</option>
                <option value="F-45-18-11-Kit">F-45-18-11-Kit (18-place Spin Columns)</option>
              </select>
            </div>

            {/* Speed with RPM / RCF Toggle */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[var(--muted)] font-medium">Speed</label>
                <div className="flex rounded-md bg-[var(--surface-solid)] border border-[var(--line)] p-0.5 text-[10px]">
                  <button
                    onClick={() => setSpeedMode('RPM')}
                    className={`px-2 py-0.5 rounded ${speedMode === 'RPM' ? 'bg-[var(--ink)] text-[var(--bg)] font-bold' : 'text-[var(--muted)]'}`}
                  >
                    RPM
                  </button>
                  <button
                    onClick={() => setSpeedMode('RCF')}
                    className={`px-2 py-0.5 rounded ${speedMode === 'RCF' ? 'bg-[var(--ink)] text-[var(--bg)] font-bold' : 'text-[var(--muted)]'}`}
                  >
                    RCF
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="500"
                  min="500"
                  max="15000"
                  value={speed}
                  onChange={(e) => setSpeed(parseInt(e.target.value) || 0)}
                  className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono font-bold text-sm"
                />
                <span className="text-[var(--faint)] font-mono text-xs">{speedMode}</span>
              </div>
            </div>

            {/* Duration & Temperature */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[var(--muted)] font-medium">Duration</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={duration}
                    onChange={(e) => setDuration(parseInt(e.target.value) || 1)}
                    className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono text-sm"
                  />
                  <span className="text-[var(--faint)] text-xs">min</span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[var(--muted)] font-medium">Temperature</label>
                <select
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono"
                >
                  <option value="4 °C">4 °C (Cold room)</option>
                  <option value="20 °C">20 °C (Room temp)</option>
                  <option value="-4 °C">-4 °C (Freezing)</option>
                </select>
              </div>
            </div>

            {/* Brake */}
            <div className="space-y-1">
              <label className="text-[var(--muted)] font-medium">Brake</label>
              <select
                value={brake}
                onChange={(e) => setBrake(e.target.value)}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)]"
              >
                <option value="Normal">Normal</option>
                <option value="Soft">Soft (protect delicate pellets)</option>
                <option value="Off">Off</option>
              </select>
            </div>

            {/* Balance Check Graphic (exact match from Mockup 1 panel 5) */}
            <div className="pt-2 border-t border-[var(--line)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[var(--muted)] font-semibold text-xs">Balance check</span>
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                    isBalanced ? 'text-[var(--ok)]' : 'text-[var(--warn)]'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${isBalanced ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  {isBalanced ? 'Rotor balanced' : 'Rotor imbalanced!'}
                </span>
              </div>

              {/* 24-position circular rotor diagram */}
              <div className="flex justify-center p-3 bg-[var(--bg-2)] rounded-xl border border-[var(--line)]">
                <div className="relative w-36 h-36 rounded-full border-2 border-[var(--line)] bg-[var(--surface-solid)] flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full border border-[var(--line)] bg-[var(--bg-2)] flex items-center justify-center text-[9px] text-[var(--faint)] font-mono">
                    AXLE
                  </div>

                  {/* 24 tube holes */}
                  {Array.from({ length: 24 }, (_, i) => {
                    const angle = (i * 360) / 24 - 90
                    const rad = (angle * Math.PI) / 180
                    const radius = 54
                    const x = 72 + radius * Math.cos(rad) - 6
                    const y = 72 + radius * Math.sin(rad) - 6
                    const isLoaded = tubesLoaded[i]

                    return (
                      <button
                        key={i}
                        onClick={() => toggleTube(i)}
                        className={`absolute w-3 h-3 rounded-full border transition-all ${
                          isLoaded
                            ? 'bg-[var(--accent)] border-white shadow-sm shadow-blue-500/50 scale-110'
                            : 'bg-[var(--bg-2)] border-[var(--line)] hover:border-slate-500'
                        }`}
                        style={{ left: `${x}px`, top: `${y}px` }}
                        title={`Tube Position ${i + 1} (${isLoaded ? 'Loaded' : 'Empty'})`}
                      />
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Action button */}
          <button
            onClick={handleStartCentrifuge}
            disabled={!isBalanced || isRunning}
            className="w-full py-3 rounded-xl ui-btn-solid transition-all shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2"
          >
            {isRunning ? `Spinning (${remainingTime} min)...` : 'Start Centrifuge'}
          </button>

          {/* Warning footer banner matching mockup */}
          <div className="p-2.5 rounded-lg bg-[var(--warn-soft)] border border-[var(--warn)]/30 text-[11px] text-[var(--warn)] flex items-center gap-2">
            <span>⚠️</span>
            <span>Ensure tube caps are closed and tubes are balanced.</span>
          </div>
        </div>
      </div>
    </div>
  )
}
