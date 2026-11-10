Unicode true

####
## CaDt-DataLens 安装包模板
##
## 注册表集成（文件关联 / 右键菜单 / PATH / Agent Skill）不在 NSIS 里重复实现，
## 安装时调用 datalens.exe --integrate=...，卸载时调用 --unintegrate=all，
## 与程序内“设置 → 系统集成”共用同一套逻辑。
##
## 构建：wails build -nsis -installscope user
## 注意：wails_tools.nsh 由 wails build 每次重新生成，自定义只改本文件。
####

# 安装后的可执行文件名；程序内的 `datalens` 命令、Agent Skill 文档都按这个名字工作
!define PRODUCT_EXECUTABLE "datalens.exe"
!define UNINST_KEY_NAME "CaDt-DataLens"

!include "wails_tools.nsh"
!include "LogicLib.nsh"

VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

# 代码签名：构建脚本传入 -DSIGNTOOL=... -DSIGN_ARGS=... 时，
# 由 NSIS 在编译期对安装包和生成的卸载程序签名（%1 为待签名文件）
!ifdef SIGNTOOL
  !finalize '"${SIGNTOOL}" ${SIGN_ARGS} "%1"'
  !uninstfinalize '"${SIGNTOOL}" ${SIGN_ARGS} "%1"'
!endif

ManifestDPIAware true

!include "MUI.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString SEC_APP_NAME       ${LANG_ENGLISH}     "CaDt-DataLens (required)"
LangString SEC_APP_NAME       ${LANG_SIMPCHINESE} "CaDt-DataLens（必需）"
LangString SEC_APP_DESC       ${LANG_ENGLISH}     "Main program, Start Menu shortcut and uninstall entry. Installs the WebView2 Runtime when missing."
LangString SEC_APP_DESC       ${LANG_SIMPCHINESE} "主程序、开始菜单快捷方式和卸载项；缺少 WebView2 运行时自动安装。"

LangString SEC_ASSOC_NAME     ${LANG_ENGLISH}     "File associations (JSON, YAML, CSV, ...)"
LangString SEC_ASSOC_NAME     ${LANG_SIMPCHINESE} "文件关联（JSON / YAML / CSV 等）"
LangString SEC_ASSOC_DESC     ${LANG_ENGLISH}     "Adds the supported formats to 'Open with'. Does not change the system default app."
LangString SEC_ASSOC_DESC     ${LANG_SIMPCHINESE} "把支持的格式加入“打开方式”，不修改系统默认程序。写入当前用户注册表。"

LangString SEC_MENU_NAME      ${LANG_ENGLISH}     "Explorer context menu"
LangString SEC_MENU_NAME      ${LANG_SIMPCHINESE} "资源管理器右键菜单"
LangString SEC_MENU_DESC      ${LANG_ENGLISH}     "Adds 'Open with CaDt-DataLens' for files, folders and folder background."
LangString SEC_MENU_DESC      ${LANG_SIMPCHINESE} "为文件、文件夹和文件夹空白处添加“用 CaDt-DataLens 打开”。"

LangString SEC_SKILL_NAME     ${LANG_ENGLISH}     "Agent Skill (optional)"
LangString SEC_SKILL_NAME     ${LANG_SIMPCHINESE} "注册全局 Agent Skill（可选）"
LangString SEC_SKILL_DESC     ${LANG_ENGLISH}     "Writes usage instructions to ~/.agents/skills and ~/.claude/skills so AI agents can call this app."
LangString SEC_SKILL_DESC     ${LANG_SIMPCHINESE} "把使用说明写入 ~/.agents/skills、~/.claude/skills，让 AI agent 学会调用本程序打开和定位文件。"

LangString SEC_PATH_NAME      ${LANG_ENGLISH}     "Add to user PATH (optional)"
LangString SEC_PATH_NAME      ${LANG_SIMPCHINESE} "加入用户 PATH（可选）"
LangString SEC_PATH_DESC      ${LANG_ENGLISH}     "Type 'datalens' in any new terminal to open that directory. Only affects newly started shells."
LangString SEC_PATH_DESC      ${LANG_SIMPCHINESE} "之后在任意目录的命令行输入 datalens 就以该目录为工作区打开；仅对新开的命令行窗口生效。"

LangString SEC_DESKTOP_NAME   ${LANG_ENGLISH}     "Desktop shortcut (optional)"
LangString SEC_DESKTOP_NAME   ${LANG_SIMPCHINESE} "创建桌面快捷方式（可选）"
LangString SEC_DESKTOP_DESC   ${LANG_ENGLISH}     "Creates a CaDt-DataLens shortcut on the desktop."
LangString SEC_DESKTOP_DESC   ${LANG_SIMPCHINESE} "在桌面创建 CaDt-DataLens 快捷方式。"

LangString RUNNING_PROMPT     ${LANG_ENGLISH}     "CaDt-DataLens is running. Please close it, then click OK to continue."
LangString RUNNING_PROMPT     ${LANG_SIMPCHINESE} "CaDt-DataLens 正在运行，请先关闭程序，再点击“确定”继续。"
LangString PLUGINS_PROMPT     ${LANG_ENGLISH}     "Also delete the plugins folder in the install directory? Choose No to keep your plugins."
LangString PLUGINS_PROMPT     ${LANG_SIMPCHINESE} "是否同时删除安装目录下的 plugins 文件夹？选择“否”将保留已安装的插件。"

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"

!ifdef WAILS_INSTALL_SCOPE
  !if "${WAILS_INSTALL_SCOPE}" == "user"
    InstallDir "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
  !else
    InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"
  !endif
!else
  InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"
!endif

ShowInstDetails show

!macro read_install_location
  !ifdef WAILS_INSTALL_SCOPE
    !if "${WAILS_INSTALL_SCOPE}" == "user"
      ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallLocation"
    !else
      ReadRegStr $0 HKLM "${UNINST_KEY}" "InstallLocation"
    !endif
  !else
    ReadRegStr $0 HKLM "${UNINST_KEY}" "InstallLocation"
  !endif
  # 升级时沿用上次安装目录（包括用户自定义的路径）
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
!macroend

!macro write_install_location
  !ifdef WAILS_INSTALL_SCOPE
    !if "${WAILS_INSTALL_SCOPE}" == "user"
      WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    !else
      WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    !endif
  !else
    WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  !endif
!macroend

# 覆盖安装/卸载前要求关闭程序；静默模式下直接失败，避免卡在对话框
!macro ensure_app_closed
  check_running:
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq ${PRODUCT_EXECUTABLE}" /NH | findstr /I /C:"${PRODUCT_EXECUTABLE}"'
  Pop $0
  ${If} $0 == "0"
    IfSilent silent_running
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(RUNNING_PROMPT)" IDOK check_running
    Abort
    silent_running:
    SetErrorLevel 66
    Abort
  ${EndIf}
!macroend

Function .onInit
  !insertmacro wails.checkArchitecture
  !insertmacro read_install_location
  !insertmacro ensure_app_closed
FunctionEnd

Function LaunchApp
  SetOutPath $INSTDIR
  Exec '"$INSTDIR\${PRODUCT_EXECUTABLE}"'
FunctionEnd

!macro run_integration ACTION
  nsExec::ExecToLog '"$INSTDIR\${PRODUCT_EXECUTABLE}" "--integrate=${ACTION}"'
  Pop $0
  ${If} $0 != "0"
    DetailPrint "integrate ${ACTION} exited with $0"
  ${EndIf}
!macroend

Section "$(SEC_APP_NAME)" SEC_APP
  SectionIn RO
  !insertmacro wails.setShellContext

  # 缺少 WebView2 运行时则静默安装（bootstrapper 由 wails build -webview2 download 内置）
  !if /FileExists "tmp\MicrosoftEdgeWebview2Setup.exe"
    !insertmacro wails.webview2runtime
  !endif

  SetOutPath $INSTDIR
  !insertmacro wails.files

  CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

  !insertmacro wails.writeUninstaller
  !insertmacro write_install_location
SectionEnd

Section "$(SEC_ASSOC_NAME)" SEC_ASSOC
  SetOutPath $INSTDIR
  !insertmacro run_integration assoc
SectionEnd

Section "$(SEC_MENU_NAME)" SEC_MENU
  SetOutPath $INSTDIR
  !insertmacro run_integration menu
SectionEnd

Section /o "$(SEC_SKILL_NAME)" SEC_SKILL
  SetOutPath $INSTDIR
  !insertmacro run_integration skill
SectionEnd

Section /o "$(SEC_PATH_NAME)" SEC_PATH
  SetOutPath $INSTDIR
  !insertmacro run_integration path
SectionEnd

Section /o "$(SEC_DESKTOP_NAME)" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_APP} "$(SEC_APP_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_ASSOC} "$(SEC_ASSOC_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MENU} "$(SEC_MENU_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SKILL} "$(SEC_SKILL_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PATH} "$(SEC_PATH_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "$(SEC_DESKTOP_DESC)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function un.onInit
  !insertmacro ensure_app_closed
FunctionEnd

Section "uninstall"
  !insertmacro wails.setShellContext

  # 先撤销文件关联/右键菜单/PATH/Agent Skill，再删除程序文件；%APPDATA% 下的配置保留
  nsExec::ExecToLog '"$INSTDIR\${PRODUCT_EXECUTABLE}" "--unintegrate=all"'
  Pop $0

  Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
  Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

  !insertmacro wails.deleteUninstaller

  # 插件目录属于用户数据，默认保留（静默卸载也保留）
  IfFileExists "$INSTDIR\plugins\*.*" 0 remove_all
  IfSilent remove_keep
  MessageBox MB_YESNO|MB_ICONQUESTION "$(PLUGINS_PROMPT)" IDNO remove_keep

  remove_all:
  RMDir /r "$INSTDIR"
  Goto uninstall_done

  remove_keep:
  Delete "$INSTDIR\${PRODUCT_EXECUTABLE}"
  RMDir "$INSTDIR"

  uninstall_done:
SectionEnd
