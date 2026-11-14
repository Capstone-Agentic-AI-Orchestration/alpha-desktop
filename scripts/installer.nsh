!macro customInit
  # electron-updater passes --updated for in-app installs. Older Alpha builds
  # omit /S, so switch to silent mode here while leaving direct Setup runs
  # interactive.
  ${if} ${isUpdated}
    SetSilent silent
  ${endIf}
!macroend

!macro customInstall
  # Alpha 2.2.0 and earlier omit --force-run. Relaunch those legacy updates
  # after copying the files; newer updater versions ask NSIS to do this itself.
  ${if} ${isUpdated}
  ${andIfNot} ${isForceRun}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${endIf}
!macroend
