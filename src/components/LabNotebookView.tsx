import React, { useState } from 'react'
import type { LabState } from '../sim/model'
import microplatePhoto from '../assets/images/microplate-purple.jpg'

interface LabNotebookViewProps {
  lab: LabState
  onSelectStation: (s: string) => void
}

export const LabNotebookView: React.FC<LabNotebookViewProps> = ({
  lab: _lab,
  onSelectStation: _onSelectStation,
}) => {
  const [section, setSection] = useState<'calculations' | 'timeline' | 'protocol' | 'samples' | 'measurements' | 'notes' | 'conclusions'>('calculations')
  const [newNoteText, setNewNoteText] = useState('')
  const [customNotes, setCustomNotes] = useState<string[]>([])

  const navItems = [
    { id: 'timeline', label: 'Timeline / Overview', icon: '⏱' },
    { id: 'protocol', label: 'Protocol', icon: '📋' },
    { id: 'samples', label: 'Samples', icon: '🧪' },
    { id: 'measurements', label: 'Measurements', icon: '📊' },
    { id: 'calculations', label: 'Calculations', icon: '🔢' },
    { id: 'notes', label: 'Notes', icon: '📝' },
    { id: 'conclusions', label: 'Conclusions', icon: '💡' },
  ]

  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newNoteText.trim()) return
    setCustomNotes([...customNotes, newNoteText.trim()])
    setNewNoteText('')
  }

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Header bar matching Mockup 1 panel 7 & Mockup 2 panel 5 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)]">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">
              Lab Notebook – Enzyme Inhibition Study
            </h1>
            <p className="text-[11px] text-[var(--muted)]">Persistent experimental audit trail & calculations</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSection('timeline')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              section === 'timeline' ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]/35' : 'bg-[var(--surface-solid)] border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Timeline View
          </button>
          <button
            onClick={() => setSection('calculations')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              section === 'calculations' ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]/35' : 'bg-[var(--surface-solid)] border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Calculations View
          </button>
          <button className="px-3.5 py-1.5 rounded-lg ui-btn-solid transition-all flex items-center gap-1.5">
            <span>+ New Entry</span>
          </button>
        </div>
      </div>

      {/* Main Notebook Layout: Left Sidebar + Clean Paper Content Area */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Nav Menu (matching Mockup 1 panel 7) */}
        <div className="lg:col-span-3 ui-panel p-3.5 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id as unknown as typeof section)}
              className={`w-full px-3.5 py-2.5 rounded-xl text-left text-xs font-medium flex items-center gap-3 transition-all ${
                section === item.id
                  ? 'bg-[var(--ink)] text-[var(--bg)] shadow-md shadow-blue-600/30'
                  : 'text-[var(--muted)] hover:bg-[var(--bg-2)]/60 hover:text-[var(--ink)]'
              }`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {/* Right Main Paper Notebook Sheet (White / Clean Lab Card styling) */}
        <div className="lg:col-span-9 rounded-2xl bg-[var(--surface-solid)] border border-[var(--line)]/80 shadow-2xl p-6 sm:p-8 space-y-6">
          {section === 'calculations' ? (
            /* Calculations Content (exact match from Mockup 1 panel 7) */
            <div className="space-y-6 text-[var(--ink)]">
              <div className="border-b border-[var(--line)] pb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-[var(--ink)] tracking-tight">Calculations</h2>
                  <p className="text-xs text-[var(--muted)]">Formal biochemical derivation records</p>
                </div>
                <span className="text-xs font-mono px-2.5 py-1 rounded bg-[var(--bg-2)] text-[var(--muted)] border border-[var(--line)]">
                  Experiment #EXP-24-08
                </span>
              </div>

              {/* 1. Inhibitor dilutions */}
              <div className="p-5 rounded-xl bg-[var(--bg-2)] border border-[var(--line)] space-y-3 font-sans">
                <h3 className="text-sm font-bold text-[var(--ink)] flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] text-xs flex items-center justify-center font-bold">1</span>
                  <span>Inhibitor dilutions</span>
                </h3>

                {/* Mathematical Equation Display */}
                <div className="p-3 bg-[var(--bg-2)] rounded-lg border border-[var(--line)] font-mono text-base font-bold text-[var(--accent)] text-center tracking-wider">
                  C₁V₁ = C₂V₂
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono text-[var(--muted)]">
                  <div>
                    <span className="text-[var(--faint)]">Stock concentration:</span> <strong className="text-[var(--ink)]">10 mM</strong>
                  </div>
                  <div>
                    <span className="text-[var(--faint)]">Target concentration:</span> <strong className="text-[var(--ink)]">100 µM (1 mL)</strong>
                  </div>
                  <div className="col-span-1 sm:col-span-2 text-[var(--muted)] bg-[var(--bg-2)]/60 p-2.5 rounded border border-[var(--line)]/80">
                    V₁ = 10 µL &nbsp;|&nbsp; V₂ = 1,000 µL &nbsp;<span className="text-[var(--ok)]">(add 990 µL buffer)</span>
                  </div>
                </div>
              </div>

              {/* 2. Reaction rate (from absorbance) */}
              <div className="p-5 rounded-xl bg-[var(--bg-2)] border border-[var(--line)] space-y-3 font-sans">
                <h3 className="text-sm font-bold text-[var(--ink)] flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] text-xs flex items-center justify-center font-bold">2</span>
                  <span>Reaction rate (from absorbance)</span>
                </h3>

                {/* Mathematical Equation Display */}
                <div className="p-3 bg-[var(--bg-2)] rounded-lg border border-[var(--line)] font-mono text-base font-bold text-[var(--accent)] text-center tracking-wider">
                  Rate = (ΔA / Δt) × (1 / εl)
                </div>

                <div className="space-y-1.5 text-xs font-mono text-[var(--muted)] bg-[var(--bg-2)]/60 p-3 rounded-lg border border-[var(--line)]/80">
                  <div>ΔA / Δt = <strong className="text-[var(--ink)]">0.032 min⁻¹</strong></div>
                  <div>ε (NADH, 340 nm) = <strong className="text-[var(--ink)]">6,220 M⁻¹ cm⁻¹</strong></div>
                  <div>l = <strong className="text-[var(--ink)]">1.00 cm</strong></div>
                  <div className="pt-2 border-t border-[var(--line)] font-bold text-[var(--ok)] text-sm">
                    Rate = 5.14 × 10⁻⁶ M min⁻¹ (5.14 µM min⁻¹)
                  </div>
                </div>
              </div>

              {/* 3. Percent inhibition */}
              <div className="p-5 rounded-xl bg-[var(--bg-2)] border border-[var(--line)] space-y-3 font-sans">
                <h3 className="text-sm font-bold text-[var(--ink)] flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] text-xs flex items-center justify-center font-bold">3</span>
                  <span>Percent inhibition</span>
                </h3>

                {/* Mathematical Equation Display */}
                <div className="p-3 bg-[var(--bg-2)] rounded-lg border border-[var(--line)] font-mono text-base font-bold text-[var(--accent)] text-center tracking-wider">
                  % Inhibition = (1 - Vi / V₀) × 100
                </div>

                <div className="space-y-1.5 text-xs font-mono text-[var(--muted)] bg-[var(--bg-2)]/60 p-3 rounded-lg border border-[var(--line)]/80">
                  <div>V₀ (uninhibited) = <strong className="text-[var(--ink)]">0.82 µM min⁻¹</strong></div>
                  <div>Vi (inhibitor present) = <strong className="text-[var(--ink)]">0.21 µM min⁻¹</strong></div>
                  <div className="pt-2 border-t border-[var(--line)] font-bold text-[var(--ok)] text-sm">
                    % Inhibition = 74.4%
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Timeline & Photo View (matching Mockup 2 panel 5) */
            <div className="space-y-6">
              <div className="border-b border-[var(--line)] pb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-[var(--ink)] tracking-tight">Timeline & Bench Observations</h2>
                  <p className="text-xs text-[var(--muted)]">Synchronised experimental history with photographed plate</p>
                </div>
                <span className="text-xs text-[var(--muted)] font-mono">Today, Session 1</span>
              </div>

              {/* Plate Photograph & Handwritten Note (matching Mockup 2 panel 5) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center p-4 rounded-xl bg-[var(--bg-2)] border border-[var(--line)]">
                <div className="relative rounded-xl overflow-hidden border border-[var(--line)] shadow-xl bg-black">
                  <img
                    src={microplatePhoto}
                    alt="Measured 96-well plate"
                    className="w-full h-48 object-cover filter contrast-110"
                  />
                  <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/80 font-mono text-[9px] text-[var(--ink)]">
                    PR-960 Read @ 562 nm
                  </div>
                </div>

                {/* Handwritten-style blue cursive annotation (exact match from Mockup 2) */}
                <div className="space-y-2 font-serif italic text-[var(--accent)] text-base leading-relaxed p-4 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/25 shadow-inner">
                  <p>"Standards look good."</p>
                  <p>"Unknown 1 = 0.93 mg/mL."</p>
                  <p className="text-[var(--warn)]">"Repeat for unknown 2 (dilute 1:2)."</p>
                  <div className="text-[11px] not-italic text-[var(--muted)] font-mono pt-2 border-t border-[var(--accent)]/25">
                    Signed: J. Doe (Lead Investigator)
                  </div>
                </div>
              </div>

              {/* Chronological Activity Log */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider">
                  Session Log Entries
                </h3>

                <div className="space-y-2 text-xs font-mono">
                  {[
                    { time: '10:02', text: 'Prepared stock dilutions (Tris-HCl 50 mM, NADH 10 mM)' },
                    { time: '10:15', text: 'Created standard series in duplicate (0 – 2.0 mg/mL)' },
                    { time: '10:28', text: 'Set up BCA assay plate and dispensed 200 µL working reagent' },
                    { time: '10:43', text: 'Measured absorbance (562 nm) on BioSim PR-960 microplate reader' },
                    { time: '11:05', text: 'Determined unknown concentration: U1 = 0.93 mg/mL' },
                  ].map((log, i) => (
                    <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg bg-[var(--surface-solid)] border border-[var(--line)]">
                      <span className="text-[var(--accent)] font-bold shrink-0">{log.time}</span>
                      <span className="text-[var(--muted)]">{log.text}</span>
                    </div>
                  ))}

                  {customNotes.map((note, i) => (
                    <div key={`custom-${i}`} className="flex items-start gap-3 p-2.5 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)]/30">
                      <span className="text-[var(--accent)] font-bold shrink-0">11:15</span>
                      <span className="text-[var(--ink)]">{note}</span>
                    </div>
                  ))}
                </div>

                {/* Add Observation Form */}
                <form onSubmit={handleAddNote} className="flex gap-2 pt-2">
                  <input
                    type="text"
                    value={newNoteText}
                    onChange={(e) => setNewNoteText(e.target.value)}
                    placeholder="Add manual observation or calculation note..."
                    className="flex-1 bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-xs text-[var(--ink)]"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 ui-btn-solid transition-colors"
                  >
                    Add note
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
