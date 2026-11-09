// Read a PHREEQC thermodynamic database (SOLUTION_MASTER_SPECIES, SOLUTION_SPECIES, PHASES) into
// plain objects. Used by phreeqc-import.mjs to generate the aqueous catalogue pack. The databases
// are U.S. Geological Survey material distributed with PHREEQC under its User Rights Notice
// (packages/pack-aqueous/NOTICE-PHREEQC.txt); get the originals from
// https://github.com/usgs-coupled/phreeqc3/tree/master/database.

/** "2Cu+2" → [2, "Cu+2"]; "H2O" → [1, "H2O"]. */
function term(text) {
  const m = /^(\d+(?:\.\d+)?)?\s*(.+)$/.exec(text.trim())
  return [m[1] ? Number(m[1]) : 1, m[2].trim()]
}

/** Split one side of a reaction into [coefficient, species] terms ("a + b" with charges like "Cu+2"). */
function side(text) {
  // A " + " separates terms; a "+" inside a formula (charge) has no spaces around it.
  return text.split(/\s+\+\s+/).map((t) => t.trim()).filter(Boolean).map(term)
}

/** Parse a reaction "lhs = rhs" into species → coefficient (products positive, reactants negative). */
export function parseReaction(text) {
  const [lhs, rhs] = text.split('=')
  const out = new Map()
  for (const [k, s] of side(lhs)) out.set(s, (out.get(s) ?? 0) - k)
  for (const [k, s] of side(rhs)) out.set(s, (out.get(s) ?? 0) + k)
  for (const [s, k] of out) if (Math.abs(k) < 1e-12) out.delete(s)
  return { text: text.trim(), terms: out, defined: side(rhs)[0]?.[1], lhs: side(lhs), rhs: side(rhs) }
}

/** Charge of a PHREEQC formula: "Cu+2" → 2, "SO4-2" → −2, "Ag+" → 1, "CaCO3" → 0. */
export function chargeOf(formula) {
  const m = /([+-])(\d*)$/.exec(formula)
  if (!m) return 0
  const n = m[2] ? Number(m[2]) : 1
  return m[1] === '+' ? n : -n
}

/**
 * Parse a database: master species by element, aqueous species (association reactions with log K
 * and ΔH in kJ/mol) and phases (dissolution reactions).
 */
export function parseDatabase(text) {
  const masters = new Map()
  const species = []
  const phases = []
  let block = ''
  let current = null
  const unitsToKJ = (value, unit) => {
    const u = (unit ?? 'kJ').toLowerCase()
    if (u.startsWith('kcal')) return value * 4.184
    if (u.startsWith('cal')) return value * 0.004184
    if (u.startsWith('j')) return value / 1000
    return value
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    // Data block keywords (a phase may be named in capitals, like "VO", so only real ones count).
    const word = line.trim()
    if (!raw.startsWith(' ') && !raw.startsWith('\t') && (/^[A-Z]+(_[A-Z]+)+$/.test(word) || ['PHASES', 'END', 'RATES'].includes(word))) {
      block = word
      current = null
      continue
    }
    if (block === 'SOLUTION_MASTER_SPECIES') {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2) masters.set(parts[0], { element: parts[0], species: parts[1], gfw: parts[4] ? Number(parts[4]) : undefined })
      continue
    }
    if (block === 'SOLUTION_SPECIES') {
      if (line.includes('=') && !/^\s*-/.test(line) && !/^\s*(log_k|logk|delta_h|-)/i.test(line.trim())) {
        current = { reaction: parseReaction(line), logK: 0, dH: undefined }
        species.push(current)
        continue
      }
      if (!current) continue
      const t = line.trim()
      let m
      if ((m = /^-?log_?k\s+([-+\d.eE]+)/i.exec(t))) current.logK = Number(m[1])
      else if ((m = /^-?delta_h\s+([-+\d.eE]+)\s*(\S+)?/i.exec(t))) current.dH = unitsToKJ(Number(m[1]), m[2])
      continue
    }
    if (block === 'PHASES') {
      const t = line.trim()
      // A phase's name starts in the first column (letters, digits or a bracket: "(Co(NH3)6)Br3").
      if (!t.includes('=') && !t.startsWith('-') && !/^(log_?k|delta_h)/i.test(t) && !raw.startsWith(' ') && !raw.startsWith('\t')) {
        current = { name: t.split(/\s+/)[0], reaction: null, logK: 0, dH: undefined }
        phases.push(current)
        continue
      }
      if (!current) continue
      let m
      if (t.includes('=') && !current.reaction) current.reaction = parseReaction(t)
      else if ((m = /^-?log_?k\s+([-+\d.eE]+)/i.exec(t))) current.logK = Number(m[1])
      else if ((m = /^-?delta_h\s+([-+\d.eE]+)\s*(\S+)?/i.exec(t))) current.dH = unitsToKJ(Number(m[1]), m[2])
    }
  }
  return { masters, species, phases: phases.filter((p) => p.reaction) }
}
