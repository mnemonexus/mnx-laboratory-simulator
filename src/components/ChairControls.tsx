import { useEffect, useId, useRef, useState } from 'react'
import type { SeatControl } from './ThreeLabScene'

/** One contextual chair action with the less frequent movement controls disclosed. */
export function ChairControls({ control }: { control: SeatControl }) {
  const [open, setOpen] = useState(false)
  const [moves, setMoves] = useState({ in: false, out: false })
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', escape)
    }
  }, [open])
  useEffect(() => setOpen(false), [control.action])
  const label = control.action === 'stand' ? 'Stand up' : control.action === 'pull' ? 'Pull out' : 'Sit down'
  const move = (direction: 'in' | 'out') => {
    control.move(direction)
    setOpen(false)
  }
  return (
    <div ref={root} className="relative flex items-center" onBlur={e => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
    }}>
      <button
        data-testid="seat-toggle"
        onClick={control.activate}
        className="px-2 py-1.5 rounded-lg font-medium text-[var(--ink)] hover:bg-[var(--line)] whitespace-nowrap"
        title={control.action === 'stand' ? 'Stand up (E or Space)' : `${label} (E)`}
      >
        {label}<span className="ml-1.5 text-[var(--muted)]">E</span>
      </button>
      <button
        ref={trigger}
        data-testid="chair-actions"
        aria-label="Move chair"
        title="Move chair"
        aria-expanded={open}
        aria-controls={id}
        className="px-1.5 py-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--line)]"
        onClick={() => {
          setMoves(control.moves())
          setOpen(!open)
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 7 3-3 3 3" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && (
        <div id={id} className="absolute bottom-full right-0 mb-2 z-50 ui-panel p-1 min-w-32 text-[11px] text-[var(--ink)]">
          {moves.in && <button data-testid="chair-push-in" className="block w-full text-left px-3 py-2 hover:bg-[var(--line)]" onClick={() => move('in')}>Tuck in</button>}
          {moves.out && <button data-testid="chair-pull-out" className="block w-full text-left px-3 py-2 hover:bg-[var(--line)]" onClick={() => move('out')}>Pull out</button>}
          {!moves.in && !moves.out && <span className="block px-3 py-2 text-[var(--muted)]">No room to move</span>}
        </div>
      )}
    </div>
  )
}
