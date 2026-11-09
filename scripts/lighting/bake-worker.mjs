// One offline bake worker: runs the same baker as the add-on's runtime fallback.
import { parentPort } from 'node:worker_threads'
import { runBake } from '../../src/three/lab/bake.ts'

parentPort.on('message', (job) => {
  job.boxes = new Float32Array(job.boxes)
  job.planes = new Float32Array(job.planes)
  if (job.quads) job.quads = new Float32Array(job.quads)
  if (job.boxAlbedo) job.boxAlbedo = new Float32Array(job.boxAlbedo)
  const result = runBake(job)
  const transfer = [result.atlas.buffer]
  if (result.volume) transfer.push(result.volume.buffer)
  parentPort.postMessage(result, transfer)
})
