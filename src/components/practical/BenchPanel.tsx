// The bench: what is on it, and a form for any operation the lab can perform, built from the
// operation's declared parameters (so a new operation needs no UI code). The kernel is the only
// judge of whether an action is possible; a refusal is shown under the form, not as a pop-up.
import { useEffect, useMemo, useState } from 'react'
import type { ContainerView, OperationDecl, ParamSpec, SessionView } from '../../../packages/lab-core/src/index.ts'
import { colourHex, nameOf } from '../../runtime/present'
import { usePractical } from './usePractical'

/** Operations offered first; the rest follow alphabetically. */
const COMMON = ['core:transfer', 'core:mix', 'core:place-in', 'core:remove-from', 'core:measure', 'core:advance-time', 'core:weigh', 'core:tare', 'core:centrifuge', 'core:fetch']

const EXAMPLE: Record<string, string> = {
  volume: '50 uL',
  mass: '0.5 g',
  time: '5 min',
  temperature: '37 Cel',
  length: '562 nm',
  dimensionless: '12000 [RCF]',
}

export function BenchPanel({ view, selection }: { view: SessionView; selection?: string }) {
  const [, rt] = usePractical()
  const ops = useMemo(() => {
    const all = rt.operations().filter((o) => o.id !== 'core:record')
    return [...all].sort((a, b) => {
      const ia = COMMON.indexOf(a.id)
      const ib = COMMON.indexOf(b.id)
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
      return a.label.localeCompare(b.label)
    })
  }, [rt, view.title])
  const [opId, setOpId] = useState('core:transfer')
  const op = ops.find((o) => o.id === opId) ?? ops[0]
  const [values, setValues] = useState<Record<string, string>>({})
  const [freshTip, setFreshTip] = useState(true)
  const tool = view.equipment.find((e) => e.id === values.tool)
  const takesTips = op?.id === 'core:transfer' && tool?.needsTip === true

  // A container chosen in the list or in 3D fills the first empty container field.
  useEffect(() => {
    if (!selection || !op) return
    const fields = Object.entries(op.params).filter(([, s]) => s.type === 'container')
    const empty = fields.find(([k]) => !values[k])
    if (empty) setValues((v) => ({ ...v, [empty[0]]: selection }))
  }, [selection])

  const submit = () => {
    if (!op) return
    const params: Record<string, unknown> = {}
    for (const [k, spec] of Object.entries(op.params)) {
      const raw = values[k]
      if (raw === undefined || raw === '') continue
      params[k] = parse(raw, spec)
    }
    // A fresh tip is the learner's choice, made with the real operations (they count).
    if (takesTips && tool && freshTip) {
      if (tool.tip !== 'none') rt.perform('core:eject-tip', { pipette: tool.id })
      rt.perform('core:attach-tip', { pipette: tool.id })
    }
    rt.perform(op.id, params)
  }

  const supplies = view.containers.filter((c) => c.kind !== 'well')
  const plates = view.containers.filter((c) => c.kind === 'plate' && (c.wells?.length ?? 0) > 1)
  return (
    <div className="ui-panel p-3 flex flex-col gap-3 min-h-0" data-testid="bench-panel">
      <div className="ui-kicker">On the bench</div>
      <ul className="space-y-0.5 overflow-y-auto min-h-0 max-h-[28vh] pr-1">
        {supplies.map((c) => (
          <li key={c.id}>
            <button
              className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded-md transition-colors ${selection === c.id ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-2)]'}`}
              onClick={() => setValues((v) => fillFirst(op, v, c.id))}
              data-testid={`container-${c.id}`}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-[var(--line-strong)]" style={{ background: c.kind === 'plate' ? 'transparent' : colourHex(c.colour || 'colourless') }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-[var(--ink)] truncate">{nameOf(c)}</span>
                <span className="block text-[10.5px] text-[var(--faint)] font-mono-ui">{describe(c, view)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {plates.map((p) => (
        <PlateMap key={p.id} plate={p} view={view} selection={selection} onPick={(id) => setValues((v) => fillFirst(op, v, id))} />
      ))}

      <div className="border-t border-[var(--line)] pt-3 space-y-2">
        <select className="ui-select w-full h-8 !py-0" data-testid="op-select" value={op?.id} onChange={(e) => { setOpId(e.target.value); setValues({}) }}>
          {ops.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {op && <p className="text-[11px] text-[var(--faint)] leading-snug line-clamp-3">{op.description}</p>}
        {op &&
          Object.entries(op.params).map(([k, spec]) => (
            <Field key={`${op.id}:${k}`} name={k} spec={spec} value={values[k] ?? ''} view={view} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
          ))}
        {takesTips && tool && (
          <label className="flex items-center gap-2 text-[11.5px] text-[var(--muted)]">
            <input type="checkbox" checked={freshTip} onChange={(e) => setFreshTip(e.target.checked)} data-testid="fresh-tip" />
            New tip first <span className="text-[var(--faint)]">(now: {tool.tip === 'none' ? 'no tip' : tool.tip === 'fresh' ? 'fresh tip' : 'used tip'})</span>
          </label>
        )}
        <button className="ui-btn-solid h-8 w-full" data-testid="op-submit" onClick={submit}>
          {op?.label ?? 'Do it'}
        </button>
        {view.lastRefusal && (
          <p className="text-[11.5px] text-[var(--warn)] leading-snug" data-testid="op-refusal">
            {view.lastRefusal.message}
          </p>
        )}
      </div>
    </div>
  )
}

/** A plate's wells, coloured by what is in them; a well fills the first empty container field. */
function PlateMap({ plate, view, selection, onPick }: { plate: ContainerView; view: SessionView; selection?: string; onPick: (id: string) => void }) {
  const wells = (plate.wells ?? []).map((id) => view.containers.find((c) => c.id === id))
  const cols = Math.max(1, Number(wells[wells.length - 1]?.position?.slice(1) ?? 12))
  return (
    <div data-testid={`plate-map-${plate.id}`}>
      <div className="text-[10.5px] text-[var(--muted)] mb-1">{plate.label}</div>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {wells.map((w) =>
          w ? (
            <button
              key={w.id}
              title={`${w.position}: ${w.volumeMl > 0 ? `${(w.volumeMl * 1000).toFixed(0)} µL` : 'empty'}`}
              onClick={() => onPick(w.id)}
              data-testid={`well-${w.id}`}
              className={`aspect-square rounded-full border ${selection === w.id ? 'border-[var(--ink)]' : 'border-[var(--line-strong)]'}`}
              style={{ background: w.volumeMl > 0 ? colourHex(w.colour || 'colourless') : 'transparent' }}
            />
          ) : null,
        )}
      </div>
    </div>
  )
}

function fillFirst(op: OperationDecl | undefined, v: Record<string, string>, id: string): Record<string, string> {
  if (!op) return v
  const empty = Object.entries(op.params).find(([k, s]) => s.type === 'container' && !v[k])
  return empty ? { ...v, [empty[0]]: id } : v
}

function describe(c: ContainerView, view: SessionView): string {
  if (c.kind === 'plate') {
    const used = view.containers.filter((w) => w.plate === c.id && w.volumeMl > 0).length
    return `${c.wells?.length ?? 0} wells, ${used} in use`
  }
  const v = c.volumeMl
  const vol = v <= 0 ? 'empty' : v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 2 : 1)} µL` : `${v.toFixed(v < 10 ? 2 : 1)} mL`
  const place = view.places.find((p) => p.id === c.place)?.label ?? view.equipment.find((e) => e.id === c.place)?.label ?? c.place
  const bits = [vol, `${c.temperatureC.toFixed(0)} °C`, place]
  if (c.layers > 1) bits.push('not mixed')
  if (c.solid) bits.push('solid')
  if (!c.open) bits.push('closed')
  return bits.join(' · ')
}

function Field({ name, spec, value, view, onChange }: { name: string; spec: ParamSpec; value: string; view: SessionView; onChange: (v: string) => void }) {
  const label = (
    <span className="block text-[10.5px] text-[var(--muted)] mb-0.5">
      {name}
      {spec.required ? ' *' : ''}
    </span>
  )
  const pick = (options: Array<{ id: string; label: string }>, group?: (id: string) => string | undefined) => (
    <label className="block">
      {label}
      <select className="ui-select w-full h-8 !py-0 text-[12px]" value={value} onChange={(e) => onChange(e.target.value)} data-testid={`param-${name}`}>
        <option value="">{spec.required ? 'Choose…' : '(none)'}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {group?.(o.id) ? `${group(o.id)} › ` : ''}
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
  if (spec.type === 'container') {
    const items = view.containers.filter((c) => c.kind !== 'plate').map((c) => ({ id: c.id, label: c.kind === 'well' ? `${c.position}` : nameOf(c) }))
    return pick(items, (id) => view.containers.find((c) => c.id === id && c.kind === 'well')?.plate)
  }
  if (spec.type === 'equipment') return pick(view.equipment.map((e) => ({ id: e.id, label: e.label })))
  if (spec.type === 'place') {
    return pick([...view.places.map((p) => ({ id: p.id, label: `${p.label} (${p.temperatureC.toFixed(0)} °C)` })), ...view.equipment.filter((e) => e.kind === 'instrument').map((e) => ({ id: e.id, label: e.label }))])
  }
  if (spec.type === 'enum') return pick((spec.values ?? []).map((v) => ({ id: v, label: v })))
  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : '')} data-testid={`param-${name}`} />
        {name}
      </label>
    )
  }
  const placeholder = spec.type === 'quantity' ? (EXAMPLE[spec.dimension ?? ''] ?? '') : spec.type === 'list' ? 'a, b, c' : spec.default !== undefined ? String(spec.default) : ''
  return (
    <label className="block">
      {label}
      <input className="ui-input w-full h-8 !py-0 text-[12px]" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} data-testid={`param-${name}`} />
    </label>
  )
}

function parse(raw: string, spec: ParamSpec): unknown {
  if (spec.type === 'number' || spec.type === 'integer') return Number(raw)
  if (spec.type === 'boolean') return raw === 'true'
  if (spec.type === 'list') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (spec.type === 'record' || spec.type === 'any') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}
