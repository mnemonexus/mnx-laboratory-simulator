// The procedure: the plan's steps with their state, the current step's guidance (as much as the
// support profile allows), decisions, and the controls for moving on.
import type { SessionView, StepView } from '../../../packages/lab-core/src/index.ts'
import { show, usePractical } from './usePractical'

interface DecisionDef {
  id: string
  forEach?: { var: string; in: string }
  options?: Array<{ id: string; label: string }>
}

const STATUS_DOT: Record<StepView['status'], string> = {
  done: 'bg-[var(--ok)]',
  current: 'bg-[var(--ink)]',
  pending: 'bg-[var(--line-strong)]',
  skipped: 'bg-[var(--line)]',
}

export function ProcedurePanel({ view }: { view: SessionView }) {
  const [state, rt] = usePractical()
  const steps = (state.entry?.json as { procedure?: { steps?: DecisionDef[] } } | undefined)?.procedure?.steps ?? []
  const current = view.steps.find((s) => s.id === view.current)
  const guidance = state.guidance
  const showSteps = guidance?.level !== 'none' && guidance?.level !== 'objective'

  return (
    <div className="ui-panel p-3 flex flex-col gap-3 min-h-0" data-testid="procedure-panel">
      <div className="flex items-center justify-between">
        <span className="ui-kicker">Procedure</span>
        <span className="font-mono-ui text-[10.5px] text-[var(--faint)]">
          {view.steps.filter((s) => s.status === 'done').length}/{view.steps.length}
        </span>
      </div>

      <ol className="space-y-0.5 overflow-y-auto min-h-0 max-h-[34vh] pr-1">
        {view.steps.map((s, i) => (
          <li key={s.id}>
            <button
              data-testid={`step-${s.id}`}
              onClick={() => rt.goTo(s.id)}
              className={`w-full flex items-start gap-2 text-left px-2 py-1.5 rounded-md transition-colors ${s.status === 'current' ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-2)]'}`}
            >
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status]}`} />
              <span className="min-w-0">
                <span className={`block text-[12.5px] ${s.status === 'skipped' ? 'text-[var(--faint)] line-through' : 'text-[var(--ink)]'}`}>
                  {showSteps || s.status !== 'pending' ? s.title : `Step ${i + 1}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {current && (
        <div className="border-t border-[var(--line)] pt-3 space-y-2">
          <div className="text-[13px] font-medium">{current.title}</div>
          {guidance?.message && <p className="text-[12px] text-[var(--muted)] leading-relaxed">{guidance.message}</p>}
          {guidance?.step?.why && <p className="text-[11.5px] text-[var(--faint)] leading-relaxed">{guidance.step.why}</p>}
          {current.kind === 'decision' && <Decision step={steps.find((d) => d.id === current.id)} view={view} />}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button className="ui-btn h-7" data-testid="practical-complete-step" onClick={() => rt.completeStep()}>
              Step done
            </button>
            <button className="ui-btn h-7" data-testid="practical-demonstrate" onClick={() => rt.demonstrate()} title="Let the reference do this step">
              Show me
            </button>
            <button className="ui-btn h-7" data-testid="practical-hint" onClick={() => rt.hint()}>
              Hint
            </button>
          </div>
        </div>
      )}
      {!current && <p className="text-[12px] text-[var(--muted)]">All steps are done. Finish when your results are in.</p>}
    </div>
  )
}

function Decision({ step, view }: { step?: DecisionDef; view: SessionView }) {
  const [, rt] = usePractical()
  if (!step?.options?.length) return null
  let items: unknown[] = [undefined]
  if (step.forEach) {
    const v = rt.evaluate(step.forEach.in)
    items = Array.isArray(v) ? v : []
  }
  const chosen = (item: unknown) => {
    const key = item === undefined ? `decision:${step.id}` : `decision:${step.id}:${String(item)}`
    return [...view.notebook].reverse().find((n) => n.field === key)?.value
  }
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const label = item === undefined ? null : view.containers.find((c) => c.id === item)?.label ?? show(item)
        const picked = chosen(item)
        return (
          <div key={String(item)} className="space-y-1">
            {label && <div className="text-[11.5px] text-[var(--muted)]">{label}</div>}
            <div className="flex flex-wrap gap-1.5">
              {step.options!.map((o) => (
                <button
                  key={o.id}
                  data-testid={`decision-${step.id}-${item === undefined ? '' : `${String(item)}-`}${o.id}`}
                  className={picked === o.id ? 'ui-btn h-7 border-[var(--ink)]' : 'ui-btn h-7'}
                  onClick={() => rt.decide(step.id, o.id, item === undefined ? undefined : String(item))}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
