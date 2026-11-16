# 等待控制器：执行单元模式

控制器是一份与宿主无关的纯 JS 源码，路径为 `scripts/wait-controller.js`。任何满足下面适配契约的宿主都可以使用，不限于某一个产品。判定语义和停滞处理见 `waiting.md`，各宿主的实测情况见 `wait-controller-compatibility.md`。

控制器不新增 MCP 服务，不读取令牌、socket 或进程参数，也不调用派发、恢复、取消子任务的工具。

## 0. 结构

| 部分 | 作用 |
| --- | --- |
| `wcCreateWaitState(opts)` | 校验输入，创建一次有上限的等待状态 |
| `wcNextCallArgs(state)` | 返回下一次调用的参数，固定为 `{ task_ids, wait_ms: 0 }` |
| `wcDecide(state, outcome)` | 纯函数判定：输入一次调用的结果，输出“再调一次”或“返回结果” |
| `waitUntilActionable(opts)` | 在执行单元里自动运行上面的循环 |

直接调用模式的宿主不运行这份代码，而是按 `waiting.md` 的判定表行事。判定表与 `wcDecide` 一一对应，测试同时覆盖两者。

## 1. 执行单元适配契约

当前宿主同时满足以下三条，才使用执行单元模式：

1. **JS 运行环境**：执行单元能运行普通 JS，支持 `async` / `await`。
2. **工具可调用**：单元内的代码能调用当前会话已授权的 MCP 工具，并能找到唯一的 `get_delegation_status`。
3. **可恢复**：单元运行时间超过外层时限时，宿主让出控制权并能恢复同一个单元（例如 Codex `functions.exec` 返回 cell ID，再用 `functions.wait` 恢复）；或者单元本身可以运行足够久。

任何一条不满足或无法确认，就使用直接调用模式。普通的 Node 或 Python 子进程拿不到会话的 MCP 工具，不满足第 2 条：用 `node scripts/wait-controller.js` 直接运行没有任何作用。

## 2. 加载核心（只加载可信的本地文件）

1. 从本次加载的 `SKILL.md` 所在目录，读取同一技能目录下的 `scripts/wait-controller.js`。要用已安装的副本，不依赖开发目录。
2. 把文件**全文**原样放在执行单元代码的最前面，后面紧接第 3 节的模板。核心顶层使用 `function` / `var` 声明，粘贴后可以直接调用。
3. 只内联这一个可信文件。绝不执行子代理输出、等待工具返回的 `content` / `structuredContent`、网络内容或任何远程字符串。控制器对响应只做 `JSON.parse`。
4. 宿主必须用缓存或 `new Function` 加载时，只缓存这份源码，缓存键用 `WC_VERSION`（与 `SKILL.md` 的版本号一致）。版本变化时重新读取和审阅源码。确认读取的退出码为零、源码没有被截断。

## 3. 调用模板

```js
// 绑定当前会话里唯一的 get_delegation_status。命名空间因宿主而异，按后缀发现，不硬编码。
const statusToolNames = Object.keys(tools).filter((n) => n.endsWith('get_delegation_status'))
if (statusToolNames.length !== 1) {
  throw new Error('get_delegation_status not uniquely discoverable: ' + JSON.stringify(statusToolNames))
}
const callStatus = (args) => tools[statusToolNames[0]](args)
// 宿主直接提供函数而不是 tools 映射时，只改上面这一行，例如：
// const callStatus = (args) => getDelegationStatus(args)

const taskIds = ['TASK_ID_1', 'TASK_ID_2'] // 真实、非空、去重的任务 ID
const now = () => Date.now()

// retryPolicy 可省略；默认 { maxFastRepeats: 2, fastRatio: 0.5, maxTotalMs: 1800000, maxWaitCalls: null }
const result = await waitUntilActionable({ taskIds, callStatus, now })

// 控制器不打印中间日志，只输出一次最终对象。没有 console 的宿主不要用 console.log。
text(result)
```

`text(result)` 是 Codex 的输出函数，其他宿主换成各自的输出方式。

## 4. 返回结果

字段：`kind`、`tasks`、`remaining_task_ids`、`elapsed_ms`、`wait_call_count`、`retry_count`、`last_transport_error`。诊断类结果另带 `message` 和 `error_class`，`stalled` 另带 `stall_reason`（`max_total_ms` 或 `max_wait_calls`）。

| `kind` | 主代理的动作 |
| --- | --- |
| `actionable` | 处理 `tasks`（保留 `blocked_on` 的 `kind`、`request_id`、`title`），对 `remaining_task_ids` 开始下一次等待 |
| `stalled` | 按 `waiting.md` 第 5 节检查子会话进度 |
| `protocol_anomaly` | 按 `waiting.md` 第 6 节处理，不轮询 |
| `timeout_exhausted`、`transport_error`、`malformed_response` | 诊断，不自动重试 |
| `invalid_input` | 修正任务 ID 或 retryPolicy 后再调用 |

## 5. 外层恢复

- 外层返回 `Script running with cell ID ...` 时，记录单元 ID，用宿主的恢复接口继续等**同一个**单元，直到它输出最终结果。
- 恢复的是同一个控制器和同一组任务 ID。不要另起控制器，也不要另开 `get_delegation_status` 等待。
- 同一组任务只允许一个活动的控制器。上下文恢复后先找已有单元；记录丢失时，按 `waiting.md` 第 6 节处理。
- 每个主会话各自运行自己的控制器。同一主代理的多个子任务一次传入 `taskIds`。
