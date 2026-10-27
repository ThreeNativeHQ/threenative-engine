/**
 * The UI layer's platform seam: one bridge and one hit-region protocol, host-independent.
 *
 * A game's `src/ui/` renders through the platform's own browser-class renderer on every
 * target — react-dom, Tailwind, CSS, SVG and fonts unchanged. Everything the UI needs from
 * the game and everything the game needs from the UI crosses through here.
 *
 * Most games never import this file: `@threenative/ui`'s `<UiLayer>` connects the UI end and
 * `game.ui` is the game end. Reach for it directly when writing a UI without React.
 *
 * @see ./ui-bridge.js for the message channel, ./ui-hit-regions.js for the input protocol.
 */

/**
 * Open the message channel between a game and its UI, whatever host is underneath.
 * @situation write a UI that talks to the game on web and on a phone alike
 * @situation send a message from a HUD rendered over the game surface
 * @constraint the transport is discovered, never configured; no game names the web view
 * @example const bridge = connectUiBridge({ end: "ui" });
 */
export { connectUiBridge } from "./ui-bridge.js";
export {
  GAME_STATE_MESSAGE,
  HIT_REGIONS_MESSAGE,
  UI_BRIDGE_GLOBALS,
  UI_DEV_METRICS_MESSAGE,
  UI_INTENT_MESSAGE,
  UI_READY_INTENT,
  UI_STARTUP_MESSAGE,
  type IUiBridge,
  type IUiMessage,
  type UiBridgeEnd,
  type UiBridgeTransport,
} from "./ui-bridge.js";
/**
 * Publish the game's state so a UI in another process can mirror it.
 * @situation show score or health in a UI rendered over the game surface
 * @situation keep a HUD in step with the game without re-rendering on the loop
 * @alias journal objective panel
 * @alias readable HUD
 * @constraint publishes once per rendered frame unless stateFlushMs selects a slower interval, and not at all with no UI listening
 * @example publishUiState(bridge, game.state);
 */
export { publishUiState } from "./ui-state.js";
/**
 * Mirror the game's published state on the UI side.
 * @situation read game state from a HUD that runs in the platform's web view
 * @constraint returns undefined until the game publishes its first state
 * @example const mirror = subscribeUiState(bridge);
 */
export { subscribeUiState } from "./ui-state.js";
/**
 * Send a player action from the UI back to the game.
 * @situation wire a Restart button in a HUD to the running game
 * @situation pause a game from a menu drawn over its surface
 * @constraint one-way; the game decides what each name means and may ignore one
 * @example sendUiIntent(bridge, "restart");
 */
export { sendUiIntent } from "./ui-state.js";
/**
 * Handle the actions a UI sends back to the game.
 * @situation restart or pause a game from a button in its HUD
 * @constraint prefer game.ui.onIntent, which connects the bridge for you
 * @example onUiIntent(bridge, (intent) => { if (intent === "restart") game.goto("Play"); });
 */
export { onUiIntent } from "./ui-state.js";
export type {
  IPublishableStore,
  IUiStateMirror,
  IUiStatePublisher,
} from "./ui-state.js";
/**
 * Tell the native input host where a UI's touchable controls are.
 * @situation let a touch on empty HUD space reach the game instead of the UI
 * @situation make a HUD button receive taps on a phone
 * @constraint mark controls with data-tn-interactive; pointer-events is not the mechanism
 * @example publishHitRegions({ bridge });
 */
export { publishHitRegions } from "./ui-hit-regions.js";
export {
  INTERACTIVE_ATTRIBUTE,
  type IHitRegion,
  type IHitRegionRegistry,
} from "./ui-hit-regions.js";
