import React, { useState } from 'react'
import type { LabState } from '../sim/model'
import { PIPETTES, type ExperienceDef, type PipetteDef } from '../content/catalog'
import { uL, uM, wellId } from '../sim/rng'
import { ThreeLabScene, type SeatControl } from './ThreeLabScene'
import { ChairControls } from './ChairControls'
import { MapIcon, mapStore, useMapState } from './LabMap'
import { WALK_EYE_HEIGHT } from '../three/lab/layout'
import { sceneUnitsToCentimetres } from '../three/units'

interface SamplePrepBenchProps {
  exp: ExperienceDef
  lab: LabState
  onTransfer: (source: string, dest: string, volume: number, pipette: string, newTip: boolean, discard: boolean) => void
  onSelectStation: (s: string) => void
}

export const SamplePrepBench: React.FC<SamplePrepBenchProps> = ({
  exp,
  lab,
  onTransfer,
  onSelectStation,
}) => {
  const defaultSource =
    exp.id === 'bca'
      ? exp.reagents.find((r) => r.kind === 'assay')?.id
      : exp.reagents.find((r) => r.kind === 'protein')?.id
  const [selectedPipette, setSelectedPipette] = useState<string>('P200')
  const [volume, setVolume] = useState<number>(50)
  const [newTip, setNewTip] = useState<boolean>(true)
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(2) // Step 3 of 6 (0-indexed: 2)

  // Pipetting state
  const [pipetteLoaded, setPipetteLoaded] = useState<{ sourceId: string; volume: number; name: string } | null>(null)
  const [selectedSource, setSelectedSource] = useState<string>(defaultSource || lab.rack[0] || '')
  const [selectedDest, setSelectedDest] = useState<string>('A1')
  const [inspectItem, setInspectItem] = useState<{ type: 'tube' | 'well'; id: string } | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [cameraMode, setCameraMode] = useState<'walk' | 'free'>('walk')
  const [seatControl, setSeatControl] = useState<SeatControl | null>(null)
  const map = useMapState()
  const [animTrigger, setAnimTrigger] = useState<{ type: 'aspirate' | 'dispense' | 'eject'; time: number } | null>(null)
  const [tipPresent, setTipPresent] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)

  const activePipetteDef: PipetteDef = PIPETTES.find((p) => p.id === selectedPipette) || PIPETTES[3]

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 3500)
  }

  // Handle Aspirate (Pick up liquid into tip)
  const handleAspirate = () => {
    if (actionBusy) return
    if (!selectedSource) {
      showToast('Select a source tube or reagent bottle first.')
      return
    }
    const sample = lab.samples[selectedSource]
    if (!sample || sample.volume < volume) {
      showToast(`Insufficient liquid in ${sample?.name || selectedSource}.`)
      return
    }
    if (!tipPresent) {
      showToast('Attach a fresh tip before aspirating.')
      return
    }
    setActionBusy(true)
    setPipetteLoaded({
      sourceId: selectedSource,
      volume,
      name: sample.name,
    })
    setAnimTrigger({ type: 'aspirate', time: performance.now() })
    showToast(`Aspirated ${volume} µL of ${sample.name}. Destination well ready.`)
    window.setTimeout(() => setActionBusy(false), 1400)
  }

  // Handle Dispense
  const handleDispense = () => {
    if (actionBusy) return
    if (!pipetteLoaded) {
      showToast('Pipette tip is empty. Aspirate liquid first.')
      return
    }
    setActionBusy(true)
    const transfer = pipetteLoaded
    const destination = selectedDest
    const dest = `${lab.plate.label}!${destination}`
    setAnimTrigger({ type: 'dispense', time: performance.now() })
    // Commit the sample-state transfer when the animated liquid column reaches
    // the bottom of the tip, so the well fills at the physically correct time.
    window.setTimeout(() => {
      onTransfer(transfer.sourceId, dest, transfer.volume, selectedPipette, newTip, false)
      showToast(`Dispensed ${transfer.volume} µL into well ${destination}.`)
    }, 650)
    window.setTimeout(() => {
      setPipetteLoaded(null)
      setNewTip(false)
      if (destination.startsWith('A') && parseInt(destination.slice(1)) < 6) {
        setSelectedDest(`A${parseInt(destination.slice(1)) + 1}`)
      }
    }, 900)
    window.setTimeout(() => setActionBusy(false), 1250)
  }

  // Handle Eject Tip
  const handleEjectTip = () => {
    if (actionBusy) return
    setActionBusy(true)
    setAnimTrigger({ type: 'eject', time: performance.now() })
    if (pipetteLoaded) {
      // Discard loaded liquid to waste
      onTransfer(pipetteLoaded.sourceId, 'waste', pipetteLoaded.volume, selectedPipette, newTip, true)
      setPipetteLoaded(null)
    }
    setTipPresent(false)
    setNewTip(false)
    showToast('Tip ejected into sharps waste.')
    // This learning mode automatically seats the next sterile tip after the
    // discarded tip visibly lands in the sharps bin.
    window.setTimeout(() => {
      setTipPresent(true)
      setNewTip(true)
      setActionBusy(false)
      showToast('Fresh sterile tip attached.')
    }, 950)
  }

  // 96-well grid rows A-H, cols 1-12
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

  const stepsList = [
    { title: exp.id === 'bca' ? 'Prepare protein standards' : 'Prepare substrate dilutions', completed: true },
    { title: exp.id === 'bca' ? 'Prepare unknown samples' : 'Prepare assay mix', completed: true },
    { title: exp.id === 'bca' ? 'Add working reagent' : 'Add enzyme', completed: false, current: true },
    { title: 'Incubate and measure', completed: false },
    { title: 'Analyse data', completed: false },
    { title: 'Complete lab notebook', completed: false },
  ]

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-hidden ui-page select-none flex flex-col">
      <div className="ui-bar h-10 px-5 flex items-center justify-between text-[12.5px] z-20">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate">{exp.title}</span>
          <span className="text-[var(--faint)]">/</span>
          <span className="text-[var(--muted)] font-mono-ui text-[11px]">
            {currentStepIndex + 1} / {stepsList.length}
          </span>
        </div>
        <button onClick={() => onSelectStation('plate-reader')} className="ui-btn h-7">
          Plate reader →
        </button>
      </div>

      {/* Main Workspace Area with Background Image */}
      <div className="relative flex-1 w-full overflow-hidden">
        {/* Real 3D laboratory bench. The DOM panels are controls; the lab itself is WebGL. */}
        <div className="absolute inset-0 z-0">
          <ThreeLabScene
            variant="prep"
            lab={lab}
            selectedSource={selectedSource}
            selectedWell={selectedDest}
            pipetteLoaded={!!pipetteLoaded}
            pipetteVolume={volume}
            tipPresent={tipPresent}
            animTrigger={animTrigger}
            cameraMode={cameraMode}
            onCameraMode={setCameraMode}
            onSeatControl={setSeatControl}
            showCameraUI={false}
            mapButton={false}
            mapAnchor={{ right: 16, bottom: 80 }}
            onTubeSelect={(id) => {
              setSelectedSource(id)
              setInspectItem({ type: 'tube', id })
            }}
            onWellSelect={(id) => {
              setSelectedDest(id)
              setInspectItem({ type: 'well', id })
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#070c18]/55 via-transparent to-[#070c18]/20 pointer-events-none" />
        </div>

        {/* Left Floating Stepper Card (matching Mockup 1 panel 2) */}
        <div className="ui-panel absolute left-5 top-5 w-72 p-4 z-20 space-y-3">
          <div className="flex items-center justify-between">
            <span className="ui-kicker">Protocol</span>
            <span className="font-mono-ui text-[11px] text-[var(--muted)]">
              {Math.round((currentStepIndex / stepsList.length) * 100)}%
            </span>
          </div>

          <div className="space-y-2">
            {stepsList.map((step, idx) => (
              <div
                key={idx}
                onClick={() => setCurrentStepIndex(idx)}
                className={`p-2 rounded-md border transition-colors cursor-pointer flex items-center gap-2.5 ${
                  idx === currentStepIndex
                    ? 'bg-[var(--bg-2)] border-[var(--ink)] text-[var(--ink)]'
                    : step.completed
                    ? 'border-[var(--line)] text-[var(--muted)]'
                    : 'border-transparent text-[var(--faint)]'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
                    idx === currentStepIndex
                      ? 'border border-[var(--ink)]'
                      : step.completed
                      ? 'bg-[var(--ok-soft)] text-[var(--ok)]'
                      : 'border border-[var(--line)]'
                  }`}
                >
                  {step.completed ? '✓' : idx + 1}
                </div>
                <span className="text-xs leading-tight">{step.title}</span>
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-[var(--line)] text-[11.5px] text-[var(--muted)] space-y-1">
            <span className="font-medium text-[var(--ink)]">Now</span>
            <p>
              {currentStepIndex === 2 ? (
                <>
                  Pipette <strong>50 µL</strong> of{' '}
                  <strong>{lab.samples[selectedSource]?.name ?? 'selected reagent'}</strong> into wells{' '}
                  <strong>A1–A6</strong>.
                  <span className="block text-[10px] text-[var(--muted)] mt-1">
                    Filled:{' '}
                    {['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((w) => {
                      const [r, c] = [w.charCodeAt(0) - 65, parseInt(w.slice(1)) - 1]
                      const filled = lab.plate.wells[r]?.[c] && (lab.plate.wells[r]?.[c]?.volume ?? 0) > 0
                      return (
                        <span
                          key={w}
                          className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-mono mr-1 ${
                            filled ? 'bg-emerald-500/20 text-[var(--ok)] border border-emerald-500/40' : 'bg-[var(--bg-2)] text-[var(--muted)]'
                          }`}
                        >
                          {w} {filled ? '✓' : '○'}
                        </span>
                      )
                    })}
                  </span>
                </>
              ) : (
                'Dispense sample reagents across the designated assay rows.'
              )}
            </p>
          </div>
        </div>

        {/* Mini 96-well plate monitor overlay (compact, matching real lab tablet readout) */}
        <div className="absolute left-6 bottom-20 z-20 pointer-events-auto">
          <div className="p-3 ui-panel flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[10px] text-[var(--muted)] font-bold uppercase tracking-wider">
              <span>Plate Grid: {lab.plate.label}</span>
              <span className="text-[var(--accent)] font-mono">Target: {selectedDest}</span>
            </div>
            <div className="bg-[var(--bg-2)] p-2 rounded-xl border border-[var(--line)]">
              {/* Inline, not grid-cols-[…]: the add-on kit's Tailwind scan splits class names at commas. */}
              <div className="grid gap-0.5" style={{ gridTemplateColumns: '14px repeat(12, 14px)' }}>
                <div />
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="text-[8px] font-mono text-[var(--faint)] text-center">
                    {i + 1}
                  </div>
                ))}
                {rows.map((rowName, rIdx) => (
                  <React.Fragment key={rowName}>
                    <div className="text-[8px] font-mono text-[var(--faint)] flex items-center justify-center">
                      {rowName}
                    </div>
                    {Array.from({ length: 12 }, (_, cIdx) => {
                      const wellKey = wellId(rIdx, cIdx)
                      const wellSample = lab.plate.wells[rIdx]?.[cIdx]
                      const isSelected = selectedDest === wellKey
                      const hasLiquid = wellSample && wellSample.volume > 0
                      return (
                        <button
                          key={wellKey}
                          onClick={() => {
                            setSelectedDest(wellKey)
                            setInspectItem({ type: 'well', id: wellKey })
                          }}
                          className={`w-3.5 h-3.5 rounded-full border transition-all ${
                            isSelected
                              ? 'border-[var(--accent)] ring-1 ring-blue-400 scale-125 z-10'
                              : hasLiquid
                              ? 'border-slate-500'
                              : 'border-[var(--line)] bg-[var(--bg-2)]'
                          }`}
                          style={{
                            backgroundColor: hasLiquid
                              ? wellSample.color || '#818cf8'
                              : undefined,
                          }}
                          title={`Well ${wellKey}: ${hasLiquid ? `${wellSample.name} (${Math.round(wellSample.volume)}µL)` : 'Empty'}`}
                        />
                      )
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="hidden absolute inset-x-84 bottom-24 top-6 flex-col items-center justify-center gap-5 z-10 pointer-events-none">
          {/* Labeled Reagent Tube Rack */}
          <div className="p-3.5 ui-panel pointer-events-auto flex flex-col items-center gap-2">
            <div className="text-[10px] font-semibold text-[var(--muted)] uppercase tracking-wider flex items-center justify-between w-full px-2">
              <span>Reagent Tubes (Bench Stock)</span>
              <span className="text-[var(--faint)] text-[9px]">Click tube to select source</span>
            </div>

            <div className="flex gap-4 p-2 bg-[var(--bg-2)]/60 rounded-xl border border-[var(--line)]">
              {lab.rack.map((tubeId) => {
                const tube = lab.samples[tubeId]
                const isSelected = selectedSource === tubeId
                const fillPct = Math.min(100, Math.max(10, (tube.volume / tube.capacity) * 100))

                return (
                  <button
                    key={tubeId}
                    onClick={() => {
                      setSelectedSource(tubeId)
                      setInspectItem({ type: 'tube', id: tubeId })
                    }}
                    className={`flex flex-col items-center group transition-all ${
                      isSelected ? 'scale-105' : 'hover:scale-102 opacity-85 hover:opacity-100'
                    }`}
                  >
                    {/* Tube Glass Vessel */}
                    <div
                      className={`relative w-8 h-18 rounded-b-md rounded-t-[3px] border overflow-hidden flex flex-col justify-end p-0.5 shadow-lg ${
                        isSelected
                          ? 'border-[var(--accent)] ring-2 ring-blue-500/40 shadow-blue-500/20'
                          : 'border-slate-600/80 bg-[var(--bg-2)]/40'
                      }`}
                    >
                      {/* Liquid volume */}
                      <div
                        className="w-full rounded-b transition-all duration-300"
                        style={{
                          height: `${fillPct}%`,
                          backgroundColor: tube.color || '#bae6fd',
                          opacity: 0.9,
                        }}
                      />
                    </div>
                    {/* Tube Label */}
                    <span
                      className={`mt-1.5 text-[10px] font-medium max-w-[70px] truncate px-1 rounded ${
                        isSelected
                          ? 'bg-[var(--ink)] text-[var(--bg)] font-bold'
                          : 'text-[var(--muted)] bg-[var(--bg-2)]/80'
                      }`}
                    >
                      {tube.name.split(' ')[0]}
                    </span>
                    <span className="text-[9px] font-mono text-[var(--faint)]">
                      {uL(tube.volume)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 96-Well Microplate */}
          <div className="p-4 ui-panel pointer-events-auto flex flex-col items-center">
            <div className="flex items-center justify-between w-full px-2 mb-2">
              <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider">
                Microplate ({lab.plate.label})
              </span>
              <span className="text-[10px] text-[var(--muted)]">
                Selected destination: <strong className="text-[var(--accent)] font-mono">{selectedDest}</strong>
              </span>
            </div>

            {/* 96-well grid */}
            <div className="bg-[var(--bg-2)] p-2.5 rounded-xl border border-[var(--line)]">
              <div className="grid gap-1" style={{ gridTemplateColumns: '16px repeat(12, 20px)' }}>
                {/* Header row 1-12 */}
                <div />
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="text-[9px] font-mono text-[var(--faint)] text-center">
                    {i + 1}
                  </div>
                ))}

                {/* Rows A-H */}
                {rows.map((rowName, rIdx) => (
                  <React.Fragment key={rowName}>
                    <div className="text-[9px] font-mono text-[var(--faint)] flex items-center justify-center">
                      {rowName}
                    </div>
                    {Array.from({ length: 12 }, (_, cIdx) => {
                      const wellKey = wellId(rIdx, cIdx)
                      const wellSample = lab.plate.wells[rIdx]?.[cIdx]
                      const isSelected = selectedDest === wellKey
                      const hasLiquid = wellSample && wellSample.volume > 0

                      return (
                        <button
                          key={wellKey}
                          onClick={() => {
                            setSelectedDest(wellKey)
                            setInspectItem({ type: 'well', id: wellKey })
                          }}
                          className={`w-5 h-5 rounded-full border transition-all flex items-center justify-center ${
                            isSelected
                              ? 'border-[var(--accent)] ring-2 ring-blue-400/50 scale-110 shadow-lg shadow-blue-500/40 z-10'
                              : hasLiquid
                              ? 'border-slate-500/80 hover:border-slate-300'
                              : 'border-[var(--line)] hover:border-slate-600 bg-[var(--bg-2)]'
                          }`}
                          style={{
                            backgroundColor: hasLiquid
                              ? wellSample.color || '#818cf8'
                              : undefined,
                          }}
                          title={`Well ${wellKey}: ${hasLiquid ? wellSample.name : 'Empty'}`}
                        />
                      )
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Floating Pipette Tool Controller (Top Right, matching Mockup 2) */}
        <div className="absolute right-6 top-6 w-72 ui-panel p-4.5 z-20 space-y-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-medium text-[var(--ink)] flex items-center gap-1.5">
              <span>Pipette ({selectedPipette})</span>
            </h3>
            <select
              value={selectedPipette}
              onChange={(e) => {
                const pipId = e.target.value
                setSelectedPipette(pipId)
                const def = PIPETTES.find((p) => p.id === pipId)
                if (def) setVolume(Math.max(def.min, Math.min(def.max, volume)))
              }}
              className="bg-[var(--bg-2)] border border-[var(--line)] rounded-md px-2 py-1 text-[11px] text-[var(--ink)]"
            >
              {PIPETTES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Volume Control */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-[var(--muted)]">
              <span>Volume (µL)</span>
              <span className="font-mono text-[var(--accent)] font-semibold">{volume} µL</span>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="number"
                min={activePipetteDef.min}
                max={activePipetteDef.max}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value) || 0)}
                className="w-20 px-2.5 py-1.5 bg-[var(--bg-2)] border border-[var(--line)] rounded-lg text-sm font-mono text-[var(--ink)] text-center font-bold"
              />
              <input
                type="range"
                min={activePipetteDef.min}
                max={activePipetteDef.max}
                step={activePipetteDef.max <= 20 ? 0.5 : 5}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="flex-1 accent-[var(--accent)]"
              />
            </div>
          </div>

          {/* Tip Status & Controls */}
          <div className="space-y-2 pt-1 border-t border-[var(--line)]">
            <label className="flex items-center gap-2 text-xs text-[var(--muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={newTip}
                onChange={(e) => setNewTip(e.target.checked)}
                className="w-4 h-4 rounded bg-[var(--surface-solid)] border-[var(--line)] text-[var(--accent)] accent-[var(--accent)]"
              />
              <span>New sterile tip</span>
            </label>

            {pipetteLoaded && (
              <div className="p-2 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-[11px] text-[var(--accent)]">
                <span className="font-semibold">Tip loaded:</span> {pipetteLoaded.volume} µL of {pipetteLoaded.name}
              </div>
            )}

            <button
              onClick={handleEjectTip}
              disabled={actionBusy}
              className="w-full py-1.5 rounded-lg bg-[var(--bg-2)] hover:bg-[var(--line)] border border-[var(--line)] text-[var(--muted)] text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>Eject tip</span>
            </button>
          </div>
        </div>

        {/* Selected Item Inspector Popup (if clicked) */}
        {inspectItem && (
          <div className="absolute left-6 bottom-24 w-72 ui-panel p-4 z-20 text-xs text-[var(--muted)] space-y-2">
            <div className="flex items-center justify-between border-b border-[var(--line)] pb-2">
              <span className="font-bold text-[var(--ink)]">
                {inspectItem.type === 'tube' ? `Tube: ${lab.samples[inspectItem.id]?.name}` : `Well: ${inspectItem.id}`}
              </span>
              <button onClick={() => setInspectItem(null)} className="text-[var(--faint)] hover:text-[var(--ink)]">✕</button>
            </div>

            {inspectItem.type === 'tube' ? (
              <div className="space-y-1">
                <div>Volume: <strong className="text-[var(--accent)]">{uL(lab.samples[inspectItem.id]?.volume || 0)}</strong></div>
                <div>Concentration: <strong className="text-[var(--accent)]">{uM(lab.samples[inspectItem.id]?.concentration || 0)}</strong></div>
                {lab.samples[inspectItem.id]?.description && (
                  <div className="text-[11px] text-[var(--muted)] pt-1 italic">{lab.samples[inspectItem.id]?.description}</div>
                )}
              </div>
            ) : (
              (() => {
                const [r, c] = [inspectItem.id.charCodeAt(0) - 65, parseInt(inspectItem.id.slice(1)) - 1]
                const w = lab.plate.wells[r]?.[c]
                return w ? (
                  <div className="space-y-1">
                    <div>Volume: <strong className="text-[var(--accent)]">{uL(w.volume)}</strong></div>
                    <div>Concentration: <strong className="text-[var(--accent)]">{uM(w.concentration)}</strong></div>
                    <div className="text-[10px] text-[var(--faint)] pt-1">History: {w.history.join(' → ')}</div>
                  </div>
                ) : (
                  <div className="text-[var(--faint)]">Empty well. Ready for liquid transfer.</div>
                )
              })()
            )}
          </div>
        )}

        {/* Interactive Prompt Banner (matching Mockup 1 panel 2) */}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-20 z-20 pointer-events-auto">
          <div className="px-5 py-2.5 rounded-full ui-panel border border-[var(--accent)]/35 shadow-xl shadow-blue-500/10 text-xs text-[var(--ink)] flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
            <span>
              Pipette <strong>{volume} µL</strong> of <strong>{lab.samples[selectedSource]?.name || selectedSource}</strong> into <strong>Well {selectedDest}</strong>.
            </span>
          </div>
        </div>

        {/* Bottom Toolbar: [Pick up], [Aspirate], [Dispense], [Eject tip] (matching Mockup 1 panel 2) */}
        <div className="absolute inset-x-0 bottom-0 h-16 ui-bar border-t px-6 flex items-center justify-between z-30">
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                showToast(`Pipette picked up and calibrated to ${volume} µL.`)
              }}
              className="px-4 py-2 rounded-xl bg-[var(--bg-2)]/80 hover:bg-[var(--line)] border border-[var(--line)] text-[var(--ink)] text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-sm"
            >
              <svg className="w-4 h-4 text-[var(--muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span>Pick up</span>
            </button>

            <button
              onClick={handleAspirate}
              disabled={actionBusy || !!pipetteLoaded}
              className={`px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-md ${
                !pipetteLoaded
                  ? 'ui-btn-solid'
                  : 'bg-[var(--bg-2)] text-[var(--muted)] border border-[var(--line)]'
              }`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
              </svg>
              <span>Aspirate</span>
            </button>

            <button
              onClick={handleDispense}
              disabled={actionBusy || !pipetteLoaded}
              className={`px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-md ${
                pipetteLoaded
                  ? 'bg-[var(--ok)] text-white shadow-emerald-600/30 animate-pulse'
                  : 'bg-[var(--bg-2)] text-[var(--muted)] border border-[var(--line)]'
              }`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
              </svg>
              <span>Dispense</span>
            </button>

            <button
              onClick={handleEjectTip}
              disabled={actionBusy}
              className="px-4 py-2 rounded-xl bg-[var(--bg-2)]/80 hover:bg-[var(--line)] border border-[var(--line)] text-[var(--ink)] text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-sm"
            >
              <svg className="w-4 h-4 text-[var(--muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>Eject tip</span>
            </button>
          </div>

          {/* Camera Rig Controls (drive the real 3D camera) */}
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1 rounded-xl border border-[var(--line)] bg-[var(--bg-2)] p-1">
              <button
                onClick={() => setCameraMode('walk')}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                  cameraMode === 'walk' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
                title={`Stand at the bench — eye height ${Math.round(sceneUnitsToCentimetres(WALK_EYE_HEIGHT))} cm`}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                </svg>
                Walk POV
              </button>
              <button
                onClick={() => setCameraMode('free')}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                  cameraMode === 'free' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
                title="Fly freely through the laboratory"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                Free fly
              </button>
              <button
                data-testid="map-toggle"
                onClick={() => mapStore.toggle()}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                  map.open || map.expanded ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
                title="Show or hide the facility map (M)"
              >
                <MapIcon />
                Map
              </button>
              {seatControl && <ChairControls control={seatControl} />}
            </div>
            <span className="hidden xl:inline text-[10px] text-[var(--faint)]">
              {cameraMode === 'walk' ? 'WASD walk · Shift sprint · drag to look · right-hold closer · M map' : 'WASD fly · Space rise · Shift descend · right-hold closer · M map'}
            </span>
          </div>
        </div>
      </div>

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="ui-panel absolute top-14 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 text-[12px] flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  )
}
