# Installs (or updates) Rubban for the current user.
#   powershell -ExecutionPolicy Bypass -File .\Install-Rubban.ps1
# Copies the Rubban build from this folder to %USERPROFILE%\Rubban\Rubban-Windows and adds Start menu
# (and optionally desktop) shortcuts. Settings live in %USERPROFILE%\Rubban\Rubban-Data.
# Coming from Marsad (or Prism): settings and the bundled kubectl/helm are copied over once, and the
# old Start menu shortcut is removed. The old install folder is left in place for you to delete.
param(
  [string]$Source = $PSScriptRoot,
  [string]$Destination = (Join-Path $env:USERPROFILE 'Rubban\Rubban-Windows'),
  [switch]$DesktopShortcut,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path $Source).Path
if (-not (Test-Path (Join-Path $Source 'Rubban.exe'))) { throw "Rubban.exe was not found in $Source. Run this script from the extracted Rubban-<version>-Windows-x64 folder." }
if (Get-Process -Name Rubban, Marsad, Prism -ErrorAction SilentlyContinue) { throw 'Close Rubban (and any older Marsad or Prism window) before installing.' }

# Earlier installs under the previous names, newest name first.
$legacyRoots = @('Marsad', 'Prism') | ForEach-Object { Join-Path $env:USERPROFILE $_ }
$legacyApps = $legacyRoots | ForEach-Object { Join-Path $_ "$(Split-Path $_ -Leaf)-Windows" }

# Keep CLIs bundled by an earlier install when this build does not bring its own.
$tools = Join-Path $Destination 'resources\app\tools'
$keepTools = $null
if (-not (Test-Path (Join-Path $Source 'resources\app\tools'))) {
  $previous = @($tools) + ($legacyApps | ForEach-Object { Join-Path $_ 'resources\app\tools' }) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($previous) {
    $keepTools = Join-Path $env:TEMP ("rubban-tools-" + [guid]::NewGuid())
    Copy-Item $previous $keepTools -Recurse
  }
}

if (Test-Path $Destination) {
  $isRubban = (Test-Path (Join-Path $Destination 'Rubban.exe')) -or (Test-Path (Join-Path $Destination 'Marsad.exe')) -or (Test-Path (Join-Path $Destination 'Prism.exe'))
  if ((Get-ChildItem $Destination -Force | Select-Object -First 1) -and -not $isRubban) { throw "$Destination is not empty and is not a Rubban install. Choose another -Destination." }
  Remove-Item (Join-Path $Destination '*') -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Get-ChildItem $Source -Force | Where-Object { $_.Name -ne 'Install-Rubban.ps1' } | Copy-Item -Destination $Destination -Recurse -Force
if ($keepTools) { Copy-Item $keepTools $tools -Recurse; Remove-Item $keepTools -Recurse -Force }

# Settings from Marsad or Prism are copied once (not moved, so the old version keeps its own).
$data = Join-Path (Split-Path $Destination -Parent) 'Rubban-Data'
if (-not (Test-Path $data)) {
  $oldData = $legacyRoots | ForEach-Object { Join-Path $_ "$(Split-Path $_ -Leaf)-Data" } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($oldData) {
    Copy-Item $oldData $data -Recurse
    Remove-Item -ErrorAction SilentlyContinue (Join-Path $data 'connection.json')
    Write-Host "Copied settings from $oldData"
  }
}

$exe = Join-Path $Destination 'Rubban.exe'
$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($old in 'Marsad.lnk', 'Prism.lnk') { Remove-Item -ErrorAction SilentlyContinue (Join-Path $programs $old), (Join-Path $desktop $old) }
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
foreach ($old in $legacyApps) { if (Test-Path $old) { Write-Host "The previous install in $old is no longer used; delete it when you are happy with Rubban." } }
if (-not $NoStart) { Start-Process $exe }
