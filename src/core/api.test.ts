import { beforeEach, describe, expect, it, vi } from "vitest";

// 拦截 Tauri IPC：invoke 打桩并记录 (command, args)，断言每个封装
// 映射到正确的命令名与参数（Rust 侧改名/改参时此处立即红）。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  appSettingsGet,
  appSettingsSet,
  backupConfigGet,
  backupConfigSet,
  backupList,
  backupNow,
  backupRestore,
  configExport,
  configImport,
  floatSetLocked,
  floatToggle,
  fsCreate,
  fsDelete,
  fsList,
  fsRead,
  fsRename,
  fsWrite,
  logLevelSet,
  logsClear,
  logsPath,
  logsTail,
  openInExplorer,
  pluginCall,
  pluginLog,
  pluginsDirGet,
  pluginsDirSet,
  pluginsExport,
  pluginsInstall,
  pluginsInstallDeps,
  pluginsInvoke,
  pluginsList,
  pluginsReadFile,
  pluginsReinstallCore,
  pluginsReload,
  pluginsRemovedCore,
  pluginsSetEnabled,
  pluginsUninstall,
  RUNTIME_LABEL,
  searchAll,
  setWindowCaptionColor,
  traySetEnabled,
  vaultGet,
  vaultSet,
} from "./api";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => mockInvoke.mockClear());

describe("api IPC 映射（invoke 命令名与参数）", () => {
  it("vault 工作区", async () => {
    await vaultGet();
    expect(mockInvoke).toHaveBeenCalledWith("vault_get");
    await vaultSet("C:\\vault");
    expect(mockInvoke).toHaveBeenCalledWith("vault_set", { path: "C:\\vault" });
  });

  it("应用设置与托盘", async () => {
    await appSettingsGet();
    expect(mockInvoke).toHaveBeenCalledWith("app_settings_get");
    await appSettingsSet("closeBehavior", "quit");
    expect(mockInvoke).toHaveBeenCalledWith("app_settings_set", {
      key: "closeBehavior",
      value: "quit",
    });
    await traySetEnabled(false);
    expect(mockInvoke).toHaveBeenCalledWith("tray_set_enabled", { enabled: false });
  });

  it("日志管理", async () => {
    await logsPath();
    expect(mockInvoke).toHaveBeenCalledWith("logs_path");
    await logsTail(400);
    expect(mockInvoke).toHaveBeenCalledWith("logs_tail", { maxLines: 400 });
    await logsClear();
    expect(mockInvoke).toHaveBeenCalledWith("logs_clear");
    await logLevelSet("warn");
    expect(mockInvoke).toHaveBeenCalledWith("log_level_set", { level: "warn" });
    await pluginLog("py-tools", "error", "boom");
    expect(mockInvoke).toHaveBeenCalledWith("plugin_log", {
      pluginId: "py-tools",
      level: "error",
      message: "boom",
    });
  });

  it("宿主文件服务", async () => {
    await fsList("V", "docs");
    expect(mockInvoke).toHaveBeenCalledWith("files_list", { vault: "V", dir: "docs" });
    await fsList("V"); // dir 默认 ""
    expect(mockInvoke).toHaveBeenCalledWith("files_list", { vault: "V", dir: "" });
    await fsRead("V", "a.md");
    expect(mockInvoke).toHaveBeenCalledWith("files_read", { vault: "V", rel: "a.md" });
    await fsWrite("V", "a.md", "# t");
    expect(mockInvoke).toHaveBeenCalledWith("files_write", {
      vault: "V",
      rel: "a.md",
      content: "# t",
    });
    await fsCreate("V", "b.md");
    expect(mockInvoke).toHaveBeenCalledWith("files_create", { vault: "V", rel: "b.md" });
    await fsDelete("V", "b.md");
    expect(mockInvoke).toHaveBeenCalledWith("files_delete", { vault: "V", rel: "b.md" });
    await fsRename("V", "a.md", "c.md");
    expect(mockInvoke).toHaveBeenCalledWith("files_rename", {
      vault: "V",
      from: "a.md",
      to: "c.md",
    });
  });

  it("搜索", async () => {
    await searchAll("V", "hello");
    expect(mockInvoke).toHaveBeenCalledWith("search_all", { vault: "V", query: "hello" });
  });

  it("插件系统", async () => {
    await pluginsList();
    expect(mockInvoke).toHaveBeenCalledWith("plugins_list");
    await pluginsSetEnabled("py-tools", true);
    expect(mockInvoke).toHaveBeenCalledWith("plugins_set_enabled", {
      id: "py-tools",
      enabled: true,
    });
    await pluginsReload("py-tools");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_reload", { id: "py-tools" });
    await pluginsInstallDeps("py-tools");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_install_deps", {
      id: "py-tools",
    });
    await pluginsUninstall("py-tools");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_uninstall", { id: "py-tools" });
    await pluginsReinstallCore("core-notes");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_reinstall_core", {
      id: "core-notes",
    });
    await pluginsRemovedCore();
    expect(mockInvoke).toHaveBeenCalledWith("plugins_removed_core");
    await pluginsInstall("D:\\p.zip", "zip");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_install", {
      source: "D:\\p.zip",
      kind: "zip",
    });
    await pluginsExport("py-tools", "D:\\out.zip");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_export", {
      id: "py-tools",
      dest: "D:\\out.zip",
    });
    await pluginsDirGet();
    expect(mockInvoke).toHaveBeenCalledWith("plugins_dir_get");
    await pluginsDirSet("D:\\ToolBoxData\\plugins");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_dir_set", {
      path: "D:\\ToolBoxData\\plugins",
    });
    await pluginsReadFile("py-tools", "ui/index.js");
    expect(mockInvoke).toHaveBeenCalledWith("plugins_read_file", {
      id: "py-tools",
      rel: "ui/index.js",
    });
    await pluginsInvoke("V", "py-tools", "cmd", { a: 1 });
    expect(mockInvoke).toHaveBeenCalledWith("plugins_invoke", {
      vault: "V",
      id: "py-tools",
      command: "cmd",
      args: { a: 1 },
    });
    await pluginCall("V", "core-example", "example.list", null);
    expect(mockInvoke).toHaveBeenCalledWith("plugin_call", {
      vault: "V",
      id: "core-example",
      command: "example.list",
      args: null,
    });
  });

  it("系统集成", async () => {
    await openInExplorer("C:\\dir");
    expect(mockInvoke).toHaveBeenCalledWith("open_in_explorer", { path: "C:\\dir" });
    await setWindowCaptionColor("#112233");
    expect(mockInvoke).toHaveBeenCalledWith("set_window_caption_color", {
      color: "#112233",
    });
    await setWindowCaptionColor(null);
    expect(mockInvoke).toHaveBeenCalledWith("set_window_caption_color", { color: null });
  });

  it("自动备份", async () => {
    await backupConfigGet();
    expect(mockInvoke).toHaveBeenCalledWith("backup_config_get");
    const cfg = {
      enabled: true,
      intervalMinutes: 60,
      keep: 5,
      lastBackupAt: null,
    };
    await backupConfigSet(cfg);
    expect(mockInvoke).toHaveBeenCalledWith("backup_config_set", { config: cfg });
    await backupNow("V");
    expect(mockInvoke).toHaveBeenCalledWith("backup_now", { vault: "V" });
    await backupList("V");
    expect(mockInvoke).toHaveBeenCalledWith("backup_list", { vault: "V" });
    await backupRestore("V", "backup-1700000000");
    expect(mockInvoke).toHaveBeenCalledWith("backup_restore", {
      vault: "V",
      name: "backup-1700000000",
    });
  });

  it("配置导入导出与浮窗", async () => {
    const frontend = { nav: "{}" };
    await configExport("C:\\c.json", frontend);
    expect(mockInvoke).toHaveBeenCalledWith("config_export", {
      path: "C:\\c.json",
      frontend,
    });
    await configImport("C:\\c.json");
    expect(mockInvoke).toHaveBeenCalledWith("config_import", { path: "C:\\c.json" });
    await floatToggle();
    expect(mockInvoke).toHaveBeenCalledWith("float_toggle");
    await floatSetLocked(true);
    expect(mockInvoke).toHaveBeenCalledWith("float_set_locked", { locked: true });
  });

  it("RUNTIME_LABEL 覆盖三种运行时", () => {
    expect(RUNTIME_LABEL.webview).toBe("JS");
    expect(RUNTIME_LABEL.process).toBe("Python");
    expect(RUNTIME_LABEL.native).toBe("原生");
  });
});
