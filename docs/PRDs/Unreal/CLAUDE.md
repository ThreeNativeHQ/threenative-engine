<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — Unreal parity PRDs

Every PRD in this folder ports a stock Unreal Engine 5.8.3 feature. The goal is to match Unreal's default visuals and performance. The method is an experiment: build the scene in Unreal, recreate exactly the same scene in ThreeNative, then tune the engine until it matches the Unreal reference.

Load the `unreal-calibration` skill (`.agents/skills/unreal-calibration/`) before you write, fill, work or review any PRD here. It holds the process: the experiment, paired arms, the judge, the parity lock policy, performance parity and lane coordination. It applies to non-visual PRDs too. The rules in `../AGENTS.md` still apply.
