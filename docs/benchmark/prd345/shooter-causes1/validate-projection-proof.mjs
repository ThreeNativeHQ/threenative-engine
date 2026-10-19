// Offline companion for the future isolated fixture producer; no rendering or source mutation.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const input=process.argv[2];if(!input)throw Error('Expected actual proof-index.json');
const root=dirname(resolve(input));const index=JSON.parse(await readFile(input,'utf8'));
assert.ok(Array.isArray(index.pairs)&&index.pairs.length>0);
const keys=['cameraMatrixWorld','cameraMatrixWorldInverse','cameraProjectionMatrix','tick','animationTicks','animationSeconds','bufferWidth','bufferHeight'];
const rows=[];
for(const pair of index.pairs){
 const left=JSON.parse(await readFile(resolve(root,pair.leftSnapshot),'utf8'));const right=JSON.parse(await readFile(resolve(root,pair.rightSnapshot),'utf8'));
 for(const snapshot of [left,right])for(const key of keys){assert.ok(Object.hasOwn(snapshot,key),'Missing measured '+key);if(key.startsWith('camera'))assert.ok(Array.isArray(snapshot[key])&&snapshot[key].length===16&&snapshot[key].every(Number.isFinite));else assert.ok(Number.isFinite(snapshot[key]));}
 for(const key of keys)assert.deepEqual(left[key],right[key],pair.name+' mismatched '+key);
 const pixels=[];for(const path of [pair.leftPNG,pair.rightPNG]){const bytes=await readFile(resolve(root,path));assert.equal(bytes.subarray(1,4).toString(),'PNG');const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);assert.equal(width,left.bufferWidth);assert.equal(height,left.bufferHeight);pixels.push({path,width,height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 rows.push({name:pair.name,matchedProjectionAndClock:true,pixels});
}
await writeFile(resolve(root,'projection-proof.json'),JSON.stringify({pairs:rows,scope:'Projection/clock validity only; no appearance, material fidelity or performance admission inferred.'},null,2));
