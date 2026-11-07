import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const CONTROLLER_URL = new URL('../scripts/wait-controller.js', import.meta.url)

// Load the SAME production file via vm. No implementation is copied here.
// If the file or the function is missing, the loader throws so every test
// fails for the expected reason ("feature missing"), not as a module error.
function loadController(extra = {}) {
  let source = ''
  try {
    source = readFileSync(CONTROLLER_URL, 'utf8')
  } catch {
    source = ''
  }
  const context = vm.createContext(extra)
  vm.runInContext(source, context, { filename: 'wait-controller.js' })
  if (typeof context.waitUntilActionable !== 'function') {
    throw new Error('waitUntilActionable is not implemented in scripts/wait-controller.js')
  }
  return context.waitUntilActionable
}

// The controller runs inside a vm realm, so its returned objects/arrays have a
// different prototype from the test realm. Clone them back into this realm so
// assert.deepStrictEqual compares data rather than realm identity.
async function run(opts, extra) {
  const r = await loadController(extra)(opts)
  return JSON.parse(JSON.stringify(r))
}

function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    peek: () => t,
  }
}

// A scripted, observable callStatus. step fields:
//   type: 'return' | 'throw'
//   value: returned result object or thrown value
//   advance: ms added to the injected fake clock during this single call
//   realDelay: real setTimeout ms (for the small real-timing serial test)
//   before: optional (clock) => void
function makeHarness(steps, clock) {
  let index = 0
  let active = 0
  let maxActive = 0
  const calls = []
  const callStatus = async (args) => {
    calls.push(JSON.parse(JSON.stringify(args)))
    active += 1
    if (active > maxActive) maxActive = active
    try {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      if (step.realDelay) await new Promise((r) => setTimeout(r, step.realDelay))
      if (step.advance && clock) clock.advance(step.advance)
      if (step.before) step.before(clock)
      await Promise.resolve()
      if (step.type === 'throw') throw step.value
      return step.value
    } finally {
      active -= 1
    }
  }
  return { callStatus, calls, stats: () => ({ count: index, maxActive, active }) }
}

function opts(harness, clock, taskIds = ['A'], retryPolicy) {
  const o = {
    taskIds,
    callStatus: harness.callStatus,
    now: clock ? clock.now : () => Date.now(),
  }
  if (retryPolicy) o.retryPolicy = retryPolicy
  return o
}

function task(id, status, extra = {}) {
  return { task_id: id, status, ...extra }
}

// A well-formed get_delegation_status result: structuredContent.tasks plus the
// same batch as compact JSON content text.
function batch(tasks, isError = false) {
  const envelope = { tasks }
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError,
  }
}

// A host that drops structuredContent and keeps only the JSON text.
function textBatch(tasks) {
  return { content: [{ type: 'text', text: JSON.stringify({ tasks }) }], isError: false }
}

function toolError(text, isError = true) {
  return { content: [{ type: 'text', text }], isError }
}

const timeoutText = (d = '300s') =>
  'tool call error: tool call failed for codeg-mcp/get_delegation_status ' +
  'Caused by: timed out awaiting tools/call after ' + d

// The exact multi-line shape observed in real MCP tool errors.
const multiLineTimeout = [
  'tool call error: tool call failed for `codeg-mcp/get_delegation_status`',
  '',
  'Caused by:',
  '    timed out awaiting tools/call after 300s',
].join(String.fromCharCode(10))

// ---------------------------------------------------------------------------
// Happy path / batch parsing
// ---------------------------------------------------------------------------

test('completed batch returns actionable result in one call with exact wait_ms:0 args', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: batch([task('A', 'completed')]), advance: 10 }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.tasks[0].status, 'completed')
  assert.deepEqual(r.remaining_task_ids, [])
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.equal(r.elapsed_ms, 10)
  assert.equal(r.last_transport_error, null)
  assert.deepEqual(h.calls[0], { task_ids: ['A'], wait_ms: 0 })
})

test('structuredContent.tasks takes priority over a different content text batch', async () => {
  const clock = makeClock()
  const result = batch([task('A', 'completed')])
  // text carries a pure-running batch that would be a protocol anomaly.
  result.content = [{ type: 'text', text: JSON.stringify({ tasks: [task('A', 'running')] }) }]
  const h = makeHarness([{ type: 'return', value: result }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.tasks[0].status, 'completed')
})

test('falls back to a pure JSON text batch when structuredContent is absent', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: textBatch([task('A', 'completed')]) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.retry_count, 0)
})

test('snake_case structured_content key is also accepted', async () => {
  const clock = makeClock()
  const result = { content: [], structured_content: { tasks: [task('A', 'completed')] }, isError: false }
  const h = makeHarness([{ type: 'return', value: result }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
})

test('a valid failed task with isError=true is a task result, never retried', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: batch([task('A', 'failed')], true) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.equal(r.last_transport_error, null)
})

test('timeout string inside a legitimate subtask body is ignored', async () => {
  const clock = makeClock()
  const body = task('A', 'completed', { text: 'child saw timed out awaiting tools/call after 300s in a log' })
  const h = makeHarness([{ type: 'return', value: batch([body]) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.equal(r.last_transport_error, null)
})

// ---------------------------------------------------------------------------
// Actionable stopping conditions
// ---------------------------------------------------------------------------

for (const kind of ['permission', 'question', 'plan_approval']) {
  test('blocked_on ' + kind + ' returns actionable and preserves kind/request_id/title', async () => {
    const clock = makeClock()
    const blocked = { kind, request_id: 'req-' + kind, title: 'Decide ' + kind }
    const h = makeHarness([{ type: 'return', value: batch([task('A', 'running', { blocked_on: blocked })]) }], clock)
    const r = await run(opts(h, clock, ['A']))
    assert.equal(r.kind, 'actionable')
    assert.deepEqual(r.tasks[0].blocked_on, blocked)
    assert.deepEqual(r.remaining_task_ids, [])
  })
}

test('unknown status is handed off explicitly as actionable', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: batch([task('A', 'unknown')]) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.tasks[0].status, 'unknown')
  assert.deepEqual(r.remaining_task_ids, [])
})

test('mixed batch returns whole batch and only running-no-blocked remaining IDs', async () => {
  const clock = makeClock()
  const tasks = [
    task('A', 'completed'),
    task('B', 'failed'),
    task('C', 'canceled'),
    task('D', 'unknown'),
    task('E', 'running'),
    task('F', 'running', { blocked_on: { kind: 'question', request_id: 'q1', title: 'Which?' } }),
  ]
  const ids = ['A', 'B', 'C', 'D', 'E', 'F']
  const h = makeHarness([{ type: 'return', value: batch(tasks) }], clock)
  const r = await run(opts(h, clock, ids))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.tasks.length, 6)
  assert.deepEqual(r.remaining_task_ids, ['E'])
})

test('pure running normal return is a protocol anomaly and does not loop', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: batch([task('A', 'running')]) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'protocol_anomaly')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.ok(typeof r.message === 'string' && r.message.length > 0)
})

// ---------------------------------------------------------------------------
// Timeout recovery (returned isError and thrown forms)
// ---------------------------------------------------------------------------

test('two real-duration timeouts then success (fake clock, no 5-minute wait)', async () => {
  const clock = makeClock()
  const h = makeHarness(
    [
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 300000 },
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 300000 },
      { type: 'return', value: batch([task('A', 'completed')]), advance: 5 },
    ],
    clock,
  )
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.wait_call_count, 3)
  assert.equal(r.retry_count, 2)
  assert.equal(r.elapsed_ms, 600005)
  assert.equal(r.last_transport_error.error_class, 'timeout')
  assert.equal(r.last_transport_error.duration_token, '300s')
  assert.deepEqual(r.remaining_task_ids, [])
  for (const c of h.calls) assert.deepEqual(c, { task_ids: ['A'], wait_ms: 0 })
})

test('returned isError timeout in the real multi-line "Caused by" shape is recovered', async () => {
  const clock = makeClock()
  const h = makeHarness(
    [
      { type: 'return', value: toolError(multiLineTimeout, true), advance: 300000 },
      { type: 'return', value: batch([task('A', 'completed')]) },
    ],
    clock,
  )
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.retry_count, 1)
  assert.equal(r.last_transport_error.form, 'returned')
})

test('thrown timeout transport error is recovered', async () => {
  const clock = makeClock()
  const h = makeHarness(
    [
      { type: 'throw', value: new Error('tool call error: timed out awaiting tools/call after 300s'), advance: 300000 },
      { type: 'return', value: batch([task('A', 'completed')]) },
    ],
    clock,
  )
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.retry_count, 1)
  assert.equal(r.last_transport_error.form, 'thrown')
  assert.equal(r.last_transport_error.error_class, 'timeout')
})

test('variable timeout durations are parsed into ms and token (600s, 1000ms, 45s)', async () => {
  for (const [d, ms] of [['600s', 600000], ['1000ms', 1000], ['45s', 45000]]) {
    const clock = makeClock()
    const h = makeHarness(
      [
        { type: 'return', value: toolError(timeoutText(d), true), advance: ms },
        { type: 'return', value: batch([task('A', 'completed')]) },
      ],
      clock,
    )
    const r = await run(opts(h, clock, ['A']))
    assert.equal(r.kind, 'actionable', 'duration ' + d)
    assert.equal(r.last_transport_error.timeout_ms, ms, 'duration ' + d)
    assert.equal(r.last_transport_error.duration_token, d, 'duration ' + d)
    assert.equal(r.retry_count, 1, 'duration ' + d)
  }
})

test('normal-duration timeouts have no total retry limit and calls never overlap', async () => {
  const clock = makeClock()
  const steps = []
  for (let i = 0; i < 5; i++) {
    steps.push({ type: 'return', value: toolError(timeoutText('300s'), true), advance: 300000 })
  }
  steps.push({ type: 'return', value: batch([task('A', 'completed')]) })
  const h = makeHarness(steps, clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.wait_call_count, 6)
  assert.equal(r.retry_count, 5)
  assert.equal(r.elapsed_ms, 1500000)
  assert.equal(h.stats().maxActive, 1)
})

test('a normal timeout resets the fast-repeat counter', async () => {
  const clock = makeClock()
  const h = makeHarness(
    [
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 0 },
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 300000 },
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 0 },
      { type: 'return', value: batch([task('A', 'completed')]) },
    ],
    clock,
  )
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'actionable')
  assert.equal(r.wait_call_count, 4)
  assert.equal(r.retry_count, 3)
})

test('immediate repeated same timeout circuit-breaks after maxFastRepeats', async () => {
  const clock = makeClock()
  const h = makeHarness(
    [
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 0 },
      { type: 'return', value: toolError(timeoutText('300s'), true), advance: 0 },
      { type: 'return', value: batch([task('A', 'completed')]) },
    ],
    clock,
  )
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'timeout_exhausted')
  assert.equal(r.wait_call_count, 2)
  assert.equal(r.retry_count, 1)
  assert.equal(h.calls.length, 2)
  assert.ok(r.message.includes('timeout_exhausted'))
  assert.equal(r.last_transport_error.error_class, 'timeout')
})

// ---------------------------------------------------------------------------
// Errors that must NOT be swallowed or retried
// ---------------------------------------------------------------------------

test('authentication error returns diagnostic without retry', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: toolError('Mcp error: authentication failed: invalid or expired token (401)', true) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'transport_error')
  assert.equal(r.error_class, 'authentication')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.ok(r.message.includes('authentication'))
})

test('disconnect error returns diagnostic without retry', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: toolError('transport error: connection closed by peer (ECONNRESET / socket hang up)', true) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'transport_error')
  assert.equal(r.error_class, 'disconnected')
  assert.equal(r.wait_call_count, 1)
})

test('parameter error (-32602) returns diagnostic without retry', async () => {
  const clock = makeClock()
  const realParamError = [
    'tool call error: tool call failed for `codeg-mcp/get_delegation_status`',
    '',
    'Caused by:',
    '    Mcp error: -32602: get_delegation_status requires a non-empty task_ids array',
  ].join(String.fromCharCode(10))
  const h = makeHarness([{ type: 'return', value: toolError(realParamError, true) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'transport_error')
  assert.equal(r.error_class, 'invalid_arguments')
  assert.equal(r.wait_call_count, 1)
})

test('unknown thrown exception returns diagnostic with evidence, no retry', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'throw', value: new Error('some wholly unknown failure') }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'transport_error')
  assert.equal(r.error_class, 'unknown')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.ok(r.message.includes('unknown failure'))
  assert.equal(r.last_transport_error.form, 'thrown')
})

test('a non-error result merely containing the timeout phrase is not auto-recovered', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: toolError(timeoutText('300s'), false) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'malformed_response')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
  assert.equal(r.last_transport_error, null)
})

test('unparseable non-error text is a malformed response, not a retry', async () => {
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: toolError('this is not json at all', false) }], clock)
  const r = await run(opts(h, clock, ['A']))
  assert.equal(r.kind, 'malformed_response')
  assert.equal(r.wait_call_count, 1)
  assert.equal(r.retry_count, 0)
})

// ---------------------------------------------------------------------------
// Malformed batches: ID set / status / blocked_on contract violations
// ---------------------------------------------------------------------------

const malformedCases = {
  'missing id': { ids: ['A', 'B'], tasks: [task('A', 'completed')] },
  'extra id': { ids: ['A'], tasks: [task('A', 'completed'), task('C', 'completed')] },
  'duplicate id': { ids: ['A', 'B'], tasks: [task('A', 'completed'), task('A', 'completed')] },
  'bad status type': { ids: ['A'], tasks: [{ task_id: 'A', status: 7 }] },
  'unknown status string': { ids: ['A'], tasks: [task('A', 'done')] },
  'blocked_on missing request_id': {
    ids: ['A'],
    tasks: [task('A', 'running', { blocked_on: { kind: 'question' } })],
  },
  'blocked_on bad kind': {
    ids: ['A'],
    tasks: [task('A', 'running', { blocked_on: { kind: 5, request_id: 'r1' } })],
  },
}

for (const [name, spec] of Object.entries(malformedCases)) {
  test('malformed response (' + name + ') returns diagnostic without retry', async () => {
    const clock = makeClock()
    const h = makeHarness([{ type: 'return', value: batch(spec.tasks, false) }], clock)
    const r = await run(opts(h, clock, spec.ids))
    assert.equal(r.kind, 'malformed_response')
    assert.equal(r.wait_call_count, 1)
    assert.equal(r.retry_count, 0)
  })
}

// ---------------------------------------------------------------------------
// Input validation / purity / no side effects
// ---------------------------------------------------------------------------

const invalidInputs = {
  'empty taskIds': [],
  'duplicate taskIds': ['A', 'A'],
  'non-string id': ['A', 5],
  'empty-string id': ['A', ''],
}
for (const [name, ids] of Object.entries(invalidInputs)) {
  test('invalid input (' + name + ') returns invalid_input with no tool call', async () => {
    const clock = makeClock()
    const h = makeHarness([{ type: 'return', value: batch([task('A', 'completed')]) }], clock)
    const r = await run(opts(h, clock, ids))
    assert.equal(r.kind, 'invalid_input')
    assert.equal(r.wait_call_count, 0)
    assert.equal(h.calls.length, 0)
  })
}

test('missing callStatus function returns invalid_input with no call', async () => {
  const r = await run({ taskIds: ['A'], now: () => 0 })
  assert.equal(r.kind, 'invalid_input')
  assert.equal(r.wait_call_count, 0)
})

test('no other side effects: exact args, no console output, input array unchanged', async () => {
  const logs = []
  const wait = loadController({ console: { log: (...a) => logs.push(a) } })
  const clock = makeClock()
  const h = makeHarness([{ type: 'return', value: batch([task('A', 'completed')]), advance: 3 }], clock)
  const taskIds = ['A']
  const snapshot = taskIds.slice()
  const r = await wait(opts(h, clock, taskIds))
  assert.equal(r.kind, 'actionable')
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0], { task_ids: ['A'], wait_ms: 0 })
  assert.deepEqual(Object.keys(h.calls[0]).sort(), ['task_ids', 'wait_ms'])
  assert.deepEqual(taskIds, snapshot)
  assert.equal(logs.length, 0)
})

// ---------------------------------------------------------------------------
// Small real-timing serial verification (tens of ms; NOT the 650s real wait)
// ---------------------------------------------------------------------------

test('small real-time waits prove serial execution without a 650s wait', async () => {
  const h = makeHarness(
    [
      { type: 'return', value: toolError(timeoutText('10ms'), true), realDelay: 15 },
      { type: 'return', value: toolError(timeoutText('10ms'), true), realDelay: 15 },
      { type: 'return', value: batch([task('A', 'completed')]), realDelay: 5 },
    ],
    null,
  )
  const r = await run({
    taskIds: ['A'],
    callStatus: h.callStatus,
    now: () => Date.now(),
  })
  assert.equal(r.kind, 'actionable')
  assert.equal(r.wait_call_count, 3)
  assert.equal(r.retry_count, 2)
  assert.ok(r.elapsed_ms >= 25, 'real elapsed should exceed ~25ms, got ' + r.elapsed_ms)
  assert.equal(h.stats().maxActive, 1)
})

for (const message of [
  timeoutText('300.5.4s'),
  timeoutText('300s') + ' followed by an authentication failure',
  'Authentication failed; previous log: timed out awaiting tools/call after 300s',
  timeoutText('0s'),
]) {
  test('noncanonical or embedded timeout does not retry: ' + message, async () => {
    const clock = makeClock()
    const h = makeHarness([
      { type: 'return', value: toolError(message), advance: 300000 },
      { type: 'return', value: batch([task('A', 'completed')]) },
    ], clock)
    const r = await run(opts(h, clock))
    assert.equal(r.kind, 'transport_error')
    assert.equal(h.calls.length, 1)
  })
}

test('unknown blocked kind is rejected rather than treated as a valid prompt', async () => {
  const h = makeHarness([{ type: 'return', value: batch([
    task('A', 'running', { blocked_on: { kind: 'made_up', request_id: 'q' } }),
  ]) }], makeClock())
  const r = await run(opts(h, makeClock()))
  assert.equal(r.kind, 'malformed_response')
  assert.equal(h.calls.length, 1)
})

test('consecutive rapid timeouts with changing durations also circuit-break', async () => {
  const clock = makeClock()
  const h = makeHarness([
    { type: 'return', value: toolError(timeoutText('300s')) },
    { type: 'return', value: toolError(timeoutText('600s')) },
    { type: 'return', value: batch([task('A', 'completed')]) },
  ], clock)
  const r = await run(opts(h, clock))
  assert.equal(r.kind, 'timeout_exhausted')
  assert.equal(h.calls.length, 2)
})

for (const policy of [
  { maxFastRepeats: 0 }, { maxFastRepeats: NaN }, { maxFastRepeats: Infinity },
  { maxFastRepeats: '2' }, { fastRatio: -1 }, { fastRatio: 0 },
  { fastRatio: NaN }, { fastRatio: 1.1 },
]) {
  test('invalid retry policy makes no tool call: ' + String(Object.values(policy)[0]), async () => {
    const h = makeHarness([{ type: 'return', value: batch([task('A', 'completed')]) }], makeClock())
    const r = await run(opts(h, makeClock(), ['A'], policy))
    assert.equal(r.kind, 'invalid_input')
    assert.equal(h.calls.length, 0)
  })
}

test('whitespace task IDs are rejected before the tool can normalize them', async () => {
  const h = makeHarness([{ type: 'return', value: batch([task(' A ', 'completed')]) }], makeClock())
  const r = await run(opts(h, makeClock(), [' A ']))
  assert.equal(r.kind, 'invalid_input')
  assert.equal(h.calls.length, 0)
})

test('documented invocation runs in a console-free Code Mode environment', async () => {
  const reference = readFileSync(new URL('../references/wait-controller.md', import.meta.url), 'utf8')
  const template = reference.match(/```js\r?\n([\s\S]*?)```/)[1]
  const source = readFileSync(CONTROLLER_URL, 'utf8')
  const output = []
  const context = vm.createContext({
    console: undefined,
    text: (value) => output.push(value),
    tools: {
      mcp__codeg_mcp__get_delegation_status: async ({ task_ids, wait_ms }) => {
        assert.equal(wait_ms, 0)
        return batch(Array.from(task_ids, (id) => task(id, 'completed')))
      },
    },
  })
  await vm.runInContext('(async () => {\n' + source + '\n' + template + '\n})()', context)
  assert.equal(output.length, 1)
  const result = typeof output[0] === 'string' ? JSON.parse(output[0]) : output[0]
  assert.equal(result.kind, 'actionable')
})

test('24 concurrent controller instances keep task IDs, retry counters and clocks isolated', async () => {
  const wait = loadController()
  let activeGlobally = 0
  let maxGlobally = 0
  const outputs = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const id = 'main-' + index + '-child'
    const clock = makeClock()
    const retries = index % 3
    let calls = 0
    let activeHere = 0
    let maxHere = 0
    const result = await wait({
      taskIds: [id], now: clock.now,
      callStatus: async (args) => {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { task_ids: [id], wait_ms: 0 })
        calls++; activeHere++; activeGlobally++
        maxHere = Math.max(maxHere, activeHere)
        maxGlobally = Math.max(maxGlobally, activeGlobally)
        try {
          await Promise.resolve()
          if (calls <= retries) {
            clock.advance(1000)
            return toolError(timeoutText('1s'))
          }
          return batch([task(id, 'completed', { text: 'result-' + index })])
        } finally { activeHere--; activeGlobally-- }
      },
    })
    assert.equal(maxHere, 1)
    assert.equal(calls, retries + 1)
    assert.equal(result.retry_count, retries)
    assert.equal(result.elapsed_ms, retries * 1000)
    assert.equal(result.tasks[0].task_id, id)
    assert.equal(result.tasks[0].text, 'result-' + index)
    return result
  }))
  assert.equal(outputs.length, 24)
  assert.ok(maxGlobally > 1, 'independent instances must actually overlap')
  assert.equal(activeGlobally, 0)
})

test('one main waits for three parallel children in batches and removes completed IDs', async () => {
  const wait = loadController()
  const state = new Map(['A', 'B', 'C'].map((id) => [id, 'running']))
  const finish = {}
  const jobs = new Map(['A', 'B', 'C'].map((id) => [id, new Promise((resolve) => {
    finish[id] = () => { state.set(id, 'completed'); resolve() }
  })]))
  const calls = []
  const callStatus = async ({ task_ids, wait_ms }) => {
    assert.equal(wait_ms, 0)
    calls.push(Array.from(task_ids))
    await Promise.race(Array.from(task_ids, (id) => jobs.get(id)))
    return batch(Array.from(task_ids, (id) => task(id, state.get(id))))
  }
  let pending = ['A', 'B', 'C']
  for (const id of ['A', 'B', 'C']) {
    const waiting = wait({ taskIds: pending, callStatus })
    finish[id]()
    const result = await waiting
    assert.equal(result.kind, 'actionable')
    pending = Array.from(result.remaining_task_ids)
    assert.ok(!pending.includes(id))
  }
  assert.deepEqual(calls, [['A', 'B', 'C'], ['B', 'C'], ['C']])
  assert.deepEqual(pending, [])
})
