# 构建核心插件并部署到 %APPDATA%/com.toolbox.desktop/plugins/_core/<id>/
# 供宿主（PluginManager 扫描 _core）与 E2E 使用。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "[build-core] 构建核心插件..."
cargo build --manifest-path (Join-Path $root "Cargo.toml") -p tb-records
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$target = Join-Path $env:APPDATA "com.toolbox.desktop\plugins\_core"
$pluginDir = Join-Path $target "core-records"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item (Join-Path $root "target\debug\tb_records.dll") (Join-Path $pluginDir "tb_records.dll") -Force

$manifest = @{
  id             = "core-records"
  name           = "记录"
  version        = "0.1.0"
  runtime        = "native"
  command        = @("tb_records.dll")
  description    = "核心插件：工作记录（data/records CRUD + 搜索提供者）"
  searchProvider = $true
  nav            = @(@{ id = "records"; label = "记录"; icon = "notebook"; group = "工作区"; view = "RecordsView" })
}
# WriteAllText 无 BOM（serde_json 不识别 BOM）
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $pluginDir "plugin.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[build-core] 已部署: $pluginDir"
