# CDP probe: drive headless Edge, dump page state + console (ASCII only)
param(
  [string]$Url = "http://localhost:1420/debug-editor.html",
  [int]$WaitSec = 7,
  [string]$Port = "9223"
)

$ErrorActionPreference = "Stop"
$base = "http://localhost:$Port"
$t = Invoke-RestMethod -Method Put -Uri "$base/json/new?$([uri]::EscapeDataString($Url))"

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([uri]$t.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null

$script:nextId = 0
function Send-Cdp($method, $params) {
  $script:nextId++
  $obj = @{ id = $script:nextId; method = $method; params = $params } | ConvertTo-Json -Depth 12 -Compress
  $b = [Text.Encoding]::UTF8.GetBytes($obj)
  $ws.SendAsync([ArraySegment[byte]]::new($b), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  return $script:nextId
}

function Receive-All([int]$TimeoutMs = 4000) {
  $cts = [Threading.CancellationTokenSource]::new($TimeoutMs)
  $buf = New-Object byte[] 262144
  $ms = [IO.MemoryStream]::new()
  try {
    do {
      $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token).GetAwaiter().GetResult()
      $ms.Write($buf, 0, $res.Count)
    } while (-not $res.EndOfMessage)
  } catch { }
  $cts.Dispose()
  return [Text.Encoding]::UTF8.GetString($ms.ToArray())
}

Receive-All 1500 | Out-Null

Send-Cdp "Runtime.enable" @{} | Out-Null
Send-Cdp "Log.enable" @{} | Out-Null
Send-Cdp "Page.enable" @{} | Out-Null

Write-Output "listening, waiting $WaitSec s for init..."
Start-Sleep -Seconds $WaitSec

$probe = @'
(() => {
  const log = document.getElementById('log');
  const ir = document.querySelector('.vditor-ir');
  return JSON.stringify({
    url: location.href,
    log: log ? log.textContent : 'NOLOG',
    vditor: !!document.querySelector('.vditor'),
    ir: !!ir,
    contenteditable: ir ? ir.getAttribute('contenteditable') : null,
    toolbarButtons: document.querySelectorAll('.vditor-toolbar button').length,
    bodyLen: document.body ? document.body.innerText.length : -1
  });
})()
'@
Send-Cdp "Runtime.evaluate" @{ expression = $probe; returnByValue = $true } | Out-Null

Start-Sleep -Seconds 1
$raw = Receive-All 5000

foreach ($line in ($raw -split "`n")) {
  $line = $line.Trim()
  if (-not $line) { continue }
  try { $m = $line | ConvertFrom-Json } catch { continue }
  if ($m.method -eq "Runtime.evaluate") { continue }
  if ($m.id) {
    $val = $m.result.result.value
    if ($val) {
      $p = $val | ConvertFrom-Json
      Write-Output "=== PAGE STATE ==="
      Write-Output "URL: $($p.url)"
      Write-Output "vditor: $($p.vditor) | ir: $($p.ir) | contenteditable: $($p.contenteditable) | toolbarButtons: $($p.toolbarButtons)"
      Write-Output "--- PAGE LOG ---"
      Write-Output $p.log
    }
    continue
  }
  if ($m.method -eq "Runtime.consoleAPICalled") {
    $args = $m.params.args | ForEach-Object { if ($null -ne $_.value) { $_.value } else { $_.description } }
    Write-Output "[console] $($args -join ' ')"
  }
  if ($m.method -eq "Runtime.exceptionThrown") {
    Write-Output "[exception] $($m.params.exceptionDetails.text) line $($m.params.exceptionDetails.lineNumber)"
  }
  if ($m.method -eq "Log.entryAdded") {
    Write-Output "[log] $($m.params.entry.level): $($m.params.entry.text)"
  }
}
$ws.Dispose()
Write-Output "=== DONE ==="
