// Entry point, as a MnemoNexus add-on (`npm run addon:pack`) and for local
// development (`npm run dev`, where dev/mockHost.ts stands in for the app).
// MnemoNexus loads this bundle as one classic script in a sandboxed frame,
// after defining `window.mnx`; the lab mounts into `mnx.root`.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { connectHost } from './host/mnx'
import { HostProvider } from './host/context'
import { ThemeProvider } from './theme'
import { GraphicsProvider, restoreGraphics } from './graphics'
import { initialiseRustScience } from './runtime/rustScience'
import { loadContent } from './runtime/content'
import { PracticalRuntime } from './runtime/practical'
import { DEV } from './env'

async function start() {
  const host = connectHost()
  const science = await initialiseRustScience()
  if (DEV) (globalThis as { __labScience?: unknown }).__labScience = science
  // Storage is async, so saved choices are read before the first render.
  const graphics = await restoreGraphics(host)
  const content = await loadContent(host.asset)
  // One practical runtime for the whole session: it outlives navigation between views.
  const practical = new PracticalRuntime(host)
  // A practical the host chose opens here, so the first render is the run itself.
  if (host.practice && !practical.launch(host.practice, host.surface)) {
    throw new Error(content.state === 'failed' ? content.message : (practical.getSnapshot().error ?? 'This practical could not start.'))
  }
  createRoot(host.root).render(
    <StrictMode>
      <HostProvider host={host}>
        <ThemeProvider>
          <GraphicsProvider initial={graphics}>
            <ErrorBoundary onEnd={practical.launched ? () => host.finish(practical.outcome()) : undefined}>
              <App practical={practical} />
            </ErrorBoundary>
          </GraphicsProvider>
        </ThemeProvider>
      </HostProvider>
    </StrictMode>,
  )
}

// Left unhandled on purpose: if the lab cannot start (say, a launch surface it
// does not support), MnemoNexus should fail the run and show why.
void start()
