from pathlib import Path
import gzip,hashlib,json,shutil
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'.linchpin/prd614-laptop-settled/full16'
OUT=ROOT/'.linchpin/prd614-laptop-settled/proof'
POSES={'ground':[41,14.799999999999999,-21.139],'edge':[78.47,19.1,1.689],'overview':[203.829,233.1,141.689],'lake':[20,84,115]}
OUT.mkdir(exist_ok=True)
manifest={'purpose':'Default forest unchanged-look acceptance; manual visual capture only','performanceGate':'UNVERIFIED: original CLI/performance failures are retained','observerScripts':[],'frames':[],'pairs':[]}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
for arm in ['BEFORE','AFTER']:
 for run in [1,2]:
  for pose,position in POSES.items():
   src=BASE/arm/f'run-{run}'/pose;dst=OUT/arm/f'run-{run}'/pose;dst.mkdir(parents=True,exist_ok=True)
   pilot=json.loads((src/'pilot.json').read_text());settle=json.loads((src/'settle.json').read_text());report=json.loads((src/'report.json').read_text());inp=json.loads((src/'input.json').read_text())
   assert pilot['pass'] is True and settle['pass'] is True,(arm,run,pose)
   assert pilot['adapter']['vendor']=='intel' and not any(x in json.dumps(pilot['adapter']).lower() for x in ['swiftshader','lavapipe','llvmpipe'])
   assert pilot['after']['camera']['transform']['position']==position
   assert pilot['after']['clock']==pilot['before']['clock']==inp['capture']['clock']
   assert pilot['after']['raf']>pilot['before']['raf'] and not pilot['after']['gpuErrors'] and not pilot['errors']
   assert pilot['after']['fiducials']==0
   terrain=settle['samples'][-1]['terrain']['terrain'];assert terrain['residentTiles']==terrain['residentTileBudget']==169 and terrain.get('pendingConstruction') is None
   assert report['resourceRows'] and all(r['pass'] for r in report['resourceRows'])
   assert report['visualRows'] and all(r['pass'] for r in report['visualRows'])
   assert report['performanceGate'].startswith('UNVERIFIED')
   raw=Image.open(src/'raw.png').convert('RGBA');label=Image.open(src/'labeled.png').convert('RGBA')
   assert raw.size==(1920,1080) and label.size==(1920,1160)
   assert label.crop((0,80,1920,1160)).tobytes()==raw.tobytes(),'Label changed original pixels'
   entry={'arm':arm,'run':run,'pose':pose,'adapter':pilot['adapter'],'settleMs':settle['samples'][-1]['elapsedMs'],'drawingBuffer':pilot['finalGeometry']['dom']['canvas'],'reusedBrowserFrom':pilot.get('reusedBrowserFrom'),'files':{}}
   for name in ['raw.png','labeled.png']:
    shutil.copyfile(src/name,dst/name);entry['files'][name]=sha(dst/name)
   for name in ['pilot.json','settle.json','report.json','input.json','preflight.json','readiness.json','capture.log']:
    data=(src/name).read_bytes();compressed=gzip.compress(data,mtime=0);(dst/(name+'.gz')).write_bytes(compressed)
    assert gzip.decompress(compressed)==data
    entry['files'][name+'.gz']={'sha256':sha(dst/(name+'.gz')),'originalSha256':hashlib.sha256(data).hexdigest()}
   manifest['frames'].append(entry)
for run in [1,2]:
 for pose in POSES:
  pair=Image.new('RGB',(3840,1160))
  for index,arm in enumerate(['BEFORE','AFTER']):pair.paste(Image.open(OUT/arm/f'run-{run}'/pose/'labeled.png').convert('RGB'),(index*1920,0))
  path=OUT/'pairs'/f'{pose}-run-{run}.png';path.parent.mkdir(exist_ok=True);pair.save(path)
  manifest['pairs'].append({'path':str(path.relative_to(OUT)),'sha256':sha(path)})
for name in ['forest-cold-start-capture.ts','forest-settled-capture.ts','collect-forest-initial.py','run-full-if-probe-passes.py','prepare-proof.py','payload-v2-sha256.json']:
 src=ROOT/'.linchpin/prd614-laptop-settled'/name;dst=OUT/'sources'/name;dst.parent.mkdir(exist_ok=True);shutil.copyfile(src,dst)
 manifest['observerScripts'].append({'path':str(dst.relative_to(OUT)),'sha256':sha(dst)})
assert len(manifest['frames'])==16 and len(manifest['pairs'])==8
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Validated16 captures,8 full-resolution pairs,unchanged raw label pixels,exact cameras,Intel adapter,169 tiles,original resource/nonblank checks; performance unverified.')
