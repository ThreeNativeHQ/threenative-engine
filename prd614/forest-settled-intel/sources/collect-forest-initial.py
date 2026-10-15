import json
import os
from pathlib import Path
import signal
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
base = root / '.linchpin/prd614-laptop-settled/full16'
payloads = root / 'artifacts/prd614/intel-inputs/telemetry-v2'
imagick_lib = Path(os.environ.get('PRD614_IMAGEMAGICK_ROOT', Path.home() / '.local/opt/prd614-imagemagick')) / 'usr/lib/x86_64-linux-gnu'

for arm in ['AFTER', 'BEFORE']:
    payload = payloads / arm.lower()
    if not (payload / 'index.html').is_file():
        raise FileNotFoundError(f'missing telemetry payload: {payload}')
    arm_base = base / arm
    arm_base.mkdir(parents=True, exist_ok=True)
    with open(arm_base / 'server.log', 'w') as log:
        server = subprocess.Popen([sys.executable, '-m', 'http.server', '5201', '--bind', '127.0.0.1'], cwd=payload, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            for pose in ['ground', 'edge', 'overview', 'lake']:
                for run in [1, 2]:
                    out = arm_base / f'run-{run}' / pose
                    out.mkdir(parents=True, exist_ok=True)
                    env = dict(os.environ, TN_PLAYTEST_HOST_DISPLAY='1', CAPTURE_LOCK='1', CAPTURE_LOCK_TIMEOUT_MS='900000', TN_CANVAS_TRACE_OUTPUT=str(out / 'trace.json'), TN_CAPTURE_POSE=pose, TN_PRD614_ROOT=str(root))
                    env['LD_LIBRARY_PATH'] = f'{imagick_lib}:{env.get("LD_LIBRARY_PATH", "")}'.rstrip(':')
                    print('START', arm, pose, run, flush=True)
                    with open(out / 'capture.log', 'w') as capture:
                        result = subprocess.run(['pnpm', 'exec', 'tsx', '.linchpin/prd614-laptop-settled/forest-settled-capture.ts'], cwd=root, env=env, stdout=capture, stderr=subprocess.STDOUT, timeout=1740)
                    print('RESULT', arm, pose, run, 'exit', result.returncode, flush=True)
                    if result.returncode:
                        print((out / 'capture.log').read_text()[-1800:], flush=True)
                        raise SystemExit(result.returncode)
                    pilot = json.loads((out / 'pilot.json').read_text())
                    settle = json.loads((out / 'settle.json').read_text())
                    assert pilot['pass'] is True and settle['pass'] is True
                    resident = settle['samples'][-1]['terrain']['terrain']['residentTiles']
                    print('PASS', arm, pose, run, 'adapter', pilot['adapter'], 'resident', resident, 'settleMs', settle['samples'][-1]['elapsedMs'], flush=True)
                    subprocess.run(['convert', str(out / 'raw.png'), '-background', '#111827', '-gravity', 'north', '-splice', '0x80', '-fill', 'white', '-font', 'DejaVu-Sans-Bold', '-pointsize', '48', '-annotate', '+0+12', f'{arm} — {pose.upper()} RUN {run}', str(out / 'labeled.png')], check=True, env=env)
        finally:
            if server.poll() is None:
                os.killpg(server.pid, signal.SIGTERM)
                server.wait(timeout=10)
print('Sixteen fresh captures pass; visual judgment remains required.', flush=True)
