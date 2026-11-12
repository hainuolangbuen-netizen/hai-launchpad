; Hai Launchpad 安装包脚本（Inno Setup 6）
; 功能：选择语言 / 选择安装路径 / 开机自启 / 桌面快捷方式 / 固定到开始菜单
; 编译：ISCC.exe installer\hai-launchpad.iss

#define AppName "Hai Launchpad"
#define AppVersion "1.0.3"
#define AppPublisher "hainuolangbuen-netizen"
#define AppUrl "https://github.com/hainuolangbuen-netizen/hai-launchpad"
#define AppExe "Hai Launchpad.exe"

[Setup]
AppId={{8F4B7E2C-5A31-4C6D-9B7E-2D1A6C0F3E55}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
; 安装路径可以改；默认装到当前用户目录，不需要管理员权限
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=Hai-Launchpad-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\resources\app\assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
AllowNoIcons=yes
; 多语言：两个语言时 Inno 会先弹「选择语言」
ShowLanguageDialog=yes
LanguageDetectionMethod=none

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "Languages\ChineseSimplified.isl"

[CustomMessages]
english.AutoStartProgram=Start %1 when Windows starts
english.AutoStartProgramGroupDescription=Startup:
english.PinToStart=Pin to Start menu
chinesesimplified.AutoStartProgram=开机时自动启动 %1
chinesesimplified.AutoStartProgramGroupDescription=启动选项：
chinesesimplified.PinToStart=固定到开始菜单

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "pinstart"; Description: "{cm:PinToStart}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "{cm:AutoStartProgram,{#AppName}}"; GroupDescription: "{cm:AutoStartProgramGroupDescription}"

[Files]
Source: "..\dist\Hai-Launchpad-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--show"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\assets\icon.ico"; IconIndex: 0
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--show"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\assets\icon.ico"; IconIndex: 0; Tasks: desktopicon

[Registry]
; 开机自启（只在勾选时写入，卸载时清掉）
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" --startup"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "--show"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent unchecked

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
{ 把安装时选择的语言写进应用的 preferences.json（只在首次安装、文件不存在时写） }
procedure WriteAppLanguage();
var
  DirName, FileName, Json: String;
begin
  DirName := ExpandConstant('{userappdata}\Hai Launchpad');
  ForceDirectories(DirName);
  FileName := DirName + '\preferences.json';
  if FileExists(FileName) then
    exit;
  if ActiveLanguage = 'chinesesimplified' then
    Json := '{"language":"zh-CN"}'
  else
    Json := '{"language":"en"}';
  SaveStringToFile(FileName, Json, False);
end;

{ 用 Shell 的 pinStart 动词把开始菜单快捷方式固定到「开始」屏幕（Win10/11 仍支持） }
procedure PinStartMenu();
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "try{' +
    '$s=New-Object -ComObject Shell.Application;' +
    '$f=$s.Namespace(''' + ExpandConstant('{autoprograms}') + ''');' +
    '$i=$f.ParseName(''Hai Launchpad.lnk'');' +
    'if($i){$i.InvokeVerb(''pinStart'')}}catch{}"';
  Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteAppLanguage();
    if WizardIsTaskSelected('pinstart') then
      PinStartMenu();
  end;
end;
