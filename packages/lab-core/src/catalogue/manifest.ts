// The capability manifest (capability manifest spec §1): what this framework build can do,
// generated from the catalogue, never hand-written. Generators and hosts read it.
import { LEARNING_CONTEXTS } from '../format/types.ts'
import { FORMAT_VERSION } from '../format/types.ts'
import type { Catalogue } from './catalogue.ts'

export const MANIFEST_VERSION = '0.1.0'

export interface CapabilityManifest {
  manifest: 'lab-capabilities'
  manifestVersion: string
  framework: { version: string; build: string }
  formats: { experimentDefinition: string[] }
  packs: Array<{ id: string; version: string; label: string }>
  contexts: string[]
  purposes: Array<{ id: string; parent?: string; label: string; status: string; signature?: unknown; dimensions?: string[]; requires?: string[] }>
  operations: Array<{ id: string; status: string; purposes: string[]; domain: string; params: Record<string, unknown> }>
  techniques: Array<{
    id: string
    version: number
    status: string
    label: string
    mode: string
    purposes: string[]
    params: Record<string, unknown>
    roles: string[]
    skills: string[]
  }>
  equipment: Array<{ id: string; class?: string; level: string; kind: string; status: string; representation: string; capabilities: Array<{ purpose: string; params?: Record<string, string>; performance?: Record<string, string> }> }>
  processModels: Array<{ id: string; contract: string; tier: string; status: string }>
  measurementModels: Array<{ id: string; contract: string; tier: string; status: string }>
  substances: Array<{ id: string; name: string; class: string; facets: string[] }>
  preparations: Array<{ id: string; label: string }>
  skills: Array<{ id: string; label: string; kind: string }>
  stubs: Array<{ kind: string; id: string; purposes?: string[] }>
}

export function exportManifest(cat: Catalogue, framework: { version: string; build: string }): CapabilityManifest {
  const latest = [...cat.techniques.values()].map((v) => v[v.length - 1])
  const facets = (s: Record<string, unknown>) => Object.keys(s).filter((k) => !['id', 'status', 'provenance'].includes(k))
  return {
    manifest: 'lab-capabilities',
    manifestVersion: MANIFEST_VERSION,
    framework,
    formats: { experimentDefinition: [FORMAT_VERSION] },
    packs: cat.packs.map((p) => ({ id: p.id, version: p.version, label: p.label })),
    contexts: [...LEARNING_CONTEXTS],
    purposes: [...cat.purposes.values()].map((p) => ({
      id: p.id,
      ...(p.parent ? { parent: p.parent } : {}),
      label: p.label,
      status: p.status,
      ...(p.signature ? { signature: p.signature } : {}),
      ...(p.dimensions ? { dimensions: p.dimensions } : {}),
      ...(p.requires ? { requires: p.requires } : {}),
    })),
    operations: [...cat.operations.values()].map((o) => ({ id: o.id, status: o.status, purposes: o.purposes, domain: o.domain, params: o.params })),
    techniques: latest.map((t) => ({
      id: t.id,
      version: t.version,
      status: t.status,
      label: t.label,
      mode: t.mode ?? 'bench',
      purposes: t.purposes,
      params: t.params,
      roles: Object.keys(t.roles ?? {}),
      skills: t.skills,
    })),
    equipment: [...cat.equipment.values()].map((e) => ({
      id: e.id,
      ...(e.parent ? { class: e.parent } : {}),
      level: e.level,
      kind: e.kind,
      status: e.status,
      representation: e.representation,
      capabilities: e.capabilities.map((c) => ({ purpose: c.purpose, ...(c.params ? { params: c.params } : {}), ...(c.performance ? { performance: c.performance } : {}) })),
    })),
    processModels: [...cat.models.values()].filter((m) => m.kind === 'process').map((m) => ({ id: m.id, contract: m.contract, tier: m.tier, status: m.status })),
    measurementModels: [...cat.models.values()].filter((m) => m.kind === 'measurement').map((m) => ({ id: m.id, contract: m.contract, tier: m.tier, status: m.status })),
    substances: [...cat.substances.values()].map((s) => ({ id: s.id, name: s.identity.name, class: s.identity.class, facets: facets(s as unknown as Record<string, unknown>) })),
    preparations: [...cat.preparations.values()].map((p) => ({ id: p.id, label: p.label })),
    skills: [...cat.skills.values()].map((s) => ({ id: s.id, label: s.label, kind: s.kind })),
    stubs: [
      ...latest.filter((t) => t.status === 'stub').map((t) => ({ kind: 'technique', id: t.id, purposes: t.purposes })),
      ...[...cat.equipment.values()].filter((e) => e.status === 'stub').map((e) => ({ kind: 'equipment', id: e.id })),
    ],
  }
}
