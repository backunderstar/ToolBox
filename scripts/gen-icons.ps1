# 生成应用图标（PNG + ICO）
# 用法: pwsh -File scripts/gen-icons.ps1
# 输出到 src-tauri/icons/，供 tauri.conf.json 引用。

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\src-tauri\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-IconPng {
    param([int]$Size, [string]$Path)
    $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # 实心方形（直角，极简）
    $rect = [System.Drawing.RectangleF]::new(0, 0, $Size, $Size)
    $accent = [System.Drawing.Color]::FromArgb(255, 180, 83, 42) # #B4532A 陶土色
    $brush = [System.Drawing.SolidBrush]::new($accent)
    $g.FillRectangle($brush, [single]0, [single]0, [single]$Size, [single]$Size)

    # "TB" 字样
    $font = [System.Drawing.Font]::new(
        "Segoe UI",
        [Math]::Max(8, $Size * 0.34),
        [System.Drawing.FontStyle]::Bold,
        [System.Drawing.GraphicsUnit]::Pixel)
    $sf = [System.Drawing.StringFormat]::new()
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $g.DrawString("TB", $font, $white, $rect, $sf)

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $brush.Dispose(); $white.Dispose()
    $font.Dispose(); $sf.Dispose()
    Write-Output "PNG  $Size x $Size  ->  $Path"
}

New-IconPng 32  (Join-Path $outDir "32x32.png")
New-IconPng 128 (Join-Path $outDir "128x128.png")
New-IconPng 256 (Join-Path $outDir "128x128@2x.png")
New-IconPng 512 (Join-Path $outDir "icon.png")

# ICO（内嵌 256x256 PNG，Vista+ 支持）
$png = [System.IO.File]::ReadAllBytes((Join-Path $outDir "128x128@2x.png"))
$ms = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($ms)
$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type: icon
$bw.Write([uint16]1)          # count
$bw.Write([byte]0)            # width  (0 = 256)
$bw.Write([byte]0)            # height (0 = 256)
$bw.Write([byte]0)            # palette
$bw.Write([byte]0)            # reserved
$bw.Write([uint16]1)          # planes
$bw.Write([uint16]32)         # bit count
$bw.Write([uint32]$png.Length)
$bw.Write([uint32]22)         # offset
$bw.Write($png)
$icoPath = Join-Path $outDir "icon.ico"
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Output "ICO  icon.ico (256x256)  ->  $icoPath"
