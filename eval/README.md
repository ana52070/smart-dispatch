# 协作效果评测框架

用来回答一个问题：**Opus 主代理 + 便宜的执行代理，能不能在保持单干质量的同时，降低主代理的 token？** 结论见 `../skills/smart-dispatch/references/eval-report.md`，原始分数与 token 见 `results.md`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `tasks/<题目>/` | 作答起点：README（规格）、待修改的源码、可见测试 |
| `ref/<编号>/` | 参考解，覆盖到起点上即可通过全部隐藏测试；`.delete` 列出覆盖后要删除的路径 |
| `hidden/<编号>.test.mjs` | 隐藏测试，作答方看不到 |
| `gen-e1.mjs`、`gen-e2.mjs` | 生成 E1、E2 的题目、参考解和隐藏测试（生成结果不入库） |
| `score.mjs` | 给一个作答目录评分：临时放入隐藏测试，按顶层测试统计通过率，跑完删除 |
| `selfcheck.sh` | 校验题目本身：初始代码应失败，参考解应 100% |
| `gen.mjs`、`prompts/` | 生成协作组“规划 / 验收”阶段的提示词（接力方式，见下文） |
| `tokens.mjs` | 从 Claude Code 本地 transcript 统计主代理 token |
| `skill-snapshots/` | 评测时使用的 1.2、1.3 版 `SKILL.md` 与任务书模板（1.1 见提交 `c2f69b9`） |

## 题目

| 编号 | 题目 | 类型 |
| --- | --- | --- |
| T1–T4 | 限流器、semver、配置加载器、流式 CSV | 规格密、代码短 |
| H1–H3 | 异步队列、补丁应用、glob | 规则交互多 |
| E1 | 24 个模块的日志 API 迁移 | 多文件机械修改 |
| E2 | 订单报表管道排障（4 个根因、数千行日志） | 看日志排障 |

## 运行

```bash
cd eval
node gen-e1.mjs && node gen-e2.mjs        # 生成 E1、E2
bash selfcheck.sh T1-limiter T1            # 校验题目
node score.mjs <作答目录> T1               # 给作答评分
```

### 分组与接力

- **单干组**：把 `tasks/<题目>` 复制成一个工作目录，交给一个新会话独立完成。
- **协作组**：Codeg 只允许一层委托，被委托的会话不能再委托，所以主代理按阶段接力：
  1. 规划会话：`node gen.mjs plan <组> <题目>`，主代理写笔记和任务书；
  2. 中继把任务书原样交给执行代理；
  3. 验收会话：`node gen.mjs accept <组> <题目> <轮次> <执行代理会话号>`，主代理验收、返修或接管。
- 工作目录根默认是本目录，可用 `EVAL_ROOT` 指定（需要其中有 `runs/`、`notes/`、`briefs/`、`skills/<版本>/`）。
- 验收会话是冷启动，比真实的单会话多出约 3.5 万–4 万加权 token，比较时需要考虑。

### token 统计

`tokens.mjs` 读取同目录的 `sessions.json`（格式：`{ "组-题目": ["Claude Code 会话 external_id", ...] }`），按消息去重后累加 usage，并折算为加权 token：输入 ×1、缓存写入 ×1.25、缓存读取 ×0.1、输出 ×5。`sessions.json` 含本机会话标识，不入库。
