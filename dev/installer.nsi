; The Windows installer. Built by the Release workflow with NSIS:
;   makensis -DVERSION=1.0.0 -DSRC=/abs/modion-1.0.0-windows-x64 -DOUT=/abs/modion-1.0.0-windows-x64-setup.exe dev/installer.nsi
;
; Installs for the current user only, so it needs no administrator rights: the program
; goes to %LOCALAPPDATA%\Programs\Modion, with Start menu and desktop shortcuts and an
; entry under "Installed apps". The folder is fixed on purpose: the uninstaller removes
; the whole folder, which is only safe when it is certain what that folder is.

Unicode true
!include "MUI2.nsh"

!define APP "Modion"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Modion"

Name "${APP} ${VERSION}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Modion"
SetCompressor /SOLID lzma
ShowInstDetails nevershow
ShowUninstDetails nevershow

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Modion.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Modion"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Modion"
  ; An update: the old program files go first, so nothing stale is left behind.
  ; (Settings, instances and game files are kept elsewhere and are not touched.)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  SetOutPath "$INSTDIR"
  File /r "${SRC}/*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\Modion.lnk" "$INSTDIR\Modion.exe" "" "$INSTDIR\Modion.ico"
  CreateShortcut "$DESKTOP\Modion.lnk" "$INSTDIR\Modion.exe" "" "$INSTDIR\Modion.ico"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Modion"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "pinexd"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Modion.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://github.com/pinexd/modion"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Only ever the program folder, and only if it really is Modion's.
  IfFileExists "$INSTDIR\Modion.exe" 0 +2
    RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\Modion.lnk"
  Delete "$DESKTOP\Modion.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
