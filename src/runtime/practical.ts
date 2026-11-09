// The practical runtime: one LabSession at a time, as an external store React subscribes to
// (useSyncExternalStore). Panels call its methods; the session (the core) decides everything
// about the science. Every call is guarded, because inside MnemoNexus an uncaught error ends the
// run, and the session is saved after each change through the host's storage.
import type { LaunchSurface } from '@mnemonexus/addon-sdk'
import type { PracticeLaunch } from '@mnemonexus/addon-sdk/practice'
import {
  type GuidanceView,
  type LabResult,
  type LearningContext,
  type OperationDecl,
  type RunStatus,
  type SessionSave,
  type SessionView,
} from '../../packages/lab-core/src/index.ts'
import { catalogue, practicals, type PracticalEntry } from './content'
import { launchTarget, toPracticeResult, type RunOutcome } from './practice'
import { ScienceBackend, type ScienceSave } from './scienceBackend'
import { DEV } from '../env'

export interface PracticalState {
  phase: 'idle' | 'running' | 'review'
  entry?: PracticalEntry
  context?: LearningContext
  view?: SessionView
  guidance?: GuidanceView
  result?: LabResult
  mnemonexus?: Record<string, unknown>
  /** Something went wrong in the runtime itself (not a refused action). */
  error?: string
  /** What happened to the last request, when it needs saying (a demonstration, a rewind). */
  notice?: string
  /** Whether the learner did any work (ending the session then counts as a completed use). */
  worked: boolean
  /** A saved run that can be resumed. */
  saved?: { entryId: string; title: string }
}

/** The part of the host the runtime needs. */
export interface PracticalHost {
  load(key: string): Promise<string | null>
  save(key: string, value: string): Promise<void>
}

const SAVE_KEY = 'practical'

interface Stored {
  entryId: string
  context: LearningContext
  save: SessionSave
  science?: ScienceSave
}

export class PracticalRuntime {
  private session?: ScienceBackend
  private state: PracticalState = { phase: 'idle', worked: false }
  private readonly subs = new Set<() => void>()
  private readonly host?: PracticalHost
  /** The simulation itself failed during this session, so a launched run must not count. */
  private faulted = false
  /** The activity the host chose (practice-v1). This session is then that one run, and reports back when it ends. */
  launched?: PracticeLaunch

  constructor(host?: PracticalHost) {
    this.host = host
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }

  getSnapshot = (): PracticalState => this.state

  /** The operations the bench can offer, from the catalogue. */
  operations(): OperationDecl[] {
    return this.session?.operations() ?? []
  }

  /** Look for a saved run to offer on the launcher. */
  async findSaved(): Promise<void> {
    try {
      const text = await this.host?.load(SAVE_KEY)
      if (!text) return
      const stored = JSON.parse(text) as Stored
      const entry = practicals().find((p) => p.id === stored.entryId)
      if (entry && this.state.phase === 'idle') this.set({ saved: { entryId: entry.id, title: entry.title } })
    } catch {
      // A damaged save is simply not offered.
    }
  }

  start(entryId: string, context?: LearningContext, seed?: number): boolean {
    // Development builds only: scripted checks of the bench (output/probes) drive the runtime that started.
    if (DEV) (globalThis as { __labPractical?: PracticalRuntime }).__labPractical = this
    return this.guard(() => {
      const entry = practicals().find((p) => p.id === entryId)
      if (!entry) throw new Error(`No practical "${entryId}"`)
      const ctx = context ?? entry.contexts[0]
      const { catalogue: cat, problems } = catalogue()
      if (problems.length) console.warn('Catalogue problems:', problems)
      const started = ScienceBackend.start(entry.json, cat, { context: ctx, seed: seed ?? (Date.now() % 1_000_000), rehearse: false })
      if (!started.ok) {
        this.set({ error: started.message })
        return false
      }
      this.session?.destroy()
      this.session = started.session
      this.state = { phase: 'running', entry, context: ctx, worked: true }
      this.refresh()
      return true
    })
  }

  /**
   * Open the practical the host chose, in the context for this surface, so the launcher never
   * shows. False, with the reason in `error`, if it cannot start.
   */
  launch(practice: PracticeLaunch, surface: LaunchSurface): boolean {
    const target = launchTarget(practice, surface, practicals())
    if (!target) {
      this.set({ error: `This add-on has no practical for "${practice.activityId}". It may need updating.` })
      return false
    }
    this.launched = practice
    if (!this.start(target.entry.id, target.context, target.seed)) return false
    this.refresh(practice.reason)
    return true
  }

  async resume(): Promise<boolean> {
    try {
      const text = await this.host?.load(SAVE_KEY)
      if (!text) return false
      const stored = JSON.parse(text) as Stored
      const entry = practicals().find((p) => p.id === stored.entryId)
      if (!entry) return false
      const r = stored.science ? ScienceBackend.loadState(stored.science, entry.json, catalogue().catalogue) : ScienceBackend.restore(stored.save, entry.json, catalogue().catalogue)
      if (!r.ok) {
        this.set({ error: r.message })
        return false
      }
      this.session?.destroy()
      this.session = r.session
      this.state = { phase: 'running', entry, context: stored.context, worked: true }
      this.refresh('Resumed where you left off.')
      return true
    } catch (e) {
      this.set({ error: `Could not resume: ${(e as Error).message}` })
      return false
    }
  }

  /** Perform an operation; a refusal is shown with the bench, not thrown. */
  perform(op: string, params: Record<string, unknown>): boolean {
    return this.act(() => this.session!.perform(op, params).ok)
  }

  /** Notebook work must not replace the current procedure step's outputs. */
  analyse(op: string, params: Record<string, unknown>): boolean {
    if (!['core:transform', 'core:fit', 'core:interpolate', 'core:compute', 'core:conclude'].includes(op)) return false
    return this.act(() => this.session!.perform(op, params, '').ok)
  }

  /** Why an operation would be refused, or null if it would go ahead. */
  check(op: string, params: Record<string, unknown>): string | null {
    try {
      return this.session?.check(op, params)?.message ?? null
    } catch (e) {
      return (e as Error).message
    }
  }

  decide(stepId: string, choice: string, item?: string): boolean {
    return this.act(() => this.session!.decide(stepId, choice, item).ok)
  }

  note(field: string, value: unknown): boolean {
    return this.act(() => this.session!.note(field, value).ok)
  }

  completeStep(stepId?: string): void {
    this.act(() => {
      this.session!.completeStep(stepId)
      return true
    })
  }

  goTo(stepId: string): void {
    this.act(() => {
      this.session!.goTo(stepId)
      return true
    })
  }

  hint(): void {
    this.act(() => {
      const g = this.session!.hint()
      this.state = { ...this.state, guidance: g }
      return true
    }, undefined)
  }

  demonstrate(): void {
    this.act(() => {
      const r = this.session!.demonstrate()
      this.notice = r.ok ? 'Demonstrated.' : `The demonstration stopped: ${r.issues[0] ?? 'unknown reason'}`
      return r.ok
    })
  }

  rewind(): void {
    this.act(() => {
      const ok = this.session!.rewind()
      this.notice = ok ? 'Undid your last action.' : 'Nothing to undo.'
      return ok
    })
  }

  /** End the run and show the review. */
  finish(status?: RunStatus): void {
    this.guard(() => {
      if (!this.session) return false
      const { result, mnemonexus } = this.session.finish(status)
      this.state = { ...this.state, phase: 'review', result, mnemonexus, view: this.session.view() }
      this.emit()
      if (!this.launched) void this.host?.save(SAVE_KEY, '').catch(() => undefined)
      return true
    })
  }

  /** What ending the session tells the host. A launched run still going ends here, as left early, and reports what happened. */
  outcome(): RunOutcome {
    if (this.launched && this.state.phase === 'running') this.finish('abandoned')
    const { result, view } = this.state
    const quality = result?.quality ?? undefined
    if (!this.launched) return { quality }
    return {
      completed: result?.status === 'submitted',
      quality,
      practice: toPracticeResult(this.launched.activityId, result, { faulted: this.faulted, steps: view?.steps }),
    }
  }

  /** Leave the review (or abandon a run) and return to the launcher. */
  close(): void {
    this.session?.destroy()
    this.session = undefined
    this.state = { phase: 'idle', worked: this.state.worked }
    this.emit()
  }

  /** Evaluate an expression on the run (panels that show a computed value). */
  evaluate(expression: string): unknown {
    try {
      return this.session?.evaluate(expression)
    } catch {
      return null
    }
  }

  // ---- Internals ----

  private notice?: string

  private act(fn: () => boolean, persist = true): boolean {
    return this.guard(() => {
      if (!this.session || this.state.phase !== 'running') return false
      this.notice = undefined
      const ok = fn()
      this.refresh(this.notice)
      if (persist) this.persist()
      return ok
    })
  }

  private refresh(notice?: string): void {
    if (!this.session) return
    const view = this.session.view()
    this.state = {
      ...this.state,
      view,
      guidance: this.state.guidance && this.state.guidance.step?.id === view.current ? this.state.guidance : this.session.guidance(),
      ...(notice ? { notice } : { notice: undefined }),
      error: undefined,
    }
    this.emit()
  }

  private persist(): void {
    // One save slot, and it is the learner's: a run the host chose must not replace it.
    if (this.launched || !this.session || !this.host || !this.state.entry || !this.state.context) return
    const stored: Stored = { entryId: this.state.entry.id, context: this.state.context, save: this.session.save(), science: this.session.saveState() }
    void this.host.save(SAVE_KEY, JSON.stringify(stored)).catch(() => undefined)
  }

  private guard(fn: () => boolean): boolean {
    try {
      return fn()
    } catch (e) {
      console.error('Practical runtime error:', e)
      this.faulted = true
      this.set({ error: (e as Error).message ?? String(e) })
      return false
    }
  }

  private set(patch: Partial<PracticalState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const fn of this.subs) {
      try {
        fn()
      } catch (e) {
        console.error('Practical subscriber failed:', e)
      }
    }
  }
}
