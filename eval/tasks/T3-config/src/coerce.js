export function coerce(type, value) {
  if (type === 'number') return Number(value)
  return value
}
