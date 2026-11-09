import React, { useState } from 'react'

interface ExperimentalDesignViewProps {
  onProceedToLab: () => void
}

export const ExperimentalDesignView: React.FC<ExperimentalDesignViewProps> = ({
  onProceedToLab,
}) => {
  const [activeTab, setActiveTab] = useState<'question' | 'variables' | 'layout' | 'method' | 'review'>('question')
  const [researchQuestion, setResearchQuestion] = useState(
    'Does inhibitor X reduce the activity of enzyme Y, and what is the IC50?'
  )
  const [dependentVar, setDependentVar] = useState('Initial reaction rate (ΔA/min)')
  const [independentVar, setIndependentVar] = useState('Inhibitor X concentration')
  const [controls, setControls] = useState({
    noInhibitor: true,
    blankNoEnzyme: true,
    substrateOnly: true,
  })
  const [replicates, setReplicates] = useState(3)

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Header bar matching Mockup 2 panel 8 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)]">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">Experimental Design</h1>
            <p className="text-[11px] text-[var(--muted)]">Plan your experiment before entering the lab</p>
          </div>
        </div>

        <span className="text-[11px] font-mono text-[var(--faint)]">Saved 2 minutes ago</span>
      </div>

      {/* Main Form Split */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Navigation Tabs (matching Mockup 2) */}
        <div className="lg:col-span-3 ui-panel p-3 space-y-1">
          {[
            { id: 'question', label: 'Research Question' },
            { id: 'variables', label: 'Variables & Controls' },
            { id: 'layout', label: 'Plate Layout' },
            { id: 'method', label: 'Method' },
            { id: 'review', label: 'Review' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as unknown as typeof activeTab)}
              className={`w-full px-3.5 py-2.5 rounded-xl text-left text-xs font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-[var(--ink)] text-[var(--bg)] shadow-md shadow-blue-600/30'
                  : 'text-[var(--muted)] hover:bg-[var(--bg-2)]/60 hover:text-[var(--ink)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Center: Interactive Form Fields (matching Mockup 2) */}
        <div className="lg:col-span-5 ui-panel p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
              Research Question
            </label>
            <input
              type="text"
              value={researchQuestion}
              onChange={(e) => setResearchQuestion(e.target.value)}
              className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-xl px-3.5 py-2.5 text-xs text-[var(--ink)]"
            />
          </div>

          <div className="space-y-3 pt-2 border-t border-[var(--line)] text-xs">
            <h3 className="font-bold text-[var(--ink)] uppercase tracking-wider text-[11px]">
              Experimental Approach
            </h3>

            <div className="space-y-1">
              <label className="text-[var(--muted)]">Dependent variable</label>
              <select
                value={dependentVar}
                onChange={(e) => setDependentVar(e.target.value)}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)]"
              >
                <option value="Initial reaction rate (ΔA/min)">Initial reaction rate (ΔA/min)</option>
                <option value="End-point absorbance (562 nm)">End-point absorbance (562 nm)</option>
                <option value="Fluorescence emission (520 nm)">Fluorescence emission (520 nm)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[var(--muted)]">Independent variable</label>
              <select
                value={independentVar}
                onChange={(e) => setIndependentVar(e.target.value)}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)]"
              >
                <option value="Inhibitor X concentration">Inhibitor X concentration</option>
                <option value="Substrate concentration">Substrate concentration</option>
                <option value="Incubation temperature">Incubation temperature</option>
              </select>
            </div>

            <div className="space-y-2 pt-1">
              <label className="text-[var(--muted)] font-medium">Controls</label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={controls.noInhibitor}
                    onChange={(e) => setControls({ ...controls, noInhibitor: e.target.checked })}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span>No inhibitor control (100% activity baseline)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={controls.blankNoEnzyme}
                    onChange={(e) => setControls({ ...controls, blankNoEnzyme: e.target.checked })}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span>Blank (no enzyme background subtraction)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={controls.substrateOnly}
                    onChange={(e) => setControls({ ...controls, substrateOnly: e.target.checked })}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span>Substrate only control (spontaneous hydrolysis)</span>
                </label>
              </div>
            </div>

            <div className="space-y-1 pt-1">
              <label className="text-[var(--muted)]">Number of replicates</label>
              <select
                value={replicates}
                onChange={(e) => setReplicates(parseInt(e.target.value))}
                className="w-full bg-[var(--surface-solid)] border border-[var(--line)] rounded-lg px-3 py-2 text-[var(--ink)] font-mono"
              >
                <option value={1}>1 (Single measurement)</option>
                <option value={2}>2 (Duplicates)</option>
                <option value={3}>3 (Triplicates — recommended)</option>
                <option value={4}>4 (Quadruplicates)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Right Summary Card: Your Plan (matching Mockup 2 panel 8) */}
        <div className="lg:col-span-4 ui-panel p-6 space-y-4">
          <div className="border-b border-[var(--line)] pb-3">
            <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">Your Plan</h2>
            <p className="text-[11px] text-[var(--muted)]">Validated experimental design summary</p>
          </div>

          <div className="space-y-2.5 text-xs text-[var(--muted)]">
            <div className="flex items-start gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1 shrink-0" />
              <span>8 inhibitor concentrations (0 – 100 µM)</span>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1 shrink-0" />
              <span>{replicates} replicates per condition ({8 * replicates} wells total)</span>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1 shrink-0" />
              <span>Include appropriate controls (No-inhibitor, Blank)</span>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1 shrink-0" />
              <span>Measure at 340 nm (NADH coupled rate)</span>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1 shrink-0" />
              <span>Analyse IC50 using nonlinear regression fit</span>
            </div>
          </div>

          <button
            onClick={onProceedToLab}
            className="w-full py-3.5 rounded-xl ui-btn-solid transition-all flex items-center justify-center gap-2 active:scale-95"
          >
            <span>Proceed to Laboratory</span>
            <span>→</span>
          </button>
        </div>
      </div>
    </div>
  )
}
