const NUM = '(?:0|[1-9]\\d*)'
const PID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const PRE = PID + '(?:\\.' + PID + ')*'
const FULL = new RegExp('^v?(' + NUM + ')\\.(' + NUM + ')\\.(' + NUM + ')(?:-(' + PRE + '))?$')
const XP = '(?:\\*|x|X|0|[1-9]\\d*)'
const PARTIAL = new RegExp('^v?(' + XP + ')(?:\\.(' + XP + ')(?:\\.(' + XP + ')(?:-(' + PRE + '))?)?)?$')

export function parse(v) {
  const m = typeof v === 'string' ? FULL.exec(v.trim()) : null
  if (!m) throw new TypeError('invalid version: ' + v)
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
const isNum = (s) => /^\d+$/.test(s)
function cmpParsed(x, y) {
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const a = x.pre[i], b = y.pre[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const an = isNum(a), bn = isNum(b)
    if (an && bn) return +a < +b ? -1 : 1
    if (an) return -1
    if (bn) return 1
    return a < b ? -1 : 1
  }
  return 0
}
export function compare(a, b) { return cmpParsed(parse(a), parse(b)) }

const isX = (s) => s === undefined || s === '*' || s === 'x' || s === 'X'
const V = (M, m, p, pre = []) => ({ major: M, minor: m, patch: p, pre })
function partial(s) {
  const m = PARTIAL.exec(s)
  if (!m) throw new TypeError('bad partial ' + s)
  const parts = [m[1], m[2], m[3]]
  let n = 0
  while (n < 3 && !isX(parts[n])) n++
  for (let i = n; i < 3; i++) if (!isX(parts[i])) throw new TypeError('bad partial ' + s)
  if (m[4] && n < 3) throw new TypeError('bad partial ' + s)
  return { n, M: +parts[0] || 0, m: +parts[1] || 0, p: +parts[2] || 0, pre: m[4] ? m[4].split('.') : [] }
}
function xrange(q) {
  if (q.n === 0) return []
  if (q.n === 1) return [['>=', V(q.M, 0, 0)], ['<', V(q.M + 1, 0, 0)]]
  if (q.n === 2) return [['>=', V(q.M, q.m, 0)], ['<', V(q.M, q.m + 1, 0)]]
  return [['=', V(q.M, q.m, q.p, q.pre)]]
}
function token(t) {
  let m
  if ((m = /^\^(.+)$/.exec(t))) {
    const q = partial(m[1])
    if (q.n === 0) return []
    const lo = ['>=', V(q.M, q.m, q.p, q.pre)]
    if (q.n === 1 || q.M > 0) return [lo, ['<', V(q.M + 1, 0, 0)]]
    if (q.n === 2 || q.m > 0) return [lo, ['<', V(0, q.m + 1, 0)]]
    return [lo, ['<', V(0, 0, q.p + 1)]]
  }
  if ((m = /^~(.+)$/.exec(t))) {
    const q = partial(m[1])
    if (q.n === 0) return []
    const lo = ['>=', V(q.M, q.m, q.p, q.pre)]
    if (q.n === 1) return [lo, ['<', V(q.M + 1, 0, 0)]]
    return [lo, ['<', V(q.M, q.m + 1, 0)]]
  }
  if ((m = /^(<=|>=|<|>|=)?(.+)$/.exec(t))) {
    const op = m[1] || '='
    const q = partial(m[2])
    if (q.n === 3) return [[op, V(q.M, q.m, q.p, q.pre)]]
    if (op === '=') return xrange(q)
    if (q.n === 0) return op === '<' || op === '>' ? [['<', V(0, 0, 0)]] : []
    const up = q.n === 1 ? V(q.M + 1, 0, 0) : V(q.M, q.m + 1, 0)
    const lo = V(q.M, q.n === 2 ? q.m : 0, 0)
    if (op === '>=') return [['>=', lo]]
    if (op === '<') return [['<', lo]]
    if (op === '>') return [['>=', up]]
    return [['<', up]]
  }
  throw new TypeError('bad token ' + t)
}
function parseSet(set) {
  const s = set.trim()
  if (s === '') return []
  const h = /^(\S+)\s+-\s+(\S+)$/.exec(s)
  if (h) {
    const a = partial(h[1]), b = partial(h[2])
    const out = [['>=', V(a.M, a.m, a.p, a.n === 3 ? a.pre : [])]]
    if (b.n === 3) out.push(['<=', V(b.M, b.m, b.p, b.pre)])
    else if (b.n === 2) out.push(['<', V(b.M, b.m + 1, 0)])
    else if (b.n === 1) out.push(['<', V(b.M + 1, 0, 0)])
    return out
  }
  const toks = s.replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1').split(/\s+/)
  return toks.flatMap(token)
}
function test1(v, [op, c]) {
  const r = cmpParsed(v, c)
  switch (op) {
    case '=': return r === 0
    case '>': return r > 0
    case '>=': return r >= 0
    case '<': return r < 0
    case '<=': return r <= 0
  }
  return false
}
export function satisfies(version, range) {
  try {
    const v = parse(version)
    if (typeof range !== 'string') return false
    const sets = range.split('||').map(parseSet)
    return sets.some((set) => {
      if (!set.every((c) => test1(v, c))) return false
      if (!v.pre.length) return true
      return set.some(([, c]) => c.pre.length && c.major === v.major && c.minor === v.minor && c.patch === v.patch)
    })
  } catch {
    return false
  }
}
