import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rename,symlink,access,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {beginRun,finishRun,cleanup,planCleanup,inspectVideo,freshExportPath,failedCleanupCommand,retentionCLI} from './retention.mjs';
const quiet=async()=>[];
async function setup(t){
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'demo-retention-')));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const root=path.join(base,'output');await mkdir(root);
 const destination=path.join(base,'final.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=64x48:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',destination]);
 const trash=path.join(base,'trash');await mkdir(trash);let n=0;
 const move=async file=>{const to=path.join(trash,String(n++));await rename(file,to);return to;};
 const run=async(stamp,state='success',keep=true)=>{
   const directory=path.join(root,`2026-10-16T00-00-${stamp}-000Z`);
   await beginRun({root,directory,workflow:'browser',keepIntermediates:keep});
   await writeFile(path.join(directory,'temp','opening.png'),'image');
   await writeFile(path.join(directory,'temp','raw.webm'),'raw');
   await writeFile(path.join(directory,'review.json'),JSON.stringify({result:state}));
   await finishRun({root,directory,workflow:'browser',state,finals:state==='success'?[destination]:[],expected:{width:64,height:48,minDuration:.9,maxDuration:1.1}});
   if(keep){const file=path.join(directory,'run-manifest.json');const m=JSON.parse(await readFile(file));m.keepIntermediates=false;await writeFile(file,JSON.stringify(m));}
   return directory;
 };
 return {base,root,destination,run,move};
}
test('successful cleanup trashes raw and verbose reports; dry-run unchanged; final stays protected',async t=>{
 const {root,run,move,destination}=await setup(t);const directory=await run('01');
 const options={root,workflow:'browser',inspectActive:quiet,trash:move};
 const before=await readdir(path.join(directory,'temp'));
 const dry=await cleanup({...options,dryRun:true});assert.equal(dry.targets.length,3);assert.equal(dry.moved.length,0);
 assert.deepEqual(await readdir(path.join(directory,'temp')),before);
 const result=await cleanup(options);assert.equal(result.moved.length,3);
 await assert.rejects(access(path.join(directory,'temp','raw.webm')));await access(destination);await access(path.join(directory,'summary.json'));
 assert.equal((await cleanup({...options,mode:'finalize',run:directory})).moved.length,0);
 await writeFile(destination,'broken');await writeFile(path.join(directory,'temp','raw.webm'),'raw');
 assert.equal((await cleanup({...options,mode:'finalize',run:directory})).moved.length,0);
});
test('latest failure, unknown resumability and active usage are preserved',async t=>{
 const {root,run,move}=await setup(t);const first=await run('01','failed');await run('02','failed');
 const file=path.join(first,'run-manifest.json');const manifest=JSON.parse(await readFile(file));delete manifest.resumable;await writeFile(file,JSON.stringify(manifest));
 const success=await run('03');
 let result=await cleanup({root,workflow:'browser',inspectActive:async()=>[path.join(success,'temp','opening.png')],trash:move});
 assert.equal(result.moved.length,0);
 manifest.state='running';manifest.active={pid:process.pid};await writeFile(file,JSON.stringify(manifest));
 result=await planCleanup({root,workflow:'browser',inspectActive:quiet});assert.ok(result.skipped.some(item=>item.reason.includes('process is active')));
});
test('resume/profile dependencies, missing configuration and symlink escapes block cleanup',async t=>{
 const {root,base,run,move}=await setup(t);const directory=await run('01');
 const frame=path.join(directory,'temp','opening.png');
 await writeFile(path.join(root,'profile-path.txt'),directory);
 assert.equal((await cleanup({root,workflow:'browser',inspectActive:quiet,trash:move})).moved.length,0);
 await writeFile(path.join(root,'profile-path.txt'),path.join(base,'missing'));
 assert.equal((await planCleanup({root,workflow:'browser',inspectActive:quiet})).targets.length,0);
 await rm(path.join(root,'profile-path.txt'));
 await writeFile(path.join(directory,'context.json'),JSON.stringify({fixtureDirectory:directory}));
 assert.equal((await planCleanup({root,workflow:'browser',inspectActive:quiet})).targets.length,0);
 await rm(path.join(directory,'context.json'));await rm(frame);await symlink(path.join(base,'final.mp4'),frame);
 const plan=await planCleanup({root,workflow:'browser',inspectActive:quiet});assert.ok(!plan.targets.some(item=>item.path===frame));assert.ok(plan.skipped.some(item=>item.reason.includes('Symlink')));
 await assert.rejects(planCleanup({root,workflow:'browser',run:base,inspectActive:quiet}),/outside/);
});
test('debug retention and final integrity are enforced',async t=>{
 const {root,run,destination,base}=await setup(t);const directory=await run('01');
 const file=path.join(directory,'run-manifest.json');const manifest=JSON.parse(await readFile(file));manifest.keepIntermediates=true;await writeFile(file,JSON.stringify(manifest));
 assert.equal((await planCleanup({root,workflow:'browser',inspectActive:quiet})).targets.length,0);
 await assert.rejects(inspectVideo(destination,{width:1920,height:1080}),/dimensions/);
 const alias=path.join(base,'alias');await symlink(base,alias);
 await assert.rejects(inspectVideo(path.join(alias,'final.mp4')),/symlinked parent/);
});
test('finishRun automatically trashes raw and intermediates after external final validation',async t=>{
 const {root,destination,move}=await setup(t);
 const directory=path.join(root,'2026-10-16T00-00-01-000Z');
 await beginRun({root,directory,workflow:'browser'});
 await writeFile(path.join(directory,'temp','opening.png'),'image');
 await writeFile(path.join(directory,'temp','raw.webm'),'footage');
 const result=await finishRun({root,directory,workflow:'browser',state:'success',finals:[destination],expected:{width:64,height:48,minDuration:.9,maxDuration:1.1},cleanupOptions:{inspectActive:quiet,trash:move}});
 assert.equal(result.moved.length,2);await assert.rejects(access(path.join(directory,'temp','raw.webm')));
 const manifest=JSON.parse(await readFile(path.join(directory,'run-manifest.json')));
 assert.equal(manifest.state,'success');assert.equal(manifest.active,undefined);
 assert.ok(manifest.artifacts.some(item=>item.purpose==='raw-footage'));
});
test('unrecognized source files prevent whole-run cleanup; manifest cannot authorize a final',async t=>{
 const {root,run,move}=await setup(t);const directory=await run('01','rehearsal');
 await writeFile(path.join(directory,'source.mjs'),'preserve source');
 assert.equal((await cleanup({root,workflow:'browser',inspectActive:quiet,trash:move})).moved.length,0);
 const success=await run('02');
 const file=path.join(success,'run-manifest.json');const manifest=JSON.parse(await readFile(file));
 manifest.artifacts.push({path:'export.mp4',purpose:'intermediate'});await writeFile(path.join(success,'export.mp4'),'final');await writeFile(file,JSON.stringify(manifest));
 const result=await cleanup({root,workflow:'browser',inspectActive:quiet,trash:move});
 assert.ok(!result.moved.some(item=>item.path.endsWith('export.mp4')));await access(path.join(success,'export.mp4'));
});

test('fresh final paths are distinct and preserve an existing default export',async t=>{
 const {base,destination}=await setup(t);
 const before=await readFile(destination);
 const first=freshExportPath(base,'final.mp4','2026-10-16T00-00-01-000Z');
 const next=freshExportPath(base,'final.mp4','2026-10-16T00-00-02-000Z');
 assert.notEqual(first,next);assert.notEqual(first,destination);
 assert.deepEqual(await readFile(destination),before);
 assert.throws(()=>freshExportPath(base,'../final.mp4'),/Invalid/);
});
test('failure pruning keeps evidence and resume files; explicit discard respects other-run dependencies',async t=>{
 const {root,run,move}=await setup(t);const directory=await run('01','failed');
 await writeFile(path.join(directory,'temp','source-last.png'),'checkpoint');
 await writeFile(path.join(directory,'temp','audio.wav'),'temporary audio');
 await writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({message:'safe error'}));
 await writeFile(path.join(directory,'context.json'),JSON.stringify({fixtureDirectory:directory}));
 // A self-reference also protects regenerable output: never override a saved dependency.
 let result=await finishRun({root,directory,workflow:'browser',state:'failed',cleanupOptions:{inspectActive:quiet,trash:move}});
 assert.equal(result.moved.length,0);
 await writeFile(path.join(directory,'context.json'),JSON.stringify({}));
 result=await finishRun({root,directory,workflow:'browser',state:'failed',cleanupOptions:{inspectActive:quiet,trash:move}});
 assert.equal(result.moved.length,2); // opening card and generated audio
 for(const name of ['temp/raw.webm','temp/source-last.png','review.json','diagnostic.json','context.json','summary.json'])await access(path.join(directory,name));
 const other=path.join(root,'2026-10-16T00-00-02-000Z');
 await beginRun({root,directory:other,workflow:'browser',dependencies:[directory]});
 const options={root,workflow:'browser',mode:'discard',run:directory,inspectActive:quiet,trash:move};
 assert.equal((await cleanup(options)).moved.length,0);
 await finishRun({root,directory:other,workflow:'browser',state:'failed',dependencies:[],cleanupOptions:{inspectActive:quiet,trash:move}});
 const preview=await cleanup({...options,dryRun:true});assert.ok(preview.targets.length>=4);
 await access(path.join(directory,'temp','raw.webm'));
 assert.ok((await cleanup(options)).moved.length>=4);
 await access(path.join(directory,'summary.json'));
 assert.equal(failedCleanupCommand(root,directory),`bash '${path.join(path.dirname(root),'start.sh')}' --cleanup-run '${directory}'`);
});
test('missing, corrupt, wrong-duration and wrong-size Downloads finals prevent raw cleanup',async t=>{
 for(const variant of ['missing','corrupt','duration','dimensions']){
  const {root,base,destination,move}=await setup(t);
  const directory=path.join(root,'2026-10-16T00-00-01-000Z');
  await beginRun({root,directory,workflow:'browser'});
  await writeFile(path.join(directory,'temp','raw.webm'),'evidence');
  let final=destination;const expected={width:64,height:48,minDuration:.9,maxDuration:1.1};
  if(variant==='missing')final=path.join(base,'missing.mp4');
  if(variant==='corrupt')await writeFile(final,'broken');
  if(variant==='duration')expected.minDuration=2,expected.maxDuration=3;
  if(variant==='dimensions')expected.width=1920;
  await assert.rejects(finishRun({root,directory,workflow:'browser',state:'success',finals:[final],expected,cleanupOptions:{inspectActive:quiet,trash:move}}));
  await access(path.join(directory,'temp','raw.webm'));
  assert.equal(JSON.parse(await readFile(path.join(directory,'run-manifest.json'))).state,'failed');
 }
});
test('successful run cannot trash footage referenced by another resumable run',async t=>{
 const {root,destination,move}=await setup(t);
 const directory=path.join(root,'2026-10-16T00-00-01-000Z');
 await beginRun({root,directory,workflow:'browser'});
 const raw=path.join(directory,'temp','raw.webm');await writeFile(raw,'raw');
 const other=path.join(root,'2026-10-16T00-00-02-000Z');
 await beginRun({root,directory:other,workflow:'oauth',dependencies:[raw]});
 // References are also honored across workflow types in this root.
 const file=path.join(other,'run-manifest.json');const manifest=JSON.parse(await readFile(file));manifest.workflow='browser';manifest.state='failed';delete manifest.active;await writeFile(file,JSON.stringify(manifest));
 const result=await finishRun({root,directory,workflow:'browser',state:'success',finals:[destination],expected:{width:64,height:48,minDuration:.9,maxDuration:1.1},cleanupOptions:{inspectActive:quiet,trash:move}});
 assert.equal(result.moved.length,0);await access(raw);
});
test('OAuth success cleans generated renderer, audio, raw and logs while preserving shared authentication and fixtures',async t=>{
 const {root,base,destination,move}=await setup(t);
 const directory=path.join(root,'2026-10-16T00-00-01-000Z');
 const profile=path.join(base,'shared-profile');await mkdir(profile);await writeFile(path.join(profile,'Preferences'),'test authentication state');
 await writeFile(path.join(root,'profile-path.txt'),profile);
 await beginRun({root,directory,workflow:'oauth'});
 const fixtures=path.join(directory,'fixtures');await mkdir(fixtures);await writeFile(path.join(fixtures,'keep.txt'),'fixture');
 await writeFile(path.join(directory,'context.json'),JSON.stringify({profile,fixtureDirectory:fixtures}));
 await writeFile(path.join(directory,'diagnostic.json'),JSON.stringify({message:'sanitized'}));
 const generated=['raw.mp4','caption-0.png','caption-renderer','capture.log','audio.wav'];
 for(const name of generated)await writeFile(path.join(directory,'temp',name),'generated');
 const result=await finishRun({root,directory,workflow:'oauth',state:'success',dependencies:[profile,fixtures],finals:[destination],expected:{width:64,height:48,minDuration:.9,maxDuration:1.1},cleanupOptions:{inspectActive:quiet,trash:move}});
 assert.equal(result.moved.length,7);
 for(const name of generated)await assert.rejects(access(path.join(directory,'temp',name)));
 assert.equal(await readFile(path.join(profile,'Preferences'),'utf8'),'test authentication state');
 assert.equal(await readFile(path.join(fixtures,'keep.txt'),'utf8'),'fixture');await access(destination);
 assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(directory,'summary.json')))).sort(),['expected','finals','state','workflow']);
});
test('targeted cleanup CLI requires a single explicit path',async()=>{
 await assert.rejects(retentionCLI({args:['--cleanup-run']}),/requires one run path/);
 await assert.rejects(retentionCLI({args:['--cleanup','--cleanup-run','somewhere']}),/Choose one/);
 assert.equal(await retentionCLI({args:[]}),false);
});
