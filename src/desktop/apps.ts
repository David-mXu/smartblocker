// App-name normalization moved to shared/ so profile snapshots, the
// background bridge and the desktop UI use one implementation. Re-exported
// here because the desktop pages import "./apps" historically.
export {
  appBlocklistEqual,
  appBlocklistKey,
  friendlyAppName,
  MAX_APP_BLOCKLIST,
  normalizeAppBlocklist,
  normalizeAppName,
  splitAppNames,
  summarizeApps,
  type AppNameResult,
} from '../shared/apps';
