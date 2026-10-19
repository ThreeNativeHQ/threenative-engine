import {spawn} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {acquireCaptureLock,CaptureLockTimeoutError,formatLockTimeoutLine} from '/home/joao/projects/threenative/threenative-engine/.worktrees/prd-345-backlight-defaults/packages/playtest/src/runner/captureLock.ts';
async function ownedGroupRunning(group:number){
 for(const name of await readdir('/proc')){
  if(!/^\d+$/.test(name))continue;
  try{const stat=await readFile('/proc/'+name+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===group&&fields[0]!=='Z'&&fields[0]!=='X')return true}catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error}
 }
 return false;
}
async function awaitOwnedGroup(group:number){
 const deadline=Date.now()+10000;
 while(await ownedGroupRunning(group)){
  if(Date.now()>deadline)throw Error('Owned child group did not settle; shared lease cannot be released safely.');
  await new Promise(resolve=>setTimeout(resolve,50));
 }
}
export async function runWithGlobalLease(command:string,args:string[],options:{lockRoot?:string;temporaryDirectory:string;timeoutMs?:number}){
 let child:ReturnType<typeof spawn>|undefined;let cancelled:NodeJS.Signals|undefined;let escalation:ReturnType<typeof setTimeout>|undefined;
 const signal=(received:NodeJS.Signals)=>{
  cancelled=received;
  if(child?.pid){
   try{process.kill(-child.pid,received)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
   escalation??=setTimeout(()=>{if(child?.pid)try{process.kill(-child.pid,'SIGKILL')}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}},5000);
  }
 };
 const interrupt=()=>signal('SIGINT');const terminate=()=>signal('SIGTERM');
 process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
 let lease:Awaited<ReturnType<typeof acquireCaptureLock>>|undefined;
 let code=1;let survivingDescendants=false;
 try{
  lease=await acquireCaptureLock({lockRoot:options.lockRoot??'/tmp/threenative-playtest-capture',timeoutMs:options.timeoutMs??120000,command:['PRD345 outer shared lease',command,...args].join(' '),onState:state=>console.log(JSON.stringify({outerCaptureLock:{root:options.lockRoot??'/tmp/threenative-playtest-capture',pid:process.pid,...state}}))});
  if(!cancelled){
   child=spawn(command,args,{detached:true,stdio:'inherit',env:{...process.env,TMPDIR:options.temporaryDirectory,CAPTURE_LOCK:'1'}});
   const outcome=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',(code,signal)=>resolve({code,signal}))});
   code=outcome.code??1;
  }
 }finally{
  if(child?.pid){
   if(!cancelled&&await ownedGroupRunning(child.pid)){
    survivingDescendants=true;
    console.error(JSON.stringify({code:'OWNED_DESCENDANTS_SURVIVED',group:child.pid,message:'Child exited while its owned descendants remained; cleaning group before lease release.'}));
    signal('SIGTERM');
   }
   await awaitOwnedGroup(child.pid);
  }
  if(escalation)clearTimeout(escalation);
  await lease?.release();
  process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
 }
 return survivingDescendants?1:cancelled?(cancelled==='SIGINT'?130:143):code;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [command,...args]=process.argv.slice(2);if(!command)throw Error('Expected child command');
 try{process.exitCode=await runWithGlobalLease(command,args,{temporaryDirectory:process.env.TN_PRD345_CHILD_TMPDIR??'/tmp/p345bt'});}catch(error){if(error instanceof CaptureLockTimeoutError){console.error(formatLockTimeoutLine(error));process.exitCode=75}else throw error}
}
