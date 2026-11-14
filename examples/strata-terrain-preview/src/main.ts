import { exposeDebug } from "@threenative/core";
import game from "./game.js";
import { showLaunchFailures } from "./launchFailure.js";
import { BIOMES, type WorldName } from "./render/biomes.js";
import { canopyComparison } from "./render/props/pack.js";

const failures = showLaunchFailures();
const query = new URLSearchParams(location.search);
game.state.setState({
  canopyComparison: canopyComparison(query.get("canopyNormals"), query.get("canopySpecular")),
});
const world = query.get("world");
if (world && Object.hasOwn(BIOMES, world)) game.resumeScene(world as WorldName);
// `?capture=1`: the running game, so a capture script reads `ctx.renderer.gpuFrameMs()` and hides
// one instanced batch by name from the same place a player's console can. Dev builds only.
if (query.has("capture")) exposeDebug("game", game);
// A rejected start() is already on the page: core reports `start-failed` through onLaunchFailure.
void game.start().then(
  () => {
    failures.ready();
    game.state.setState({ showcase: query.has("showcase") });
  },
  () => undefined,
);
