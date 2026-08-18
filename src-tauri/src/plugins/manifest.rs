//! 插件清单（plugin.json）解析与校验。

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntime {
    Webview,
    Process,
    /// 原生核心插件（cdylib DLL，宿主进程内经 C ABI 调用）
    Native,
}

/// 前端界面声明（插件自带页面，宿主经 iframe + tb-plugin:// 协议加载）。
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiDecl {
    /// 入口 HTML（相对插件目录），如 "ui/index.html"
    #[serde(default)]
    pub entry: String,
}

/// 主题声明（皮肤插件）：插件作为"主题包"向宿主主题系统提供
/// base（亮/暗基础）+ 令牌覆盖 + 可选 CSS 覆盖文件。启用后并入设置页
/// 主题选择器；纯数据插件无需任何运行时代码（runtime 可为 webview 且不写 entry）。
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDecl {
    /// 亮/暗基础（驱动 tokens.css 的 [data-theme]）
    #[serde(default)]
    pub base: String,
    /// 令牌覆盖（CSS 变量名 → 值）；为空表示完全使用 base 默认
    #[serde(default)]
    pub tokens: std::collections::HashMap<String, String>,
    /// 可选 CSS 覆盖文件（相对插件目录）：组件级换肤（布局微调/形状/动效），
    /// 经宿主全局注入，切换主题即移除
    #[serde(default)]
    pub css: Option<String>,
}

/// 导航入口声明（插件启用时并入侧边栏；仅内容型插件使用）。
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NavDecl {
    /// 导航项 id（前端 ViewId 或插件自定义）
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// 图标名（前端内置图标表的 key，如 "file-text"）
    #[serde(default)]
    pub icon: String,
    /// 侧边栏分组（如 "工作区"）
    #[serde(default)]
    pub group: String,
    /// 视图组件名（前端内置组件表的 key，如 "RecordsView"）
    #[serde(default)]
    pub view: String,
}

/// 插件清单。v1 字段：
/// - runtime = "webview"：entry 为 JS 文件相对路径，运行于界面内
/// - runtime = "process"：command 为启动命令（argv），如 ["python", "main.py"]
/// - runtime = "native"：command 为 DLL 文件名（相对插件目录），如 ["tb_records.dll"]
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub runtime: PluginRuntime,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub config: serde_json::Value,
    /// 搜索提供者：实现 `search.provide {query, limit?} -> [{path, title, snippet}]`
    /// 命令，启用后自动进入全局搜索范围（任何 runtime 均可声明）。
    #[serde(default)]
    pub search_provider: bool,
    /// 系统插件：数据安全/横切能力（如备份、搜索），前端不可禁用。
    #[serde(default)]
    pub system: bool,
    /// 插件自带前端界面（宿主经 iframe 加载；缺省则用宿主内置视图组件）。
    #[serde(default)]
    pub ui: Option<UiDecl>,
    /// 导航入口（启用时并入侧边栏）。
    #[serde(default)]
    pub nav: Vec<NavDecl>,
    /// 主题声明（皮肤插件）：非空时本插件是主题包，启用后并入主题选择器。
    /// 纯主题插件可省略 entry（webview 运行时仅作类型占位，不加载代码）。
    #[serde(default)]
    pub theme: Option<ThemeDecl>,
}

/// v1 认识的权限（未知权限记录 warning，不阻止加载）。
pub const KNOWN_PERMISSIONS: &[&str] = &["fs:read:vault", "fs:write:vault", "log", "network"];

impl PluginManifest {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty()
            && self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err(format!(
                "插件 id 非法（仅允许小写字母/数字/连字符）: {:?}",
                self.id
            ));
        }
        if self.name.trim().is_empty() {
            return Err(format!("插件缺少 name: {}", self.id));
        }
        if self.version.trim().is_empty() {
            return Err(format!("插件缺少 version: {}", self.id));
        }
        match self.runtime {
            PluginRuntime::Webview => {
                // 纯主题插件（声明了 theme）无需 JS 入口：它只是数据包
                if self.entry.as_deref().unwrap_or("").trim().is_empty() && self.theme.is_none() {
                    return Err(format!(
                        "webview 插件缺少 entry（JS 入口）: {}",
                        self.id
                    ));
                }
            }
            PluginRuntime::Process => {
                let cmd = self.command.as_ref();
                if cmd.map(|c| c.is_empty()).unwrap_or(true) {
                    return Err(format!("process 插件缺少 command（启动命令）: {}", self.id));
                }
            }
            PluginRuntime::Native => {
                let cmd = self.command.as_ref();
                if cmd.map(|c| c.is_empty()).unwrap_or(true) {
                    return Err(format!("native 插件缺少 command（DLL 文件名）: {}", self.id));
                }
            }
        }
        for p in &self.permissions {
            if !KNOWN_PERMISSIONS.contains(&p.as_str()) {
                eprintln!(
                    "[plugin] 警告: {} 声明了未知权限 {:?}（忽略）",
                    self.id, p
                );
            }
        }
        if let Some(t) = &self.theme {
            if t.base != "light" && t.base != "dark" {
                return Err(format!("主题 base 非法（仅 light/dark）: {}", self.id));
            }
        }
        Ok(())
    }
}
