// The practical mode: the launcher, a running practical (the 3D bench with the procedure, bench
// and notebook panels over it), or the review.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionView } from '../../../packages/lab-core/src/index.ts'
import { clock, rotorPositions, toLabState } from '../../runtime/present'
import { catalogue, CONTEXT_LABELS } from '../../runtime/content'
import { ThreeLabScene, type SceneVariant } from '../ThreeLabScene'
import { BenchPanel } from './BenchPanel'
import { NotebookPanel } from './NotebookPanel'
import { PracticalLauncher } from './PracticalLauncher'
import { ProcedurePanel } from './ProcedurePanel'
import { ReviewView } from './ReviewView'
import { usePractical } from './usePractical'

export function PracticalView() {
  const [state] = usePractical()
  if (state.phase === 'review' && state.result) return <ReviewView result={state.result} />
  if (state.phase === 'running' && state.view) return <PracticalShell view={state.view} />
  return <PracticalLauncher />
}

const VIEWS: Array<{ id: SceneVariant; label: string }> = [
  { id: 'prep', label: 'Bench' },
  { id: 'reader', label: 'Reader' },
  { id: 'centrifuge', label: 'Centrifuge' },
]

type Trigger = { type: 'aspirate' | 'dispense' | 'eject'; time: number } | null

/**
 * What the 3D scene should animate for the newest event: a learner's pipette transfer from the
 * rack into the plate (aspirate, then dispense), a centrifuge run, a plate read. Only the scene's
 * existing animations are used, and only for events it can show; everything else is still.
 */
function useEventMotion(view: SessionView, lab: ReturnType<typeof toLabState>, setScene: (v: SceneVariant) => void) {
  const [source, setSource] = useState<string | undefined>()
  const [well, setWell] = useState<string | undefined>()
  const [volumeUl, setVolumeUl] = useState(50)
  const [loaded, setLoaded] = useState(false)
  const [trigger, setTrigger] = useState<Trigger>(null)
  const [reading, setReading] = useState(false)
  const [spinning, setSpinning] = useState(false)
  // Events already there when the shell opened (a resumed run, auto-performed steps) are not replayed.
  const seen = useRef(view.recent[view.recent.length - 1]?.index ?? -1)
  const timers = useRef<number[]>([])
  const isCentrifuge = useMemo(() => {
    const cat = catalogue().catalogue
    return (equipment: string) => cat.isA(equipment, 'core:centrifuge')
  }, [])
  const rotor = useMemo(() => rotorPositions(view, isCentrifuge), [view, isCentrifuge])
  const tip = view.equipment.some((e) => e.kind === 'tool' && e.tip && e.tip !== 'none')

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  const last = view.recent[view.recent.length - 1]
  useEffect(() => {
    if (!last || last.index <= seen.current) return
    seen.current = last.index
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms))
    const p = last.params as Record<string, unknown>
    // Only the learner's own actions move the scene: a demonstration or an auto-performed step
    // may run many operations, and switching stations rebuilds them.
    if (last.actor !== 'learner') return
    if (last.op === 'core:transfer' && last.facts.tool !== 'pour') {
      const src = String(p.source ?? '')
      const dst = view.containers.find((c) => c.id === p.destination)
      if (!lab.rack.includes(src) || dst?.kind !== 'well' || !dst.position) return
      setScene('prep')
      setSource(src)
      setWell(dst.position)
      setVolumeUl(Math.round(Number(last.facts.deliveredL ?? 0) * 1e6))
      setTrigger({ type: 'aspirate', time: performance.now() })
      later(1500, () => {
        setLoaded(true)
        setTrigger({ type: 'dispense', time: performance.now() })
      })
      later(2900, () => setLoaded(false))
    } else if (last.op === 'core:centrifuge' && last.facts.ran) {
      setScene('centrifuge')
      setSpinning(true)
      later(4000, () => setSpinning(false))
    } else if (last.op === 'core:measure' && view.containers.find((c) => c.id === p.subject)?.kind === 'plate') {
      setScene('reader')
      setReading(true)
      later(3000, () => setReading(false))
    }
  }, [last?.index])

  return { source, well, volumeUl, loaded, trigger, reading, spinning, rotor, tip }
}

function PracticalShell({ view }: { view: SessionView }) {
  const [state, rt] = usePractical()
  const [scene, setScene] = useState<SceneVariant>('prep')
  const [notebook, setNotebook] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'procedure' | 'bench' | 'scene'>('procedure')
  const [selection, setSelection] = useState<string | undefined>()
  const lab = useMemo(() => toLabState(view), [view])
  const plate = view.containers.find((c) => c.kind === 'plate' && (c.wells?.length ?? 0) === 96)
  const motion = useEventMotion(view, lab, setScene)

  return (
    <div className="relative w-full h-full overflow-hidden" data-testid="practical-shell" data-mobile-panel={mobilePanel}>
      <div className="absolute inset-0 z-0">
        <ThreeLabScene
          variant={scene}
          lab={lab}
          selectedSource={motion.source ?? selection}
          selectedWell={motion.well}
          pipetteLoaded={motion.loaded}
          pipetteVolume={motion.volumeUl}
          tipPresent={motion.tip}
          animTrigger={motion.trigger}
          reading={motion.reading}
          spinning={motion.spinning}
          rotorLoaded={motion.rotor}
          showCameraUI={false}
          mapButton={false}
          onTubeSelect={(id) => { setSelection(id); setMobilePanel('bench') }}
          onWellSelect={(id) => { if (plate) { setSelection(`${plate.id}/${id}`); setMobilePanel('bench') } }}
        />
      </div>

      <div className="practical-header absolute top-0 inset-x-0 z-20 px-3 pt-3 pointer-events-none">
        <div className="ui-panel pointer-events-auto px-3 py-2 flex flex-wrap items-center gap-2 justify-between">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-[13px] font-semibold truncate">{view.title}</span>
            {state.context && <span className="ui-chip">{CONTEXT_LABELS[state.context]}</span>}
            <span className="font-mono-ui text-[11px] text-[var(--muted)]" title="Simulated time">
              {clock(view.timeS)}
            </span>
            {(state.notice || state.error) && (
              <span className={`text-[12px] truncate ${state.error ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`} data-testid="practical-notice">
                {state.error ?? state.notice}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="practical-views ui-nav text-[11px]">
              {VIEWS.map((v) => (
                <button key={v.id} className={scene === v.id ? 'ui-tab ui-tab-on' : 'ui-tab'} onClick={() => setScene(v.id)} data-testid={`practical-view-${v.id}`}>
                  {v.label}
                </button>
              ))}
            </div>
            <button className="ui-btn h-7" onClick={() => rt.rewind()} data-testid="practical-undo">
              Undo
            </button>
            <button className="ui-btn h-7" onClick={() => setNotebook((n) => !n)} data-testid="practical-notebook">
              Notebook
            </button>
            <button className="ui-btn-solid h-7 px-3" onClick={() => rt.finish()} data-testid="practical-finish">
              Finish
            </button>
          </div>
        </div>
      </div>

      <div className="practical-procedure absolute left-3 top-24 bottom-3 z-10 w-[300px] max-w-[42vw] flex flex-col pointer-events-none">
        <div className="pointer-events-auto min-h-0 max-h-full overflow-y-auto rounded-[var(--radius)]">
          <ProcedurePanel view={view} />
        </div>
      </div>

      <div className="practical-bench absolute right-3 top-24 bottom-3 z-10 w-[320px] max-w-[46vw] flex flex-col pointer-events-none">
        <div className="pointer-events-auto min-h-0 max-h-full overflow-y-auto rounded-[var(--radius)]">
          <BenchPanel view={view} selection={selection} />
        </div>
      </div>

      <nav className="practical-mobile-nav" aria-label="Practical workspace">
        {(['procedure', 'bench', 'scene'] as const).map(panel => <button key={panel} className={mobilePanel === panel && !notebook ? 'ui-tab ui-tab-on' : 'ui-tab'} aria-pressed={mobilePanel === panel && !notebook} data-testid={`mobile-${panel}`} onClick={() => { setNotebook(false); setMobilePanel(panel) }}>{panel === 'procedure' ? 'Procedure' : panel === 'bench' ? 'Bench' : 'Lab'}</button>)}
        <button className={notebook ? 'ui-tab ui-tab-on' : 'ui-tab'} aria-pressed={notebook} data-testid="mobile-notebook" onClick={() => setNotebook(true)}>Notebook</button>
      </nav>
      {notebook && (
        <div className="practical-notebook absolute inset-y-3 z-30 w-[560px] max-w-[92vw]">
          <NotebookPanel view={view} onClose={() => setNotebook(false)} />
        </div>
      )}
    </div>
  )
}
