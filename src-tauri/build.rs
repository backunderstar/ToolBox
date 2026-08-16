fn main() {
    // 打包资源目录（核心插件 _core 随安装包分发）：确保目录始终存在，
    // 否则 tauri-build 因 `resources/_core` 缺失而拒绝构建
    // （release 构建由 pnpm build:core:release 填充 DLL）。
    let _ = std::fs::create_dir_all("resources/_core");
    tauri_build::build()
}
