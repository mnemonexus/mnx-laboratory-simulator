import { useEffect, useRef, useState } from 'react'
import { useGraphics } from '../graphics'
import { TIERS, type GraphicsSettings, type Tier } from '../three/quality'

const TIER_LABEL: Record<Tier, string> = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' }

type Choice<T> = { value: T; label: string }

function Row<T extends string | number | boolean>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11.5px] text-[var(--muted)]">{label}</span>
      <div className="flex gap-0.5 rounded-md border border-[var(--line)] bg-[var(--bg-2)] p-0.5">
        {choices.map((c) => (
          <button
            key={String(c.value)}
            onClick={() => onChange(c.value)}
            className={`px-1.5 py-0.5 rounded text-[10.5px] ${
              c.value === value ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const tierChoices: Choice<Tier>[] = TIERS.map((t) => ({ value: t, label: TIER_LABEL[t] }))

export function GraphicsMenu() {
  const g = useGraphics()
  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const s = g.settings
  const set = <K extends keyof GraphicsSettings>(k: K) => (v: GraphicsSettings[K]) => g.setOption(k, v)

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`ui-btn h-7 w-7 !p-0 ${open ? 'border-[var(--ink)]' : ''}`}
        title="Graphics settings"
        aria-label="Graphics settings"
        aria-expanded={open}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.559.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.398.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.272-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {open && (
        <div className="ui-panel-solid rise-in absolute right-0 top-9 z-[60] w-[300px] p-3 text-[var(--ink)] shadow-2xl">
          <div className="flex items-baseline justify-between">
            <div className="ui-kicker">Graphics</div>
            <div className="text-[10px] text-[var(--faint)] truncate max-w-[170px]" title={g.gpu}>
              {g.gpu || 'GPU unknown'}
            </div>
          </div>

          <div className="mt-2 grid grid-cols-5 gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--bg-2)] p-0.5">
            {(['auto', ...TIERS] as const).map((p) => (
              <button
                key={p}
                data-preset={p}
                aria-pressed={g.preset === p}
                onClick={() => g.setPreset(p)}
                className={`py-1 rounded-md text-[11px] font-medium ${
                  g.preset === p ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
              >
                {p === 'auto' ? 'Auto' : TIER_LABEL[p]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] text-[var(--faint)] leading-snug">
            {g.preset === 'auto'
              ? `Auto picked ${TIER_LABEL[g.autoTier]} for this device and lowers it if frames run slow.`
              : g.preset === 'custom'
                ? `Custom, based on ${TIER_LABEL[g.base]}.`
                : g.preset === 'ultra'
                  ? 'Ultra is meant for dedicated graphics cards.'
                  : `${TIER_LABEL[g.base]} preset.`}
          </p>

          <button
            onClick={() => setAdvanced((a) => !a)}
            className="mt-2 w-full flex items-center justify-between text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
          >
            <span>Advanced</span>
            <span>{advanced ? '−' : '+'}</span>
          </button>

          {advanced && (
            <div className="mt-1 divide-y divide-[var(--line)]">
              <div className="py-1.5">
                <div className="flex items-center justify-between text-[11.5px] text-[var(--muted)]">
                  <span>Render scale</span>
                  <span className="font-mono-ui text-[var(--ink)]">{Math.round(s.renderScale * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={100}
                  step={5}
                  value={Math.round(s.renderScale * 100)}
                  onChange={(e) => g.setOption('renderScale', Number(e.target.value) / 100)}
                  className="w-full"
                />
              </div>
              <Row
                label="Anti-aliasing"
                value={s.antialias}
                onChange={set('antialias')}
                choices={[
                  { value: 'off', label: 'Off' },
                  { value: 'smaa', label: 'SMAA' },
                  { value: 'msaa4', label: '4×' },
                ]}
              />
              <Row
                label="Refine when still"
                value={s.refine}
                onChange={set('refine')}
                choices={[
                  { value: false, label: 'Off' },
                  { value: true, label: 'On' },
                ]}
              />
              <Row
                label="Ambient occlusion"
                value={s.ao}
                onChange={set('ao')}
                choices={[
                  { value: 'off', label: 'Off' },
                  { value: 'half', label: 'Half' },
                  { value: 'full', label: 'Full' },
                ]}
              />
              <Row
                label="Reflections"
                value={s.ssr}
                onChange={set('ssr')}
                choices={[
                  { value: 'off', label: 'Probe' },
                  { value: 'half', label: 'Half' },
                  { value: 'full', label: 'Full' },
                ]}
              />
              <Row
                label="Bloom"
                value={s.bloom}
                onChange={set('bloom')}
                choices={[
                  { value: false, label: 'Off' },
                  { value: true, label: 'On' },
                ]}
              />
              <Row
                label="Dynamic shadows"
                value={s.shadows}
                onChange={set('shadows')}
                choices={[
                  { value: 'off', label: 'Off' },
                  { value: 'medium', label: 'Med' },
                  { value: 'high', label: 'High' },
                ]}
              />
              <Row label="Lighting" value={s.lighting} onChange={set('lighting')} choices={tierChoices} />
              <Row label="Textures" value={s.textures} onChange={set('textures')} choices={tierChoices} />
              <Row
                label="Prop detail"
                value={s.detail}
                onChange={set('detail')}
                choices={[
                  { value: 'reduced', label: 'Reduced' },
                  { value: 'full', label: 'Full' },
                ]}
              />
              <Row
                label="Frame cap"
                value={s.fpsCap}
                onChange={set('fpsCap')}
                choices={[
                  { value: 30, label: '30' },
                  { value: 60, label: '60' },
                  { value: 0, label: 'Max' },
                ]}
              />
              <Row
                label="Performance overlay"
                value={g.showStats}
                onChange={g.setShowStats}
                choices={[
                  { value: false, label: 'Off' },
                  { value: true, label: 'On' },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
