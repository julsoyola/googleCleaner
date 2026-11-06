// Standalone Node-only retention policy; vendored into the OAuth workflow.
import {access,readFile,readdir,writeFile,mkdir,lstat,realpath,open,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const verifiedVideos=new Map();
const exec=promisify(execFile);
const OWNER='project-demo-retention-v1';
const dateRun=/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
const inside=(base,value)=>value===base||value.startsWith(base+path.sep);
const overlaps=(a,b)=>inside(a,b)||inside(b,a);
const exists=async file=>{try{await lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export async function canonicalRoot(root){
  const resolved=path.resolve(root),info=await lstat(resolved);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Output root must be a real directory.');
  const canonical=await realpath(resolved);
  if(canonical!==resolved)throw new Error('Symlinked output roots are not eligible.');
  return canonical;
}
async function safePath(root,target){
  const resolved=path.resolve(target);
  if(!inside(root,resolved)||resolved===root)throw new Error('Target escapes the workflow output root.');
  let current=root;
  for(const part of path.relative(root,resolved).split(path.sep)){
    current=path.join(current,part);
    if((await lstat(current)).isSymbolicLink())throw new Error('Symlink targets are not eligible.');
  }
  if(!inside(root,await realpath(resolved)))throw new Error('Canonical target escapes output root.');
  return resolved;
}
async function tree(target){
  const stat=await lstat(target);
  if(stat.isSymbolicLink())throw new Error('Symlinks inside cleanup targets are not eligible.');
  if(stat.isFile())return [{file:target,bytes:stat.size,nlink:stat.nlink}];
  if(!stat.isDirectory())throw new Error('Unsupported filesystem object.');
  const result=[];
  for(const entry of await readdir(target))result.push(...await tree(path.join(target,entry)));
  return result;
}
function purpose(workflow,relative){
  const file=relative.replace(/^temp\//,'');
  if(file.includes('/'))return null;
  if(['export.mp4','previous-export.mp4'].includes(file))return 'final-video';
  if(['captions.json','captions.srt','summary.json'].includes(file))return 'retained-metadata';
  if(['context.json','fixtures.json','approval.json','preflight.json'].includes(file))return 'run-metadata';
  if(['review.json','diagnostic.json','diagnostic-replay.json','inspection-readonly.json','inspection-readonly-error.json','failure-analysis.json'].includes(file)||/^diagnostic-attempt-\d+\.json$/.test(file))return 'diagnostic';
  if(workflow==='oauth'){
    if(file==='raw.mp4')return 'raw-footage';
    if(file==='caption-renderer'||/^caption-\d+\.png$/.test(file)||file==='capture.log')return 'intermediate';
  }else if(workflow==='browser'){
    if(/^page@[a-f0-9]+\.webm$/.test(file)||file==='raw.webm')return 'raw-footage';
    if(['opening.mp4','closing.mp4','walkthrough.mp4','opening.png','closing.png'].includes(file)||/^(caption|source|qa)-[a-z0-9-]+\.png$/.test(file))return 'intermediate';
  }
  if(/^temp\/(?:audio|narration|soundtrack)\.(?:wav|aac|m4a|mp3)$/.test(relative))return 'intermediate';
  return null;
}
export function freshExportPath(directory,name,stamp=new Date().toISOString().replace(/[:.]/g,'-')){
  if(path.basename(name)!==name||!name.endsWith('.mp4')||!dateRun.test(stamp))throw new Error('Invalid export name or timestamp.');
  return path.join(directory,`${name.slice(0,-4)}-${stamp}.mp4`);
}
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
export function failedCleanupCommand(root,directory){
  return `bash ${quote(path.join(path.dirname(root),'start.sh'))} --cleanup-run ${quote(directory)}`;
}
async function writeManifest(run,manifest){await writeFile(path.join(run,'run-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});}
export async function discover(root,workflow,legacyFinals=[]){
  root=await canonicalRoot(root);
  const runs=[],skipped=[];
  for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.isDirectory()||!dateRun.test(entry.name))continue;
    const directory=path.join(root,entry.name);
    try{
      let manifest;
      if(await exists(path.join(directory,'run-manifest.json'))){
        await safePath(root,path.join(directory,'run-manifest.json'));
        manifest=await json(path.join(directory,'run-manifest.json'));
        if(manifest.owner!==OWNER||manifest.workflow!==workflow)throw new Error('Unrecognized manifest owner.');
      }else{
        await safePath(root,path.join(directory,'review.json'));
        const review=await json(path.join(directory,'review.json'));
        const result=String(review.result||'');
        const recognized=workflow==='oauth'?/^(INCOMPLETE:|DRAFT:)/.test(result):/^(INCOMPLETE|PASS: isolated real-UI rehearsal|EXPORTED)/.test(result);
        if(!recognized)throw new Error('Legacy run ownership/status cannot be established.');
        const state=/^(DRAFT:|EXPORTED)/.test(result)?'success':result.startsWith('PASS: isolated')?'rehearsal':'failed';
        manifest={owner:OWNER,workflow,state,legacy:true,dependencies:[],finals:[],artifacts:[]};
        if(state==='success'){
          const video=review.outputMetadata?.streams?.find(s=>s.codec_type==='video');
          manifest.expected=workflow==='browser'?{width:1920,height:1080,minDuration:83.8,maxDuration:84.2}:null;
          const exported=path.join(directory,'export.mp4');
          if(!await exists(exported))throw new Error('Successful legacy run has no retained final export.');
          const metadata=await inspectVideo(exported,manifest.expected||{});
          manifest.expected={width:metadata.width,height:metadata.height,minDuration:Math.max(0.1,metadata.duration-2),maxDuration:metadata.duration+2};
          manifest.finals=[{path:'export.mp4'}];
          if(typeof review.output==='string')manifest.finals.push({path:review.output});
          for(const final of legacyFinals)if(!manifest.finals.some(item=>item.path===final))manifest.finals.push({path:final});
          for(const final of manifest.finals)await inspectVideo(path.resolve(directory,final.path),manifest.expected);
          // Browser legacy reports did not save the Downloads path. The retained
          // export remains a final; never infer a destination from its basename.
          void video;
        }
      }
      const files=await readdir(directory,{withFileTypes:true});
      const artifacts=[];
      for(const file of files){
        if(file.name==='temp'&&file.isDirectory()){
          for(const child of await readdir(path.join(directory,'temp'))){
            const kind=purpose(workflow,`temp/${child}`);
            if(kind)artifacts.push({path:`temp/${child}`,purpose:kind});
          }
        }else{
          const kind=purpose(workflow,file.name);
          if(kind)artifacts.push({path:file.name,purpose:kind});
        }
      }
      // New manifests authorize exact generated names. Legacy adapters use
      // only their traced writer patterns, never arbitrary log/fixture names.
      if(manifest.legacy)manifest.artifacts=artifacts;
      runs.push({directory,manifest});
    }catch(error){skipped.push({path:directory,reason:error.code==='ENOENT'?'Missing status/configuration; resumability unknown.':error.message});}
  }
  return {root,runs,skipped};
}
export async function inspectVideo(file,expected={}){
  const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!stat.size)throw new Error('Final video is missing, empty, or symlinked.');
  if(await realpath(file)!==path.resolve(file))throw new Error('Final video path uses a symlinked parent or alias.');
  const cacheKey=JSON.stringify([path.resolve(file),stat.ino,stat.size,stat.mtimeMs,expected]);
  if(verifiedVideos.has(cacheKey))return verifiedVideos.get(cacheKey);
  const {stdout}=await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{maxBuffer:1024*1024});
  const metadata=JSON.parse(stdout),video=metadata.streams?.find(s=>s.codec_type==='video');
  const duration=Number(metadata.format?.duration);
  if(!video||!Number.isFinite(duration)||duration< (expected.minDuration??0.1)||duration>(expected.maxDuration??86400))throw new Error('Final has no playable stream or plausible duration.');
  if((expected.width&&video.width!==expected.width)||(expected.height&&video.height!==expected.height))throw new Error('Final dimensions differ from expected export dimensions.');
  await exec('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{maxBuffer:1024*1024});
  const result={bytes:stat.size,width:video.width,height:video.height,duration,codec:video.codec_name};
  verifiedVideos.set(cacheKey,result);return result;
}
export async function activePaths(root){
  // Read process metadata only; never log command lines, which may hold URLs.
  const {stdout:processes}=await exec('/bin/ps',['-ax','-o','pid=,command='],{maxBuffer:8*1024*1024});
  const commands=new Map(processes.split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(.*)$/);return m?[Number(m[1]),m[2]]:[0,''];}));
  const {stdout}=await exec('/usr/sbin/lsof',['-nP','-F','pn'],{maxBuffer:32*1024*1024});
  const paths=[];let pid=0;
  for(const line of stdout.split('\n')){
    if(line.startsWith('p'))pid=Number(line.slice(1));
    if(pid===process.pid||!line.startsWith('n'))continue;
    const file=line.slice(1),command=commands.get(pid)||'';
    if(inside(root,file))paths.push(file);
    if(file===path.dirname(root)&&/\bnode\b.*record\.mjs/.test(command)&&!command.includes('--cleanup'))paths.push(root);
  }
  return paths;
}
async function references(root,runs){
  const protectedPaths=[],skipped=[];let hold=false;
  const protect=async(value,owner)=>{
    if(typeof value!=='string'||!path.isAbsolute(value)){skipped.push({path:owner,reason:'Ambiguous configured dependency; skipped.'});hold=true;return;}
    try{
      const canonical=await realpath(value);
      protectedPaths.push(canonical,path.resolve(value));
    }catch{skipped.push({path:owner,reason:'Configured dependency is missing; skipped.'});if(owner===root)hold=true;else protectedPaths.push(owner);}
  };
  for(const name of ['profile-path.txt','native-profile-path.txt','pending-run.txt']){
    const file=path.join(root,name);
    if(await exists(file))try{await safePath(root,file);await protect((await readFile(file,'utf8')).trim(),root);}catch{hold=true;skipped.push({path:file,reason:'Unreadable reference; cleanup skipped.'});}
  }
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!dateRun.test(entry.name)||runs.some(run=>path.basename(run.directory)===entry.name))continue;
    const config=path.join(root,entry.name,'context.json');
    if(await exists(config)){hold=true;skipped.push({path:config,reason:'Unrecognized run has resume configuration; cleanup skipped.'});}
  }
  for(const run of runs){
    const {directory,manifest}=run;
    for(const dep of manifest.dependencies||[])await protect(dep,directory);
    const config=path.join(directory,'context.json');
    if(await exists(config)){
      try{
        await safePath(root,config);
        const data=await json(config);
        for(const key of ['profile','fixtureDirectory','resumeRun','sourceRun'])if(data[key])await protect(data[key],directory);
      }catch{protectedPaths.push(directory);skipped.push({path:directory,reason:'Unreadable resume configuration; preserved.'});}
    }
  }
  return {protectedPaths,skipped,hold};
}
async function assertTarget(root,target,runs,protectedPaths,active){
  target=await safePath(root,target);
  if([...protectedPaths,...active].some(file=>overlaps(target,file)))throw new Error('Protected dependency/profile or active output.');
  const files=await tree(target);
  for(const item of files){
    const run=runs.find(run=>inside(run.directory,item.file));
    if(!run)throw new Error('No workflow run owns this artifact.');
    const relative=path.relative(run.directory,item.file);
    const entry=run.manifest.artifacts.find(a=>a.path===relative);
    const kind=purpose(run.manifest.workflow,relative);
    if(item.nlink>1)throw new Error('Hard-linked output is ambiguous.');
    if(['run-manifest.json','review.json'].includes(relative)&&target===run.directory)continue;
    if(!entry||!kind||entry.purpose!==kind)throw new Error('Unrecognized generated artifact or source file.');
    if(['final-video','retained-metadata'].includes(kind))throw new Error('Final video or retained metadata is protected.');
    if(/\.(?:mjs|cjs|js|ts|html|css|svg|swift|sh|md)$/i.test(item.file))throw new Error('Source files cannot be cleanup targets.');
    for(const final of run.manifest.finals||[]){
      const destination=path.resolve(run.directory,final.path);
      if(overlaps(target,destination))throw new Error('Cleanup target contains a final video.');
    }
  }
  return files.reduce((sum,file)=>sum+file.bytes,0);
}
export async function planCleanup({root,workflow,mode='old',run:requestedRun,inspectActive=activePaths,legacyFinals=[]}){
  const inventory=await discover(root,workflow,legacyFinals);
  if(requestedRun&&!inventory.runs.some(item=>item.directory===path.resolve(requestedRun)))throw new Error('Requested run is missing, outside the output root, or unrecognized.');
  const refs=await references(inventory.root,inventory.runs);
  const skipped=[...inventory.skipped,...refs.skipped],targets=[];
  let active;
  try{active=await inspectActive(inventory.root);}catch{skipped.push({path:inventory.root,reason:'Could not establish active file usage; cleanup skipped.'});return {...inventory,skipped,targets,totalBytes:0};}
  if(refs.hold)return {...inventory,skipped,targets,totalBytes:0};
  const failures=inventory.runs.filter(run=>['failed','running'].includes(run.manifest.state));
  const latestFailure=failures.at(-1)?.directory;
  const latestSuccess=inventory.runs.filter(run=>run.manifest.state==='success').at(-1)?.directory;
  for(const run of inventory.runs){
    const {directory,manifest}=run;
    if(requestedRun&&path.resolve(requestedRun)!==directory)continue;
    if(manifest.active?.pid&&alive(manifest.active.pid)){skipped.push({path:directory,reason:'Recording/export process is active.'});continue;}
    if(active.some(file=>overlaps(directory,file))){skipped.push({path:directory,reason:'Output is in use.'});continue;}
    if(['failure','discard'].includes(mode)&&(!manifest.automaticRawCleanup||manifest.state!=='failed')){
      skipped.push({path:directory,reason:'Targeted failure cleanup requires a completed new-format failed run.'});continue;
    }
    if(!['finalize','discard','failure'].includes(mode)&&(directory===latestFailure||manifest.keepIntermediates)){
      skipped.push({path:directory,reason:directory===latestFailure?'Latest failed/incomplete run.':'Debug retention requested.'});continue;
    }
    if(mode==='failure'&&manifest.keepIntermediates){skipped.push({path:directory,reason:'Debug retention requested.'});continue;}
    if(manifest.state==='running'||(manifest.state==='failed'&&!['failure','discard'].includes(mode)&&(workflow==='oauth'||manifest.resumable!==false))){
      skipped.push({path:directory,reason:'Failed/abandoned run resumability cannot be ruled out.'});continue;
    }
    if(mode==='finalize'&&manifest.state!=='success'){skipped.push({path:directory,reason:'Only a successful reviewed export can be finalized.'});continue;}
    if(mode==='success'&&manifest.state!=='success')continue;
    if(manifest.state==='success'){
      try{
        if(!manifest.finals?.length)throw new Error('Final destination is unknown.');
        for(const final of manifest.finals)await inspectVideo(path.resolve(directory,final.path),manifest.expected);
      }catch(error){skipped.push({path:directory,reason:error.message});continue;}
    }
    const disposable=manifest.artifacts.filter(a=>a.disposition!=='trashed').filter(a=>{
      if(mode==='discard')return ['intermediate','diagnostic','raw-footage','run-metadata'].includes(a.purpose);
      // Failed takes need their raw evidence, last checkpoint images, logs,
      // original errors and fixture context; cards/encodes can be regenerated.
      if(mode==='failure')return a.purpose==='intermediate'&&!/(?:^|\/)(?:capture\.log|source-[a-z0-9-]+\.png)$/.test(a.path);
      return a.purpose==='intermediate'||
        (a.purpose==='diagnostic'&&manifest.state!=='failed'&&(manifest.automaticRawCleanup||a.path!=='review.json'))||
        (a.purpose==='run-metadata'&&manifest.state==='success'&&manifest.automaticRawCleanup)||
        (a.purpose==='raw-footage'&&(mode==='finalize'||manifest.state==='success'&&manifest.automaticRawCleanup));
    });
    // Rehearsals have no resumable app state or fixture dependencies. Entire
    // old rehearsal directories may be trashed only if every file is owned.
    const whole=mode==='old'&&manifest.state==='rehearsal'&&directory!==latestSuccess;
    const candidates=whole?[directory]:disposable.map(a=>path.join(directory,a.path));
    for(const target of candidates){
      if(!await exists(target))continue; // Previously cleaned generated output.
      try{
        const bytes=await assertTarget(inventory.root,target,inventory.runs,refs.protectedPaths,active);
        if(!['finalize','discard'].includes(mode)&&!manifest.automaticRawCleanup&&(await tree(target)).some(file=>purpose(workflow,path.relative(directory,file.file))==='raw-footage'))throw new Error('Legacy raw footage requires explicit finalization.');
        targets.push({path:target,bytes,purpose:target===directory?'obsolete rehearsal':purpose(workflow,path.relative(directory,target))});
      }catch(error){skipped.push({path:target,reason:error.message});}
    }
  }
  return {...inventory,skipped,targets,totalBytes:targets.reduce((sum,t)=>sum+t.bytes,0)};
}
async function withLock(root,action){
  const file=path.join(root,'retention-maintenance.lock');
  let handle;
  try{handle=await open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));}
  catch(error){if(error.code==='EEXIST')throw new Error('Cleanup/startup lock exists; skip until its ownership is resolved.');throw error;}
  try{return await action();}finally{await handle.close();await unlink(file);}
}
export async function trashArtifact(target,root){
  if(process.platform!=='darwin')throw new Error('This cleanup requires macOS Trash.');
  const source=fileURLToPath(new URL('./retention-trash.swift',import.meta.url));
  const cache=path.join(root,'retention-tools');
  await mkdir(cache,{recursive:true,mode:0o700});
  await safePath(root,cache);
  const digest=createHash('sha256').update(await readFile(source)).digest('hex').slice(0,12);
  const binary=path.join(cache,`trash-${digest}`);
  if(!await exists(binary))await exec('/usr/bin/swiftc',[source,'-o',binary]);
  await safePath(root,binary);
  const {stdout}=await exec(binary,[target]);
  return JSON.parse(stdout).destination;
}
export async function cleanup(options){
  const root=await canonicalRoot(options.root);
  const perform=async()=>{
    const plan=await planCleanup(options);
    const moved=[],errors=[];
    if(!options.dryRun)for(const run of plan.runs){
      if(run.manifest.state!=='success'||!plan.targets.some(target=>inside(run.directory,target.path)))continue;
      if(run.manifest.legacy){
        run.manifest.legacy=false;run.manifest.adoptedLegacy=true;
        await writeManifest(run.directory,run.manifest);
      }
      if(!await exists(path.join(run.directory,'summary.json'))){
        await writeFile(path.join(run.directory,'summary.json'),JSON.stringify({workflow:options.workflow,state:'success',finals:run.manifest.finals.map(f=>path.basename(f.path)),expected:run.manifest.expected},null,2),{mode:0o600});
      }
    }
    if(!options.dryRun)for(const target of plan.targets){
      try{
        // Re-resolve references/usage immediately before each mutation.
        const fresh=await planCleanup(options);
        if(!fresh.targets.some(item=>item.path===target.path))throw new Error('Target protection changed; skipped.');
        const destination=await (options.trash||trashArtifact)(target.path,root);
        moved.push({...target,destination});
        const owner=fresh.runs.find(run=>inside(run.directory,target.path));
        if(owner&&target.path!==owner.directory){
          for(const artifact of owner.manifest.artifacts)if(inside(target.path,path.resolve(owner.directory,artifact.path)))artifact.disposition='trashed';
          await writeManifest(owner.directory,owner.manifest);
        }
      }catch(error){errors.push({path:target.path,reason:error.message});}
    }
    return {targets:plan.targets,totalBytes:plan.totalBytes,skipped:plan.skipped,moved,errors,movedBytes:moved.reduce((sum,t)=>sum+t.bytes,0)};
  };
  return options.dryRun?perform():withLock(root,perform);
}
export async function beginRun({root,directory,workflow,dependencies=[],keepIntermediates=false}){
  await mkdir(root,{recursive:true,mode:0o700});root=await canonicalRoot(root);
  return withLock(root,async()=>{
    if(path.dirname(path.resolve(directory))!==root||!dateRun.test(path.basename(directory)))throw new Error('Run must be a timestamp directory directly in the output root.');
    await mkdir(directory,{mode:0o700});
    await mkdir(path.join(directory,'temp'),{mode:0o700});
    const manifest={owner:OWNER,workflow,state:'running',active:{pid:process.pid},dependencies,
      keepIntermediates,automaticRawCleanup:true,resumable:workflow==='oauth',finals:[],artifacts:[]};
    await writeManifest(directory,manifest);return manifest;
  });
}
export async function syncArtifacts(directory){
  const manifest=await json(path.join(directory,'run-manifest.json'));
  const names=await readdir(path.join(directory,'temp'));
  manifest.artifacts=names.flatMap(name=>{const kind=purpose(manifest.workflow,`temp/${name}`);return kind?[{path:`temp/${name}`,purpose:kind}]:[];});
  for(const name of await readdir(directory)){
    const kind=purpose(manifest.workflow,name);
    if(kind)manifest.artifacts.push({path:name,purpose:kind});
  }
  await writeManifest(directory,manifest);return manifest;
}
export async function finishRun({root,directory,workflow,state,finals=[],expected,dependencies,cleanupOptions={}}){
  const manifest=await syncArtifacts(directory);
  delete manifest.active;
  if(dependencies)manifest.dependencies=dependencies;
  let validationError;
  if(state==='success')try{
    if(!expected||!Number.isInteger(expected.width)||!Number.isInteger(expected.height)||expected.width<=0||expected.height<=0||!(expected.minDuration>0)||!(expected.maxDuration>=expected.minDuration))throw new Error('Success requires expected dimensions and duration bounds.');
    for(const file of finals){
      if(inside(await canonicalRoot(root),path.resolve(file))&&path.resolve(file)!==path.join(directory,'export.mp4'))throw new Error('Final destination overlaps temporary outputs.');
      await inspectVideo(file,expected);
    }
    if(!finals.some(file=>!inside(path.resolve(root),path.resolve(file))))throw new Error('An external final destination is required.');
    manifest.expected=expected;manifest.finals=finals.map(file=>({path:path.resolve(file)}));
  }catch(error){state='failed';validationError=error;}
  manifest.state=state;
  await writeManifest(directory,manifest);
  await writeFile(path.join(directory,'summary.json'),JSON.stringify({workflow,state,finals:state==='success'?finals.map(file=>path.basename(file)):[],expected:state==='success'?expected:undefined},null,2),{mode:0o600});
  let result={moved:[],movedBytes:0,skipped:[],errors:[]};
  if(['success','failed'].includes(state)&&!manifest.keepIntermediates){
    try{result=await cleanup({...cleanupOptions,root,workflow,mode:state==='success'?'success':'failure',run:directory});}
    catch{result.errors.push({path:directory,reason:'Automatic Trash cleanup unavailable; artifacts retained.'});}
    if(result.errors.length||result.skipped.length){
      console.warn('Some run artifacts were preserved by cleanup safeguards.');
      for(const item of [...result.errors,...result.skipped])console.warn(`${path.relative(root,item.path)}: ${item.reason}`);
    }
  }
  if(state==='failed')console.error(`Discard this run's evidence when no longer needed:\n${failedCleanupCommand(root,directory)}`);
  else if(result.errors.length||result.skipped.length)console.warn(`Retry eligible cleanup: bash ${quote(path.join(path.dirname(root),'start.sh'))} --cleanup`);
  if(validationError)throw validationError;
  return result;
}
export async function retentionCLI({root,workflow,args,legacyFinals=[]}){
  const modes=['--cleanup','--cleanup-run','--finalize-run'].filter(flag=>args.includes(flag));
  if(!modes.length){if(args.includes('--dry-run'))throw new Error('--dry-run requires --cleanup or --cleanup-run.');return false;}
  if(modes.length!==1)throw new Error('Choose one cleanup mode.');
  const flag=modes[0],index=args.indexOf(flag),targeted=flag!=='--cleanup';
  if(args.filter(arg=>arg===flag).length!==1||args.some((arg,i)=>arg!==flag&&arg!=='--dry-run'&&!(targeted&&i===index+1)))throw new Error('Use --cleanup [--dry-run] or --cleanup-run <run> [--dry-run].');
  if(targeted&&(!args[index+1]||args[index+1].startsWith('--')))throw new Error(`${flag} requires one run path.`);
  const result=await cleanup({root,workflow,legacyFinals,mode:flag==='--finalize-run'?'finalize':targeted?'discard':'old',run:targeted?path.resolve(args[index+1]):undefined,dryRun:args.includes('--dry-run')});
  for(const item of result.targets)console.log(`${item.bytes} bytes  ${path.relative(root,item.path)} (${item.purpose})`);
  console.log(`${args.includes('--dry-run')?'Eligible':'Moved to Trash'}: ${args.includes('--dry-run')?result.totalBytes:result.movedBytes} bytes; ${result.moved.length} moved; ${result.skipped.length} preserved/skipped.`);
  for(const item of [...result.skipped,...result.errors])console.log(`Preserved ${path.relative(root,item.path)}: ${item.reason}`);
  if(result.errors.length)process.exitCode=1;
  return true;
}
