// Inline worker entry for the lightmap baker.
import { runBake, type BakeJob } from './bake'

self.onmessage = (e: MessageEvent<BakeJob>) => {
  const result = runBake(e.data)
  const transfer: Transferable[] = [result.atlas.buffer]
  if (result.volume) transfer.push(result.volume.buffer)
  ;(self as unknown as Worker).postMessage(result, transfer)
}
