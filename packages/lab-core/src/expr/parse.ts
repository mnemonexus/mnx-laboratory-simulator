// The expression language of the definition format (format spec §15): a small, pure,
// unit-aware language parsed by the framework (never eval). This file: lexer and parser.
//
// Grammar (precedence from loosest to tightest):
//   expr     := or
//   or       := and ('||' and)*
//   and      := not ('&&' not)*
//   not      := '!' not | compare
//   compare  := additive (('=='|'!='|'<'|'<='|'>'|'>=') additive | 'in' additive)?
//   additive := mult (('+'|'-') mult)*
//   mult     := unary (('*'|'/') unary)*
//   unary    := '-' unary | power
//   power    := postfix ('^' unary)?
//   postfix  := primary ('.' name | '[' expr ']')*
//   primary  := number [unit] | string | true | false | null | name | call | '(' expr ')' | '[' list ']'
//   call     := name '(' [arg (',' arg)*] ')'
//   arg      := name 'in' expr ':' expr      (a binder: all(s in samples(): reading(read, s) > 0))
//             | name '=' expr                (a named argument: samples(role='unknown'))
//             | expr
// Names may contain hyphens between letters or digits (step ids such as range-check), so
// subtraction needs spaces: `a - b`. A unit written straight after a number belongs to it
// ("100 uM", "5%", "0.05 g").
import { isUnit } from '../units/units.ts'

export type Node =
  | { t: 'num'; value: number; unit?: string; pos: number }
  | { t: 'str'; value: string; pos: number }
  | { t: 'bool'; value: boolean; pos: number }
  | { t: 'null'; pos: number }
  | { t: 'name'; name: string; pos: number }
  | { t: 'list'; items: Node[]; pos: number }
  | { t: 'member'; target: Node; name: string; pos: number }
  | { t: 'index'; target: Node; index: Node; pos: number }
  | { t: 'call'; name: string; args: Arg[]; pos: number }
  | { t: 'unary'; op: '-' | '!'; arg: Node; pos: number }
  | { t: 'binary'; op: BinaryOp; left: Node; right: Node; pos: number }

export type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | '+' | '-' | '*' | '/' | '^'

export type Arg =
  | { kind: 'positional'; value: Node }
  | { kind: 'named'; name: string; value: Node }
  | { kind: 'binder'; name: string; source: Node; body: Node }

export class ExprError extends Error {
  readonly source: string
  readonly pos: number
  constructor(message: string, source: string, pos: number) {
    super(pos >= 0 ? `${message} (at ${pos + 1} in "${source}")` : message)
    this.name = 'ExprError'
    this.source = source
    this.pos = pos
  }
}

export const PARSE_LIMITS = { maxLength: 4000, maxDepth: 64 }

type Tok =
  | { k: 'num'; v: number; unit?: string; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'name'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'end'; pos: number }

const OPS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '^', '!', '(', ')', '[', ']', ',', '.', ':', '=']
const UNIT_CHARS = /[A-Za-z0-9_%\[\]{}()/.*^µμ°-]/

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i))!
      const pos = i
      i += m[0].length
      const unit = readUnit(src, i)
      if (unit) i = unit.end
      out.push({ k: 'num', v: Number(m[0]), unit: unit?.text, pos })
      continue
    }
    if (c === "'" || c === '"') {
      const pos = i
      let s = ''
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          s += src[i + 1]
          i += 2
        } else s += src[i++]
      }
      if (src[i] !== c) throw new ExprError('Unclosed text', src, pos)
      i++
      out.push({ k: 'str', v: s, pos })
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const pos = i
      let j = i + 1
      while (j < src.length) {
        if (/[A-Za-z0-9_]/.test(src[j])) j++
        else if (src[j] === '-' && /[A-Za-z0-9_]/.test(src[j - 1]) && /[A-Za-z0-9_]/.test(src[j + 1] ?? '')) j++
        else break
      }
      out.push({ k: 'name', v: src.slice(i, j), pos })
      i = j
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new ExprError(`Unexpected character "${c}"`, src, i)
    out.push({ k: 'op', v: op, pos: i })
    i += op.length
  }
  out.push({ k: 'end', pos: src.length })
  return out
}

/** A unit straight after a number: the longest run of unit characters that parses as a unit. */
function readUnit(src: string, start: number): { text: string; end: number } | undefined {
  let i = start
  while (src[i] === ' ') i++
  const first = src[i]
  if (!first || !/[A-Za-z%\[µμ°]/.test(first)) return undefined
  let j = i
  let depth = 0
  while (j < src.length && UNIT_CHARS.test(src[j])) {
    if (src[j] === '(') depth++
    if (src[j] === ')') {
      if (depth === 0) break
      depth--
    }
    j++
  }
  for (let end = j; end > i; end--) {
    const text = src.slice(i, end)
    if (/[./*^-]$/.test(text)) continue
    if (isUnit(text) && !RESERVED.has(text)) return { text, end }
  }
  return undefined
}

const RESERVED = new Set(['in', 'true', 'false', 'null'])

class Parser {
  private i = 0
  private depth = 0
  private readonly toks: Tok[]
  private readonly src: string
  constructor(toks: Tok[], src: string) {
    this.toks = toks
    this.src = src
  }

  parse(): Node {
    const node = this.expr()
    const t = this.peek()
    if (t.k !== 'end') this.fail(`Unexpected ${describe(t)}`, t.pos)
    return node
  }

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)]
  }

  private next(): Tok {
    return this.toks[this.i++]
  }

  private isOp(v: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t.k === 'op' && t.v === v
  }

  private isName(v: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t.k === 'name' && t.v === v
  }

  private expect(v: string): void {
    const t = this.next()
    if (t.k !== 'op' || t.v !== v) this.fail(`Expected "${v}" but found ${describe(t)}`, t.pos)
  }

  private fail(message: string, pos: number): never {
    throw new ExprError(message, this.src, pos)
  }

  private enter(pos: number) {
    if (++this.depth > PARSE_LIMITS.maxDepth) this.fail('Expression is nested too deeply', pos)
  }

  private expr(): Node {
    this.enter(this.peek().pos)
    const node = this.or()
    this.depth--
    return node
  }

  private or(): Node {
    let left = this.and()
    while (this.isOp('||')) {
      const pos = this.next().pos
      left = { t: 'binary', op: '||', left, right: this.and(), pos }
    }
    return left
  }

  private and(): Node {
    let left = this.not()
    while (this.isOp('&&')) {
      const pos = this.next().pos
      left = { t: 'binary', op: '&&', left, right: this.not(), pos }
    }
    return left
  }

  private not(): Node {
    if (this.isOp('!')) {
      const pos = this.next().pos
      return { t: 'unary', op: '!', arg: this.not(), pos }
    }
    return this.compare()
  }

  private compare(): Node {
    const left = this.additive()
    const t = this.peek()
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.next()
      return { t: 'binary', op: t.v as BinaryOp, left, right: this.additive(), pos: t.pos }
    }
    if (t.k === 'name' && t.v === 'in') {
      this.next()
      return { t: 'binary', op: 'in', left, right: this.additive(), pos: t.pos }
    }
    return left
  }

  private additive(): Node {
    let left = this.mult()
    while (this.isOp('+') || this.isOp('-')) {
      const t = this.next() as { v: '+' | '-'; pos: number }
      left = { t: 'binary', op: t.v, left, right: this.mult(), pos: t.pos }
    }
    return left
  }

  private mult(): Node {
    let left = this.unary()
    while (this.isOp('*') || this.isOp('/')) {
      const t = this.next() as { v: '*' | '/'; pos: number }
      left = { t: 'binary', op: t.v, left, right: this.unary(), pos: t.pos }
    }
    return left
  }

  private unary(): Node {
    if (this.isOp('-')) {
      const pos = this.next().pos
      return { t: 'unary', op: '-', arg: this.unary(), pos }
    }
    return this.power()
  }

  private power(): Node {
    const base = this.postfix()
    if (this.isOp('^')) {
      const pos = this.next().pos
      return { t: 'binary', op: '^', left: base, right: this.unary(), pos }
    }
    return base
  }

  private postfix(): Node {
    let node = this.primary()
    for (;;) {
      if (this.isOp('.')) {
        const pos = this.next().pos
        const name = this.next()
        if (name.k !== 'name') this.fail(`Expected a field name after "."`, name.pos)
        node = { t: 'member', target: node, name: name.v, pos }
      } else if (this.isOp('[')) {
        const pos = this.next().pos
        const index = this.expr()
        this.expect(']')
        node = { t: 'index', target: node, index, pos }
      } else return node
    }
  }

  private primary(): Node {
    const t = this.next()
    switch (t.k) {
      case 'num':
        return { t: 'num', value: t.v, unit: t.unit, pos: t.pos }
      case 'str':
        return { t: 'str', value: t.v, pos: t.pos }
      case 'name':
        if (t.v === 'true' || t.v === 'false') return { t: 'bool', value: t.v === 'true', pos: t.pos }
        if (t.v === 'null') return { t: 'null', pos: t.pos }
        if (t.v === 'in') this.fail('Unexpected "in"', t.pos)
        if (this.isOp('(')) return this.call(t.v, t.pos)
        return { t: 'name', name: t.v, pos: t.pos }
      case 'op':
        if (t.v === '(') {
          const node = this.expr()
          this.expect(')')
          return node
        }
        if (t.v === '[') {
          const items: Node[] = []
          if (!this.isOp(']')) {
            items.push(this.expr())
            while (this.isOp(',')) {
              this.next()
              items.push(this.expr())
            }
          }
          this.expect(']')
          return { t: 'list', items, pos: t.pos }
        }
        return this.fail(`Unexpected "${t.v}"`, t.pos)
      case 'end':
        return this.fail('Unexpected end of expression', t.pos)
    }
  }

  private call(name: string, pos: number): Node {
    this.expect('(')
    const args: Arg[] = []
    if (!this.isOp(')')) {
      args.push(this.arg())
      while (this.isOp(',')) {
        this.next()
        args.push(this.arg())
      }
    }
    this.expect(')')
    return { t: 'call', name, args, pos }
  }

  private arg(): Arg {
    const t = this.peek()
    if (t.k === 'name' && this.isOp('=', 1)) {
      this.next()
      this.next()
      return { kind: 'named', name: t.v, value: this.expr() }
    }
    if (t.k === 'name' && this.isName('in', 1)) {
      const save = this.i
      this.next()
      this.next()
      const source = this.additive()
      if (this.isOp(':')) {
        this.next()
        return { kind: 'binder', name: t.v, source, body: this.expr() }
      }
      this.i = save
    }
    return { kind: 'positional', value: this.expr() }
  }
}

function describe(t: Tok): string {
  switch (t.k) {
    case 'end':
      return 'the end of the expression'
    case 'num':
      return `number ${t.v}`
    case 'str':
      return `text "${t.v}"`
    default:
      return `"${t.v}"`
  }
}

const parsed = new Map<string, Node>()

/** Parse an expression. Parsed trees are cached by source text (the canonical AST, OQ-E1). */
export function parseExpression(source: string): Node {
  const text = source.startsWith('=') ? source.slice(1) : source
  const hit = parsed.get(text)
  if (hit) return hit
  if (text.length > PARSE_LIMITS.maxLength) throw new ExprError(`Expression is longer than ${PARSE_LIMITS.maxLength} characters`, text, -1)
  if (text.trim() === '') throw new ExprError('Empty expression', text, 0)
  const node = new Parser(lex(text), text).parse()
  if (parsed.size > 5000) parsed.clear()
  parsed.set(text, node)
  return node
}

/** A parameter value is an expression when it starts with "=" (format spec §8.1). */
export function isExpressionValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=')
}

/** Function names and free names used by an expression (for static checks). */
export function analyse(node: Node): { calls: Map<string, number[]>; names: Set<string> } {
  const calls = new Map<string, number[]>()
  const names = new Set<string>()
  const walk = (n: Node, bound: Set<string>) => {
    switch (n.t) {
      case 'name':
        if (!bound.has(n.name)) names.add(n.name)
        break
      case 'list':
        n.items.forEach((x) => walk(x, bound))
        break
      case 'member':
        walk(n.target, bound)
        break
      case 'index':
        walk(n.target, bound)
        walk(n.index, bound)
        break
      case 'unary':
        walk(n.arg, bound)
        break
      case 'binary':
        walk(n.left, bound)
        walk(n.right, bound)
        break
      case 'call': {
        const arities = calls.get(n.name) ?? []
        arities.push(n.args.length)
        calls.set(n.name, arities)
        let inner = bound
        for (const a of n.args) {
          if (a.kind === 'binder') {
            walk(a.source, inner)
            inner = new Set([...inner, a.name])
            walk(a.body, inner)
          } else walk(a.value, inner)
        }
        break
      }
      default:
        break
    }
  }
  walk(node, new Set(['it']))
  return { calls, names }
}
