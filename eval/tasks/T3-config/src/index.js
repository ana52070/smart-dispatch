import { parseIni } from './ini.js'
import { coerce } from './coerce.js'

export class ConfigError extends Error {}

export function loadConfig({ schema, files = [] }) {
  const flat = {}
  for (const [key, spec] of Object.entries(schema)) {
    if ('default' in spec) flat[key] = spec.default
  }
  for (const text of files) {
    for (const [key, value] of Object.entries(parseIni(text))) {
      flat[key] = coerce(schema[key].type, value)
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.')
    let node = out
    for (const p of parts.slice(0, -1)) node = node[p] = node[p] || {}
    node[parts[parts.length - 1]] = value
  }
  return out
}
