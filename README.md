# ToolBox

个人工具箱桌面应用：Rust 核心 + Tauri 2 + React/TypeScript。

规划笔记、数据处理、清单记录、AI 整理与博客发布等模块，详见 [PLAN.md](PLAN.md)。

## 开发

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 启动开发模式（弹窗）
```

## 当前状态

- **M0 骨架（本次）**：应用外壳（顶栏/侧栏/状态栏）、设计令牌与亮暗主题、Rust `ping` 命令打通 IPC。
- 模块按里程碑推进：M1 笔记 → M2 插件系统 → M3 数据工具 → M4 清单与记录 → M5 主题系统 → M6 AI → M7 博客发布。

## 目录

```
src-tauri/   Rust 核心（core 数据层 / plugins 插件管理 / rpc 协议）
src/         前端（themes 主题引擎 / components 组件 / core IPC）
scripts/     开发辅助脚本（如图标生成）
```

## 环境要求

- Rust（MSVC 工具链）+ Visual Studio Build Tools（含 C++ 桌面开发）
- Node.js ≥ 20、pnpm
- Windows 10/11（WebView2 运行时）
