// Clean host-integration interface so the workbench can embed in a larger app
// (e.g. MnemoNexus scheduler, LMS, assessment harness).
// The React overlay talks to the sim ONLY through this port; the 3D renderer
// talks to NOBODY except via VisualState pushed to it.

export type WorkbenchEvent =
  | { type: 'experience-started'; id: string }
  | { type: 'transfer'; source: string; dest: string; vol: number; ok: boolean }
  | { type: 'plate-read'; wells: number; raw: boolean }
  | { type: 'kinetics-run'; traces: number }
  | { type: 'graded'; score: number; validity: string }
  | { type: 'camera'; preset: string }
  | { type: 'pick'; kind: string; id: string }

export interface WorkbenchSnapshot {
  experienceId: string
  clock: number
  waste: number
  measurements: number
  notes: number
  log: string[]
}

export interface WorkbenchHost {
  emit(ev: WorkbenchEvent): void
  subscribe(cb: (ev: WorkbenchEvent) => void): () => void
  setSnapshotProvider(fn: () => WorkbenchSnapshot | null): void
  getSnapshot(): WorkbenchSnapshot | null
  engineKind: 'local' | 'worker'
}

export function createHost(engineKind: 'local' | 'worker' = 'local'): WorkbenchHost {
  const subs = new Set<(ev: WorkbenchEvent) => void>()
  let provider: (() => WorkbenchSnapshot | null) | null = null
  const host: WorkbenchHost = {
    engineKind,
    emit(ev) {
      subs.forEach((cb) => {
        try {
          cb(ev)
        } catch {
          /* host listeners must never break the lab */
        }
      })
    },
    subscribe(cb) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    setSnapshotProvider(fn) {
      provider = fn
    },
    getSnapshot() {
      return provider ? provider() : null
    },
  }
  try {
    ;(window as unknown as { __bioworkbench?: WorkbenchHost }).__bioworkbench = host
  } catch {
    /* non-browser */
  }
  return host
}
