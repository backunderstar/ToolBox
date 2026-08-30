//! 捆绑 Python 运行时：随安装包分发可重定位的 CPython（python-build-standalone），
//! 目标机没有 Python 时 process 插件（`command: ["python", "main.py"]`）也能运行。
//!
//! 链路：
//! - 构建期 `pnpm fetch:python` 把 full 变体（含 pip）解压到 `src-tauri/resources/python/`
//! - 打包期 `bundle.resources` 随 NSIS 分发（tauri.conf.json）
//! - 打包版首启 `ensure_bundled_python` 部署到 `%APPDATA%/com.toolbox.desktop/python/`
//!   （配置目录可写：插件"安装依赖" pip install --target 需要）
//! - 解释器解析三级优先（`resolve_interpreter`）：
//!   1. 插件目录自带 `python.exe`（插件完全自包含）
//!   2. 全局捆绑解释器
//!   3. 回落系统 PATH（原行为）
//!
//! 与 `_core` 核心插件部署（manager::ensure_core_plugins）同构。

use std::path::{Path, PathBuf};
use tauri::Manager;

/// 资源子目录名（bundle.resources 与部署目录共用）。
pub const PYTHON_DIR: &str = "python";

/// 打包版：把随包分发的 Python 运行时部署到 `%APPDATA%/com.toolbox.desktop/python/`
/// （覆盖部署，与应用版本一致；失败只记日志不阻断启动）。
/// dev 由 `pnpm fetch:python` 直接落在仓库 `src-tauri/resources/python/`，无需部署。
#[cfg(not(dev))]
pub fn ensure_bundled_python(app: &tauri::AppHandle) {
    let Ok(res) = app.path().resource_dir() else {
        return;
    };
    let src = res.join("resources").join(PYTHON_DIR);
    if !src.join("python.exe").is_file() {
        return; // 未捆绑（如 dev 构建直接打包）→ 回落系统 python
    }
    let Some(dst) = bundled_python_deploy_dir(app) else {
        return;
    };
    match deploy_bundled_python(&src, &dst) {
        Ok(()) => crate::core::log::info(&format!(
            "[python] 已部署捆绑 Python 运行时到 {:?}",
            dst
        )),
        Err(e) => crate::core::log::error(&format!("[python] 捆绑 Python 运行时部署失败: {e}")),
    }
}

/// 部署目标目录：`%APPDATA%/com.toolbox.desktop/python/`（与 app_config_dir 一致）。
pub(crate) fn bundled_python_deploy_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(PYTHON_DIR))
}

/// 部署实现（可测）：**原子替换**——先整体复制到同父目录的临时目录，完成后
/// 一次性切换（删旧 → rename）。
/// 为什么不能"先删旧目录再复制"：部署期间部署目录会短暂不完整（python.exe 已
/// 在而 Lib 未到），此时并发启动的 process 插件会把它当作可用捆绑解释器，
/// Python 启动即崩（Failed to import encodings，8/29 打包冒烟实测）。原子替换
/// 保证部署目录要么是完整的旧版本，要么不存在（回落资源目录，同样完整）。
/// 仅 `ensure_bundled_python`（release）调用；dev 下无调用方，压制 dead_code 告警。
#[cfg_attr(dev, allow(dead_code))]
pub(crate) fn deploy_bundled_python(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = dst.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    super::manager::copy_dir_recursive(src, &tmp)?;
    let _ = std::fs::remove_dir_all(dst);
    std::fs::rename(&tmp, dst).map_err(|e| format!("部署失败: {e}"))
}

/// 当前生效的捆绑解释器目录：优先部署目录（打包版首启后），其次资源目录
/// （打包资源 / dev 仓库 `src-tauri/resources/python`）。
pub(crate) fn bundled_python_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(d) = bundled_python_deploy_dir(app) {
        if d.join("python.exe").is_file() {
            return Some(d);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("resources").join(PYTHON_DIR));
    }
    // dev：target/debug/toolbox.exe → 仓库根 → src-tauri/resources/python
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(p.join("src-tauri").join("resources").join(PYTHON_DIR));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.join("python.exe").is_file())
}

/// 解释器命令是否 Python（大小写/`.exe` 后缀不敏感）。
pub(crate) fn is_python_command(cmd: &str) -> bool {
    let lower = cmd.trim_end_matches(".exe").to_ascii_lowercase();
    lower == "python" || lower == "python3"
}

/// 解析 process 插件的解释器（仅对 `python`/`python3` 生效）：
/// 1. 插件目录内自带解释器 `<plugin>/python.exe`（第三层：插件完全自包含）
/// 2. `bundled_dir` 指定的全局捆绑解释器目录（第二层：默认路径；由调用方在能拿到
///    AppHandle 时经 `bundled_python_dir` 解析后缓存——**数据对象不持有 tauri 类型**，
///    见 manager.rs struct 注释的历史教训）
/// 3. 都没有 → Err（调用方保留原命令走系统 PATH，spawn 失败时给安装提示）
///    非 Python 命令不解析（Err，走原命令）。
pub(crate) fn resolve_interpreter(
    bundled_dir: Option<&Path>,
    plugin_dir: &Path,
    requested: &str,
) -> Result<PathBuf, String> {
    if !is_python_command(requested) {
        return Err(format!("非 Python 解释器命令，不解析: {requested}"));
    }
    // 1. 插件自带（整个运行时随插件分发，见插件开发指南 §3.5 方案 D）
    let self_contained = plugin_dir.join("python.exe");
    if self_contained.is_file() {
        return Ok(self_contained);
    }
    // 2. 全局捆绑（默认路径：目标机无 Python 也能跑）
    if let Some(dir) = bundled_dir {
        let exe = dir.join("python.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    Err("未找到捆绑解释器，回落系统 python".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 部署：覆盖式复制（先删旧再复制），旧残留不残留。
    #[test]
    fn deploy_replaces_old_copy() {
        let base = std::env::temp_dir().join(format!("tb-python-deploy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("Lib")).unwrap();
        std::fs::write(src.join("python.exe"), b"old").unwrap();
        std::fs::write(src.join("Lib/keep.txt"), b"1").unwrap();
        // 首次部署
        deploy_bundled_python(&src, &dst).unwrap();
        assert!(dst.join("python.exe").is_file());
        // 覆盖部署：旧目录里的残留文件被清掉（与应用版本一致）
        std::fs::write(dst.join("stale.txt"), b"stale").unwrap();
        std::fs::write(src.join("Lib/new.txt"), b"2").unwrap();
        deploy_bundled_python(&src, &dst).unwrap();
        assert!(!dst.join("stale.txt").exists(), "覆盖部署应清空旧残留");
        assert!(dst.join("Lib/new.txt").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 三级解析：插件目录自带解释器优先于一切。
    #[test]
    fn resolve_prefers_plugin_self_contained() {
        let base = std::env::temp_dir().join(format!("tb-python-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let plugin_dir = base.join("plugins/my-py");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("python.exe"), b"x").unwrap();
        // app = None（无捆绑）也应命中插件自带
        let p = resolve_interpreter(None, &plugin_dir, "python").unwrap();
        assert_eq!(p, plugin_dir.join("python.exe"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 无自带、无捆绑 → Err（回落系统 PATH）。
    #[test]
    fn resolve_falls_back_when_nothing_bundled() {
        let base = std::env::temp_dir().join(format!("tb-python-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let plugin_dir = base.join("plugins/my-py");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        assert!(resolve_interpreter(None, &plugin_dir, "python").is_err());
        // 非 python 命令不解析
        assert!(resolve_interpreter(None, &plugin_dir, "node").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
