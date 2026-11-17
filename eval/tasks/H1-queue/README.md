# 任务 H1：带重试、超时和取消的异步任务队列

在 `src/queue.js` 中实现并导出 `createQueue`、`AbortError`、`TimeoutError`。现有文件只有一个最简单的并发队列，需要按下面的规格重写。

## 接口

```js
const q = createQueue({ concurrency = 1, timers })
const p = q.add(fn, { priority = 0, signal, retries = 0, backoffMs = 100, timeoutMs })
q.pause(); q.resume(); q.setConcurrency(n); q.clear()
q.size      // 正在排队等待开始的任务数（不含运行中、不含退避等待中）
q.pending   // 正在运行的任务数
await q.onIdle()
```

`timers` 可选，形如 `{ setTimeout(fn, ms) -> id, clearTimeout(id) }`，默认使用全局的 `setTimeout` / `clearTimeout`。队列中**所有**计时都必须通过 `timers` 完成，测试会注入假时钟。

## 规则

1. `concurrency` 必须是正整数，否则 `createQueue` 和 `setConcurrency` 抛出 `RangeError`。
2. `add` 返回一个 Promise：任务最终成功时以 `fn` 的结果兑现；最终失败时以最后一次的错误拒绝。
3. **调度顺序**：有空闲槽位时，从等待队列中取 `priority` 最大的任务；优先级相同时，先 `add` 的先运行（按 `add` 调用顺序）。
4. **启动时机**：`add` 调用后，任务不能在 `add` 内部同步开始运行；应在微任务中开始（`await Promise.resolve()` 之后可以观察到它已开始）。任务结束释放槽位后，下一个任务同样在微任务中开始，不需要等待计时器。
5. `fn` 被调用时传入 `{ signal, attempt }`：`attempt` 从 1 开始；`signal` 是本次尝试专属的 `AbortSignal`，在外部取消或本次尝试超时时被触发。`fn` 可以返回 Promise，也可以同步返回值或同步抛错（同步抛错按失败处理）。
6. **重试**：一次尝试失败（拒绝、同步抛错或超时）后，如果已失败次数 ≤ `retries`，等待 `backoffMs * 2^(失败次数-1)` 毫秒后重新排队，否则以该错误拒绝。
   - 退避等待期间**不占用**槽位，也不计入 `size`。
   - 退避结束后重新进入等待队列，**保持原来的 add 顺序位置**：它排在同优先级中比它晚 `add` 的任务前面。
   - 外部取消引起的失败不重试。
7. **超时**：设置了 `timeoutMs` 时，每次尝试开始时启动计时器。超时时：本次尝试的 `signal` 被触发；本次尝试以 `TimeoutError` 失败（可重试）；槽位**立即**释放。之后即使 `fn` 返回的 Promise 再兑现或拒绝，也一律忽略。
8. **取消**：传入的 `signal` 被触发时，Promise 以 `AbortError` 拒绝，任务不再运行或重试：
   - 还在等待队列中：移出队列，`fn` 不会被调用。
   - 正在运行：触发本次尝试的 `signal`，**立即**释放槽位，忽略之后 `fn` 的结果。
   - 在退避等待中：取消退避计时器。
   - 调用 `add` 时 `signal` 已经被触发：返回的 Promise 直接拒绝，任务不进入队列。
9. **暂停**：`pause()` 之后不再启动新任务（运行中的不受影响，退避结束的任务照常回到队列）；`resume()` 恢复调度。
10. **调整并发**：`setConcurrency(n)` 立即生效；调大时立刻按规则 3 启动更多任务，调小时不打断运行中的任务。
11. `clear()`：等待队列中的所有任务以 `AbortError` 拒绝；运行中和退避中的任务不受影响。
12. `onIdle()`：返回一个 Promise，当队列中没有运行中、等待中、退避中的任务时兑现；调用时已经空闲则立刻兑现（在微任务中）。
13. `AbortError`、`TimeoutError` 都继承 `Error`，`name` 分别为 `'AbortError'`、`'TimeoutError'`。

运行 `npm test` 执行可见测试。
