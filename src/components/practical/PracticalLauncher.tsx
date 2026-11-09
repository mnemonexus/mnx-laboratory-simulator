// The practical launcher: a searchable catalogue of the curated experiments (each variant its own
// practical), with the learning contexts each supports.
import { useEffect, useMemo, useState } from 'react'
import type { LearningContext } from '../../../packages/lab-core/src/index.ts'
import { CONTEXT_LABELS, LEVEL_LABELS, practicals, searchPracticals } from '../../runtime/content'
import { ThreeLabScene } from '../ThreeLabScene'
import { usePractical } from './usePractical'

export function PracticalLauncher() {
  const [state, rt] = usePractical()
  const entries = useMemo(() => practicals(), [])
  const [selected, setSelected] = useState(entries[0]?.id)
  const entry = entries.find((e) => e.id === selected) ?? entries[0]
  const [context, setContext] = useState<LearningContext | undefined>(entry?.contexts[0])

  useEffect(() => {
    void rt.findSaved()
  }, [rt])
  useEffect(() => {
    setContext(entry?.contexts[0])
  }, [entry?.id])

  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState<string | undefined>()
  const [level, setLevel] = useState<string | undefined>()
  const subjects = useMemo(() => [...new Set(entries.map((e) => e.discipline))], [entries])
  const levels = useMemo(() => {
    const order = [...new Set(Object.values(LEVEL_LABELS))]
    const rank = (l: string) => (order.indexOf(l) < 0 ? order.length : order.indexOf(l))
    return [...new Set(entries.map((e) => levelLabel(e.level)).filter((l): l is string => !!l))].sort((a, b) => rank(a) - rank(b))
  }, [entries])
  const found = useMemo(() => {
    const filtered = entries.filter((e) => (!subject || e.discipline === subject) && (!level || levelLabel(e.level) === level))
    return searchPracticals(filtered, query)
  }, [entries, query, subject, level])
  // The details follow the results: when the chosen practical is filtered out, show the first match.
  useEffect(() => {
    if (found.length && !found.some((e) => e.id === selected)) setSelected(found[0].id)
  }, [found, selected])
  // Without a query the catalogue reads by subject; with one, by relevance.
  const groups = useMemo(() => {
    if (query.trim()) return [['', found] as const]
    const m = new Map<string, typeof entries>()
    for (const e of found) m.set(e.discipline, [...(m.get(e.discipline) ?? []), e])
    return [...m.entries()]
  }, [found, query])

  return (
    <div className="relative w-full h-full overflow-hidden ui-page" data-testid="practical-launcher">
      <div className="absolute inset-0 z-0">
        <ThreeLabScene variant="home" showCameraUI={false} />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(90deg, var(--overlay-strong) 0%, var(--overlay) 55%, transparent 100%)' }} />
      </div>
      <div className="relative z-10 h-full overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 space-y-4">
            <div>
              <div className="ui-chip mb-3">Practicals</div>
              <h1 className="ui-title text-[34px] leading-tight">Run a practical</h1>
              <p className="mt-2 text-[13.5px] text-[var(--muted)] max-w-md leading-relaxed">
                Each practical is simulated from its chemistry and biology: what you do decides what you get.
              </p>
            </div>
            {state.saved && (
              <div className="ui-panel p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="ui-kicker">Saved run</div>
                  <div className="text-[13px] font-medium truncate">{state.saved.title}</div>
                </div>
                <button className="ui-btn-solid h-8 px-3" data-testid="practical-resume" onClick={() => void rt.resume()}>
                  Resume
                </button>
              </div>
            )}
            <div className="ui-panel p-3 space-y-2.5">
              <input
                type="search"
                className="ui-input w-full"
                data-testid="practical-search"
                placeholder="Search: titration, enzymes, flame test, GCSE…"
                aria-label="Search practicals"
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
              />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Subject">
                <FilterChip label="All subjects" on={!subject} onClick={() => setSubject(undefined)} />
                {subjects.map((d) => (
                  <FilterChip key={d} label={d} on={subject === d} onClick={() => setSubject(subject === d ? undefined : d)} />
                ))}
              </div>
              {levels.length > 1 && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Level">
                  <FilterChip label="All levels" on={!level} onClick={() => setLevel(undefined)} />
                  {levels.map((l) => (
                    <FilterChip key={l} label={l} on={level === l} onClick={() => setLevel(level === l ? undefined : l)} />
                  ))}
                </div>
              )}
              <div className="text-[11.5px] text-[var(--muted)] px-0.5" data-testid="practical-count">
                {found.length === entries.length ? `${entries.length} practicals` : `${found.length} of ${entries.length} practicals`}
              </div>
            </div>
            <div className="ui-panel p-2 space-y-3">
              {found.length === 0 && <div className="px-2 py-3 text-[13px] text-[var(--muted)]">No practical matches. Try fewer or different words.</div>}
              {groups.map(([discipline, list]) => (
                <div key={discipline || 'results'}>
                  {discipline && <div className="ui-kicker px-2 pt-1 pb-1">{discipline}</div>}
                  {list.map((e) => (
                    <button
                      key={e.id}
                      data-testid={`practical-${e.id}`}
                      onClick={() => setSelected(e.id)}
                      className={`w-full text-left px-2 py-2 rounded-md transition-colors ${e.id === entry?.id ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-2)]'}`}
                    >
                      <div className="text-[13px] font-medium text-[var(--ink)]">{e.title}</div>
                      {(!discipline || e.level) && (
                        <div className="text-[11px] text-[var(--muted)] mt-0.5">{[!discipline ? e.discipline : '', levelLabel(e.level)].filter(Boolean).join(' · ')}</div>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {entry && (
            <div className="lg:col-span-7">
              <div className="ui-panel p-5 space-y-4">
                <div>
                  <div className="ui-kicker">{[entry.discipline, levelLabel(entry.level)].filter(Boolean).join(' · ')}</div>
                  <h2 className="text-[20px] font-semibold mt-1">{entry.title}</h2>
                  {(entry.curricula.length > 0 || entry.topics.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {[...entry.topics, ...entry.curricula].map((t) => (
                        <span key={t} className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--line)] text-[var(--muted)]">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {entry.summary && <p className="text-[13.5px] leading-relaxed">{entry.summary}</p>}
                {entry.briefing && entry.briefing !== entry.summary && <p className="text-[13px] text-[var(--muted)] leading-relaxed">{entry.briefing}</p>}
                <div>
                  <div className="ui-kicker mb-2">How</div>
                  <div className="flex flex-wrap gap-2">
                    {entry.contexts.map((c) => (
                      <button
                        key={c}
                        data-testid={`practical-context-${c}`}
                        onClick={() => setContext(c)}
                        className={c === context ? 'ui-btn border-[var(--ink)]' : 'ui-btn'}
                      >
                        {CONTEXT_LABELS[c]}
                      </button>
                    ))}
                  </div>
                </div>
                {state.error && <div className="text-[12.5px] text-[var(--danger)]">{state.error}</div>}
                <button className="ui-btn-solid h-10 px-5 text-[13px]" data-testid={`practical-start-${entry.id}`} onClick={() => rt.start(entry.id, context)}>
                  Start
                  <span className="opacity-75">→</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function levelLabel(level: string | undefined): string | undefined {
  return level ? (LEVEL_LABELS[level] ?? level) : undefined
}

function FilterChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`text-[11.5px] px-2.5 py-1 rounded-full border transition-colors ${on ? 'border-[var(--ink)] text-[var(--ink)] bg-[var(--bg-2)]' : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]'}`}
    >
      {label}
    </button>
  )
}
