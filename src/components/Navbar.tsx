import React from 'react'
import { useTheme } from '../theme'
import { GraphicsMenu } from './GraphicsMenu'

export type ActiveStation =
  | 'home'
  | 'practical'
  | 'station-selector'
  | 'sample-prep'
  | 'centrifuge'
  | 'plate-reader'
  | 'chromatography'
  | 'analysis'
  | 'notebook'
  | 'design'
  | 'troubleshoot'

interface NavbarProps {
  activeStation: ActiveStation
  onSelectStation: (s: ActiveStation) => void
  taskTitle?: string
  labClock: number
  onOpenNotebook: () => void
  notebookCount: number
  onEndSession: () => void
}

const STATIONS: { id: ActiveStation; label: string }[] = [
  { id: 'practical', label: 'Practicals' },
  { id: 'station-selector', label: 'Lab' },
  { id: 'sample-prep', label: 'Bench' },
  { id: 'plate-reader', label: 'Reader' },
  { id: 'centrifuge', label: 'Centrifuge' },
  { id: 'chromatography', label: 'Chromatography' },
  { id: 'analysis', label: 'Analysis' },
]

export const Navbar: React.FC<NavbarProps> = ({
  activeStation,
  onSelectStation,
  labClock,
  onOpenNotebook,
  notebookCount,
  onEndSession,
}) => {
  const { mode, hostControlled, toggle } = useTheme()
  const formatTime = (sec: number) => {
    const totalMinutes = Math.floor(sec / 60) + 14 * 60 + 32
    const hours = Math.floor(totalMinutes / 60) % 24
    const mins = totalMinutes % 60
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
  }

  return (
    <header className="lab-navbar ui-bar sticky top-0 z-50 h-12 w-full px-3 flex items-center justify-between select-none">
      <div className="flex items-center gap-4 min-w-0">
        <button aria-label="Workbench home" onClick={() => onSelectStation('home')} className="flex items-center gap-2.5 text-left shrink-0 group">
          <div className="w-7 h-7 rounded-[7px] bg-[var(--ink)] text-[var(--bg)] flex items-center justify-center">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 3.75H6.375c-.621 0-1.125.504-1.125 1.125v14.25c0 .621.504 1.125 1.125 1.125h11.25c.621 0 1.125-.504 1.125-1.125V9.375M9 3.75l7.5 7.5M9 3.75v5.625c0 .621.504 1.125 1.125 1.125H15.75" />
            </svg>
          </div>
          <div className="leading-none hidden sm:block">
            <div className="text-[12.5px] font-semibold tracking-tight text-[var(--ink)]">Workbench</div>
            <div className="text-[10px] text-[var(--faint)] mt-0.5">MnemoNexus</div>
          </div>
        </button>

        <select className="station-picker ui-select min-w-0 max-w-[145px]" aria-label="Station" data-testid="station-select" value={activeStation} onChange={e => onSelectStation(e.target.value as ActiveStation)}>
          <option value="home">Home</option>
          {STATIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          <option value="notebook">Notebook</option>
          <option value="design">Design</option>
          <option value="troubleshoot">Diagnose</option>
        </select>
        <nav className="station-nav ui-nav text-[11.5px] min-w-0 overflow-x-auto">
          {STATIONS.map((s) => (
            <button
              key={s.id}
              data-testid={`station-${s.id}`}
              onClick={() => onSelectStation(s.id)}
              className={activeStation === s.id ? 'ui-tab ui-tab-on' : 'ui-tab'}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="hidden lg:flex items-center gap-2 px-2.5 h-7 rounded-md border border-[var(--line)] text-[11px] font-mono-ui text-[var(--muted)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--ok)]" />
          <span className="text-[var(--ink)]">{formatTime(labClock)}</span>
          <span className="text-[var(--faint)]">×10</span>
        </div>

        <button
          onClick={() => {
            onOpenNotebook()
            onSelectStation('notebook')
          }}
          className={`navbar-notebook ui-btn h-7 ${activeStation === 'notebook' ? 'border-[var(--ink)]' : ''}`}
        >
          Notebook
          {notebookCount > 0 && (
            <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--ink)] text-[var(--bg)] text-[9px] font-mono-ui leading-4 text-center">
              {notebookCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onSelectStation('design')}
          className={`navbar-extra ui-btn h-7 hidden sm:inline-flex ${activeStation === 'design' ? 'border-[var(--ink)]' : ''}`}
        >
          Design
        </button>
        <button
          onClick={() => onSelectStation('troubleshoot')}
          className={`navbar-extra ui-btn h-7 hidden sm:inline-flex ${activeStation === 'troubleshoot' ? 'border-[var(--ink)]' : ''}`}
        >
          Diagnose
        </button>

        <GraphicsMenu />

        {/* Inside MnemoNexus the user's look sets light or dark. */}
        {!hostControlled && (
          <button
            onClick={toggle}
            className="ui-btn h-7 w-7 !p-0"
            title={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label="Toggle theme"
          >
            {mode === 'dark' ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1.5M12 19.5V21M4.22 4.22l1.06 1.06M18.72 18.72l1.06 1.06M3 12h1.5M19.5 12H21M4.22 19.78l1.06-1.06M18.72 5.28l1.06-1.06M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            )}
          </button>
        )}

        <button
          onClick={onEndSession}
          data-testid="end-session"
          className="ui-btn h-7 min-w-7 !px-2 whitespace-nowrap"
          title="End session"
          aria-label="End session"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
          <span className="hidden xl:inline">End session</span>
        </button>
      </div>
    </header>
  )
}
