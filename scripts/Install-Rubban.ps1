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

# A Rubban install has Rubban.exe and either the current layout (a VERSION file next to it) or the
# Electron layout of 0.11 and earlier (resources\app\package.json). Updating from 0.11 uses this.
function Test-RubbanInstall([string]$Folder) {
  if (-not (Test-Path (Join-Path $Folder 'Rubban.exe'))) { return $false }
  return (Test-Path (Join-Path $Folder 'VERSION')) -or (Test-Path (Join-Path $Folder 'resources\app\package.json'))
}

# Keep CLIs bundled by the existing install when this build does not bring its own.
$tools = Join-Path $Destination 'tools'
$oldTools = Join-Path $Destination 'resources\app\tools'
$keepTools = $null
if (-not (Test-Path (Join-Path $Source 'tools'))) {
  $existing = @($tools, $oldTools) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($existing) {
    $keepTools = Join-Path $env:TEMP ("rubban-tools-" + [guid]::NewGuid())
    Copy-Item $existing $keepTools -Recurse
  }
}

if (Test-Path $Destination) {
  if ((Get-ChildItem $Destination -Force | Select-Object -First 1) -and -not (Test-RubbanInstall $Destination)) { throw "$Destination is not empty and is not a Rubban install. Choose another -Destination." }
  # Keep the installer's marker and uninstaller when a zip update lands on an installed copy.
  Get-ChildItem $Destination -Force | Where-Object { $_.Name -ne 'installed.json' -and $_.Name -notlike 'unins*' } | Remove-Item -Recurse -Force
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

$version = (Get-Content (Join-Path $Destination 'VERSION') -Raw).Trim()
Write-Host "Rubban $version installed to $Destination (settings: $data)"
if (-not $NoStart) { Start-Process $exe }
