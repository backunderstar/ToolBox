# ToolBox 插件开发参考（宿主接口全量）

本文档是**在 ToolBox 宿主框架里写插件**的完整参考：可调用的方法、推荐的实现方式、
可复用的 CSS 变量、协议速查。源码依据：`src/core/pluginRuntime.ts`（桥）、
`src-tauri/src/plugins/`（manifest/process/manager）、`src/styles/tokens.css`（令牌）。

> 若宿主版本升级导致接口变化，以宿主源码为准；本模板只依赖稳定接口。

---

## 1. 插件清单（plugin.json）字段全量

```jsonc
{
  "id": "my-plugin",            // 必填：小写字母/数字开头，仅小写字母/数字/连字符；= 目录名
  "name": "我的插件",            // 必填：显示名
  "version": "0.1.0",           // 必填
  "description": "一句话说明",
  "runtime": "process",         // 必填：webview | process | native
  "entry": "main.js",           // webview 必填：JS 入口（相对插件目录）
  "command": ["python", "main.py"], // process 必填：启动命令 argv；native 必填：DLL 文件名
  "permissions": ["log"],       // process 调核心 API 的权限门控（见 §4）
  "config": {},                 // 注入插件的内容（native 经 FFI；process 可在 init 时自读）
  "searchProvider": false,      // true = 实现 search.provide 命令，进入全局搜索（见 §7）
  "system": false,              // true = 数据安全/横切能力，前端不可禁用（一般第三方不写）
  "ui": { "entry": "ui/index.js" },   // 可选：自带前端界面（宿主 PluginUiView 挂载）
  "nav": [{ "id": "my-plugin", "label": "我的插件", "icon": "puzzle", "group": "插件" }],
                                  // 可选：侧边栏入口（点击进入本插件自带前端）
                                  // icon 可选：grid / file-text / check / sparkle / globe /
                                  // gear / sun / moon / folder / chevron-right / panel-left /
                                  // chevron-down / plus / trash / refresh / puzzle /
                                  // arrow-up / arrow-down / float
  "actions": [{ "id": "greet", "label": "问候", "icon": "puzzle", "topbar": true, "tray": true }],
                                  // 可选：宿主外壳动作（顶栏图标按钮 / 托盘菜单项，见 §8）
  "settings": { "entry": "ui/settings.js" },
                                  // 可选：设置页「插件设置」段的自定义面板入口
  "float": { "entry": "ui/float.js" },
                                  // 可选：桌面浮窗界面（Alt+Q 的独立小窗）。启用且声明后，
                                  // 浮窗显示本插件界面（注册 key = 插件 id；多个声明时页签
                                  // 切换；不声明则浮窗空态）。浮窗窗口能力（创建/置底/快捷键/
                                  // 锁定）属宿主框架，插件只提供内容，见 §10.1
  "theme": { "base": "light", "tokens": {}, "css": "theme.css" }
                                  // 可选：皮肤插件（主题包，纯数据，见 §9）
}
```

- 未知 `permissions` 只警告不阻止加载；未知顶层字段忽略。
- `nav` 的 id 不能与宿主内置视图冲突：`overview` / `plugins` / `settings`（保留）。

---

## 2. 桥 API（界面里可调用的宿主方法，全量）

宿主把统一桥注入插件自带前端（`mount(el, api)` 的第二个参数，类型 `PluginBridgeApi`）。
webview 插件入口的 `api` 是同构子集（`call`/`on`/`context` + `app`/`fs`/`events`/`log`）。

```ts
interface PluginBridgeApi {
  /** 本插件 id */
  pluginId: string;

  /** 调用插件命令（默认本插件；targetPluginId 可跨插件调用）
   *  → 宿主统一路由：native→FFI / process→JSON-RPC / webview→前端注册表 */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;

  /** 订阅插件事件（默认只收本插件；targetPluginId 跨插件订阅）
   *  返回取消函数——组件卸载时必须调用，防泄漏 */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;

  /** 写宿主运行日志（落盘 logs/ + dev 终端，来源 [plugin:<id>]；
   *  level: debug|info|warn|error）——UI 与 webview 插件用；process 用核心 API log */
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;

  /** 宿主上下文快照：当前工作区等（随工作区切换更新） */
  context: {
    vault: string | null;              // 当前工作区绝对路径（未选为 null）
    activePath?: string;               // 宿主当前活动文件（相对 vault）
    activeContent?: string;            // 宿主当前活动文件内容
  } & Record<string, unknown>;

  /** 跨视图导航（宿主 Sidebar 同机制） */
  nav?: { go: (view: string) => void };

  /** 宿主能力（主窗口可用） */
  host?: {
    /** 宿主聚合搜索：FTS（全文索引）+ 所有启用插件的 search.provide 命中 */
    search: (query: string) => Promise<
      { filename?: string; title?: string; snippet?: string; source?: string; path?: string }[]
    >;
  };
}
```

用法示例：

```ts
// 调用本插件命令（process → Python 的 JSON-RPC）
const r = await api.call("hello", { name: "世界" });

// 跨插件调用（targetPluginId 指定目标插件）
const r2 = await api.call("pytext.stats", { text }, "py-tools");

// 订阅本插件事件
const off = api.on("progress", (data) => { /* { percent, message } */ });
onBeforeUnmount(off); // 必须取消订阅

// 跳转宿主视图（如回插件页）
api.nav?.go("plugins");
```

---

## 3. process 插件协议速查（JSON-RPC over stdio，NDJSON）

每行一个 JSON 对象：

| 方向 | 格式 | 说明 |
|---|---|---|
| 宿主 → 插件 | `{"id":1,"method":"init","params":{"apiVersion":1,"pluginId":"..."}}` | 启动握手，必须响应 `commands` 白名单 |
| 插件 → 宿主 | `{"id":1,"result":{"commands":["hello"]}}` | init 响应 |
| 宿主 → 插件 | `{"id":2,"method":"call","params":{"command":"hello","args":{}}}` | 调命令（白名单外拒绝） |
| 插件 → 宿主 | `{"id":2,"result":{...}}` / `{"id":2,"error":{"code":-32000,"message":"..."}}` | 命令响应 |
| 插件 → 宿主 | `{"method":"progress","params":{...}}` | 事件（Notification，无 id）→ 前端 `api.on("progress")` |
| 宿主 → 插件 | `{"method":"shutdown"}` | 关闭信号，收到后**及时退出**（不要挂起） |

- 协议强制 UTF-8：Windows 下 stdin/stdout/stderr 先 `reconfigure(encoding="utf-8")`（模板 main.py 已做）。
- 命令白名单：init 响应的 `commands` 之外，宿主拒绝调用。
- 超时：命令 30s（宿主侧 API_TIMEOUT），挂死会被杀进程树；**长任务要拆小步 + 事件汇报进度**。

---

## 4. 核心 API（process 插件 → 宿主，按 permissions 门控）

插件进程在**处理 call 请求期间**可反向调用核心 API（发 `{"id":N,"method":"<api>","params":{...}}`
给宿主，读同 id 响应；模板 main.py 的 `call_core()` 是现成实现）。需在 plugin.json 声明对应权限：

| 方法 | 参数 | 权限 | 说明 |
|---|---|---|---|
| `fs.readText` | `{path}`（vault 相对） | `fs:read:vault` | 读工作区内文件 |
| `fs.writeText` | `{path, content}` | `fs:write:vault` | 写工作区内文件（自动建父目录） |
| `fs.listDir` | `{dir}`（空=vault 根） | `fs:read:vault` | 列目录；返回 `[{name,path,isDir,size,mtime}]` |
| `log` | `{message, level?}`（level: debug/info/warn/error，缺省 info） | `log` | 写宿主运行日志（logs/ 落盘 + dev 终端，来源 `[plugin:<id>]`） |
| `notify` | `{title?, body?}` | `notify` | 宿主右上角横幅（5s 自动消失） |
| `open` | `{path}`（vault 相对） | `open` | 用系统默认应用打开 |
| `clipboard.read` | — | `clipboard` | 读剪贴板文本 |
| `clipboard.write` | `{text}` | `clipboard` | 写剪贴板 |
| `http.request` | `{url, method?, headers?, body?, timeoutSec?}` | `http` | 受控 HTTP（reqwest；响应 ≤4MB；timeoutSec 默认 10） |
| `shell.exec` | `{cmd, args?, timeoutSec?}` | `shell` | 执行命令（**强能力**；cwd=vault；返回 `{code,stdout,stderr}` 尾部） |

> 注意：**不是安全沙箱**——process 插件进程本身可做任意 OS 操作；权限门控的只是"经宿主转发的核心 API"。
> 只安装可信来源的插件。

**核心 API 调用完整示例**（Python 端 → 宿主，端到端）：

```python
# 插件命令内：列出 vault 根目录（权限 fs:read:vault）
def list_root():
    entries = call_core("fs.listDir", {"dir": ""})   # 见模板 main.py 的 call_core
    return [e["name"] for e in entries if e["isDir"]]

# 插件命令内：写工作区文件（权限 fs:write:vault）
def save_note(title, content):
    call_core("fs.writeText", {"path": f"notes/{title}.md", "content": content})
    return {"ok": True}
```

```ts
// 前端侧：任意位置调本插件命令（最终经 Python → 核心 API）
await api.call("fileList");
```

---

## 5. 事件（双通道）

- **插件进程 → 宿主 → 前端**：Python `notify("progress", {...})`（写 stdout Notification）→
  宿主转发 `plugin-event` → 前端 `api.on("progress", cb)`。
- **宿主外壳 → 插件 UI**：顶栏按钮 / 托盘菜单项 / 设置面板动作点击 → `api.on("action", cb)`
  收到 `{action, source}`（`source` = `topbar | tray | settings`）。非 webview 插件还可实现
  约定命令 `plugin.action {action, source}`（宿主也会调用，未实现则忽略）。
- **本插件 UI → 其他插件**：`api.on(event, cb, targetPluginId)` 跨插件订阅。

### 5.1 插件日志（行为日志，各形态统一通道）

**所有插件形态都能写宿主运行日志**（`logs/` 按天落盘 + dev 终端，来源前缀 `[plugin:<id>]`，
级别 debug/info/warn/error，随宿主日志级别过滤，保留 7 天自动清理）：

| 形态 | 写法 | 权限 |
|---|---|---|
| **process（Python）** | `call_core("log", {"message": "...", "level": "warn"})` | `log` |
| process（Python）stderr | `print("...", file=sys.stderr)`（自动捕获为 info，无需权限） | — |
| **native（cdylib）** | `tb_sdk::log("...")`（TbHostApi 回调） | — |
| **webview 插件** | `api.log("info", "...")` | — |
| **插件自带前端 UI** | `api.log("error", "...")`（桥自带） | — |

示例（Python）：

```python
call_core("log", {"message": "开始处理", "level": "info"})
call_core("log", {"message": f"失败: {err}", "level": "error"})
```

示例（前端 UI / webview）：

```ts
api.log("debug", "按钮被点击");
api.log("warn", "结果为空");
```

> 日志查看：设置页「日志」卡片（应用内查看器 + 级别过滤 + 打开目录 + 清空）；
> 级别阈值由宿主全局设置控制（低于阈值不落盘）。

---

## 6. 可复用 CSS 变量（tokens.css 全量，亮暗自动切换）

**这些变量是宿主提供给插件的公开契约**：插件界面（主界面 / 设置面板 / 浮窗）都运行在宿主
同一文档里，样式可直接 `var(--xxx)` 引用本表全部变量，随亮暗主题自动切换。宿主承诺这些
变量**只增不删不改**（新版本会保持兼容），插件可放心依赖——**只引用变量，不要写死颜色/尺寸**
（写死会破坏主题自适应）。

| 分类 | 变量 | 说明 |
|---|---|---|
| 字体 | `--font-sans` / `--font-mono` | 正文 / 等宽（代码、数值） |
| 字号 | `--text-xs`(11px) `--text-sm`(12.5) `--text-md`(14) `--text-lg`(16) `--text-xl`(20) `--text-2xl`(28) | 阶梯 |
| 间距 | `--space-1`(4) `--space-2`(8) `--space-3`(12) `--space-4`(16) `--space-5`(24) `--space-6`(32) `--space-8`(48) | 8 点节奏 |
| 圆角 | `--radius-sm`(4) `--radius-md`(8) `--radius-lg`(12) | 内小外大 |
| 动效 | `--ease`(cubic-bezier) `--dur`(200ms) | 统一过渡 |
| 画布 | `--bg` `--bg-soft` `--bg-elevated` | 底层 / 软底（输入、代码块）/ 浮起（卡片、面板） |
| 文字 | `--fg` `--fg-muted` `--fg-faint` | 主文 / 次要 / 信息性元数据（时间、状态） |
| 边框 | `--border` `--border-strong` | 常规 / hover 加强 |
| 强调 | `--accent` `--accent-strong` `--accent-soft` `--on-accent` | 陶土强调色；主按钮底色 / hover 加深 / 淡底徽标 / 强调上的文字 |
| 语义色 | `--pastel-blue-*` `--pastel-green-*` `--pastel-yellow-*` `--pastel-red-*` `--pastel-purple-*` `--pastel-amber-*` | 淡彩标签/状态（bg + fg 成对） |
| 危险 | `--danger` | 删除/错误强调 |
| 阴影 | `--shadow-1` `--shadow-2` | 卡片 / 浮层 |
| 滚动条 | `--scrollbar` | 自定义滚动条颜色 |

推荐组合：卡片 = `--bg-elevated` + 1px `--border` + `--radius-lg` + `--shadow-1`；
输入 = `--bg-soft` + `--border`，focus 时 `--accent` 边框 + 3px 半透明焦点环；主按钮 = `--accent` 底 +
`--on-accent` 字，hover 用 `--accent-strong`。

### 6.1 宿主全局 CSS class（可选复用）

插件界面除了用变量自建样式，也可直接复用宿主全局 class（随主题自适应，无需重复实现）：

| class | 用途 | 示例 |
|---|---|---|
| `.btn` / `.btn-sm` | 通用按钮（描边 + 悬停加深 + 按下缩放） | `<button class="btn">确定</button>` |
| `.btn-danger` | 危险按钮（红底白字） | 删除确认 |
| `.icon-btn`（加 `.sm` 变小） | 图标按钮（方形 hover 底） | 关闭/刷新小按钮 |
| `.badge` + 变体 | 徽标（`.badge-provider` 等） | 来源标记 |
| `.plugin-error` | 错误提示条（淡红底） | 插件页卡片内错误展示 |
| `.empty-state` | 空状态（居中 + 图标/文案） | 列表为空引导 |

> 复用宿主 class 的好处：hover/active/focus 等状态宿主已实现；缺点是耦合宿主内部命名——
> 建议**主要用变量自建**（tpl-* 前缀），宿主 class 只用于通用按钮/错误条这类"语义稳定"的组件。

---

## 7. 搜索提供者（searchProvider）

plugin.json 声明 `"searchProvider": true`，并实现 `search.provide` 命令：
宿主 `api.host.search` / 顶栏全局搜索聚合时调用 `{"command":"search.provide","args":{"query":"...","limit":20}}`，
返回 `[{path, title, snippet}]`（`path` 为 vault 相对路径）。宿主 FTS 命中在前，提供者命中在后（带来源徽章）。
示例见仓库 `plugins/py-tools/main.py` 的 `search_provide`（用 `fs.listDir` 递归枚举 vault）。

---

## 8. 宿主外壳动作（顶栏 / 托盘 / 设置面板）

plugin.json 声明 `actions`（`topbar` / `tray` 布尔，可都用）或 `settings.entry` 后，宿主自动渲染：
- 顶栏图标按钮 / 托盘菜单项 → 点击发 `plugin-event` 事件 `action`（`{action, source}`）→
  界面 `api.on("action")` 订阅；非 webview 插件宿主还会调 `plugin.action {action, source}` 命令。
- 设置页「插件设置」段：`settings.entry` 指向自包含 JS（注册 key 约定
  `window.__TB_PLUGIN_UI__["settings:<插件id>"]`，宿主 SettingsView 挂载）。

完整示例见仓库 `core-plugins/example`（顶栏按钮 + 托盘两项 + 设置面板）。

---

## 9. 皮肤插件（theme）

plugin.json 声明 `"theme": {"base":"light|dark","tokens":{},"css":"theme.css"}`，
纯数据（无需运行时代码）；启用后并入设置页主题选择器。`tokens` 覆盖 tokens.css 变量，
`css` 为可选组件级覆盖文件。示例见仓库 `plugins/theme-maple` / `theme-midnight`。

---

## 10. 推荐实现方式（最佳实践）

1. **样式**：写在 `.vue` 的 `<style>` 块（Vite 提取为 `ui/style.css`，宿主注入），
   只引用 §6 的令牌；**不要写独立未 import 的 style.css**（构建链路不带，界面裸奔）。
   类名用自己插件的前缀（如 `my-*`），避免污染宿主。
2. **状态完备**：所有交互给 hover / active（`scale(0.98)`）/ `:focus-visible`（焦点环）/
   disabled；异步命令给加载态（按钮禁用/文字变化）与错误可见（不用 `alert`，用错误条）。
   空列表给引导文案。
3. **事件清理**：`api.on` 返回取消函数，组件卸载（`onBeforeUnmount`）必须调用。
4. **并发守卫**：读-改-写命令（如列表增删）连点会并发，用 `busy` 标志在途拒绝（core-example 示范）。
5. **命令失败**：界面 `api.call` 抛错要 catch 并展示，不静默吞错。
6. **进程侧**：stdin/stdout/stderr 强制 UTF-8；收到 `shutdown` 立即退出；
   长任务拆步 + `notify` 事件汇报进度，别让宿主等满 30s 超时。
7. **依赖**：第三方 Python 库放 `vendor/`（`requirements.txt` 声明，插件页「安装依赖」
   按钮用捆绑 Python 的 pip 装到 vendor/；main.py 把 vendor 插进 sys.path）。
   依赖目录与构建产物**不入库**（分发源码，对方装完点「安装依赖」）。
8. **跨插件**：`api.call(cmd, args, targetPluginId)` 调其他插件命令；同名命令不冲突。

### 10.1 桌面浮窗界面（manifest.float）

插件启用且声明 `"float": { "entry": "ui/float.js" }` 后，**桌面半透明浮窗（全局快捷键
Alt+Q）显示该插件界面**——类似自带前端的另一个窗口形态：

- **窗口能力属宿主**：浮窗创建、置底（桌面层）、Alt+Q 显隐、位置锁定/解锁都由宿主完成，
  插件只提供内容（入口 JS + 样式）。
- **注册 key = 插件 id**（与主界面同机制；浮窗是独立窗口，`window` 对象独立，注册不冲突）。
- **多个插件声明**时浮窗底部页签切换；都不声明则浮窗显示空态。
- **入口独立于 `ui`**：浮窗通常做精简版（小窗口 280px），core-example 示例见
  `core-plugins/example/ui/float.ts` + `FloatPanel.vue`（构建脚本自动支持 `ui/float.ts` →
  `float.js`；仓库外开发在 build.mjs 里加第二个入口，或用同一个 `ui/index.js`）。
- 浮窗里插件照常用 `api.call` / `api.on` / `api.context.vault`（与主界面同桥）。

---

## 11. 调试

- 插件 stderr 会被宿主捕获并写入日志（dev 终端 `[plugin:stderr] ...`），init 失败时附到错误信息。
- 宿主日志 `log` 核心 API（权限 `log`）或 `print(..., file=sys.stderr)`。
- 启动时宿主打印解释器来源：`[plugin] <id> 解释器: <路径> (插件自带|全局捆绑|系统 PATH 回落)`。
- 界面错误：`api.call` 的 reject 文案会包含插件返回的 error message（Python 异常文本）。

## 12. 独立测试（不启动 ToolBox 就能测）

第三方开发时的测试分两层：**独立测试**（本模板自带，覆盖协议与界面逻辑）+
**宿主集成冒烟**（装进 ToolBox 验证权限门控、事件到前端、UI 注入等宿主侧能力）。

### 12.1 process 协议：`test/mock-host.py`（模拟宿主）

模拟宿主按真实协议（JSON-RPC over stdio）spawn 你的 `main.py`：init 握手 → 逐命令
call → 自动应答核心 API 请求（fs.listDir 列 `--vault` 目录或临时 mock vault，
其余返回 `{"ok": true}`）→ 收集事件 → shutdown。全部 PASS 退出码 0（可进 CI）。

```bash
# 冒烟：init + 白名单每条命令 call({})（参数必填的命令会 WARN 不算失败）
python test/mock-host.py .

# 单命令 + 参数（bash/zsh：JSON 直接写）
python test/mock-host.py . --call hello --args '{"name":"张三"}'

# PowerShell：双引号要转义（否则被吃掉变成 {name:张三}，脚本会尝试裸键容错）
python test/mock-host.py . --call hello --args '{\"name\":\"张三\"}'

# 校验事件推送数量（eventDemo 应推 3 个 progress）
python test/mock-host.py . --call eventDemo --expect-events 3

# 核心 API 用真实目录（fileList 递归列真实 vault）
python test/mock-host.py . --call fileList --vault D:\my-vault

# 异步插件（长任务必须异步：宿主单次 call 硬超时 30s，call 应秒回 jobId，
# 后台线程跑完再推事件）。--wait-done 等终态事件（done/failed/cancelled）：
python test/mock-host.py . --call layer.run `
    --args '{\"input\":\"D:/in.xlsx\",\"outDir\":\"D:/out\",\"layers\":4}' `
    --wait-done --wait-timeout 90
# --wait N：call 返回后继续收 N 个通知（进度事件等）；--wait-timeout 设上限（缺省 60s）
```

> ⚠️ 事件到达时机：宿主 read_loop 持续解析 stdout，但**事件只在 call 在途时**转发到前端
> （process.rs `call_raw` 循环内），空闲期事件在通道积压。异步插件不要依赖事件实时到达——
> 前端以**轮询 `layer.status` 类命令**驱动进度，`progress` 通知当实时补充。仓库实例：
> `plugins/probe-rat-layer`（探针卡分层，后台线程跑 ~25s 分层，UI 轮询 status）。

### 12.2 自带前端：`npm test`（vitest + jsdom）

api 桥全部打桩（`test/helpers.ts` 的 `mockApi()`），覆盖：

- **入口契约**（`test/index.test.ts`）：`window.__TB_PLUGIN_UI__["<你的id>"]`
  注册了 `{ mount, unmount }`；mount 渲染、unmount 清空。
- **界面行为**（`test/App.test.ts`）：点击按钮 → `api.call` 收到正确命令与参数、
  返回值上屏；`api.on("progress")` 订阅后 mock 宿主 push 事件 → 事件流更新；
  `host.search` 结果显示；命令失败 → 错误条。

改完 `ui/` 后 `npm test` 即可回归。mock api 只覆盖本模板用到的桥字段；
用了 `nav` / `context.activePath` 等更多字段时在 `mockApi()` 里补。

### 12.3 命令注册式 webview 插件 / native / 主题

- **webview 命令注册式**（无自带前端）：入口只依赖宿主注入的 api 对象——node 里
  mock api 后直接 import 入口、调用 `api.app.registerCommand` 注册的命令即可单测
  （宿主指南 §1/§2 的内联代码即此形态）。
- **native（cdylib）**：依赖宿主进程（libloading + C ABI + TbHostApi 回灌），
  独立测试成本高——装进 ToolBox 后用插件页「命令试玩台」+ 事件流冒烟最实际。
- **主题插件**：纯数据包，校验 plugin.json 结构与 tokens 键引用即可。

### 12.4 必须回宿主测的能力（独立测试覆盖不到）

- 权限门控：`permissions` 未声明时宿主会拒绝核心 API（mock-host 不强制权限）。
- 事件到前端全链路、Blob/CSP 注入、托盘/顶栏动作、宿主搜索聚合。
- 打包后安装（插件页「安装 .zip」）与目标机无 Python 场景（捆绑运行时解析）。
