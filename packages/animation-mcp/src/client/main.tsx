import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) throw new Error("Pose Lab root missing.");
createRoot(root).render(<App project={root.dataset.project ?? "project"} />);
