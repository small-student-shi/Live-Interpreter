<#
  Live Interpreter - portable Node.js bootstrap

      powershell -NoProfile -ExecutionPolicy Bypass -File setup-node.ps1 [-Version v22.14.0]

  Downloads the official Windows x64 Node.js zip and extracts a *portable*
  runtime into runtime\node\, so the app runs on a PC that has no Node.js
  installed (no admin rights, no installer).

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files
  as ANSI unless they carry a BOM, so any UTF-8 text here would be mangled
  into parse errors.

  Only needed on a PC without Node.js. If the bundle already ships
  runtime\node\node.exe, end users never touch this file.
#>
param([string]$Version = 'v22.14.0')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root 'runtime'
$target     = Join-Path $runtimeDir 'node'
$nodeExe    = Join-Path $target 'node.exe'
$flatExe    = Join-Path $runtimeDir 'node.exe'

if ((Test-Path $nodeExe) -or (Test-Path $flatExe)) {
  Write-Host 'Portable runtime already present.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$zip = Join-Path $runtimeDir "node-$Version-win-x64.zip"

# China-friendly mirrors first: nodejs.org is often slow or unreachable there.
$mirrors = @(
  "https://mirrors.aliyun.com/nodejs-release/$Version/node-$Version-win-x64.zip",
  "https://npmmirror.com/mirrors/node/$Version/node-$Version-win-x64.zip",
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/$Version/node-$Version-win-x64.zip",
  "https://nodejs.org/dist/$Version/node-$Version-win-x64.zip"
)

$downloaded = $false
foreach ($url in $mirrors) {
  try {
    Write-Host "Downloading: $url"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
    $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
    Write-Host ("Done in {0}s ({1} MB)" -f [int]$sw.Elapsed.TotalSeconds, $mb)
    $downloaded = $true
    break
  }
  catch {
    Write-Host ("Failed: " + $_.Exception.Message)
    if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
  }
}

if (-not $downloaded) {
  Write-Host 'All mirrors failed.'
  exit 1
}

try {
  $staging = Join-Path $runtimeDir '_extract'
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  Write-Host 'Extracting...'
  Expand-Archive -Path $zip -DestinationPath $staging -Force
  $inner = Get-ChildItem -Path $staging -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Unexpected archive layout' }

  # Keep only node.exe: the CLI tooling adds ~13 MB and is never used here.
  $exe = Join-Path $inner.FullName 'node.exe'
  if (-not (Test-Path $exe)) { throw 'node.exe not found inside the archive' }
  Copy-Item $exe -Destination $flatExe -Force

  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
catch {
  Write-Host ("Extract failed: " + $_.Exception.Message)
  exit 1
}

if (-not (Test-Path $flatExe)) {
  Write-Host "node.exe missing after extract: $flatExe"
  exit 1
}

$ver = & $flatExe -v
Write-Host "Portable Node.js ready: $flatExe ($ver)"
Set-Content -Path (Join-Path $runtimeDir 'VERSION.txt') -Value "$Version ($ver)" -Encoding ASCII
exit 0