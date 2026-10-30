# Installs (or updates) Rubban for the current user.
#   powershell -ExecutionPolicy Bypass -File .\Install-Rubban.ps1
# Copies the Rubban build from this folder to %USERPROFILE%\Rubban\Rubban-Windows and adds Start menu
# (and optionally desktop) shortcuts. Settings live in %USERPROFILE%\Rubban\Rubban-Data.
param(
  [string]$Source = $PSScriptRoot,
  [string]$Destination = (Join-Path $env:USERPROFILE 'Rubban\Rubban-Windows'),
  [switch]$DesktopShortcut,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path $Source).Path
if (-not (Test-Path (Join-Path $Source 'Rubban.exe'))) { throw "Rubban.exe was not found in $Source. Run this script from the extracted Rubban-<version>-Windows-x64 folder." }
if (Get-Process -Name Rubban -ErrorAction SilentlyContinue) { throw 'Close Rubban before installing.' }

# Keep CLIs bundled by the existing install when this build does not bring its own.
$tools = Join-Path $Destination 'resources\app\tools'
$keepTools = $null
if (-not (Test-Path (Join-Path $Source 'resources\app\tools'))) {
  if (Test-Path $tools) {
    $keepTools = Join-Path $env:TEMP ("rubban-tools-" + [guid]::NewGuid())
    Copy-Item $tools $keepTools -Recurse
  }
}

if (Test-Path $Destination) {
  $isRubban = Test-Path (Join-Path $Destination 'Rubban.exe')
  if ((Get-ChildItem $Destination -Force | Select-Object -First 1) -and -not $isRubban) { throw "$Destination is not empty and is not a Rubban install. Choose another -Destination." }
  Remove-Item (Join-Path $Destination '*') -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Get-ChildItem $Source -Force | Where-Object { $_.Name -ne 'Install-Rubban.ps1' } | Copy-Item -Destination $Destination -Recurse -Force
if ($keepTools) { Copy-Item $keepTools $tools -Recurse; Remove-Item $keepTools -Recurse -Force }

$data = Join-Path (Split-Path $Destination -Parent) 'Rubban-Data'

$exe = Join-Path $Destination 'Rubban.exe'
$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$targets = @(Join-Path $programs 'Rubban.lnk')
if ($DesktopShortcut) { $targets += Join-Path $desktop 'Rubban.lnk' }
foreach ($link in $targets) {
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = $exe
  $shortcut.WorkingDirectory = $Destination
  $shortcut.IconLocation = "$exe,0"
  $shortcut.Description = 'Rubban Kubernetes workbench'
  $shortcut.Save()
}

$version = (Get-Content (Join-Path $Destination 'resources\app\package.json') -Raw | ConvertFrom-Json).version
Write-Host "Rubban $version installed to $Destination (settings: $data)"
if (-not $NoStart) { Start-Process $exe }
