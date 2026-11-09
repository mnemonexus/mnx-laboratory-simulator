import React from 'react'
import type { ActiveStation } from './Navbar'
import { ThreeLabScene } from './ThreeLabScene'

interface StationSelectorProps {
  onSelectStation: (s: ActiveStation) => void
  labClock: number
}

const STATIONS: { id: ActiveStation; name: string; desc: string }[] = [
  { id: 'sample-prep', name: 'Sample preparation', desc: 'Pipettes, tubes, reagents' },
  { id: 'centrifuge', name: 'Centrifuge', desc: 'Balance, RCF, pellets' },
  { id: 'plate-reader', name: 'Plate reader', desc: 'Absorbance · fluorescence' },
  { id: 'chromatography', name: 'Chromatography', desc: 'Fractions and elution' },
  { id: 'analysis', name: 'Analysis', desc: 'Curves, fits, unknowns' },
  { id: 'notebook', name: 'Notebook', desc: 'Protocol and calculations' },
]

export const StationSelector: React.FC<StationSelectorProps> = ({ onSelectStation, labClock }) => {
  const formatTime = (sec: number) => {
    const totalMinutes = Math.floor(sec / 60) + 14 * 60 + 32
    const hours = Math.floor(totalMinutes / 60) % 24
    const mins = totalMinutes % 60
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
  }

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-hidden ui-page">
      <ThreeLabScene variant="overview" />

      <aside className="ui-panel absolute right-5 top-5 bottom-16 w-80 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--line)]">
          <div className="ui-kicker">Stations</div>
          <h2 className="ui-title text-[18px] mt-1">Select a workspace</h2>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin p-2">
          {STATIONS.map((st) => (
            <button
              key={st.id + st.name}
              onClick={() => onSelectStation(st.id)}
              className="w-full text-left px-3 py-2.5 rounded-md hover:bg-[var(--bg-2)] transition-colors flex items-center justify-between group"
            >
              <span>
                <span className="block text-[13px] font-medium">{st.name}</span>
                <span className="block text-[11.5px] text-[var(--muted)] mt-0.5">{st.desc}</span>
              </span>
              <span className="text-[var(--faint)] group-hover:text-[var(--ink)]">→</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="ui-panel absolute left-5 right-5 bottom-4 h-12 px-4 flex items-center justify-between">
        <div className="text-[12.5px]">
          <span className="text-[var(--muted)]">Task </span>
          <span className="font-medium">Prepare samples for plate assay</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono-ui text-[12px] text-[var(--muted)]">{formatTime(labClock)}</span>
          <button onClick={() => onSelectStation('sample-prep')} className="ui-btn-solid h-8 px-3 text-[12px]">
            Enter bench
          </button>
        </div>
      </div>
    </div>
  )
}
