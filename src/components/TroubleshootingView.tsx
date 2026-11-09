import React, { useState } from 'react'
import notebookPhoto from '../assets/images/notebook-desk.jpg'

interface TroubleshootingViewProps {
  onBackToLab: () => void
}

export const TroubleshootingView: React.FC<TroubleshootingViewProps> = ({
  onBackToLab,
}) => {
  const [selectedAction, setSelectedAction] = useState<string>('enzyme')
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null)

  const handleInvestigate = () => {
    switch (selectedAction) {
      case 'substrate':
        setDiagnosticResult(
          'Diagnostic Test Result: Substrate concentration verified at 10.0 mM via enzymatic endpoint assay (100% of nominal). Substrate degradation is ruled out.'
        )
        break
      case 'ph':
        setDiagnosticResult(
          'Diagnostic Test Result: Buffer pH measured with calibrated glass electrode at 7.41 ± 0.02. Within enzyme pH optimum. Buffer is ruled out.'
        )
        break
      case 'enzyme':
        setDiagnosticResult(
          'CRITICAL DISCOVERY! Parallel assay with fresh Enzyme E-β under identical conditions restored 100% expected activity (41.8 µM/min). The suspect E-α stock has suffered thermal denaturation / freeze-thaw inactivation! Protein concentration was normal (A280 unchanged), but catalytic activity was collapsed.'
        )
        break
      case 'instrument':
        setDiagnosticResult(
          'Diagnostic Test Result: Plate reader wavelength and detector linearity verified with calibrated optical standards (R² = 0.9999). Instrument optics are operating nominally.'
        )
        break
    }
  }

  return (
    <div className="relative w-full h-[calc(100vh-3rem)] overflow-y-auto ui-page select-none flex flex-col">
      {/* Header bar matching Mockup 2 panel 8 */}
      <div className="ui-bar px-6 flex items-center justify-between text-xs text-[var(--muted)] z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--warn-soft)] border border-[var(--warn)]/30 flex items-center justify-center text-[var(--warn)]">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--ink)] leading-tight">Troubleshooting</h1>
            <p className="text-[11px] text-[var(--muted)]">Your results are not what you expected. Investigate and decide what to do next.</p>
          </div>
        </div>

        <button
          onClick={onBackToLab}
          className="px-3.5 py-1.5 rounded-lg bg-[var(--bg-2)] hover:bg-[var(--line)] border border-[var(--line)] text-[var(--ink)] text-xs font-medium flex items-center gap-1.5 transition-colors"
        >
          <span>Back to Laboratory</span>
          <span>→</span>
        </button>
      </div>

      {/* Main Troubleshooting Layout (matching Mockup 2 panel 8) */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Problem Alert & Investigation Options */}
        <div className="lg:col-span-6 space-y-4">
          {/* Observed Result Alert Box (exact match from Mockup 2 panel 8) */}
          <div className="p-4 rounded-xl bg-[var(--warn-soft)] border border-[var(--danger)]/40 text-xs space-y-3">
            <div className="text-[10px] uppercase font-bold text-[var(--danger)] tracking-wider">
              Observed Result
            </div>

            <div className="flex items-start gap-3">
              <span className="text-xl">⚠️</span>
              <div className="space-y-1 flex-1">
                <span className="font-bold text-[var(--danger)] text-sm">
                  The control reaction shows only 40% of the expected activity.
                </span>
                <p className="text-[var(--muted)] text-[11px]">
                  Nominal initial rate: 42.0 µM/min. Measured rate: 16.8 µM/min. The assay cannot proceed until the discrepancy is explained.
                </p>
              </div>
            </div>

            <button className="px-3 py-1 rounded bg-[var(--surface-solid)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)] text-xs font-mono">
              View data →
            </button>
          </div>

          {/* Diagnostic Investigation Choice Card (matching Mockup 2 panel 8) */}
          <div className="ui-panel p-5 space-y-4">
            <h2 className="text-sm font-bold text-[var(--ink)] tracking-wide">
              What would you like to do?
            </h2>

            <div className="space-y-2">
              {[
                { id: 'substrate', label: 'Check the substrate stock (concentration & purity)' },
                { id: 'ph', label: 'Measure the pH of the buffer' },
                { id: 'enzyme', label: 'Re-run the assay with fresh enzyme (parallel test)' },
                { id: 'instrument', label: 'Check instrument calibration and detector wavelength' },
              ].map((opt) => (
                <label
                  key={opt.id}
                  className={`p-3.5 rounded-xl border flex items-center gap-3 cursor-pointer transition-all ${
                    selectedAction === opt.id
                      ? 'bg-[var(--accent-soft)] border-blue-500/60 text-[var(--ink)] font-medium shadow-sm'
                      : 'bg-[var(--bg-2)] border-[var(--line)] text-[var(--muted)] hover:bg-[var(--bg-2)]/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="troubleshoot"
                    checked={selectedAction === opt.id}
                    onChange={() => {
                      setSelectedAction(opt.id)
                      setDiagnosticResult(null)
                    }}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-xs">{opt.label}</span>
                </label>
              ))}
            </div>

            <button
              onClick={handleInvestigate}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-[var(--accent)] text-[var(--ink)] font-semibold text-xs transition-all shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2 active:scale-95"
            >
              <span>Execute Diagnostic Action</span>
              <span>→</span>
            </button>

            {/* Diagnostic Outcome Output */}
            {diagnosticResult && (
              <div
                className={`p-4 rounded-xl border text-xs leading-relaxed space-y-2 ${
                  selectedAction === 'enzyme'
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                    : 'bg-[var(--surface-solid)] border-[var(--line)] text-[var(--muted)]'
                }`}
              >
                <div className="font-bold flex items-center gap-2">
                  <span>{selectedAction === 'enzyme' ? '🎯' : 'ℹ️'}</span>
                  <span>Investigation Findings:</span>
                </div>
                <p>{diagnosticResult}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Desk Photo with Handwritten Lab Notes (matching Mockup 2 panel 8) */}
        <div className="lg:col-span-6 ui-panel p-5 space-y-4">
          <div className="relative rounded-xl overflow-hidden border border-[var(--line)] shadow-2xl bg-black">
            <img
              src={notebookPhoto}
              alt="Laboratory Notebook on Desk"
              className="w-full h-80 object-cover filter contrast-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

            {/* Handwritten Floating Sticky Note (exact match from Mockup 2 panel 8) */}
            <div className="absolute right-6 top-8 w-60 p-4 rounded-xl bg-amber-100 text-slate-900 shadow-2xl rotate-1 border border-amber-300 font-serif text-xs leading-relaxed select-none">
              <div className="font-bold border-b border-amber-300 pb-1 mb-1.5 text-amber-950">
                Possible causes:
              </div>
              <ul className="space-y-1 italic text-slate-800">
                <li>• Enzyme inactive?</li>
                <li>• Wrong pH?</li>
                <li>• Substrate degraded?</li>
                <li>• Instrument issue?</li>
                <li>• Inhibitor contamination?</li>
              </ul>
            </div>

            {/* Bottom Quotation from Mockup 2 */}
            <div className="absolute bottom-4 left-6 right-6 text-center text-xs font-serif italic text-[var(--muted)]">
              "Good scientists ask the next best question."
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[var(--bg-2)] border border-[var(--line)] text-xs text-[var(--muted)] leading-relaxed">
            <span className="font-bold text-[var(--ink)]">Scientific principle: </span>
            A failed experiment must be diagnosed by isolating competing hypotheses through
            discriminating controls. Never randomly adjust multiple variables at once.
          </div>
        </div>
      </div>
    </div>
  )
}
