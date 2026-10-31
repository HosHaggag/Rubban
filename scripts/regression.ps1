# Regression test for the whole Windows release cycle, run on a Windows machine:
#   zip starts -> portable update (apply-update.ps1 -Zip) -> installer compiles -> silent install into a
#   scratch profile -> installed build keeps its data in %LOCALAPPDATA%\Rubban and copies old settings ->
#   in-app update (apply-update.ps1 -Setup) -> settings survive -> uninstall keeps settings.
#
#   pwsh scripts/regression.ps1 [-Release <folder with the zip>] [-SkipInstaller] [-KeepWork] [-Force]
#
# Needs release/Rubban-<VERSION>-Windows-x64.zip (go run ./cmd/buildtool package --os windows) and, unless
# -SkipInstaller, Inno Setup 6 (the installer is built here when it is missing). Everything happens in a
# temporary folder with LOCALAPPDATA pointed at it; the real %LOCALAPPDATA%\Rubban is never touched. The
# install steps register the scratch install in the current user's Uninstall registry key and Start menu
# for a few seconds, so they refuse to run when Rubban is installed for real on this machine (-Force).
param(
  [string]$Release = (Join-Path (Split-Path $PSScriptRoot -Parent) 'release'),
  [string]$Work = (Join-Path $env:TEMP 'rubban-regression'),
  [switch]$SkipInstaller,
  [switch]$KeepWork,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$Release = (Resolve-Path $Release).Path
$version = (Get-Content (Join-Path $repo 'VERSION') -Raw).Trim()
$zip = Join-Path $Release "Rubban-$version-Windows-x64.zip"
$setup = Join-Path $Release "Rubban-$version-Setup.exe"
$applyUpdate = Join-Path $repo 'internal\updater\scripts\apply-update.ps1'
$appId = '{B5C3E6F2-6D0A-4F59-9B44-2D7A1F8E4C10}'
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\${appId}_is1"
$startMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Rubban.lnk'
$realInstall = Join-Path $env:LOCALAPPDATA 'Programs\Rubban'
$fixturePreferences = '{"theme":"dark","clusters":{"regression":{"label":"Regression cluster"}}}'
$results = [System.Collections.Generic.List[object]]::new()
$installed = $false

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Step([string]$Name, [scriptblock]$Body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $Body
    $results.Add([pscustomobject]@{ Step = $Name; Result = 'PASS'; Seconds = [int]$sw.Elapsed.TotalSeconds; Detail = '' })
    Write-Host ("PASS  {0} ({1}s)" -f $Name, [int]$sw.Elapsed.TotalSeconds)
  } catch {
    $results.Add([pscustomobject]@{ Step = $Name; Result = 'FAIL'; Seconds = [int]$sw.Elapsed.TotalSeconds; Detail = $_.Exception.Message })
    Write-Host ("FAIL  {0} - {1}" -f $Name, $_.Exception.Message) -ForegroundColor Red
    throw
  }
}
# Runs a block with LOCALAPPDATA (and the smoke variables) pointed at the scratch profile.
function With-ScratchEnv([hashtable]$Vars, [scriptblock]$Body) {
  $saved = @{}
  foreach ($k in $Vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $Vars[$k]) }
  try { & $Body } finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
}
function Wait-Exit([System.Diagnostics.Process]$Process, [int]$Seconds, [string]$What) {
  if (-not $Process.WaitForExit($Seconds * 1000)) { try { $Process.Kill() } catch {}; throw "$What did not exit within $Seconds s" }
  return $Process.ExitCode
}
# Starts Rubban.exe --smoke-test with the given environment and returns the parsed desktop-smoke.json.
# The first launch of a fresh WebView2 profile can exceed the app's 30 s smoke timeout: one retry.
function Invoke-Smoke([string]$Exe, [hashtable]$Env, [string]$OutDir) {
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    Remove-Item $OutDir -Recurse -Force -ErrorAction SilentlyContinue
    $vars = @{ RUBBAN_DISABLE_UPDATES = '1'; RUBBAN_SMOKE_DIR = $OutDir } + $Env
    $code = With-ScratchEnv $vars { $p = Start-Process -FilePath $Exe -ArgumentList '--smoke-test' -PassThru; Wait-Exit $p 90 'Rubban --smoke-test' }
    $file = Join-Path $OutDir 'desktop-smoke.json'
    $report = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } else { $null }
    $timedOut = $report -and $report.ready -eq 'timeout'
    if ($code -eq 0 -and $report -and $report.rendererErrors.Count -eq 0) { return $report }
    if ($timedOut -and $attempt -eq 1) { Write-Host '      (smoke timed out on the first launch; retrying)'; continue }
    $errors = if ($report) { $report.rendererErrors -join '; ' } else { 'no desktop-smoke.json' }
    throw "Rubban --smoke-test exited with $code; renderer errors: $errors"
  }
}
function Dead-ProcessId { $p = Start-Process cmd -ArgumentList '/c exit 0' -PassThru -WindowStyle Hidden; [void]$p.WaitForExit(); return $p.Id }
function Invoke-ApplyUpdate([hashtable]$Params) {
  $resultFile = Join-Path $Work ("result-" + [guid]::NewGuid() + ".json")
  & $applyUpdate @Params -ProcessId (Dead-ProcessId) -ResultFile $resultFile -Version $version -NoStart
  Assert (Test-Path $resultFile) 'apply-update.ps1 wrote no result file'
  $result = Get-Content $resultFile -Raw | ConvertFrom-Json
  Assert ($result.ok -eq $true) "apply-update.ps1 reported: $($result.error)"
  return $result
}
function Find-ISCC {
  $cmd = Get-Command ISCC -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if ($base) { $p = Join-Path $base 'Inno Setup 6\ISCC.exe'; if (Test-Path $p) { return $p } }
  }
  return $null
}
function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) { if (& $Test) { return }; Start-Sleep -Milliseconds 500 }
  throw "$What did not happen within $Seconds s"
}

Write-Host "Rubban $version regression - release folder $Release - work folder $Work"
Assert (Test-Path $zip) "$zip is missing: run `go run ./cmd/buildtool package --os windows` first"
if (-not $SkipInstaller -and -not $Force -and ((Test-Path (Join-Path $realInstall 'installed.json')) -or (Test-Path $uninstallKey))) {
  throw "Rubban is installed for real on this machine ($realInstall); the install steps would overwrite its registration. Uninstall it, pass -SkipInstaller, or pass -Force."
}
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Work, (Join-Path $Work 'out') | Out-Null
$out = Join-Path $Work 'out'
$scratchLocal = Join-Path $Work 'local'
$app = Join-Path $Work 'app'
$realInstallExisted = Test-Path $realInstall

try {
  Step 'Portable zip starts' {
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $Work 'portable')
    $script:portableExe = (Get-ChildItem (Join-Path $Work 'portable') -Recurse -Filter Rubban.exe | Select-Object -First 1).FullName
    Assert ($null -ne $portableExe) 'the zip has no Rubban.exe'
    $report = Invoke-Smoke $portableExe @{ RUBBAN_DATA_DIR = (Join-Path $Work 'portable-data') } (Join-Path $out 'portable')
    Assert ($report.bodyLength -gt 500) "the page is nearly empty ($($report.bodyLength) characters)"
    Assert (Test-Path (Join-Path $Work 'portable-data\port')) 'RUBBAN_DATA_DIR was not used'
  }

  Step 'Portable update through the zip helper' {
    $dir = Join-Path $Work 'update-zip'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item $zip (Join-Path $dir 'update.zip')
    $install = Split-Path $portableExe -Parent
    $null = Invoke-ApplyUpdate @{ Zip = (Join-Path $dir 'update.zip'); Install = $install; Exe = $portableExe }
    Assert (Test-Path $portableExe) 'Rubban.exe is gone after the update'
    Assert ((Get-Content (Join-Path $install 'VERSION') -Raw).Trim() -eq $version) 'VERSION changed after the update'
    Assert (-not (Test-Path (Join-Path $dir 'update.zip'))) 'the helper did not remove the downloaded zip'
  }

  if ($SkipInstaller) { Write-Host 'SKIP  installer steps (-SkipInstaller)' }
  else {
    Step 'Installer compiles' {
      if (-not (Test-Path $setup)) {
        if (Get-Command go -ErrorAction SilentlyContinue) {
          With-ScratchEnv @{ RUBBAN_RELEASE_DIR = $Release } { Push-Location $repo; try { go run ./cmd/buildtool installer | Out-Host; if ($LASTEXITCODE -ne 0) { throw "buildtool installer exited with $LASTEXITCODE" } } finally { Pop-Location } }
        } else {
          $iscc = Find-ISCC
          Assert ($null -ne $iscc) 'Inno Setup 6 (ISCC.exe) was not found; install it or pass -SkipInstaller'
          & $iscc /Qp "/DVersion=$version" "/DRelease=$Release" (Join-Path $repo 'installer\rubban.iss') | Out-Host
          if ($LASTEXITCODE -ne 0) { throw "ISCC exited with $LASTEXITCODE" }
        }
      }
      Assert (Test-Path $setup) "$setup was not produced"
      Assert ((Get-Item $setup).Length -gt 1MB) 'the installer is implausibly small'
    }

    Step 'Silent install into a scratch profile (no admin, migrates settings next to Setup.exe)' {
      # The installer is started from a folder that has a Rubban-Data beside it, like a zip extract in Downloads.
      $src = Join-Path $Work 'setup-src'; New-Item -ItemType Directory -Force -Path (Join-Path $src 'Rubban-Data') | Out-Null
      Set-Content -Path (Join-Path $src 'Rubban-Data\preferences.json') -Value $fixturePreferences -NoNewline -Encoding ascii
      Copy-Item $setup (Join-Path $src 'Setup.exe')
      $log = Join-Path $out 'setup.log'
      $code = With-ScratchEnv @{ LOCALAPPDATA = $scratchLocal } { $p = Start-Process -FilePath (Join-Path $src 'Setup.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$app`"", "/LOG=`"$log`"") -PassThru; Wait-Exit $p 180 'Setup.exe' }
      $script:installed = $true
      Assert ($code -eq 0) "Setup.exe exited with $code (see $log)"
      Assert (Test-Path (Join-Path $app 'Rubban.exe')) 'Rubban.exe was not installed'
      Assert (Test-Path (Join-Path $app 'VERSION')) 'VERSION was not installed'
      Assert (-not (Test-Path (Join-Path $app 'Install-Rubban.ps1'))) 'Install-Rubban.ps1 should not be installed'
      $marker = Get-Content (Join-Path $app 'installed.json') -Raw
      $info = ($marker -replace '^\xEF\xBB\xBF', '') | ConvertFrom-Json
      Assert ($info.installer -eq 'inno' -and $info.version -eq $version) "installed.json is wrong: $marker"
      Assert ($info.migratedFrom -eq (Join-Path $src 'Rubban-Data')) "installed.json migratedFrom is '$($info.migratedFrom)'"
      $reg = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
      Assert ($null -ne $reg -and $reg.DisplayVersion -eq $version) 'the Apps list entry is missing or has the wrong version'
      Assert (Test-Path $startMenuLink) 'the Start menu shortcut is missing'
    }

    Step 'Installed build keeps its data in LOCALAPPDATA and copies the old settings' {
      $report = Invoke-Smoke (Join-Path $app 'Rubban.exe') @{ LOCALAPPDATA = $scratchLocal; RUBBAN_DATA_DIR = $null } (Join-Path $out 'installed')
      $data = Join-Path $scratchLocal 'Rubban'
      Assert (Test-Path (Join-Path $data 'port')) "the data folder $data was not used"
      Assert (-not (Test-Path (Join-Path (Split-Path $app -Parent) 'Rubban-Data'))) 'the installed build still wrote Rubban-Data next to itself'
      Assert ((Get-Content (Join-Path $data 'preferences.json') -Raw) -eq $fixturePreferences) 'preferences.json was not copied from the old data folder'
      Assert ((Get-Content (Join-Path $data 'migrated-from.txt') -Raw).Trim() -eq (Join-Path $Work 'setup-src\Rubban-Data')) 'migrated-from.txt does not name the source'
      Assert (Test-Path (Join-Path $Work 'setup-src\Rubban-Data\preferences.json')) 'the old data folder was modified'
    }

    Step 'In-app update runs the installer silently over the existing install' {
      $dir = Join-Path $Work 'update-setup'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Copy-Item $setup (Join-Path $dir "Rubban-$version-Setup.exe")
      With-ScratchEnv @{ LOCALAPPDATA = $scratchLocal } { $null = Invoke-ApplyUpdate @{ Setup = (Join-Path $dir "Rubban-$version-Setup.exe"); Install = $app; Exe = (Join-Path $app 'Rubban.exe') } }
      Assert (Test-Path (Join-Path $app 'Rubban.exe')) 'Rubban.exe is gone after the update'
      Assert (Test-Path (Join-Path $app 'installed.json')) 'installed.json is gone after the update'
      Assert ((Test-Path $realInstall) -eq $realInstallExisted) "the update installed into $realInstall instead of the registered folder"
      Assert (-not (Test-Path (Join-Path $dir "Rubban-$version-Setup.exe"))) 'the helper did not remove the downloaded installer'
    }

    Step 'Settings survive the update' {
      $null = Invoke-Smoke (Join-Path $app 'Rubban.exe') @{ LOCALAPPDATA = $scratchLocal; RUBBAN_DATA_DIR = $null } (Join-Path $out 'updated')
      Assert ((Get-Content (Join-Path $scratchLocal 'Rubban\preferences.json') -Raw) -eq $fixturePreferences) 'preferences.json changed across the update'
    }

    Step 'Uninstall removes the program and keeps the settings' {
      $unins = Get-ChildItem $app -Filter 'unins*.exe' | Select-Object -First 1
      Assert ($null -ne $unins) 'no uninstaller in the install folder'
      $code = With-ScratchEnv @{ LOCALAPPDATA = $scratchLocal } { $p = Start-Process -FilePath $unins.FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru; Wait-Exit $p 120 'the uninstaller' }
      Assert ($code -eq 0) "the uninstaller exited with $code"
      # The uninstaller finishes from a copy of itself in TEMP after the original exits.
      Wait-Until { -not (Test-Path $uninstallKey) -and -not (Test-Path (Join-Path $app 'Rubban.exe')) } 60 'removal of the program'
      $script:installed = $false
      Assert (-not (Test-Path $app)) "the install folder $app is still there"
      Assert (-not (Test-Path $startMenuLink)) 'the Start menu shortcut is still there'
      Assert (Test-Path (Join-Path $scratchLocal 'Rubban\preferences.json')) 'the settings were deleted although the default answer is No'
    }
  }
} catch {
  # Reported in the summary; the remaining steps depend on this one.
} finally {
  if ($installed) {
    Write-Host 'Cleaning up the scratch install...'
    $unins = Get-ChildItem $app -Filter 'unins*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($unins) { With-ScratchEnv @{ LOCALAPPDATA = $scratchLocal } { Start-Process -FilePath $unins.FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait } ; Start-Sleep -Seconds 5 }
  }
}

Write-Host ''
$results | Format-Table -AutoSize | Out-Host
$failed = @($results | Where-Object Result -eq 'FAIL').Count
if (-not $KeepWork -and $failed -eq 0) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
if ($failed) { Write-Host "$failed step(s) failed; outputs kept in $Work" -ForegroundColor Red; exit 1 }
Write-Host 'All steps passed.'
