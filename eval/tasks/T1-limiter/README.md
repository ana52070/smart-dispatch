# 任务 T1：修复限流器

用户反馈：`src/limiter.js` 的令牌桶限流器“慢速补充时永远补不满”，而且“一个用户被限流，其他用户也被限流”。请修复它，使其**完全符合下面的规格**。可以重写实现，但不能改变导出的接口。

## 规格

```js
import { createLimiter } from './src/limiter.js'
const limiter = createLimiter({ capacity, refillPerSec, now })
limiter.tryTake(key, cost = 1) // -> boolean
limiter.available(key)         // -> number
```

1. `capacity`、`refillPerSec` 必须是正的有限数，否则 `createLimiter` 抛出 `RangeError`。`now` 可选，默认 `Date.now`，返回毫秒。
2. 每个 `key` 一个独立的桶，第一次出现时是满的（`capacity` 个令牌）。
3. 令牌按经过的时间**连续**补充：`tokens = min(capacity, tokens + elapsedMs * refillPerSec / 1000)`，保留小数，不能取整。
4. `cost` 必须是正的有限数，否则 `tryTake` 抛出 `RangeError`。
5. `cost > capacity` 时直接返回 `false`，不消耗任何令牌。
6. 令牌不足时返回 `false`，不扣减；足够时扣减 `cost` 并返回 `true`。
7. 时钟回退（`now()` 比上次记录的时间小）时，这一次不补充也不扣减补充量，并把该桶的基准时间更新为新的 `now()`。
8. `available(key)` 先结算补充，再返回当前令牌数；从未出现过的 `key` 返回 `capacity`，并且不会因此创建桶以外的副作用。

运行 `npm test` 执行可见测试。
