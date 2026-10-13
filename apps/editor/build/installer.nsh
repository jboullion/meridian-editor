; Included by electron-builder's NSIS installer (nsis.include). Adds the editor to
; Explorer's "Open with" for .json and .roo files without becoming their default.
; Windows goes by a file's last extension only, so room sources (.room.json) are
; .json to it; taking over .json would open every JSON file in the editor.
; Per-user installs write under HKCU (SHELL_CONTEXT).

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\MeridianRoomEditor.Room" "" "Meridian room"
  WriteRegStr SHELL_CONTEXT "Software\Classes\MeridianRoomEditor.Room\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\MeridianRoomEditor.Room\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.json\OpenWithProgids" "MeridianRoomEditor.Room" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.roo\OpenWithProgids" "MeridianRoomEditor.Room" ""
  ; Tell Explorer the associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.json\OpenWithProgids" "MeridianRoomEditor.Room"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.roo\OpenWithProgids" "MeridianRoomEditor.Room"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\MeridianRoomEditor.Room"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
