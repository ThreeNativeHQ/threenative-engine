// Pose Lab as a library: the Asset Library (create-threenative, PRD-915) mounts this handler at
// `/__assets/pose/`. Core carries the built copy (`mcp/pose-lab.mjs`), as it carries the server.
export { type PoseLabHandler, createPoseLabHandler } from "./server.js";
