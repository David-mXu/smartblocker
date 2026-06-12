// Cross-browser API access. Firefox exposes promise-based WebExtension APIs
// on `browser` (its `chrome.*` namespace is callback-only); Chrome and Edge
// expose promise-based APIs on `chrome`. Always import `api` from here.
declare const browser: typeof chrome | undefined;

export const api: typeof chrome =
  typeof browser !== 'undefined' ? browser : chrome;

export const IS_FIREFOX = typeof browser !== 'undefined';
