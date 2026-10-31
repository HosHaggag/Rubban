; Rubban for Windows: a per-user installer (no administrator prompt).
; Build: go run ./cmd/buildtool package --os windows, then go run ./cmd/buildtool installer
; (the buildtool passes /DVersion=<VERSION>). The program goes to %LOCALAPPDATA%\Programs\Rubban and
; its settings to %LOCALAPPDATA%\Rubban; installed.json next to Rubban.exe tells Rubban so.
#ifndef Version
  #error Pass /DVersion=<VERSION>
#endif
; Release is the folder holding Rubban-<version>-Windows-x64 (the buildtool passes it; defaults to ..\release).
#ifndef Release
  #define Release "..\release"
#endif

[Setup]
AppId={{B5C3E6F2-6D0A-4F59-9B44-2D7A1F8E4C10}
AppName=Rubban
AppVersion={#Version}
AppPublisher=Rubban contributors
DefaultDirName={localappdata}\Programs\Rubban
DisableProgramGroupPage=yes
; The uninstaller removes the install folder, so it must be one Rubban owns: no folder page.
DisableDirPage=yes
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\Rubban.exe
SetupIconFile=..\assets\rubban.ico
OutputDir={#Release}
OutputBaseFilename=Rubban-{#Version}-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#Release}\Rubban-{#Version}-Windows-x64\*"; DestDir: "{app}"; Excludes: "Install-Rubban.ps1"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Rubban"; Filename: "{app}\Rubban.exe"
Name: "{autodesktop}\Rubban"; Filename: "{app}\Rubban.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Rubban.exe"; Description: "Start Rubban"; Flags: nowait postinstall skipifsilent

; Files the in-app updater added later are removed too.
[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function JsonEscape(S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  MigratedFrom: String;
  Lines: TArrayOfString;
begin
  if CurStep = ssPostInstall then
  begin
    // A Rubban-Data next to the Setup.exe is the data folder of the zip the user ran Rubban from.
    MigratedFrom := '';
    if DirExists(ExpandConstant('{src}\Rubban-Data')) then
      MigratedFrom := ExpandConstant('{src}\Rubban-Data');
    // Built in a variable: Pascal Script has no array literals, and a line that starts with "["
    // would be read as a section tag. UTF-8, so a non-ASCII folder name survives; Rubban skips
    // the byte order mark.
    SetArrayLength(Lines, 1);
    Lines[0] := '{"installer":"inno","version":"{#Version}","migratedFrom":"' + JsonEscape(MigratedFrom) + '"}';
    SaveStringsToUTF8File(ExpandConstant('{app}\installed.json'), Lines, False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if MsgBox('Also delete your settings (' + ExpandConstant('{localappdata}\Rubban') + ')?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{localappdata}\Rubban'), True, True, True);
end;
