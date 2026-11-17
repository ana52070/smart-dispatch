# 任务 T3：完成配置加载器

`src/` 下有一个只完成了一半的配置加载器（`index.js`、`ini.js`、`coerce.js`）。现在它只能合并默认值和 INI 文件，而且 INI 解析有缺陷。请按下面的规格完成它。可以自由增删 `src/` 里的文件，但 `src/index.js` 必须导出 `loadConfig` 和 `ConfigError`。

## 接口

```js
import { loadConfig, ConfigError } from './src/index.js'
const config = loadConfig({ schema, files = [], env = {}, argv = [] })
```

- `schema`：键为点分路径（如 `'server.port'`），值为 `{ type, default?, required? }`。`type` 是 `'string' | 'number' | 'boolean' | 'array'` 之一。
- `files`：INI 文本字符串的数组（不是文件路径）。
- `env`：类似 `process.env` 的对象。
- `argv`：类似 `process.argv.slice(2)` 的字符串数组。
- 返回**嵌套对象**，例如 `{ server: { port: 8080, host: 'localhost' }, debug: false }`。只包含 schema 中的键：有默认值、或者被某个来源设置过的键才出现在结果里。

## 优先级

`argv` > `env` > `files`（数组中靠后的文件覆盖靠前的）> `default`。

## INI 格式

- 逐行处理，每行先去掉首尾空白。空行忽略。以 `;` 或 `#` 开头的行是注释。
- `[section]` 设置后续键的前缀，`[a.b]` 表示前缀 `a.b`。第一个 section 之前的键没有前缀。每个文件开始时前缀都重置为空。
- `key = value`：键和值都去掉首尾空白。只按**第一个** `=` 分割。
- 值不带引号时，如果出现“空白后跟 `;` 或 `#`”，从这里开始到行尾都是行内注释，要去掉（`port = 80 ; web` 的值是 `80`；`a = b;c` 的值是 `b;c`）。
- 值用双引号包起来时，引号内的内容原样保留（包括 `;`、`#` 和首尾空白），并支持转义：`\"`、`\\`、`\n`、`\t`。引号后面只允许跟空白或行内注释。
- 同一来源中重复的键，后出现的生效。
- 无法识别的行（不是空行、注释、section，也没有 `=`），或者引号没有闭合，记一条错误，错误信息包含 `file <文件序号，从 1 开始> line <行号，从 1 开始>`。

## 环境变量

- 只处理以 `APP_` 开头的变量。去掉前缀后按 `__`（两个下划线）拆分成路径段，全部转小写，再用 `.` 连接：`APP_SERVER__PORT` → `server.port`，`APP_DEBUG` → `debug`。
- 其他变量忽略。

## 命令行参数

- `--key=value`：设置 `key`。
- `--key`（不带 `=`）：只有 `key` 的类型是 `boolean` 时合法，值为 `true`；否则记一条包含 `missing value` 的错误。
- `--no-key`：只有 `key` 的类型是 `boolean` 时合法，值为 `false`；否则记错误。
- 不以 `--` 开头的参数记一条包含 `unexpected argument` 的错误。

## 类型转换

来自 INI、环境变量、命令行的值都是字符串，按 schema 类型转换：

- `string`：原样保留。
- `number`：去掉首尾空白后不能为空，且 `Number(...)` 必须是有限数，否则记错误。
- `boolean`：不区分大小写，`true/1/yes/on` 为真，`false/0/no/off` 为假，其他值记错误。
- `array`：按逗号分割，每项去掉首尾空白，丢弃空项。
- 默认值不做转换，但数组默认值必须**复制**，修改返回结果不能影响 schema 或后续调用。

## 错误

- 任何来源出现 schema 里没有的键，记一条错误，信息包含 `unknown key "<key>"`。
- 合并后缺少 `required: true` 的键，记一条错误，信息包含 `missing required "<key>"`。
- 转换失败的错误信息要包含出错的键名。
- **收集全部错误后**一次性抛出 `ConfigError`（继承 `Error`），它的 `errors` 属性是全部错误信息组成的字符串数组。没有错误时正常返回。

运行 `npm test` 执行可见测试。
