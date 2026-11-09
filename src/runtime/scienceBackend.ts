// One authoritative LabSession behind a versioned boundary. Renderers never own science.
import { LabSession, WORLD_SCHEMA, type Catalogue, type RunStatus, type SessionOptions, type SessionSave } from '../../packages/lab-core/src/index.ts'
import { scientificNumerics } from '../../packages/lab-core/src/models/numerics.ts'

export const SCIENCE_API = 'lab-science/1'
export type ScienceCommand =
  | { kind: 'perform'; op: string; params: Record<string, unknown>; step?: string }
  | { kind: 'decide'; step: string; choice: string; item?: string }
  | { kind: 'note'; field: string; value: unknown }

export interface ScienceSave {
  format: typeof SCIENCE_API
  worldSchema: typeof WORLD_SCHEMA
  session: SessionSave
  numerics?: 'lab-numerics/1'
}

/** Synchronous local adapter. Future worker/Wasm kernels sit below this coordinator. */
export class ScienceBackend {
  readonly api = SCIENCE_API
  get kind() { return scientificNumerics()?.implementation ?? 'typescript-reference' }
  private revision = 0
  private destroyed = false
  private readonly session: LabSession
  private constructor(session: LabSession) { this.session = session }

  static start(input: unknown, cat: Catalogue, options: SessionOptions = {}) {
    const result = LabSession.start(input, cat, options)
    return result.ok ? { ...result, session: new ScienceBackend(result.session) } : result
  }
  static restore(save: SessionSave, input: unknown, cat: Catalogue) {
    const definition = input as { id?: string; version?: string } | null
    if (!save || save.format !== 'lab-session' || !definition || save.definition?.id !== definition.id || save.definition?.version !== definition.version) {
      return { ok: false as const, message: 'The scientific save belongs to a different experiment version' }
    }
    const result = LabSession.restore(save, input, cat)
    return result.ok ? { ...result, session: new ScienceBackend(result.session) } : result
  }
  static loadState(save: ScienceSave, input: unknown, cat: Catalogue) {
    if (save.format !== SCIENCE_API || save.worldSchema !== WORLD_SCHEMA || (save.numerics && save.numerics !== 'lab-numerics/1')) return { ok: false as const, message: 'Unsupported scientific save version' }
    return ScienceBackend.restore(save.session, input, cat)
  }
  private read<T>(fn: (session: LabSession) => T): T {
    if (this.destroyed) throw new Error('Scientific session was destroyed')
    return fn(this.session)
  }
  private change<T>(fn: (session: LabSession) => T): T {
    return this.read(session => { const result = fn(session); this.revision++; return result })
  }
  /** Commands execute in order; each retains the kernel's existing transaction/refusal semantics. */
  submit(commands: readonly ScienceCommand[]) {
    return commands.map(command => {
      switch (command.kind) {
        case 'perform': return this.perform(command.op, command.params, command.step)
        case 'decide': return this.decide(command.step, command.choice, command.item)
        case 'note': return this.note(command.field, command.value)
      }
    })
  }
  snapshot(afterRevision = -1) {
    return this.read(() => afterRevision === this.revision ? null : { revision: this.revision, view: this.view() })
  }
  saveState(): ScienceSave { return { format: SCIENCE_API, worldSchema: WORLD_SCHEMA, numerics: 'lab-numerics/1', session: this.save() } }
  save() { return this.read(s => s.save()) }
  view() { return this.read(s => s.view()) }
  operations() { return this.read(s => s.operations()) }
  check(op: string, params: Record<string, unknown>) { return this.read(s => s.check(op, params)) }
  evaluate(expression: string) { return this.read(s => s.evaluate(expression)) }
  guidance(asked = false) { return this.read(s => s.guidance(asked)) }
  perform(op: string, params: Record<string, unknown>, step?: string) { return this.change(s => s.perform(op, params, step)) }
  decide(step: string, choice: string, item?: string) { return this.change(s => s.decide(step, choice, item)) }
  note(field: string, value: unknown) { return this.change(s => s.note(field, value)) }
  completeStep(step?: string) { return this.change(s => s.completeStep(step)) }
  goTo(step: string) { return this.change(s => s.goTo(step)) }
  hint() { return this.change(s => s.hint()) }
  demonstrate() { return this.change(s => s.demonstrate()) }
  rewind() { return this.change(s => s.rewind()) }
  finish(status?: RunStatus) { return this.change(s => s.finish(status)) }
  destroy() { this.destroyed = true }
}
