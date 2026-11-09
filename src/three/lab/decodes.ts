// Image decodes that finish after the synchronous build. The loading screen waits
// for them, so a texture never changes size (and re-uploads) once the lab is live.
const pending = new Set<Promise<void>>()

/** Track an image decode; failures still settle (the texture keeps its placeholder). */
export function trackDecode(image: HTMLImageElement) {
  const done = new Promise<void>((resolve) => {
    const finish = () => {
      // onload handlers that copy the image run before this listener resolves
      queueMicrotask(resolve)
    }
    image.addEventListener('load', finish, { once: true })
    image.addEventListener('error', finish, { once: true })
  })
  pending.add(done)
  void done.then(() => pending.delete(done))
}

/** Resolves once every decode tracked so far has settled. */
export async function decodesSettled() {
  while (pending.size) await Promise.all([...pending])
}
