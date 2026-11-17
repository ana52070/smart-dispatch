// Minimal INI parser: returns a flat { 'section.key': 'value' } map.
let prefix = ''

export function parseIni(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      prefix = sec[1] + '.'
      continue
    }
    const [k, v] = line.split('=')
    out[prefix + k.trim()] = (v || '').trim()
  }
  return out
}
