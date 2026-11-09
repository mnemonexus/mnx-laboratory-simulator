// Sim port: async message-style API over the pure engine.
// ─────────────────────────────────────────────────────────────────
// Target architecture: heavy simulation runs in a Web Worker for
// determinism + performance (see worker.ts). The single-file production
// build inlines everything into one HTML file, where separate worker
// chunks cannot be emitted — so this build uses LocalEngine, which
// exposes the IDENTICAL async protocol on the main thread (yielding
// between ops). Swap `createLocalEngine()` for `createWorkerEngine()`
// in any non-singlefile host to move sim off-thread with zero UI changes.
import type { Answers, GradeResult, LabState, ReaderSettings } from './model'
import { makeLab, readPlate, runKinetics, transfer, type EngineMsg, type TransferOpts } from './engine'
import { gradeExperience } from './grading'
import type { ExperienceDef } from '../content/catalog'

export interface TransferRequest extends TransferOpts {
  wlLabel?: string
}

export interface SimEngine {
  readonly kind: 'local' | 'worker'
  newSession(def: ExperienceDef): Promise<LabState>
  transfer(state: LabState, req: TransferRequest): Promise<{ next: LabState; messages: EngineMsg[]; ok: boolean }>
  readPlate(state: LabState, settings: ReaderSettings, wlLabel: string): Promise<{ next: LabState; values: Record<string, number>; saturated: number }>
  runKinetics(state: LabState, settings: ReaderSettings, vmax: number, km: number): Promise<{ next: LabState; key: string; wells: string[] }>
  grade(def: ExperienceDef, state: LabState, answers: Answers): Promise<GradeResult>
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export function createLocalEngine(): SimEngine {
  return {
    kind: 'local',
    async newSession(def) {
      await tick()
      return makeLab(def.plateLabel, def.reagents)
    },
    async transfer(state, req) {
      await tick()
      return transfer(state, req)
    },
    async readPlate(state, settings, wlLabel) {
      await tick()
      return readPlate(state, settings, wlLabel)
    },
    async runKinetics(state, settings, vmax, km) {
      await tick()
      return runKinetics(state, settings, vmax, km)
    },
    async grade(def, state, answers) {
      await tick()
      return gradeExperience(def, state, answers)
    },
  }
}

// ─── Worker protocol (for non-singlefile hosts) ────────────────────────────
export type WorkerRequest =
  | { id: number; op: 'newSession'; def: ExperienceDef }
  | { id: number; op: 'transfer'; state: LabState; req: TransferRequest }
  | { id: number; op: 'readPlate'; state: LabState; settings: ReaderSettings; wlLabel: string }
  | { id: number; op: 'runKinetics'; state: LabState; settings: ReaderSettings; vmax: number; km: number }
  | { id: number; op: 'grade'; def: ExperienceDef; state: LabState; answers: Answers }

export type WorkerResponse = { id: number; ok: boolean; payload?: unknown; error?: string }
