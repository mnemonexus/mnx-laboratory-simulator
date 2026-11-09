// Coverage across many definitions: aggregable gap reports and the unlock analysis
// (degradation and coverage §6–§8; manifest spec §4). Gaps name the missing capability, not the
// experiment, so reports from any number of definitions and sources merge by fingerprint.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { ExperimentDefinition, LearningContext } from '../format/types.ts'
import { hasErrors, type Finding } from '../schema/findings.ts'
import { normalise, validateV1 } from '../format/validate.ts'
import { coverageOf, type CoverageReport, type CoverageRequirement, type GapEntry, resolveRoleEquipment } from './compile.ts'

/**
 * Coverage of a definition this build may not fully support: only V1 (structure) gates it, so
 * unknown materials, techniques and equipment become gaps instead of stopping the analysis.
 */
export function analyseCoverage(input: unknown, cat: Catalogue, context?: LearningContext): { coverage?: CoverageReport; findings: Finding[] } {
  const findings = validateV1(input)
  if (hasErrors(findings)) return { findings }
  const def = normalise(input as ExperimentDefinition)
  const ctx = context ?? def.context?.intendedContexts?.[0] ?? 'practical-session'
  const coverage = coverageOf(def, cat, ctx)
  const add = (r: CoverageRequirement, gap: GapEntry['gap']) => {
    coverage.requirements.push(r)
    coverage.gaps.push({ fingerprint: [gap.kind, gap.purpose ?? '', gap.id ?? ''].join('|'), gap, path: r.path, centrality: r.centrality })
  }
  // Materials the catalogue does not know block the experiment.
  const local = new Map((def.materials?.substances ?? []).map((s) => [s.id, s.ref]))
  const seen = new Set<string>()
  const supplies = [...(def.materials?.supplies ?? []), ...(def.materials?.samples ?? [])]
  supplies.forEach((s, i) => {
    const base = i < (def.materials?.supplies?.length ?? 0) ? `/materials/supplies/${i}` : `/materials/samples/${i - (def.materials?.supplies?.length ?? 0)}`
    const refs = [...(s.contains ?? []).map((c) => c.substance), ...(s.preparation ? [s.preparation] : [])]
    for (const ref of refs) {
      const id = local.get(ref) ?? ref
      if (cat.substances.has(id) || cat.preparations.has(id) || local.has(ref) && !local.get(ref)) continue
      if (seen.has(id)) continue
      seen.add(id)
      add({ path: base, kind: 'material', requested: id, resolved: null, rung: 'unsupported', centrality: 'objective' }, { kind: 'material', id })
    }
  })
  // Equipment roles nothing can fill.
  ;(def.equipment?.roles ?? []).forEach((role, i) => {
    if (resolveRoleEquipment(role.requires as Record<string, unknown>, cat)) return
    const purpose = typeof role.requires.purpose === 'string' ? role.requires.purpose : undefined
    const id = typeof role.requires.class === 'string' ? role.requires.class : undefined
    add({ path: `/equipment/roles/${i}`, kind: 'equipment', requested: id ?? purpose ?? role.id, resolved: null, rung: 'unsupported', centrality: 'objective' }, { kind: 'equipment', purpose, id })
  })
  coverage.verdict = coverage.requirements.some((r) => r.rung === 'unsupported' && r.centrality === 'objective')
    ? 'not-supported'
    : coverage.requirements.some((r) => r.rung !== 'exact')
      ? 'supported-with-degradation'
      : 'fully-supported'
  return { coverage, findings }
}

export interface GapReport {
  report: 'lab-gaps'
  reportVersion: '0.1'
  frameworkBuild: string
  entries: Array<{
    fingerprint: string
    gap: GapEntry['gap']
    occurrences: Array<{ definition: string; context: LearningContext; centrality: GapEntry['centrality']; path: string; result: string }>
  }>
}

/** Merge the gaps of many coverage reports by fingerprint. No learner data, no source text. */
export function gapReport(coverages: readonly CoverageReport[], frameworkBuild: string): GapReport {
  const byPrint = new Map<string, GapReport['entries'][number]>()
  for (const c of coverages) {
    for (const g of c.gaps) {
      const entry = byPrint.get(g.fingerprint) ?? { fingerprint: g.fingerprint, gap: g.gap, occurrences: [] }
      entry.occurrences.push({ definition: `${c.definition.id}@${c.definition.version}`, context: c.context, centrality: g.centrality, path: g.path, result: 'unsupported' })
      byPrint.set(g.fingerprint, entry)
    }
  }
  const entries = [...byPrint.values()].sort((a, b) => b.occurrences.length - a.occurrences.length || a.fingerprint.localeCompare(b.fingerprint))
  return { report: 'lab-gaps', reportVersion: '0.1', frameworkBuild, entries }
}

export interface UnlockRow {
  fingerprint: string
  gap: GapEntry['gap']
  /** Definitions that need it. */
  definitions: number
  /** Of those, where it is central to an objective. */
  objectiveCentral: number
  /** Definitions it alone stands between and full support. */
  unlocksAlone: number
  /** Greedy order: implement in this order to unlock the most definitions soonest. */
  rank: number
  /** Definitions fully supported after implementing this and everything ranked above it. */
  unlockedCumulative: number
}

/**
 * Which gaps, implemented in which order, make the most definitions fully supported? A greedy
 * set cover over each definition's set of missing capabilities (§8.3).
 */
export function unlockAnalysis(coverages: readonly CoverageReport[]): UnlockRow[] {
  const needs = coverages.map((c) => new Set(c.gaps.map((g) => g.fingerprint)))
  const info = new Map<string, { gap: GapEntry['gap']; defs: Set<number>; central: Set<number> }>()
  coverages.forEach((c, i) => {
    for (const g of c.gaps) {
      const row = info.get(g.fingerprint) ?? { gap: g.gap, defs: new Set<number>(), central: new Set<number>() }
      row.defs.add(i)
      if (g.centrality === 'objective') row.central.add(i)
      info.set(g.fingerprint, row)
    }
  })
  const done = new Set<string>()
  const unlocked = () => needs.filter((n) => n.size > 0 && [...n].every((f) => done.has(f))).length
  const rows: UnlockRow[] = []
  while (done.size < info.size) {
    let best: string | undefined
    let bestGain = -1
    let bestFreq = -1
    for (const [f, row] of info) {
      if (done.has(f)) continue
      done.add(f)
      const gain = unlocked()
      done.delete(f)
      if (gain > bestGain || (gain === bestGain && row.defs.size > bestFreq)) {
        best = f
        bestGain = gain
        bestFreq = row.defs.size
      }
    }
    if (!best) break
    done.add(best)
    const row = info.get(best)!
    rows.push({
      fingerprint: best,
      gap: row.gap,
      definitions: row.defs.size,
      objectiveCentral: row.central.size,
      unlocksAlone: needs.filter((n) => n.size === 1 && n.has(best!)).length,
      rank: rows.length + 1,
      unlockedCumulative: unlocked(),
    })
  }
  return rows
}
