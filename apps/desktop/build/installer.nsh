; Extra NSIS hooks for the Scout Windows installer.
;
; - Registers the native-messaging host so the Chrome extension can find us
;   immediately after install (no separate `pnpm install-native-host` step).

!macro customInstall
  ; Native-messaging host registration is currently a per-user concern (HKCU).
  ; We write a forwarding registry entry that points at scripts/native-host.cmd,
  ; which the install-native-host.js script also creates. Same key path so both
  ; flows stay idempotent.
  DetailPrint "Registering Scout native-messaging host"
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.scout.desktop" "" "$LOCALAPPDATA\Scout\NativeMessaging\com.scout.desktop.json"
  WriteRegStr HKCU "Software\Chromium\NativeMessagingHosts\com.scout.desktop"     "" "$LOCALAPPDATA\Scout\NativeMessaging\com.scout.desktop.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.scout.desktop" "" "$LOCALAPPDATA\Scout\NativeMessaging\com.scout.desktop.json"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.scout.desktop"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.scout.desktop"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.scout.desktop"
!macroend
