!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\songs"
  CreateDirectory "$INSTDIR\songs\local"
  CreateDirectory "$INSTDIR\songs\suno"
  CreateDirectory "$INSTDIR\songs\youtube"
  CreateDirectory "$INSTDIR\songs\covers"
!macroend
