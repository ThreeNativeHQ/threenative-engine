import game from "./game.js";
import { showLaunchFailures } from "./launchFailure.js";
import { BIOMES, type WorldName } from "./render/biomes.js";
import { canopyComparison } from "./render/pack.js";

const failures = showLaunchFailures();
const query = new URLSearchParams(location.search);
game.state.setState({
  canopyComparison: canopyComparison(query.get("canopyNormals"), query.get("canopySpecular")),
});
const world = query.get("world");
if (world && Object.hasOwn(BIOMES, world)) game.resumeScene(world as WorldName);
void game.start().then(() => {
  failures.ready();
  game.state.setState({ showcase: query.has("showcase") });
});
