// wait-controller.js
//
// Pure, dependency-free wait controller for smart-dispatch. No import / require
// / fs / process dependencies: paste the WHOLE file into the current
// functions.exec (Code Mode) cell and bind `callStatus` to the real
// get_delegation_status tool name discovered in that host. An ordinary Node
// subprocess has no `tools` object and must NOT run this file directly.
//
// Contract (see references/wait-controller.md):
//   await waitUntilActionable({ taskIds, callStatus, retryPolicy, now })
// `callStatus` is awaited strictly one at a time with exactly
// { task_ids: taskIds, wait_ms: 0 }. The controller never dispatches,
// resumes, or cancels subtasks, prints nothing, and keeps no cross-session
// state (concurrency de-dup and same-cell recovery belong to the host adapter).

var WC_DEFAULTS = { maxFastRepeats: 2, fastRatio: 0.5 };
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
function wcMatchTimeout(text) {
  // Match the whole diagnostic, not a quotation inside another error.
  var match = /^(?:tool call error:\s*(?:tool call failed for (?:`[^`\s]*get_delegation_status`|[^\s`]*get_delegation_status)\s+Caused by:\s*)?)?timed out awaiting tools\/call after ([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h)$/.exec(text.trim());
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

function wcHasAny(text, words) {
  var t = text.toLowerCase();
  for (var i = 0; i < words.length; i += 1) {
    if (t.indexOf(words[i]) >= 0) return true;
  }
  return false;
}

function wcClassifyErrorClass(text) {
  if (wcHasAny(text, ['auth', 'unauthoriz', '401', '403', 'credential', 'token'])) return 'authentication';
  if (wcHasAny(text, ['disconnect', 'connection closed', 'connection reset', 'connection refused', 'connection lost', 'econn', 'socket', 'broken pipe', 'transport closed', 'eof'])) return 'disconnected';
  if (wcHasAny(text, ['-32602', 'invalid argument', 'invalid param', 'invalid input', 'requires', 'non-empty', 'bad request'])) return 'invalid_arguments';
  return 'unknown';
}

async function waitUntilActionable(opts) {
  var o = (opts && typeof opts === 'object') ? opts : {};
  var taskIds = o.taskIds;
  var callStatus = o.callStatus;
  var rp = Object.assign({}, WC_DEFAULTS, (o.retryPolicy && typeof o.retryPolicy === 'object') ? o.retryPolicy : {});
  var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
  var startMs = now();

  var wait_call_count = 0;
  var retry_count = 0;
  var last_transport_error = null;

  function result(kind, extra) {
    return Object.assign({
      kind: kind,
      tasks: [],
      remaining_task_ids: [],
      elapsed_ms: now() - startMs,
      wait_call_count: wait_call_count,
      retry_count: retry_count,
      last_transport_error: last_transport_error,
    }, extra || {});
  }

  var ids = Array.isArray(taskIds) ? taskIds.slice() : null;
  var idsValid = !!ids && ids.length > 0;
  if (idsValid) {
    idsValid = (new Set(ids)).size === ids.length;
    for (var v = 0; v < ids.length; v += 1) {
      if (typeof ids[v] !== 'string' || ids[v].length === 0 || ids[v].trim() !== ids[v]) { idsValid = false; break; }
    }
  }
  if (!idsValid || typeof callStatus !== 'function') {
    return result('invalid_input', {
      remaining_task_ids: idsValid ? ids.slice() : [],
      message: 'invalid_input: taskIds must be a non-empty array of unique non-empty strings and callStatus must be a function',
      error_class: 'invalid_input',
    });
  }

  if (!Number.isInteger(rp.maxFastRepeats) || rp.maxFastRepeats < 1 ||
      !Number.isFinite(rp.fastRatio) || rp.fastRatio <= 0 || rp.fastRatio > 1) {
    return result('invalid_input', {
      remaining_task_ids: ids.slice(),
      message: 'invalid_input: maxFastRepeats must be a positive integer and fastRatio must be in (0, 1]',
      error_class: 'invalid_input',
    });
  }

  var fastRepeatCount = 0;

  for (;;) {
    var callStartMs = now();
    wait_call_count += 1;
    var returned = null;
    var thrown = null;
    var didThrow = false;
    try {
      returned = await callStatus({ task_ids: ids.slice(), wait_ms: 0 });
    } catch (e) {
      thrown = e;
      didThrow = true;
    }
    var callElapsedMs = now() - callStartMs;
    var form = didThrow ? 'thrown' : 'returned';
    var candidate = didThrow ? thrown : returned;

    // 1) A valid task batch always wins, even when isError is true or the body
    //    happens to contain a timeout string. Never scan a valid batch's text.
    if (form === 'returned') {
      var batchTasks = wcParseBatch(returned, ids);
      if (batchTasks) {
        var actionable = false;
        for (var a = 0; a < batchTasks.length; a += 1) {
          var t = batchTasks[a];
          if (t.status !== 'running' || (t.status === 'running' && t.blocked_on != null)) {
            actionable = true;
            break;
          }
        }
        if (actionable) {
          var remaining = [];
          for (var r = 0; r < batchTasks.length; r += 1) {
            if (batchTasks[r].status === 'running' && batchTasks[r].blocked_on == null) {
              remaining.push(batchTasks[r].task_id);
            }
          }
          return result('actionable', { tasks: batchTasks, remaining_task_ids: remaining });
        }
        return result('protocol_anomaly', {
          tasks: batchTasks,
          remaining_task_ids: ids.slice(),
          message: 'protocol_anomaly: wait_ms=0 returned all running without blocked_on; refusing to poll',
          error_class: 'protocol_anomaly',
        });
      }
    }

    // 2) No valid batch: classify the transport / tool error form.
    var text = wcTextOf(candidate);
    var isError = form === 'returned' && returned && returned.isError === true;
    var errorForm = isError || form === 'thrown';
    var timeout = wcMatchTimeout(text);

    if (timeout && errorForm) {
      last_transport_error = {
        form: form,
        message: text,
        error_class: 'timeout',
        duration_token: timeout.token,
        timeout_ms: timeout.timeout_ms,
      };
      var isFast = timeout.timeout_ms <= 0 || callElapsedMs < timeout.timeout_ms * rp.fastRatio;
      if (isFast) {
        fastRepeatCount += 1;
      } else {
        fastRepeatCount = 0;
      }
      if (fastRepeatCount >= rp.maxFastRepeats) {
        return result('timeout_exhausted', {
          remaining_task_ids: ids.slice(),
          message: 'timeout_exhausted: ' + rp.maxFastRepeats + ' consecutive near-instant tools/call timeouts; handing off. last=' + text,
          error_class: 'timeout_exhausted',
        });
      }
      retry_count += 1;
      continue;
    }

    var errorClass = wcClassifyErrorClass(text);
    if (errorForm) {
      last_transport_error = {
        form: form,
        message: text,
        error_class: errorClass,
        duration_token: null,
        timeout_ms: null,
      };
      return result('transport_error', {
        remaining_task_ids: ids.slice(),
        message: 'transport_error[' + errorClass + ']: ' + text,
        error_class: errorClass,
      });
    }

    return result('malformed_response', {
      remaining_task_ids: ids.slice(),
      message: 'malformed_response: no valid task batch and no tool error envelope; ' + text,
      error_class: 'malformed_response',
    });
  }
}
