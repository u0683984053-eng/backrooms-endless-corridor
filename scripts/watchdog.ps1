param(
  [switch]$Loop,
  [switch]$Once,
  [switch]$Report,
  [int]$ThresholdSec = 600,
  [int]$MaxMinutes = 720,
  [int]$IntervalSec = 15
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $root 'logs\op-marker.txt'
$log    = Join-Path $root 'logs\watchdog.log'

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}

function Get-NodeCpuDelta([ref]$last) {
  $total = 0.0
  Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
    try { $total += $_.CPU } catch {}
  }
  $delta = if ($last.Value -ge 0) { $total - $last.Value } else { 0.0 }
  $last.Value = $total
  return $delta
}

function Check-Once {
  if (-not (Test-Path $marker)) { return 'idle' }
  $content = (Get-Content $marker -Raw).Trim()
  if ($content -like 'DONE*') { return 'done' }
  $ageSec = [int]((Get-Date) - (Get-Item $marker).LastWriteTime).TotalSeconds
  if ($ageSec -gt $ThresholdSec) {
    $cpu = Get-NodeCpuDelta ([ref]$script:lastCpu)
    if ($cpu -gt 1.0) {
      Log ("ALERT-长时间运行: 标记超龄 {0}s, node CPU 增量 {1:N1}s (仍在产出, 属正常慢). 任务: {2}" -f $ageSec, $cpu, $content)
      return 'long'
    } else {
      Log ("ALERT-疑似挂起: 标记超龄 {0}s 且 node CPU 空转 ({1:N1}s). 任务: {2}" -f $ageSec, $cpu, $content)
      try { [console]::beep(1200, 800) } catch {}
      return 'hang'
    }
  }
  return 'running'
}

if ($Report) {
  if (Test-Path $marker) { Log ("REPORT marker: {0}" -f (Get-Content $marker -Raw).Trim()) } else { Log 'REPORT marker: none' }
  if (Test-Path $log) { Get-Content $log -Tail 25 } else { Log 'REPORT log: none' }
  exit 0
}

$script:lastCpu = -1.0
Log ("WATCHDOG START threshold={0}s interval={1}s max={2}min pid={3}" -f $ThresholdSec, $IntervalSec, $MaxMinutes, $PID)
Set-Content -Path (Join-Path $root 'logs\watchdog.pid') -Value $PID -Encoding UTF8

$deadline = (Get-Date).AddMinutes($MaxMinutes)
$mode = if ($Loop) { 'loop' } else { 'once' }
while ($mode -eq 'loop' -and (Get-Date) -lt $deadline) {
  Check-Once | Out-Null
  Start-Sleep -Seconds $IntervalSec
}
if ($mode -eq 'once') { Check-Once | Out-Null }
Log 'WATCHDOG EXIT'
