[Setup]
AppName=FaceID
AppVersion=1.0
DefaultDirName={autopf}\FaceID
DefaultGroupName=FaceID
OutputDir=installer_output
OutputBaseFilename=FaceID_Setup
Compression=lzma
SolidCompression=yes
DisableProgramGroupPage=yes

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "dist\FaceID.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\FaceID"; Filename: "{app}\FaceID.exe"
Name: "{autodesktop}\FaceID"; Filename: "{app}\FaceID.exe"

[Run]
Filename: "{app}\FaceID.exe"; Description: "Lancer FaceID"; Flags: nowait postinstall skipifsilent
