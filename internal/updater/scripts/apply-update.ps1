# Applies a downloaded Rubban update after Rubban has exited. Started detached by internal/updater:
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File apply-update.ps1 -Zip <zip> -Install <folder> -ProcessId <pid> -Exe <Rubban.exe> -ResultFile <json> -Version <v>
# A build put in place by the installer passes -Setup <Rubban-<v>-Setup.exe> instead of -Zip: the same
# wait, result file and restart, with the installer run silently over the existing install.
# Always starts a Rubban again (the new one, or the old one when something went wrong) and writes result.json.
param(
  [string]$Zip = '',
  [string]$Setup = '',
  [Parameter(Mandatory)][string]$Install,
  [Parameter(Mandatory)][int]$ProcessId,
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$ResultFile,
  [string]$Version = '',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
if (-not $Zip -and -not $Setup) { throw 'Pass -Zip or -Setup.' }
$work = Split-Path ($(if ($Setup) { $Setup } else { $Zip })) -Parent
$extract = Join-Path $work 'extract'
$backup = Join-Path $work 'backup'
function Write-Result([bool]$ok, [string]$message) {
  $json = [ordered]@{ ok = $ok; version = $Version; error = $message; installedTo = $Install } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($ResultFile, $json)
}
$ok = $false; $message = ''
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -or (Get-Process -Name Rubban -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Install, [StringComparison]::OrdinalIgnoreCase) }))) { Start-Sleep -Milliseconds 250 }
  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) { throw 'Rubban did not close in time.' }
  if ($Setup) {
    $log = Join-Path $work 'setup.log'
    $run = Start-Process -FilePath $Setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', "/LOG=`"$log`"") -Wait -PassThru
    if ($run.ExitCode -ne 0) { throw "The installer exited with code $($run.ExitCode). See $log." }
    $ok = $true
  } else {
  Remove-Item $extract, $backup -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $Zip -DestinationPath $extract -Force
  $source = Get-ChildItem $extract -Recurse -Filter Rubban.exe | Select-Object -First 1
  if (-not $source) { throw 'The update does not contain Rubban.exe.' }
  $sourceDir = $source.DirectoryName
  $installer = Join-Path $sourceDir 'Install-Rubban.ps1'
  if (-not (Test-Path $installer)) { throw 'The update does not contain Install-Rubban.ps1.' }
  Copy-Item $Install $backup -Recurse -Force
  try {
    & $installer -Source $sourceDir -Destination $Install -NoStart
  } catch {
    # Put the previous version back so the user is never left without the app.
    Remove-Item (Join-Path $Install '*') -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $backup '*') $Install -Recurse -Force
    throw
  }
  $ok = $true
  }
} catch {
  $message = $_.Exception.Message
}
Remove-Item $extract, $backup -Recurse -Force -ErrorAction SilentlyContinue
if ($ok) { Remove-Item $(if ($Setup) { $Setup } else { $Zip }) -Force -ErrorAction SilentlyContinue }
Write-Result $ok $message
if (-not $NoStart) { Start-Process $Exe }
