from pathlib import Path
import json,subprocess,time
root=Path.cwd()
done=Path.home()/'offload/jobs/prd614-laptop-overview-calibrated.done'
for attempt in range(50):
    if done.exists(): break
    time.sleep(.1)
assert done.is_file() and done.read_text().strip()=='0', 'Calibrated laptop probe did not exit successfully'
p=root/'.linchpin/prd614-laptop-settled/after-overview-calibrated'
for name in ['pilot.json','settle.json']:
    assert json.loads((p/name).read_text())['pass'] is True, name
assert json.loads((p/'pilot.json').read_text())['adapter']['vendor'].lower()=='intel'
print('Calibrated Intel probe PASS; starting full16',flush=True)
raise SystemExit(subprocess.run(['python3','.linchpin/prd614-laptop-settled/collect-forest-initial.py'],timeout=10800).returncode)
