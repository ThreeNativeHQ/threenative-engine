"""Reversible stock PassNode.compileAsync comparison after the original frame matrix."""
import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import sys

task = Path(__file__).resolve().parents[2]
baseline = task.parent / "prd616-before"
primary = task.parent.parent
renderer = baseline / "packages/core/src/renderer.ts"
census = baseline / "packages/core/src/pipeline-census.ts"
artifact = task / "artifacts/prd616/preferred-compile"
raw = Path.home() / ".cache/agent-dumps/prd616/raw"
anchor = '      if (typeof raw.compileAsync !== "function") return;\n'
preferred = '''      if (outputPass !== undefined) {
        if (typeof raw.getRenderTarget !== "function" || typeof raw.setRenderTarget !== "function" || typeof raw.getMRT !== "function" || typeof raw.setMRT !== "function")
          throw new Error("preferred experiment needs the stock render target and MRT APIs");
        const previousScene = outputPass.scene;
        const previousCamera = outputPass.camera;
        const previousTarget = raw.getRenderTarget();
        const previousMrt = raw.getMRT();
        setOutputPipelineRoot(outputPass, targetScene ?? scene, camera);
        try {
          if (targetScene !== undefined && targetScene !== scene) {
            raw.setRenderTarget(outputPass.renderTarget);
            raw.setMRT(outputPass.getMRT());
            await raw.compileAsync(scene, camera, targetScene);
          } else {
            await outputPass.compileAsync(raw as never);
          }
        } finally {
          outputPass.scene = previousScene;
          outputPass.camera = previousCamera;
          raw.setRenderTarget(previousTarget);
          raw.setMRT(previousMrt);
        }
        console.log("TN_PRD616_PREFERRED_COMPILE_COMPLETE");
        return;
      }
'''

def run(args, cwd, log):
    with log.open("wb") as output:
        return subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT).returncode

original = {path: path.read_bytes() for path in (renderer, census)}
text = original[renderer].decode()
assert text.count(anchor) == 1, "preferred compile insertion seam changed"
variant = text.replace(anchor, anchor + preferred)
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=baseline, text=True).strip() == "1d056cec3d84ad0a6aebd89a97d3bd66b8d04de9"
if sys.argv[1:] == ["--selfcheck"]:
    assert variant.count(preferred) == 1 and "_callDepth" not in preferred
    print("PRD616_PREFERRED_PREPARATION_PASS: no files changed")
    raise SystemExit(0)
assert sys.argv[1:] == ["--run"], "use --selfcheck or --run"
assert not (primary / ".linchpin/prd616-native-gates.running").exists(), "desktop CPU gates still running"
assert (primary / ".linchpin/prd616-final-matrix.pid.exit").read_text().strip() == "0", "original frame matrix must finish successfully first"
artifact.mkdir(parents=True, exist_ok=True)
raw.mkdir(parents=True, exist_ok=True)
backups = task / "artifacts/prd616/preferred-backups"
backups.mkdir(parents=True, exist_ok=True)
for path, content in original.items():
    backup = backups / (path.name + ".original")
    backup.write_bytes(content)
    assert backup.read_bytes() == content, f"backup verification failed: {backup}"
result = None
try:
    renderer.write_text(variant)
    census.write_bytes((task / "packages/core/src/pipeline-census.ts").read_bytes())
    with (task / "artifacts/prd616/preferred-source.patch").open("wb") as patch:
        subprocess.run(["git", "diff", "--", "packages/core/src/renderer.ts", "packages/core/src/pipeline-census.ts"], cwd=baseline, stdout=patch, check=True)
    assert run(["pnpm", "--filter", "@threenative/core", "build"], baseline, raw / "preferred-build.log") == 0, "see preferred-build.log"
    server = shlex.join(["pnpm", "--dir", str(baseline), "--filter", "abyss-framework", "dev", "--host", "127.0.0.1", "--port", "5182", "--strictPort"])
    command = ["node", "packages/playtest/dist/runner/cli.js", str(task / "examples/abyss-framework/playtests/warm-up-reuse.playtest.json"), "--project", str(baseline / "examples/abyss-framework"), "--url", "http://127.0.0.1:5182", "--server-command", server, "--browser-recipe", "webgpu", "--headed", "--artifacts", str(artifact)]
    os.environ["CAPTURE_LOCK_TIMEOUT_MS"] = "900000"
    result = run(command, task, raw / "preferred-runtime.log")
    assert "TN_PRD616_PREFERRED_COMPILE_COMPLETE" in (artifact / "console.json").read_text(), "stock preferred branch was not reached"
finally:
    for path, content in original.items():
        path.write_bytes(content)
        assert hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(content).digest(), f"restore failed: {path}"
    assert run(["pnpm", "--filter", "@threenative/core", "build"], baseline, raw / "preferred-restore-build.log") == 0, "source restored; baseline build failed, see preferred-restore-build.log"
print(f"PRD616_PREFERRED_RUNTIME: exit={result}; raw={raw / 'preferred-runtime.log'}; original source/build restored")
assert result in (0, 1), "preferred experiment failed before a valid scenario verdict"
