//! 插件依赖安装：捆绑 Python 的 `pip install --target <插件>/vendor -r requirements.txt`。
//!
//! 独立成模块（2026-09 拆分，原 manager.rs 内部）：pip 命令构造/超时/输出尾部
//! 收集与插件管理器状态无关，纯函数可单独测试。vendored 放置——main.py 启动时
//! sys.path 插入 vendor/，见插件开发指南 §3.5 方案 A。

use std::path::Path;
use std::time::{Duration, Instant};

/// pip install 超时：装小依赖几秒，pandas 等大 wheel 也要几分钟（网速决定）。
pub(crate) const PIP_TIMEOUT: Duration = Duration::from_secs(600);

/// 取文本末尾 N 行（错误/输出回显用，避免全量输出刷屏）。
pub(crate) fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// 用指定 Python 跑 `pip install --target <vendor> -r <req>`（workdir 为插件目录）。
///
/// 输出落临时文件再读尾部：piped 缓冲写满会阻塞 pip（Windows 管道 ~4KB），
/// 且进度条输出（\r 刷新）很大，没必要全量进内存。
/// 返回 `(pip 结果, stdout 尾部, stderr 尾部)`——pip 结果 `Ok(true)` 成功、
/// `Ok(false)` 退出码非 0、`Err` 为启动失败/超时；尾部供调用方拼进错误信息。
pub(crate) fn run_pip_install(
    python: &Path,
    req: &Path,
    vendor: &Path,
    workdir: &Path,
) -> (Result<bool, String>, String, String) {
    let tag = format!("tb-pip-{}", std::process::id());
    let out_log = std::env::temp_dir().join(format!("{tag}.out.log"));
    let err_log = std::env::temp_dir().join(format!("{tag}.err.log"));
    let vendor_s = vendor.to_string_lossy().into_owned();
    let req_s = req.to_string_lossy().into_owned();
    let result = (|| -> Result<bool, String> {
        let out = std::fs::File::create(&out_log).map_err(|e| format!("创建日志文件失败: {e}"))?;
        let err = std::fs::File::create(&err_log).map_err(|e| format!("创建日志文件失败: {e}"))?;
        let mut child = std::process::Command::new(python)
            .args([
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "--target",
                &vendor_s,
                "-r",
                &req_s,
            ])
            .current_dir(workdir)
            .stdout(std::process::Stdio::from(out))
            .stderr(std::process::Stdio::from(err))
            .spawn()
            .map_err(|e| format!("启动 pip 失败: {e}"))?;
        let deadline = Instant::now() + PIP_TIMEOUT;
        loop {
            if let Some(status) =
                child.try_wait().map_err(|e| format!("等待 pip 失败: {e}"))?
            {
                return Ok(status.success());
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "pip install 超过 {} 秒仍未完成，已终止（网络慢可重试）",
                    PIP_TIMEOUT.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    })();
    let tail = |p: &Path| -> String {
        std::fs::read_to_string(p)
            .map(|s| tail_lines(&s, 40))
            .unwrap_or_default()
    };
    let out_tail = tail(&out_log);
    let err_tail = tail(&err_log);
    let _ = std::fs::remove_file(&out_log);
    let _ = std::fs::remove_file(&err_log);
    (result, out_tail, err_tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_lines_keeps_last_n() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("a\nb", 10), "a\nb");
        assert_eq!(tail_lines("", 5), "");
        assert_eq!(tail_lines("a\nb\nc", 0), "");
    }
}
