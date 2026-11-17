export class ConfigError extends Error {
  constructor(errors) {
    super(errors.length + ' config error(s): ' + errors.join('; '))
    this.errors = errors
  }
}

function parseQuoted(s) {
  let out = ''
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[++i]
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : '\\' + n
      continue
    }
    if (ch === '"') return { value: out, rest: s.slice(i + 1) }
    out += ch
  }
  return null
}

function parseIni(text, fileNo, errors) {
  const out = []
  let prefix = ''
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim()
    const where = 'file ' + fileNo + ' line ' + (idx + 1)
    if (!line || line[0] === ';' || line[0] === '#') return
    const sec = /^\[([^\]]+)\]$/.exec(line)
    if (sec) { prefix = sec[1].trim() + '.'; return }
    const eq = line.indexOf('=')
    const key = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!key) { errors.push(where + ': unrecognized line'); return }
    const rest = line.slice(eq + 1).trim()
    let value
    if (rest[0] === '"') {
      const q = parseQuoted(rest)
      if (!q) { errors.push(where + ': unterminated quote'); return }
      const tail = q.rest.trimStart()
      if (tail && !(/^\s/.test(q.rest) && (tail[0] === ';' || tail[0] === '#'))) { errors.push(where + ': text after quoted value'); return }
      value = q.value
    } else {
      const m = /\s[;#]/.exec(rest)
      value = (m ? rest.slice(0, m.index) : rest).trim()
    }
    out.push([prefix + key, value])
  })
  return out
}

const TRUE = ['true', '1', 'yes', 'on'], FALSE = ['false', '0', 'no', 'off']
function coerce(key, type, value, errors) {
  if (typeof value !== 'string') return { ok: true, value }
  switch (type) {
    case 'string': return { ok: true, value }
    case 'number': {
      const t = value.trim(), n = Number(t)
      if (t === '' || !Number.isFinite(n)) { errors.push('invalid number for "' + key + '": ' + value); return { ok: false } }
      return { ok: true, value: n }
    }
    case 'boolean': {
      const t = value.trim().toLowerCase()
      if (TRUE.includes(t)) return { ok: true, value: true }
      if (FALSE.includes(t)) return { ok: true, value: false }
      errors.push('invalid boolean for "' + key + '": ' + value); return { ok: false }
    }
    case 'array': return { ok: true, value: value.split(',').map((x) => x.trim()).filter(Boolean) }
  }
  errors.push('bad schema type for "' + key + '"'); return { ok: false }
}

export function loadConfig({ schema, files = [], env = {}, argv = [] }) {
  const errors = []
  const flat = new Map()
  for (const [key, spec] of Object.entries(schema)) {
    if ('default' in spec) flat.set(key, Array.isArray(spec.default) ? spec.default.slice() : spec.default)
  }
  const apply = (pairs) => {
    for (const [key, value] of pairs) {
      const spec = schema[key]
      if (!spec) { errors.push('unknown key "' + key + '"'); continue }
      const c = coerce(key, spec.type, value, errors)
      if (c.ok) flat.set(key, c.value)
    }
  }
  files.forEach((text, i) => apply(parseIni(text, i + 1, errors)))
  apply(Object.entries(env).filter(([k]) => k.startsWith('APP_')).map(([k, v]) => [k.slice(4).split('__').map((s) => s.toLowerCase()).join('.'), v]))
  const fromArgv = []
  for (const arg of argv) {
    if (!arg.startsWith('--')) { errors.push('unexpected argument "' + arg + '"'); continue }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) { fromArgv.push([body.slice(0, eq), body.slice(eq + 1)]); continue }
    if (schema[body]) {
      if (schema[body].type === 'boolean') fromArgv.push([body, true])
      else errors.push('missing value for "' + body + '"')
      continue
    }
    if (body.startsWith('no-') && schema[body.slice(3)]) {
      if (schema[body.slice(3)].type === 'boolean') fromArgv.push([body.slice(3), false])
      else errors.push('missing value for "' + body.slice(3) + '" (cannot negate)')
      continue
    }
    errors.push('unknown key "' + body + '"')
  }
  apply(fromArgv)
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.required && !flat.has(key)) errors.push('missing required "' + key + '"')
  }
  if (errors.length) throw new ConfigError(errors)
  const out = {}
  for (const [key, value] of flat) {
    const parts = key.split('.')
    let node = out
    for (const p of parts.slice(0, -1)) node = node[p] = node[p] || {}
    node[parts[parts.length - 1]] = value
  }
  return out
}
