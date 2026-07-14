; NSIS installer hooks for HT Logistic Agent
;
; Fixes "无法打开要写入的文件 ht-sidecar" error during update install:
; when the old app is still running (or its child processes were orphaned
; by a crash/force-kill), NSIS cannot overwrite ht-sidecar.exe.
;
; This hook runs BEFORE file copy and kills:
;   - HT Logistic Agent.exe  (main app, may still be open)
;   - ht-sidecar.exe         (Python sidecar, orphaned if app crashed)
; We do NOT kill node.exe globally because the user may have other Node
; apps running. Pi's node.exe is a child of the app; killing the app
; triggers its on_window_event cleanup which kills pi. If the app already
; crashed, pi's node.exe is orphaned but won't lock the installer files
; (pi-runtime is a directory, not a single locked exe), so we leave it.

!macro NSIS_HOOK_PREINSTALL
  ; Kill main app exe (productName from tauri.conf.json)
  nsExec::ExecToLog 'taskkill /F /IM "HT Logistic Agent.exe"'
  Pop $0

  ; Kill orphaned Python sidecar
  nsExec::ExecToLog 'taskkill /F /IM ht-sidecar.exe'
  Pop $0

  ; Give OS a moment to release file handles after taskkill
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend
