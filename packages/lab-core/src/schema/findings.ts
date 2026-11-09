// Findings: the common shape of every validation result (format spec §18; manifest spec §2).

export type ValidationLevel = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'VS'
export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  /** Stable code: ED-<level>-<NAME> for definitions, CAT-… for catalogue entries. */
  code: string
  level: ValidationLevel
  severity: Severity
  /** JSON Pointer (RFC 6901) into the validated document. */
  path: string
  message: string
  data?: Record<string, unknown>
}

export interface FindingSummary {
  errors: number
  warnings: number
  info: number
}

export function summarise(findings: readonly Finding[]): FindingSummary {
  const s = { errors: 0, warnings: 0, info: 0 }
  for (const f of findings) {
    if (f.severity === 'error') s.errors++
    else if (f.severity === 'warning') s.warnings++
    else s.info++
  }
  return s
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'error')
}

// ---- JSON Pointer ----

export function escapePointerToken(token: string | number): string {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

export function pointer(...tokens: Array<string | number>): string {
  return tokens.length === 0 ? '' : '/' + tokens.map(escapePointerToken).join('/')
}

export function childPointer(base: string, token: string | number): string {
  return `${base}/${escapePointerToken(token)}`
}

export function parsePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new Error(`Not a JSON Pointer: "${path}"`)
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

export function getAtPointer(doc: unknown, path: string): unknown {
  let cur: unknown = doc
  for (const token of parsePointer(path)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur) ? cur[Number(token)] : (cur as Record<string, unknown>)[token]
  }
  return cur
}

/** Set a value at a pointer, creating objects on the way. Mutates `doc`. */
export function setAtPointer(doc: unknown, path: string, value: unknown): void {
  const tokens = parsePointer(path)
  if (tokens.length === 0) throw new Error('Cannot replace the document root')
  let cur = doc as Record<string, unknown>
  for (const token of tokens.slice(0, -1)) {
    const next = Array.isArray(cur) ? cur[Number(token)] : cur[token]
    if (next === null || typeof next !== 'object') {
      const created = {}
      if (Array.isArray(cur)) cur[Number(token)] = created
      else cur[token] = created
      cur = created as Record<string, unknown>
    } else {
      cur = next as Record<string, unknown>
    }
  }
  const last = tokens[tokens.length - 1]
  if (Array.isArray(cur)) cur[Number(last)] = value
  else cur[last] = value
}
