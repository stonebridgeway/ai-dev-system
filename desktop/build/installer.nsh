; The uninstaller's own step (docs/DESKTOP.md, "The Windows install"),
; included by electron-builder's NSIS script. It runs before the program's
; files are removed, while the runtime it ships is still there: its Node runs
; `ai-dev uninstall`, which stops the daemon and removes the runtime copies the
; app made in the AI Dev home and the link AI clients run
; (ai-dev-mcp-server/src/core/bundle-uninstall.mjs).
;
; Two questions first: take AI Dev out of the AI clients' settings (Yes by
; default: their entries run the runtime that is going), and delete AI Dev's
; own data (No by default). An uninstaller built "one click" runs this step
; silently — electron-builder's un.onInit turns silence on after its "Are you
; sure?" — and a silent NSIS answers a MessageBox that carries /SD itself,
; without showing it. So the boxes here carry no /SD
; and are shown only when the person did not ask for silence with /S, read
; from the command line as un.onInit reads it; /S takes the defaults.
;
; `ai-dev uninstall` says by its exit status what it left: 3 — files an AI
; client still runs, which the person may close and Retry; 4 — the
; data, its folder holding what AI Dev did not make; anything else but
; 0 — another failure. Each has a box of its own.
;
; An update runs the old uninstaller too, with --updated or, in its place,
; --delete-app-data, and with /KEEP_APP_DATA either way: then nothing of this
; happens.
;
; All of it is the uninstaller's: electron-builder compiles the script twice,
; and the installer's pass, run with -WX, refuses a variable it never uses.
; The strings are named by language id — 1033 English, 1049 Russian: this
; file is included before the installer loads its languages, when the
; ${LANG_*} names are not defined yet.

!ifdef BUILD_UNINSTALLER

Var aiDevAsk
Var aiDevClients
Var aiDevData
Var aiDevStatus

LangString aiDevRemoveClients 1033 "Remove AI Dev from your AI clients' settings (Claude, Cursor, VS Code, Codex, Gemini)?$\r$\n$\r$\nTheir AI Dev entries run the program you are removing and would stop working."
LangString aiDevRemoveClients 1049 "Убрать AI Dev из настроек ваших AI-клиентов (Claude, Cursor, VS Code, Codex, Gemini)?$\r$\n$\r$\nИх записи AI Dev запускают удаляемую программу и перестанут работать."
LangString aiDevRemoveData 1033 "Also delete AI Dev's data: the vault it keeps (the skills and the notes in it), the tasks and session history, the local model, the search index, the backups, the settings?$\r$\n$\r$\nThey are in the .ai-dev folder of your profile, or in the folder AI_DEV_HOME names; a folder that holds anything else as well is kept. Your projects are not touched."
LangString aiDevRemoveData 1049 "Удалить и данные AI Dev: его хранилище (навыки и заметки в нём), задачи и историю сессий, локальную модель, поисковый индекс, резервные копии, настройки?$\r$\n$\r$\nОни в папке .ai-dev вашего профиля или в папке, которую называет AI_DEV_HOME; папка, где есть и другое, остаётся. Ваши проекты не затрагиваются."
LangString aiDevInUse 1033 "Some of AI Dev's files are in use, most likely by an AI client that is still running (Claude, Cursor, VS Code, Codex, Gemini).$\r$\n$\r$\nClose your AI clients and click Retry. Cancel leaves those files — and the data, if you asked to delete it — in AI Dev's folder: .ai-dev in your profile, or the folder AI_DEV_HOME names; you can delete them later."
LangString aiDevInUse 1049 "Часть файлов AI Dev занята — скорее всего, AI-клиентом, который ещё работает (Claude, Cursor, VS Code, Codex, Gemini).$\r$\n$\r$\nЗакройте AI-клиенты и нажмите «Повторить». «Отмена» оставит эти файлы — и данные, если вы просили их удалить, — в папке AI Dev: .ai-dev вашего профиля или папке, которую называет AI_DEV_HOME; их можно удалить позже."
LangString aiDevDataKept 1033 "AI Dev's data was not deleted: its folder also holds files AI Dev did not make.$\r$\n$\r$\nDelete AI Dev's own folders in it yourself if you want them gone."
LangString aiDevDataKept 1049 "Данные AI Dev не удалены: в их папке есть и файлы, которые сделал не AI Dev.$\r$\n$\r$\nЕсли данные больше не нужны, удалите папки AI Dev в ней сами."
LangString aiDevNotDone 1033 "AI Dev could not remove everything it made outside its program folder (code $aiDevStatus).$\r$\n$\r$\nAn AI client may still list AI Dev, and some of its files may be left in its folder: .ai-dev in your profile, or the folder AI_DEV_HOME names."
LangString aiDevNotDone 1049 "AI Dev не смог убрать всё, что сделал вне папки программы (код $aiDevStatus).$\r$\n$\r$\nAI-клиент может ещё показывать AI Dev, а часть его файлов — остаться в его папке: .ai-dev вашего профиля или папке, которую называет AI_DEV_HOME."

!macro customUnInstall
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${if} ${Errors}
  ${andIfNot} ${isUpdated}
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
      StrCpy $aiDevAsk "1"
    ${else}
      StrCpy $aiDevAsk "0"
    ${endIf}
    StrCpy $aiDevClients "--clients"
    StrCpy $aiDevData ""
    ${if} $aiDevAsk == "1"
      MessageBox MB_YESNO|MB_ICONQUESTION "$(aiDevRemoveClients)" IDYES aiDevClientsAnswered
      StrCpy $aiDevClients ""
      aiDevClientsAnswered:
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(aiDevRemoveData)" IDNO aiDevDataAnswered
      StrCpy $aiDevData "--data"
      aiDevDataAnswered:
    ${endIf}
    ${if} ${FileExists} "$INSTDIR\resources\runtime\node\node.exe"
      aiDevRun:
      nsExec::ExecToLog '"$INSTDIR\resources\runtime\node\node.exe" "$INSTDIR\resources\runtime\ai-dev-mcp-server\bin\ai-dev.mjs" uninstall --yes $aiDevClients $aiDevData'
      Pop $aiDevStatus
      DetailPrint "ai-dev uninstall: $aiDevStatus"
      ${if} $aiDevAsk == "1"
        ${if} $aiDevStatus == "3"
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(aiDevInUse)" IDRETRY aiDevRun
        ${elseIf} $aiDevStatus == "4"
          MessageBox MB_OK|MB_ICONINFORMATION "$(aiDevDataKept)"
        ${elseIf} $aiDevStatus != "0"
          MessageBox MB_OK|MB_ICONEXCLAMATION "$(aiDevNotDone)"
        ${endIf}
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

!endif
