// Web Worker entry for the simulation core (non-singlefile hosts).
// Usage (host with worker-chunk support):
//   const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
//   ...post WorkerRequest, receive WorkerResponse...
// The single-file build uses createLocalEngine() instead (identical protocol).
import { makeLab, readPlate, runKinetics, transfer } from './engine'
import { gradeExperience } from './grading'
import type { WorkerRequest, WorkerResponse } from './port'

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  try {
    let payload: unknown = null
    switch (req.op) {
      case 'newSession':
        payload = makeLab(req.def.plateLabel, req.def.reagents)
        break
      case 'transfer':
        payload = transfer(req.state, req.req)
        break
      case 'readPlate':
        payload = readPlate(req.state, req.settings, req.wlLabel)
        break
      case 'runKinetics':
        payload = runKinetics(req.state, req.settings, req.vmax, req.km)
        break
      case 'grade':
        payload = gradeExperience(req.def, req.state, req.answers)
        break
    }
    const res: WorkerResponse = { id: req.id, ok: true, payload }
    self.postMessage(res)
  } catch (err) {
    const res: WorkerResponse = { id: (req as { id: number }).id, ok: false, error: String(err) }
    self.postMessage(res)
  }
}

export {}
