// The end-of-run review, from the core's assessment: the validity verdict, the dimensions with
// their gates, objectives, the evidence behind them and the likely misconceptions.
import type { LabResult } from '../../../packages/lab-core/src/index.ts'
import { useLabHost } from '../../host/context'
import { usePractical } from './usePractical'

const DIMENSION: Record<string, string> = {
  'procedural-fidelity': 'Procedure',
  'technique-quality': 'Technique',
  outcome: 'Outcome',
  analysis: 'Analysis',
  interpretation: 'Interpretation',
  'safety-practice': 'Safety',
}

export function ReviewView({ result }: { result: LabResult }) {
  const [state, rt] = usePractical()
  const host = useLabHost()
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
  const failed = result.evidence.filter((e) => !e.passed)
  const passed = result.evidence.filter((e) => e.passed)

  return (
    <div className="w-full h-full overflow-y-auto ui-page" data-testid="review-view">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
        <div>
          <div className="ui-kicker">Review</div>
          <h1 className="ui-title text-[28px] mt-1">{state.entry?.title}</h1>
        </div>
        <div className="ui-panel p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Score" value={pct(result.score)} />
          <Stat label="Validity" value={result.validity.verdict.replace(/-/g, ' ')} />
          <Stat label="Recall grade" value={result.quality === null ? '—' : `${result.quality} / 5`} />
          <Stat label="Hints · undos" value={`${result.support.hintsUsed} · ${result.support.rewinds}`} />
        </div>
        {result.validity.reasons.length > 0 && (
          <div className="ui-panel p-4">
            <div className="ui-kicker mb-2">Why the result may not be valid</div>
            <ul className="list-disc pl-5 text-[12.5px] space-y-0.5">
              {result.validity.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="ui-panel p-4">
          <div className="ui-kicker mb-2">Dimensions</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {result.dimensions.map((d) => (
              <div key={d.id} className="border border-[var(--line)] rounded-md p-2.5">
                <div className="text-[11.5px] text-[var(--muted)]">{DIMENSION[d.id] ?? d.id}</div>
                <div className="text-[15px] font-medium">
                  {d.gate ? (d.gate === 'passed' ? 'Passed' : <span className="text-[var(--danger)]">Failed</span>) : pct(d.score)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ui-panel p-4">
          <div className="ui-kicker mb-2">Objectives</div>
          <ul className="space-y-1">
            {result.objectives.map((o) => {
              const statement = (state.entry?.json as { context?: { objectives?: Array<{ id: string; statement: string }> } })?.context?.objectives?.find((x) => x.id === o.id)?.statement ?? o.id
              return (
                <li key={o.id} className="flex items-start gap-2 text-[12.5px]">
                  <span className={o.met ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}>{o.met ? '✓' : '✗'}</span>
                  <span>{statement}</span>
                </li>
              )
            })}
          </ul>
        </div>
        {(failed.length > 0 || result.misconceptions.length > 0) && (
          <div className="ui-panel p-4">
            <div className="ui-kicker mb-2">What went wrong</div>
            <ul className="space-y-1 text-[12.5px]">
              {failed.map((e) => (
                <li key={e.id}>
                  <span className="text-[var(--danger)]">✗</span> {e.statement}
                </li>
              ))}
            </ul>
            {result.misconceptions.length > 0 && (
              <p className="text-[12px] text-[var(--muted)] mt-2">Possible misconceptions: {result.misconceptions.join(', ')}</p>
            )}
          </div>
        )}
        {passed.length > 0 && (
          <div className="ui-panel p-4">
            <div className="ui-kicker mb-2">What went right</div>
            <ul className="space-y-1 text-[12.5px]">
              {passed.map((e) => (
                <li key={e.id}>
                  <span className="text-[var(--ok)]">✓</span> {e.statement}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {/* The host launched this one run, and is waiting for its report. */}
          {!rt.launched && (
            <button className="ui-btn h-9 px-4" data-testid="review-close" onClick={() => rt.close()}>
              Back to practicals
            </button>
          )}
          <button className="ui-btn-solid h-9 px-4" data-testid="review-end-session" onClick={() => host.finish(rt.outcome())}>
            End session
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[var(--muted)]">{label}</div>
      <div className="text-[18px] font-medium capitalize">{value}</div>
    </div>
  )
}
