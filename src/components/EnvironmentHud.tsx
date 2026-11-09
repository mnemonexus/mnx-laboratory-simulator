import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useSceneRect } from './LabMap'
import { useLabHost } from '../host/context'
import type { EnvironmentNotice } from '../runtime/environment'
import type { InteractionPrompt } from '../three/lab/interactions'
import type { LabWorld, LookMode } from '../three/lab/world'

let lastLookMode: LookMode = 'drag'

export function EnvironmentHud({ world, prompt, notice, active, clearNotice, containerRef, settingsOpen }: {
  world: LabWorld; prompt: InteractionPrompt | null; notice: EnvironmentNotice | null; active: boolean; clearNotice: () => void
  containerRef: RefObject<HTMLElement | null>; settingsOpen: boolean
}) {
  const host = useLabHost()
  const rect = useSceneRect(containerRef)
  const [look, setLook] = useState(lastLookMode)
  const changed = useRef(false)
  useEffect(() => {
    let cancelled = false
    world.setLookMode(lastLookMode)
    void host.load('camera-look-mode').then(raw => {
      if (cancelled || changed.current || (raw !== 'drag' && raw !== 'follow')) return
      lastLookMode = raw; setLook(raw); world.setLookMode(raw)
    })
    return () => { cancelled = true }
  }, [host, world])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(clearNotice, 10000)
    return () => clearTimeout(timer)
  }, [notice, clearNotice])

  if (!rect) return null
  const lookControl = <>
      <label htmlFor="camera-look-mode">Look</label>
      <select id="camera-look-mode" data-testid="camera-look-mode" value={look} onChange={e => {
        const value = e.target.value as LookMode
        changed.current = true; lastLookMode = value; setLook(value); world.setLookMode(value)
        void host.save('camera-look-mode', value)
      }}>
        <option value="drag">Hold & drag</option>
        <option value="follow">Mouse movement</option>
      </select>
      {look === 'follow' && <span>{active ? 'Tab: cursor · Esc: settings' : 'Return to scene to look'}</span>}
  </>
  return createPortal(<div className="environment-hud" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
    {look === 'follow' && active && <div className="environment-look-capture" data-lab-mouse-capture="true" aria-hidden="true" />}
    {!settingsOpen && <div className="environment-look ui-panel">{lookControl}</div>}
    {settingsOpen && <div className="environment-settings ui-panel" role="dialog" aria-modal="false" aria-label="Lab settings" data-testid="lab-settings">
      <div className="environment-target">Lab settings</div>
      <div className="environment-settings-look">{lookControl}</div>
      <p>WASD to move. Hold the right mouse button to look closer. Hold Tab to use the cursor. Release Tab over a menu to keep using it, then return to the scene to look around.</p>
      <button className="ui-btn-solid" data-testid="resume-lab" onClick={() => world.closeSettings()}>Resume laboratory</button>
    </div>}
    {look === 'follow' && active && <span className="environment-reticle" aria-hidden="true">·</span>}
    {prompt && !settingsOpen && <div className="environment-prompt ui-panel" data-testid="environment-prompt">
      <div className="environment-target">{prompt.label}</div>
      {prompt.detail && <div className="environment-detail">{prompt.detail}</div>}
      <button className="ui-btn" data-testid="environment-interact" onPointerDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={() => world.interact()}>
        <kbd>E</kbd> {prompt.action}
      </button>
    </div>}
    {notice && <div className="environment-notice ui-panel" data-testid="environment-notice" role="status" aria-live="polite" data-tone={notice.tone}>
      <div className="environment-target">{notice.title}</div>
      <div>{notice.message}</div>
      <button aria-label="Dismiss message" onClick={clearNotice}>×</button>
    </div>}
  </div>, document.body)
}
