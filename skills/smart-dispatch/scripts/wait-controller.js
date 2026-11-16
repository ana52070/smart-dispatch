// wait-controller.js — smart-dispatch wait controller (version 1.1.0)
//
// Pure, dependency-free and host-neutral. No import / require / fs / process.
//
// Two layers share ONE set of semantics:
//   1. wcCreateWaitState(opts) + wcDecide(state, outcome)
//      A pure decision state machine: feed it the outcome of one
//      get_delegation_status call, it says "call again" or "return <result>".
//   2. waitUntilActionable(opts)
//      An automatic loop over (1) for hosts that have a JS execution unit able
//      to call the session's MCP tools (see references/wait-controller.md).
//      Hosts without such a unit follow the same table manually
//      (references/waiting.md, "direct-call mode").
//
// An ordinary Node subprocess has no session MCP tools: paste the WHOLE file
// into the host's execution unit and bind `callStatus` there.
//
// Contract:
//   await waitUntilActionable({ taskIds, callStatus, retryPolicy, now })
// `callStatus` is awaited strictly one at a time with exactly
// { task_ids: taskIds, wait_ms: 0 }. The controller never dispatches,
// resumes, or cancels subtasks, prints nothing, and keeps no cross-session
// state. Every run is bounded by retryPolicy.maxTotalMs (default 30 min) and
// optionally maxWaitCalls; reaching a bound returns kind 'stalled' so the main
// agent can check child progress instead of waiting forever.

var WC_VERSION = '1.1.0';
var WC_DEFAULTS = { maxFastRepeats: 2, fastRatio: 0.5, maxTotalMs: 1800000, maxWaitCalls: null };
var WC_STATUSES = ['running', 'completed', 'failed', 'canceled', 'unknown'];
var WC_BLOCKED_KINDS = ['permission', 'question', 'plan_approval'];

function wcUnitMs(unit) {
  switch (unit) {
    case 'ns': return 1e-6;
    case 'us': return 1e-3;
    case 'ms': return 1;
    case 's': return 1000;
    case 'm': return 60000;
    case 'h': return 3600000;
    default: return null;
  }
}

// Strictly identify the canonical transport timeout. Returns null for any
// other wording; a stray 'timeout' word is never enough to auto-recover.
// Known canonical shapes (each must match the WHOLE diagnostic):
//   Codex:       [tool call error: tool call failed for `x/get_delegation_status` Caused by:]
//                timed out awaiting tools/call after 300s
//   Claude Code: MCP server "codeg-mcp" tool "get_delegation_status" sent no
//                response or progress for 1800s; aborting. [If this server is
//                configured ... (0 disables).]
var WC_TIMEOUT_SHAPES = [
  /^(?:tool call error:\s*(?:tool call failed for (?:`[^`\s]*get_delegation_status`|[^\s`]*get_delegation_status)\s+Caused by:\s*)?)?timed out awaiting tools\/call after ([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h)$/,
  /^MCP server "[^"\r\n]+" tool "[^"\s]*get_delegation_status" sent no response or progress for ([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h); aborting\.(?: If this server is configured in your MCP settings, set a per-server "timeout" \(ms\) to allow longer silent runs for just this server; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT \(ms\) globally \(0 disables\)\.)?$/,
];

function wcMatchTimeout(text) {
  var trimmed = text.trim();
  var match = null;
  for (var i = 0; i < WC_TIMEOUT_SHAPES.length && !match; i += 1) match = WC_TIMEOUT_SHAPES[i].exec(trimmed);
  if (!match) return null;
  var value = Number(match[1]);
  var unit = match[2];
  var factor = wcUnitMs(unit);
  if (value <= 0 || !Number.isFinite(value * factor)) return null;
  return { token: value + unit, timeout_ms: value * factor };
}

function wcContentTexts(content) {
  var out = [];
  if (typeof content === 'string') {
    out.push(content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (var i = 0; i < content.length; i += 1) {
    var b = content[i];
    if (b && typeof b === 'object' && typeof b.text === 'string') out.push(b.text);
    else if (typeof b === 'string') out.push(b);
  }
  return out;
}

// Collect evidence text from either a returned MCP result or a thrown value.
function wcTextOf(value) {
  var parts = [];
  if (typeof value === 'string') parts.push(value);
  else if (value && typeof value === 'object') {
    if (typeof value.message === 'string') parts.push(value.message);
    if (typeof value.text === 'string') parts.push(value.text);
    if (typeof value.error === 'string') parts.push(value.error);
    var texts = wcContentTexts(value.content);
    for (var i = 0; i < texts.length; i += 1) parts.push(texts[i]);
  }
  if (parts.length === 0) {
    if (value == null) parts.push('[no error value]');
    else {
      try { parts.push(String(value)); } catch (e) { parts.push('[unstringifiable error value]'); }
    }
  }
  return parts.join(String.fromCharCode(10));
}

function wcValidateTasks(tasks, ids) {
  if (!Array.isArray(tasks) || tasks.length !== ids.length) return false;
  var requested = new Set(ids);
  var seen = new Set();
  for (var i = 0; i < tasks.length; i += 1) {
    var t = tasks[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
    if (typeof t.task_id !== 'string' || !requested.has(t.task_id) || seen.has(t.task_id)) return false;
    seen.add(t.task_id);
    if (typeof t.status !== 'string' || WC_STATUSES.indexOf(t.status) === -1) return false;
    if (t.status === 'running' && t.blocked_on != null) {
      var b = t.blocked_on;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
      if (WC_BLOCKED_KINDS.indexOf(b.kind) === -1) return false;
      if (typeof b.request_id !== 'string' || b.request_id.length === 0) return false;
      if (b.title != null && typeof b.title !== 'string') return false;
    }
  }
  return seen.size === ids.length;
}

// Priority: a valid structuredContent.tasks batch first, then a pure JSON text
// batch. Returns the validated tasks array or null. Response text is only ever
// JSON.parse'd, never executed.
function wcParseBatch(result, ids) {
  if (!result || typeof result !== 'object') return null;
  var sc = result.structuredContent != null ? result.structuredContent : result.structured_content;
  var candidates = [];
  if (sc && typeof sc === 'object' && Array.isArray(sc.tasks)) candidates.push(sc.tasks);
  var texts = wcContentTexts(result.content);
  for (var i = 0; i < texts.length; i += 1) {
    var parsed;
    try { parsed = JSON.parse(texts[i]); } catch (e) { continue; }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) candidates.push(parsed.tasks);
  }
  for (var c = 0; c < candidates.length; c += 1) {
    if (wcValidateTasks(candidates[c], ids)) return candidates[c];
  }
  return null;
}

// Diagnostic label only: none of these classes is ever retried. Word-bounded
// patterns avoid labelling e.g. "max tokens" or "thereof" as auth/disconnect.
var WC_ERROR_PATTERNS = [
  ['authentication', /\b(?:unauthori[sz]ed|unauthenticated|authenticat\w*|auth(?:orization)? (?:failed|error|required)|forbidden|credentials?|(?:invalid|expired|missing|bad) (?:api |access |bearer )?token|40[13])\b/i],
  ['disconnected', /\b(?:disconnect\w*|connection (?:closed|reset|refused|lost|aborted)|econn\w*|epipe|broken pipe|socket hang up|socket closed|transport closed|unexpected eof|eof)\b/i],
  ['invalid_arguments', /(?:-32602|\binvalid (?:argument|param\w*|input)s?\b|\bbad request\b|\brequires? an?\b|\bnon-empty\b)/i],
];

function wcClassifyErrorClass(text) {
  for (var i = 0; i < WC_ERROR_PATTERNS.length; i += 1) {
    if (WC_ERROR_PATTERNS[i][1].test(text)) return WC_ERROR_PATTERNS[i][0];
  }
  return 'unknown';
}

function wcIsPositiveInteger(v) {
  return Number.isInteger(v) && v >= 1;
}

// Build the mutable state for one bounded wait run, or an invalid_input result.
// Returns { state } or { result }.
function wcCreateWaitState(opts) {
  var o = (opts && typeof opts === 'object') ? opts : {};
  var rp = Object.assign({}, WC_DEFAULTS, (o.retryPolicy && typeof o.retryPolicy === 'object') ? o.retryPolicy : {});
  var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
  var state = {
    ids: null,
    policy: rp,
    now: now,
    startMs: now(),
    wait_call_count: 0,
    retry_count: 0,
    fastRepeatCount: 0,
    last_transport_error: null,
  };

  var ids = Array.isArray(o.taskIds) ? o.taskIds.slice() : null;
  var idsValid = !!ids && ids.length > 0;
  if (idsValid) {
    idsValid = (new Set(ids)).size === ids.length;
    for (var v = 0; v < ids.length; v += 1) {
      if (typeof ids[v] !== 'string' || ids[v].length === 0 || ids[v].trim() !== ids[v]) { idsValid = false; break; }
    }
  }
  state.ids = idsValid ? ids : [];
  if (!idsValid || (o.requireCallStatus !== false && typeof o.callStatus !== 'function')) {
    return { result: wcResult(state, 'invalid_input', {
      message: 'invalid_input: taskIds must be a non-empty array of unique non-empty strings and callStatus must be a function',
      error_class: 'invalid_input',
    }) };
  }

  if (!wcIsPositiveInteger(rp.maxFastRepeats) ||
      !Number.isFinite(rp.fastRatio) || rp.fastRatio <= 0 || rp.fastRatio > 1 ||
      !Number.isFinite(rp.maxTotalMs) || rp.maxTotalMs <= 0 ||
      (rp.maxWaitCalls != null && !wcIsPositiveInteger(rp.maxWaitCalls))) {
    return { result: wcResult(state, 'invalid_input', {
      remaining_task_ids: ids.slice(),
      message: 'invalid_input: maxFastRepeats must be a positive integer, fastRatio in (0, 1], maxTotalMs a positive finite number, maxWaitCalls null or a positive integer',
      error_class: 'invalid_input',
    }) };
  }
  return { state: state };
}

function wcResult(state, kind, extra) {
  return Object.assign({
    kind: kind,
    tasks: [],
    remaining_task_ids: [],
    elapsed_ms: state.now() - state.startMs,
    wait_call_count: state.wait_call_count,
    retry_count: state.retry_count,
    last_transport_error: state.last_transport_error,
  }, extra || {});
}

// The arguments for the next call; also counts the call. Always wait_ms:0.
function wcNextCallArgs(state) {
  state.wait_call_count += 1;
  return { task_ids: state.ids.slice(), wait_ms: 0 };
}

// Pure decision for one finished call.
//   outcome = { form: 'returned' | 'thrown', value, callElapsedMs }
// Returns { action: 'call' } (wait again with the same IDs) or
//         { action: 'return', result }.
function wcDecide(state, outcome) {
  var ids = state.ids;
  var rp = state.policy;
  var form = outcome && outcome.form === 'thrown' ? 'thrown' : 'returned';
  var candidate = outcome ? outcome.value : undefined;
  var callElapsedMs = outcome && Number.isFinite(outcome.callElapsedMs) ? outcome.callElapsedMs : 0;

  // 1) A valid task batch always wins, even when isError is true or the body
  //    happens to contain a timeout string. Never scan a valid batch's text.
  if (form === 'returned') {
    var batchTasks = wcParseBatch(candidate, ids);
    if (batchTasks) {
      var remaining = [];
      for (var r = 0; r < batchTasks.length; r += 1) {
        if (batchTasks[r].status === 'running' && batchTasks[r].blocked_on == null) {
          remaining.push(batchTasks[r].task_id);
        }
      }
      if (remaining.length < batchTasks.length) {
        return { action: 'return', result: wcResult(state, 'actionable', { tasks: batchTasks, remaining_task_ids: remaining }) };
      }
      return { action: 'return', result: wcResult(state, 'protocol_anomaly', {
        tasks: batchTasks,
        remaining_task_ids: ids.slice(),
        message: 'protocol_anomaly: wait_ms=0 returned all running without blocked_on; refusing to poll',
        error_class: 'protocol_anomaly',
      }) };
    }
  }

  // 2) No valid batch: classify the transport / tool error form.
  var text = wcTextOf(candidate);
  var errorForm = form === 'thrown' || (candidate && candidate.isError === true);
  var timeout = errorForm ? wcMatchTimeout(text) : null;

  if (timeout) {
    state.last_transport_error = {
      form: form,
      message: text,
      error_class: 'timeout',
      duration_token: timeout.token,
      timeout_ms: timeout.timeout_ms,
    };
    if (callElapsedMs < timeout.timeout_ms * rp.fastRatio) state.fastRepeatCount += 1;
    else state.fastRepeatCount = 0;
    if (state.fastRepeatCount >= rp.maxFastRepeats) {
      return { action: 'return', result: wcResult(state, 'timeout_exhausted', {
        remaining_task_ids: ids.slice(),
        message: 'timeout_exhausted: ' + rp.maxFastRepeats + ' consecutive near-instant tools/call timeouts; handing off. last=' + text,
        error_class: 'timeout_exhausted',
      }) };
    }
    // 3) Bounded run: hand the decision back instead of waiting forever.
    var elapsed = state.now() - state.startMs;
    var stallReason = null;
    if (elapsed >= rp.maxTotalMs) stallReason = 'max_total_ms';
    else if (rp.maxWaitCalls != null && state.wait_call_count >= rp.maxWaitCalls) stallReason = 'max_wait_calls';
    if (stallReason) {
      return { action: 'return', result: wcResult(state, 'stalled', {
        remaining_task_ids: ids.slice(),
        stall_reason: stallReason,
        message: 'stalled: no actionable result after ' + elapsed + 'ms and ' + state.wait_call_count +
          ' wait calls (' + stallReason + '); check child progress before waiting again',
        error_class: 'stalled',
      }) };
    }
    state.retry_count += 1;
    return { action: 'call' };
  }

  if (errorForm) {
    var errorClass = wcClassifyErrorClass(text);
    state.last_transport_error = {
      form: form,
      message: text,
      error_class: errorClass,
      duration_token: null,
      timeout_ms: null,
    };
    return { action: 'return', result: wcResult(state, 'transport_error', {
      remaining_task_ids: ids.slice(),
      message: 'transport_error[' + errorClass + ']: ' + text,
      error_class: errorClass,
    }) };
  }

  return { action: 'return', result: wcResult(state, 'malformed_response', {
    remaining_task_ids: ids.slice(),
    message: 'malformed_response: no valid task batch and no tool error envelope; ' + text,
    error_class: 'malformed_response',
  }) };
}

async function waitUntilActionable(opts) {
  var created = wcCreateWaitState(opts);
  if (created.result) return created.result;
  var state = created.state;
  var callStatus = opts.callStatus;

  for (;;) {
    var callStartMs = state.now();
    var args = wcNextCallArgs(state);
    var outcome;
    try {
      outcome = { form: 'returned', value: await callStatus(args) };
    } catch (e) {
      outcome = { form: 'thrown', value: e };
    }
    outcome.callElapsedMs = state.now() - callStartMs;
    var decision = wcDecide(state, outcome);
    if (decision.action === 'return') return decision.result;
  }
}
