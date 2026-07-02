// Cross-browser API access. Firefox exposes promise-based WebExtension APIs
// on `browser` (its `chrome.*` namespace is callback-only); Chrome and Edge
// expose promise-based APIs on `chrome`. Always import `api` from here.
//
// NOTE: modern Chrome (138+) ALSO defines a `browser` alias in MV3, so
// `typeof browser !== 'undefined'` is NOT a Firefox test anymore — it silently
// misrouted Chrome onto the Firefox code paths (in-process inference instead
// of the offscreen document). Detect Firefox by a Firefox-only API instead.
declare const browser: (typeof chrome & { runtime: { getBrowserInfo?: unknown } }) | undefined;

export const api: typeof chrome =
  typeof browser !== 'undefined' ? browser : chrome;

/** True only on Firefox: getBrowserInfo exists nowhere else. */
export const IS_FIREFOX =
  typeof browser !== 'undefined' && typeof browser.runtime?.getBrowserInfo === 'function';
