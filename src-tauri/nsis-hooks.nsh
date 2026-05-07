!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\songs"
  CreateDirectory "$INSTDIR\songs\local"
  CreateDirectory "$INSTDIR\songs\suno"
  CreateDirectory "$INSTDIR\songs\youtube"
  CreateDirectory "$INSTDIR\songs\covers"
  CreateDirectory "$INSTDIR\tools"
  SetOutPath "$INSTDIR\tools"
  File "/oname=yt-dlp.exe" "$%INSTALLER_TOOLS_DIR%\yt-dlp.exe"
  File "/oname=ffmpeg.exe" "$%INSTALLER_TOOLS_DIR%\ffmpeg.exe"
  File "/oname=ffprobe.exe" "$%INSTALLER_TOOLS_DIR%\ffprobe.exe"
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\tools\yt-dlp.exe"
  Delete "$INSTDIR\tools\ffmpeg.exe"
  Delete "$INSTDIR\tools\ffprobe.exe"
  RMDir "$INSTDIR\tools"
!macroend
