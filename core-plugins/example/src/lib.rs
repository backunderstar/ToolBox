//! # ToolBox 核心插件教学示例（id: `core-example`，DLL: `tb_example.dll`）
//!
//! 这是**全部核心插件实现要点**的最小完整样板：照着本文件 + 同目录 `ui/`
//! + `docs/核心插件示例教程.md`，就能学会如何写一个 ToolBox 核心插件。
//!
//! 覆盖的知识点（逐条对照下面的实现）：
//! 1. **crate 形态**：`cdylib` 动态库 + `tb-sdk` 依赖（见 Cargo.toml），随应用分发到 `_core/`
//! 2. **数据层（纯函数 + 单测）**：以 vault 内普通文件为唯一真源（JSON），
//!    原子写（临时文件 + rename）、损坏文件隔离保留现场、空输入拒绝（见 `data` 模块）
//! 3. **插件样板 `tb_plugin!`**：State 类型 + `state_from_cfg`（从 manifest 配置构造实例）
//!    + `call`（命令分发）——宏自动生成 5 个 C ABI 导出（tb_abi_version/tb_create/
//!      tb_call/tb_free_string/tb_destroy）并隔离 panic（见文件末尾）
//! 4. **命令集**：`example.list/add/toggle/delete`（业务 CRUD）、`example.echo`
//!    （参数 + 中文 UTF-8）、`example.info`（回显 manifest config 与运行环境）
//! 5. **事件推送**：写操作成功后 `tb_sdk::emit` 发 `example-changed` → 宿主转发
//!    `plugin-event` → 前端/其他窗口 `api.on` 订阅（多窗口一致）
//! 6. **宿主能力回灌（TbHostApi）**：`log`（宿主日志）、`open_path`（用系统默认
//!    应用打开路径）；回调经 `tb_create` 传入的服务表调用，ctx 原样透传
//! 7. **搜索提供者**：实现 `search.provide` 命令 + manifest 声明 `searchProvider: true`
//!    → 进入宿主全局搜索聚合（`search_all`）
//! 8. **配置**：manifest `config` 字段 → `state_from_cfg` 读取（本示例读 `author`）
//! 9. **自带前端**：同目录 `ui/`（Vue 3，index.ts + App.vue + bridge.ts + style.css），
//!    manifest 的 `ui.entry` 声明，宿主 `plugins_read_file` 注入挂载
//! 10. **导航**：manifest `nav` 声明侧边栏入口（宿主导航全配置化）
//!
//! 命令契约（与宿主 api.call / plugin_call 一致）：method + params(JSON) → result(JSON)。
//! 业务含义：vault 内 `data/example/items.json` 存一组"示例条目"（id/text/done/createdAt）。

// tb_plugin! 展开的 FFI 入口（tb_create/tb_call）带裸指针参数，属 C ABI 语义；
// clippy 的 not_unsafe_ptr_arg_deref 对宏展开的 span 无法用局部 allow 压制
// （宏内/调用点 allow 均失效），文件级统一豁免。本文件除宏样板外无其他
// 裸指针公共 API（如有需单独复核）。
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod data;

use serde_json::Value;
use std::ffi::c_void;
use tb_sdk::{tb_plugin, TbHostApi};

/// 插件实例状态：`tb_create` 时由 manifest 配置构造，`tb_call` 期间可读写。
/// 除命令参数外的一切实例数据都应放这里（vault 路径、配置、缓存等）。
pub struct ExampleState {
    vault: String,
    /// 来自 manifest `config.author`（演示"插件配置"知识点）
    author: String,
}

/// 由配置构造实例。config = manifest 的 `config` 字段（JSON 对象），
/// 宿主注入时会合并 `vault`（当前工作区路径）等运行期键。
fn state_from_cfg(cfg: &Value) -> Result<ExampleState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    let author = cfg
        .get("author")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok(ExampleState { vault, author })
}

/// 命令分发：method + params → result。这是插件的"路由表"——
/// `init` 握手时宿主会读取 manifest；前端经 `api.call(method, params)` 到达这里。
/// 返回 Err 会转成 `{"ok": false, "error": ...}`，前端 `api.call` 抛异常。
fn call(
    state: &mut ExampleState,
    host: TbHostApi,
    ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let vault = state.vault.clone();
    // 常用取参帮助：取字符串参数
    let s = |k: &str| {
        params
            .get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    // 写操作后广播变更事件（教学点：事件推送；多窗口/前端订阅刷新）
    let changed = |action: &str| {
        tb_sdk::emit(host, ctx, "example-changed", serde_json::json!({ "action": action }));
    };

    match method {
        // ---- 业务 CRUD（数据层在 data 模块，纯函数便于单测）----
        "example.list" => data::list(&vault)
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("序列化失败: {e}"))),
        "example.add" => {
            let text = s("text").ok_or("缺少 text")?;
            let out = data::add(&vault, &text)
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("序列化失败: {e}")))?;
            changed("add");
            Ok(out)
        }
        "example.toggle" => {
            let id = s("id").ok_or("缺少 id")?;
            let out = data::toggle(&vault, &id)
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("序列化失败: {e}")))?;
            changed("toggle");
            Ok(out)
        }
        "example.delete" => {
            let id = s("id").ok_or("缺少 id")?;
            let out = data::delete(&vault, &id)
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("序列化失败: {e}")))?;
            changed("delete");
            Ok(out)
        }

        // ---- 教学演示命令 ----
        // 参数 + 中文 UTF-8（JSON 全程 UTF-8，无需额外处理）
        "example.echo" => Ok(serde_json::json!({
            "text": format!("你好，{}！", s("name").unwrap_or_else(|| "世界".into())),
            "received": params,
        })),
        // 回显运行环境与配置（验证 manifest config 注入 + 宿主提供的 vault）
        "example.info" => Ok(serde_json::json!({
            "plugin": "core-example",
            "vault": vault,
            "author": state.author,
        })),
        // 宿主能力：写宿主日志（dev 终端可见 [plugin] 前缀行）
        "example.log" => {
            let msg = s("message").unwrap_or_default();
            tb_sdk::log(host, ctx, 0, &format!("[core-example] {msg}"));
            Ok(Value::Null)
        }
        // 宿主能力：用系统默认应用打开路径（文件/文件夹，Windows 资源管理器）
        "example.openPath" => {
            let rel = s("path").unwrap_or_default();
            let p = tb_sdk::resolve_safe(&vault, &rel).map_err(|e| format!("路径非法: {e}"))?;
            let cstr = to_cstr(&p.to_string_lossy())?;
            let opened = host
                .open_path
                .map(|f| unsafe { f(ctx, cstr.as_ptr()) })
                .unwrap_or(-1);
            if opened != 0 {
                return Err(format!("打开失败（{rel}）"));
            }
            Ok(Value::Null)
        }

        // ---- 宿主外壳动作（顶栏按钮 / 托盘菜单项）的约定命令：
        // 点击 → 宿主发 plugin-event 事件 `action`（UI 经 api.on 订阅）
        //   + 调本命令 {action, source}（source = topbar | tray | settings）。
        // 未实现本命令的插件不受影响（宿主忽略调用错误，事件通道照发）。
        "plugin.action" => {
            let action = s("action").unwrap_or_default();
            let source = s("source").unwrap_or_default();
            tb_sdk::log(
                host,
                ctx,
                0,
                &format!("[core-example] 外壳动作触发: {source} → {action}"),
            );
            Ok(serde_json::json!({
                "ok": true,
                "action": action,
                "source": source,
                "author": state.author,
            }))
        }

        // ---- 搜索提供者：manifest 声明 searchProvider: true 后，宿主 search_all
        // 聚合时调用本命令，返回统一结构 [{filename, snippet, path}] ----
        "search.provide" => {
            let query = s("query").unwrap_or_default();
            let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(20);
            let items = data::list(&vault)?;
            let hits: Vec<Value> = items
                .iter()
                .filter(|it| it.text.contains(&query))
                .take(limit as usize)
                .map(|it| {
                    serde_json::json!({
                        "filename": format!("示例条目 · {}", it.text),
                        "snippet": format!("[{}] {}", if it.done { "完成" } else { "待办" }, it.text),
                        "path": format!("data/example/items.json#{}", it.id),
                    })
                })
                .collect();
            Ok(Value::Array(hits))
        }

        _ => Err(format!("未知命令: {method}")),
    }
}

/// CString 帮助（open_path 回调需要 NUL 结尾的 C 字符串）。
fn to_cstr(s: &str) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(s).map_err(|_| "路径含 NUL".to_string())
}

// 生成全部 C ABI 样板（含 panic 隔离）：State / 构造器 / 分发器 三样即完整插件。
// （用 // 而非 ///：rustdoc 不为宏调用生成文档，/// 会触发 unused_doc_comments 警告）
tb_plugin!(ExampleState, state_from_cfg, call);
