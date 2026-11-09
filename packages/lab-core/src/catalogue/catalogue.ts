// The catalogue: every pack's entries in one registry, validated and cross-referenced.
// Definitions, the compiler and the kernel resolve everything through it.
import { childPointer, type Finding } from '../schema/findings.ts'
import { validate } from '../schema/schema.ts'
import { FORMATS } from '../format/formats.ts'
import { parseQuantity } from '../units/quantity.ts'
import type { StepDef } from '../format/types.ts'
import { CATALOGUE_DEFS, ENTRY_SCHEMAS } from './schema.ts'
import {
  ENTRY_KINDS,
  type EntryKind,
  type EquipmentDef,
  type ModelDecl,
  type OperationDecl,
  type PackContent,
  type PackManifest,
  type PreparationDef,
  type PurposeDef,
  type RuleDef,
  type SkillDef,
  type SubstanceDef,
  type TechniqueDef,
} from './types.ts'

export type ResolvedEntry =
  | { kind: 'operation'; entry: OperationDecl }
  | { kind: 'technique'; entry: TechniqueDef }
  | { kind: 'equipment'; entry: EquipmentDef }
  | { kind: 'substance'; entry: SubstanceDef }
  | { kind: 'preparation'; entry: PreparationDef }
  | { kind: 'skill'; entry: SkillDef }
  | { kind: 'rule'; entry: RuleDef }
  | { kind: 'model'; entry: ModelDecl }

export interface Provider {
  kind: 'operation' | 'technique' | 'equipment'
  id: string
  status: string
}

/** Split "core:serial-dilution@2" into id and pinned version. */
export function splitRef(ref: string): { id: string; version?: number } {
  const at = ref.lastIndexOf('@')
  if (at < 0) return { id: ref }
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) }
}

export function namespaceOf(id: string): string | undefined {
  const colon = id.indexOf(':')
  return colon < 0 ? undefined : id.slice(0, colon)
}

export class Catalogue {
  readonly packs: PackManifest[] = []
  readonly purposes = new Map<string, PurposeDef>()
  readonly operations = new Map<string, OperationDecl>()
  /** All versions, ascending. */
  readonly techniques = new Map<string, TechniqueDef[]>()
  readonly equipment = new Map<string, EquipmentDef>()
  /** Lineages already walked (looked up every simulation step), cleared when equipment is added. */
  private readonly lineages = new Map<string, EquipmentDef[]>()
  readonly substances = new Map<string, SubstanceDef>()
  readonly preparations = new Map<string, PreparationDef>()
  readonly skills = new Map<string, SkillDef>()
  readonly rules = new Map<string, RuleDef>()
  readonly models = new Map<string, ModelDecl>()

  /** Load packs, validate every entry and cross-reference. Errors leave entries out. */
  static build(contents: PackContent[]): { catalogue: Catalogue; findings: Finding[] } {
    const cat = new Catalogue()
    const findings: Finding[] = []
    contents.forEach((content, p) => cat.addPack(content, `/packs/${p}`, findings))
    findings.push(...cat.crossReference())
    return { catalogue: cat, findings }
  }

  private addPack(content: PackContent, base: string, findings: Finding[]): void {
    const packFindings = validate(content.pack, ENTRY_SCHEMAS.pack, { prefix: 'CAT', formats: FORMATS }, `${base}/pack`)
    findings.push(...packFindings)
    if (packFindings.some((f) => f.severity === 'error')) return
    const ns = content.pack.id
    if (this.packs.some((p) => p.id === ns)) {
      findings.push(err('CAT-V2-DUPLICATE-PACK', `${base}/pack/id`, `Pack "${ns}" is loaded twice`))
      return
    }
    this.packs.push(content.pack)
    for (const kind of ENTRY_KINDS) {
      const list = content[kind] as unknown[] | undefined
      if (!list) continue
      list.forEach((raw, i) => {
        const path = `${base}/${kind}/${i}`
        const f = validate(raw, ENTRY_SCHEMAS[kind], { prefix: 'CAT', formats: FORMATS, defs: CATALOGUE_DEFS, unknownSeverity: 'warning' }, path)
        findings.push(...f)
        if (f.some((x) => x.severity === 'error')) return
        const entry = raw as { id: string }
        if (kind !== 'purposes' && namespaceOf(entry.id) !== ns) {
          findings.push(err('CAT-V2-NAMESPACE', childPointer(path, 'id'), `"${entry.id}" is not in this pack's namespace "${ns}:"`))
          return
        }
        if (!this.insert(kind, raw)) {
          findings.push(err('CAT-V2-DUPLICATE-ID', childPointer(path, 'id'), `"${entry.id}" is defined twice`))
        }
      })
    }
  }

  private insert(kind: EntryKind, raw: unknown): boolean {
    const put = <T extends { id: string }>(map: Map<string, T>, v: T) => {
      if (map.has(v.id)) return false
      map.set(v.id, v)
      return true
    }
    switch (kind) {
      case 'purposes':
        return put(this.purposes, raw as PurposeDef)
      case 'operations':
        return put(this.operations, raw as OperationDecl)
      case 'techniques': {
        const t = raw as TechniqueDef
        const versions = this.techniques.get(t.id) ?? []
        if (versions.some((v) => v.version === t.version)) return false
        versions.push(t)
        versions.sort((a, b) => a.version - b.version)
        this.techniques.set(t.id, versions)
        return true
      }
      case 'equipment':
        this.lineages.clear()
        return put(this.equipment, raw as EquipmentDef)
      case 'substances':
        return put(this.substances, raw as SubstanceDef)
      case 'preparations':
        return put(this.preparations, raw as PreparationDef)
      case 'skills':
        return put(this.skills, raw as SkillDef)
      case 'rules':
        return put(this.rules, raw as RuleDef)
      case 'models':
        return put(this.models, raw as ModelDecl)
    }
  }

  // ---- Lookup ----

  technique(ref: string): TechniqueDef | undefined {
    const { id, version } = splitRef(ref)
    const versions = this.techniques.get(id)
    if (!versions) return undefined
    return version === undefined ? versions[versions.length - 1] : versions.find((v) => v.version === version)
  }

  /** Resolve any namespaced catalogue id. */
  resolve(ref: string): ResolvedEntry | undefined {
    const { id } = splitRef(ref)
    const op = this.operations.get(id)
    if (op) return { kind: 'operation', entry: op }
    const t = this.technique(ref)
    if (t) return { kind: 'technique', entry: t }
    const e = this.equipment.get(id)
    if (e) return { kind: 'equipment', entry: e }
    const s = this.substances.get(id)
    if (s) return { kind: 'substance', entry: s }
    const p = this.preparations.get(id)
    if (p) return { kind: 'preparation', entry: p }
    const k = this.skills.get(id)
    if (k) return { kind: 'skill', entry: k }
    const r = this.rules.get(id)
    if (r) return { kind: 'rule', entry: r }
    const m = this.models.get(id)
    if (m) return { kind: 'model', entry: m }
    return undefined
  }

  /** The equipment entry and its ancestors (model → class → parent classes). */
  lineage(equipmentId: string): EquipmentDef[] {
    const hit = this.lineages.get(equipmentId)
    if (hit) return hit
    const out: EquipmentDef[] = []
    let cur = this.equipment.get(equipmentId)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      out.push(cur)
      cur = cur.parent ? this.equipment.get(cur.parent) : undefined
    }
    if (out.length) this.lineages.set(equipmentId, out)
    return out
  }

  /** Whether equipment `id` is, or descends from, class `classId`. */
  isA(id: string, classId: string): boolean {
    return this.lineage(id).some((e) => e.id === classId)
  }

  /** A property, inherited from the class if the model does not set it. */
  property(equipmentId: string, name: string): string | number | boolean | undefined {
    for (const e of this.lineage(equipmentId)) {
      const v = e.properties?.[name]
      if (v !== undefined) return v
    }
    return undefined
  }

  /** Whether purpose `id` is `ancestor` or specialises it. */
  purposeIsA(id: string, ancestor: string): boolean {
    let cur: string | undefined = id
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      if (cur === ancestor) return true
      seen.add(cur)
      cur = this.purposes.get(cur)?.parent
    }
    return false
  }

  /** Every operation, technique and equipment entry that declares the purpose (or a specialisation). */
  providersOf(purpose: string): Provider[] {
    const out: Provider[] = []
    for (const op of this.operations.values()) {
      if (op.purposes.some((p) => this.purposeIsA(p, purpose))) out.push({ kind: 'operation', id: op.id, status: op.status })
    }
    for (const versions of this.techniques.values()) {
      const t = versions[versions.length - 1]
      if (t.purposes.some((p) => this.purposeIsA(p, purpose))) out.push({ kind: 'technique', id: t.id, status: t.status })
    }
    for (const e of this.equipment.values()) {
      if (e.capabilities.some((c) => this.purposeIsA(c.purpose, purpose))) out.push({ kind: 'equipment', id: e.id, status: e.status })
    }
    return out
  }

  /**
   * Whether equipment meets a requirement: { class?, purpose?, <param>: value } (capability
   * model §6). Every parameter named must be declared by a capability for that purpose and
   * cover the value: a key the equipment does not declare cannot be confirmed, so it fails.
   */
  meets(equipmentId: string, req: Record<string, unknown>): boolean {
    if (typeof req.class === 'string' && !this.isA(equipmentId, req.class)) return false
    const purpose = typeof req.purpose === 'string' ? req.purpose : undefined
    if (!purpose) return true
    const caps = this.capabilitiesOf(equipmentId).filter((c) => this.purposeIsA(c.purpose, purpose))
    if (caps.length === 0) return false
    for (const [key, value] of Object.entries(req)) {
      if (key === 'purpose' || key === 'class' || value === undefined || value === null) continue
      const declared = caps.map((c) => c.params?.[key]).filter((x): x is string => typeof x === 'string')
      if (declared.length === 0) return false
      if (!declared.some((r) => covers(r, value))) return false
    }
    return true
  }

  /** All capability descriptors of an equipment entry, including inherited ones. */
  capabilitiesOf(equipmentId: string) {
    return this.lineage(equipmentId).flatMap((e) => e.capabilities)
  }

  // ---- Cross-reference validation (CAT-V2) ----

  private crossReference(): Finding[] {
    const out: Finding[] = []
    const need = (ok: boolean, code: string, path: string, message: string) => {
      if (!ok) out.push(err(code, path, message))
    }
    const hasPurpose = (id: string) => this.purposes.has(id)
    const hasSkill = (id: string) => this.skills.has(id)
    const hasMaterial = (id: string) => this.substances.has(id) || this.preparations.has(id)

    for (const p of this.purposes.values()) {
      const path = `/purposes/${p.id}`
      if (p.parent) need(hasPurpose(p.parent), 'CAT-V2-UNKNOWN-PURPOSE', `${path}/parent`, `Unknown parent purpose "${p.parent}"`)
      for (const r of p.requires ?? []) need(hasPurpose(r), 'CAT-V2-UNKNOWN-PURPOSE', `${path}/requires`, `Unknown required purpose "${r}"`)
    }
    for (const o of this.operations.values()) {
      for (const p of o.purposes) need(hasPurpose(p), 'CAT-V2-UNKNOWN-PURPOSE', `/operations/${o.id}/purposes`, `Unknown purpose "${p}"`)
      for (const s of o.skills ?? []) need(hasSkill(s), 'CAT-V2-UNKNOWN-SKILL', `/operations/${o.id}/skills`, `Unknown skill "${s}"`)
    }
    for (const versions of this.techniques.values()) {
      for (const t of versions) {
        const path = `/techniques/${t.id}@${t.version}`
        for (const p of t.purposes) need(hasPurpose(p), 'CAT-V2-UNKNOWN-PURPOSE', `${path}/purposes`, `Unknown purpose "${p}"`)
        for (const s of t.skills) need(hasSkill(s), 'CAT-V2-UNKNOWN-SKILL', `${path}/skills`, `Unknown skill "${s}"`)
        for (const c of t.quality ?? []) for (const s of c.skills ?? []) need(hasSkill(s), 'CAT-V2-UNKNOWN-SKILL', `${path}/quality/${c.id}`, `Unknown skill "${s}"`)
        for (const [name, role] of Object.entries(t.roles ?? {})) {
          for (const pref of role.prefer ?? []) need(this.equipment.has(pref), 'CAT-V2-UNKNOWN-EQUIPMENT', `${path}/roles/${name}/prefer`, `Unknown equipment "${pref}"`)
          const purpose = role.requires?.purpose
          if (purpose) need(hasPurpose(purpose), 'CAT-V2-UNKNOWN-PURPOSE', `${path}/roles/${name}/requires/purpose`, `Unknown purpose "${purpose}"`)
          const cls = role.requires?.class
          if (cls) need(this.equipment.has(cls), 'CAT-V2-UNKNOWN-EQUIPMENT', `${path}/roles/${name}/requires/class`, `Unknown equipment class "${cls}"`)
        }
        this.checkSteps(t.steps, `${path}/steps`, out, t.id)
        // A step id equal to a parameter, role or derived value would hide it from expressions.
        const names = new Set([...Object.keys(t.params), ...Object.keys(t.roles ?? {}), ...Object.keys(t.derived ?? {})])
        const walk = (steps: StepDef[], base: string) =>
          steps.forEach((s, i) => {
            if (names.has(s.id)) out.push(err('CAT-V2-STEP-SHADOWS-NAME', `${base}/${i}/id`, `Step "${s.id}" in ${t.id} has the same name as a parameter, role or derived value`))
            if (s.steps) walk(s.steps, `${base}/${i}/steps`)
          })
        walk(t.steps, `${path}/steps`)
      }
    }
    for (const e of this.equipment.values()) {
      const path = `/equipment/${e.id}`
      if (e.parent) need(this.equipment.has(e.parent), 'CAT-V2-UNKNOWN-EQUIPMENT', `${path}/parent`, `Unknown parent "${e.parent}"`)
      for (const c of e.capabilities) need(hasPurpose(c.purpose), 'CAT-V2-UNKNOWN-PURPOSE', `${path}/capabilities`, `Unknown purpose "${c.purpose}"`)
      for (const s of e.skills ?? []) need(hasSkill(s), 'CAT-V2-UNKNOWN-SKILL', `${path}/skills`, `Unknown skill "${s}"`)
      for (const c of e.consumables ?? []) need(this.equipment.has(c), 'CAT-V2-UNKNOWN-EQUIPMENT', `${path}/consumables`, `Unknown consumable "${c}"`)
      if (e.level === 'model') need(!!e.parent, 'CAT-V2-MODEL-WITHOUT-CLASS', `${path}/parent`, `Model "${e.id}" names no class`)
      // A plate's format may be inherited from its class (as the world builder reads it).
      if (e.kind === 'plate') need(this.lineage(e.id).some((x) => !!x.format), 'CAT-V2-PLATE-WITHOUT-FORMAT', `${path}/format`, `Plate "${e.id}" has no format`)
    }
    for (const s of this.substances.values()) {
      const path = `/substances/${s.id}`
      if (s.enzyme) {
        for (const x of [...s.enzyme.substrates, ...s.enzyme.products, ...Object.keys(s.enzyme.km), ...Object.keys(s.enzyme.inhibitors ?? {})]) {
          need(this.substances.has(x), 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/enzyme`, `Unknown substance "${x}"`)
        }
      }
      if (s.hazard?.wasteStream) need(this.equipment.has(s.hazard.wasteStream) || this.isWasteStream(s.hazard.wasteStream), 'CAT-V2-UNKNOWN-WASTE-STREAM', `${path}/hazard/wasteStream`, `Unknown waste stream "${s.hazard.wasteStream}"`)
      for (const r of s.organism?.requires ?? []) need(this.substances.has(r.substance), 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/organism/requires`, `Unknown growth factor "${r.substance}"`)
      for (const m of s.organism?.mutants ?? []) need(!!this.substances.get(m.to)?.organism, 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/organism/mutants`, `Mutant "${m.to}" is not an organism in the catalogue`)
      if (s.drying) need(this.substances.has(s.drying.hydrate), 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/drying/hydrate`, `Unknown hydrate "${s.drying.hydrate}"`)
      if (s.fluorescence?.bound) need(this.substances.has(s.fluorescence.bound.to), 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/fluorescence/bound/to`, `Unknown protein "${s.fluorescence.bound.to}"`)
      const seq = s.dna?.sequence
      if (seq && s.dna?.lengthBp !== undefined) need(s.dna.lengthBp === seq.length, 'CAT-V2-SEQUENCE-LENGTH', `${path}/dna/lengthBp`, `lengthBp ${s.dna.lengthBp} does not match its ${seq.length}-base sequence`)
      for (const f of s.dna?.features ?? []) {
        need(!!seq && f.end <= seq.length && f.start <= f.end, 'CAT-V2-FEATURE-RANGE', `${path}/dna/features`, `Feature ${f.gene} lies outside the sequence`)
        need((f.end - f.start + 1) % 3 === 0, 'CAT-V2-FEATURE-FRAME', `${path}/dna/features`, `Coding sequence ${f.gene} is not a whole number of codons`)
      }
    }
    for (const p of this.preparations.values()) {
      const path = `/preparations/${p.id}`
      need(hasMaterial(p.solvent), 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/solvent`, `Unknown solvent "${p.solvent}"`)
      for (const c of p.components) need(this.substances.has(c.substance), 'CAT-V2-UNKNOWN-SUBSTANCE', `${path}/components`, `Unknown substance "${c.substance}"`)
    }
    for (const m of this.models.values()) {
      for (const t of m.trigger ?? []) need(this.substances.has(t), 'CAT-V2-UNKNOWN-SUBSTANCE', `/models/${m.id}/trigger`, `Unknown substance "${t}"`)
      // A functional-group class: every instance fills each role with a known substance and makes one.
      for (const [i, inst] of (m.instances ?? []).entries()) {
        for (const role of Object.keys(m.template?.roles ?? {})) need(this.substances.has(inst.from[role] ?? ''), 'CAT-V2-UNKNOWN-SUBSTANCE', `/models/${m.id}/instances/${i}/from`, `Role "${role}" is not filled with a known substance`)
        need(this.substances.has(inst.product), 'CAT-V2-UNKNOWN-SUBSTANCE', `/models/${m.id}/instances/${i}/product`, `Unknown product "${inst.product}"`)
      }
    }
    return out
  }

  /** Waste streams are equipment classes of kind container under core:waste (or their sub-streams). */
  isWasteStream(id: string): boolean {
    if (this.equipment.has(id)) return this.isA(id, 'core:waste-container')
    // "core:chemical-waste.heavy-metal" is a sub-stream of the class "core:chemical-waste".
    const dot = id.lastIndexOf('.')
    return dot > 0 && this.isWasteStream(id.slice(0, dot))
  }

  private checkSteps(steps: StepDef[], path: string, out: Finding[], owner: string): void {
    steps.forEach((s, i) => {
      const p = `${path}/${i}`
      if (s.kind === 'operation' && s.ref && !this.operations.has(s.ref)) {
        out.push(err('CAT-V2-UNKNOWN-OPERATION', `${p}/ref`, `Unknown operation "${s.ref}" in ${owner}`))
      }
      if ((s.kind === 'technique' || s.kind === 'data' || s.kind === 'design') && s.ref && !this.technique(s.ref) && !this.operations.has(s.ref)) {
        out.push(err('CAT-V2-UNKNOWN-TECHNIQUE', `${p}/ref`, `Unknown technique "${s.ref}" in ${owner}`))
      }
      if (s.kind === 'purpose' && s.ref && !this.purposes.has(s.ref)) {
        out.push(err('CAT-V2-UNKNOWN-PURPOSE', `${p}/ref`, `Unknown purpose "${s.ref}" in ${owner}`))
      }
      if (s.steps) this.checkSteps(s.steps, `${p}/steps`, out, owner)
    })
  }

  /** Counts per kind, for summaries. */
  counts(): Record<string, number> {
    return {
      purposes: this.purposes.size,
      operations: this.operations.size,
      techniques: this.techniques.size,
      equipment: this.equipment.size,
      substances: this.substances.size,
      preparations: this.preparations.size,
      skills: this.skills.size,
      rules: this.rules.size,
      models: this.models.size,
    }
  }
}

/** Does a declared parameter (a range "20..200 uL", a value, or a token "96-well") cover a requested value? */
export function covers(declared: string, value: unknown): boolean {
  const asQ = (v: unknown) => {
    if (v && typeof v === 'object' && 'si' in v && 'dim' in v) return { si: (v as { si: number }).si }
    if (typeof v !== 'string') return undefined
    try {
      const p = parseQuantity(v)
      return p.kind === 'range' ? undefined : { si: p.q.si }
    } catch {
      return undefined
    }
  }
  try {
    const r = parseQuantity(declared)
    const q = asQ(value)
    if (!q) return false
    if (r.kind === 'range') return q.si >= r.lo.si - 1e-12 * Math.abs(r.lo.si || 1) && q.si <= r.hi.si + 1e-12 * Math.abs(r.hi.si || 1)
    return Math.abs(r.q.si - q.si) <= 1e-9 * Math.max(1, Math.abs(r.q.si))
  } catch {
    return declared === value
  }
}

function err(code: string, path: string, message: string): Finding {
  return { code, level: 'V2', severity: 'error', path, message }
}
