// toggle 前后枚举 toolbox 窗口可见性，定位浮窗窗口
const { execSync } = await import("node:child_process");
const targets = await fetch("http://localhost:9226/json").then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420/.test(t.url));
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 800));

// 用 PowerShell 枚举（脚本内嵌临时 ps1 太麻烦，用 node 直接跑不了 Win32；改为调用外部 pwsh）
const enumCmd = `Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public delegate bool EWPX(IntPtr h, IntPtr l);
public class WEX {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EWPX f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
"@
$proc = Get-Process toolbox | Select-Object -First 1
$script:o = @()
$cb = [EWPX]{ param($h, $l)
  $p2 = 0; [WEX]::GetWindowThreadProcessId($h, [ref]$p2) | Out-Null
  if ($p2 -eq $proc.Id) {
    $sb = New-Object System.Text.StringBuilder 256
    [WEX]::GetWindowText($h, $sb, 256) | Out-Null
    $rc = New-Object WEX+RECT
    [WEX]::GetWindowRect($h, [ref]$rc) | Out-Null
    $script:o += "$h|$([WEX]::IsWindowVisible($h))|$($sb.ToString())|$($rc.R-$rc.L)x$($rc.B-$rc.T)"
  }
  return $true
}
[WEX]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:o`;

const enumWindows = () => execSync(`pwsh -Command "${enumCmd.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim().split("\n");

console.log("== toggle 前 ==");
console.log(enumWindows().join("\n"));
const r1 = await ev(`window.__TAURI_INTERNALS__.invoke('float_toggle').then(v => 'visible=' + v).catch(e => 'err ' + e)`);
console.log("toggle:", r1);
await new Promise((r) => setTimeout(r, 1500));
console.log("== toggle 后 ==");
console.log(enumWindows().join("\n"));
ws.close();
process.exit(0);
