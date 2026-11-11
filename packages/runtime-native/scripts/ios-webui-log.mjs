// Judges for the iOS simulator launches that prove the UI host. Pure functions over launch logs, so
// a Linux spec can pin what each marker means before a macOS run depends on it (PRD-842).

const OVERLAY = /TN_UI_OVERLAY:(\{[^\n]*\})/gu;

function overlayRecords(log) {
  const records = [];
  for (const [, text] of log.matchAll(OVERLAY)) {
    try {
      records.push({ at: log.indexOf(text), ...JSON.parse(text) });
    } catch {
      records.push({ at: log.indexOf(text), malformed: text });
    }
  }
  return records;
}

/** The plain smoke launch has `ui.renderer` native, so no web view may exist or log. */
export function judgePlainLaunch(log) {
  return /TN_UI_OVERLAY|TN_UI_PAGE/u.test(log)
    ? ['a native-renderer launch logged a UI overlay line; the iOS shell must not create a web view']
    : [];
}

/** `Presentation cap: N fps` is what the host reads `TNMaxFps` into. */
export function judgePresentationCap(log, fps) {
  return log.includes(`Presentation cap: ${fps} fps`)
    ? []
    : [`Info.plist TNMaxFps=${fps} did not reach the host: no "Presentation cap: ${fps} fps" line`];
}

export function judgeBundleMissing(log) {
  return log.includes('TN_UI_BUNDLE_MISSING')
    ? []
    : ['a web-renderer launch with no ui/index.html did not refuse with TN_UI_BUNDLE_MISSING'];
}

/**
 * A web-renderer launch whose page loaded, ran its module and received game state. Each check names
 * the host behaviour a failure points at.
 */
export function judgeWebUiLaunch(log) {
  const failures = [];
  const records = overlayRecords(log);
  const attached = records.find((record) => record.attached === true);
  const loaded = records.find((record) => record.loaded === true);
  const firstState = records.find((record) => record.firstState === true);
  const evalAt = log.indexOf('TN_IOS_GAME_EVAL');
  if (records.some((record) => record.loaded === false)) failures.push('the page failed to load (TN_UI_OVERLAY loaded:false)');
  if (!attached) failures.push('the overlay never attached (TN_UI_OVERLAY attached:true)');
  if (evalAt < 0) failures.push('the game never evaluated (TN_IOS_GAME_EVAL)');
  else if (attached && attached.at > evalAt) failures.push('the game evaluated before the UI attached');
  if (!loaded) failures.push('the page never finished loading (TN_UI_OVERLAY loaded:true)');
  if (/TN_UI_PAGE \[error\]/u.test(log)) failures.push('the page logged an error (TN_UI_PAGE [error])');
  // `ready` is the probe seeing `__tnUiReceive` installed by the page module, so the module ran:
  // the scheme handler answered 200 with a JavaScript MIME type and the CORS header. It is posted
  // through the `tnHost` message handler, so the handler was registered before the web view copied
  // its configuration.
  if (!/TN_UI_PAGE:[^\n]*"event":"ready"/u.test(log)) failures.push('the page module never ran (no TN_UI_PAGE ready)');
  if (!/TN_UI_PAGE:[^\n]*"event":"first-state"/u.test(log)) failures.push('the page never received game state (no TN_UI_PAGE first-state)');
  if (!firstState) failures.push('the host never delivered state (TN_UI_OVERLAY firstState:true)');
  else if (typeof firstState.frame !== 'string' || firstState.frame !== firstState.parent) {
    failures.push(`the overlay frame ${firstState.frame} is not pinned to its parent ${firstState.parent}`);
  } else if (/\{0, 0\}\}$/u.test(firstState.frame) || /, \{0, /u.test(firstState.frame)) {
    failures.push(`the overlay frame ${firstState.frame} has no size`);
  }
  return failures;
}
