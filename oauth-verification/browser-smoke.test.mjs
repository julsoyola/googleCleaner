// Local DOM integration test, not an OAuth demo or recording.
// All Drive reads are in-memory test doubles. No Google requests or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, delay } from './support.mjs';
import { recorderGuardSource } from './browser-guard.mjs';
import { waitForAuthentication } from './auth-readiness.mjs';

const tools=path.dirname(fileURLToPath(import.meta.url));
const folderId='test_folder_12345';
const account='owner@example.com';
const expected=[
  {role:'review',name:'generated-review.txt',content:'Disposable review.\n'},
  {role:'keep',name:'generated-keep.txt',content:'Disposable keep.\n'},
];
function browserStubs(settings) {
  globalThis.__testAuth = {pending:false, delayNext:false, errorNext:null};
  globalThis.__testFiles=[...settings.expected.map((file,i)=>({id:`fixture_id_${i}`,name:file.name,
    content:file.content,size:String(new TextEncoder().encode(file.content).length),parents:[settings.folderId],
    ownedByMe:true,trashed:false,mimeType:'text/plain',modifiedTime:new Date().toISOString()})),
    {id:'personal_id',name:'PRIVATE FILENAME MUST NOT RENDER.txt',parents:['other_folder'],mimeType:'text/plain'}];
  globalThis.chrome={runtime:{getManifest:()=>({oauth2:{client_id:'unit-test'}}),
    sendMessage:async message=>{
      if(message.type==='authenticate') {
        if (__testAuth.pending) return {ok:false,error:'Google sign-in is in progress. Resume cleanup after signing in.'};
        if (message.interactive && __testAuth.delayNext) {
          __testAuth.pending = true;
          __testAuth.delayNext = false;
          return new Promise(resolve => { __testAuth.finish = () => {
            __testAuth.pending = false;
            resolve(__testAuth.errorNext ? {ok:false,error:__testAuth.errorNext} : {ok:true,token:'unit-test-only'});
            __testAuth.errorNext = null;
          }; });
        }
        return{ok:true,token:'unit-test-only'};
      }
      if(message.type==='getJob')return{ok:true,job:null};
      throw new Error('No mutations allowed in this DOM smoke test');
    }},storage:{onChanged:{addListener(){}}}};
  globalThis.fetch=async input=>{
    const url=new URL(input);
    if(url.origin!=='https://www.googleapis.com')throw new Error('External request blocked');
    if(url.pathname.endsWith('/about'))return Response.json({user:{emailAddress:settings.account}});
    if(url.pathname.endsWith('/files')) {
      const rows=url.searchParams.get('q')?.includes(' in parents')
        ? __testFiles.filter(file=>file.parents?.includes(settings.folderId)):__testFiles;
      return Response.json({files:rows});
    }
    const id=url.pathname.split('/').at(-1);
    if(id===settings.folderId)return Response.json({id,name:'Test folder',mimeType:'application/vnd.google-apps.folder',trashed:false});
    const file=__testFiles.find(file=>file.id===id);
    if(!file)return new Response('',{status:404});
    return url.searchParams.get('alt')==='media'?new Response(file.content):Response.json(file);
  };
  globalThis.__personalRendered=false;
  new MutationObserver(()=>{
    if(document.body?.textContent.includes('PRIVATE FILENAME'))globalThis.__personalRendered=true;
  }).observe(document,{childList:true,subtree:true});
}

test('real popup preserves hidden selection and validates approval without dispatching', {timeout:30000}, async()=>{
  const server=createServer(async(req,res)=>{
    const filename=req.url.split('?')[0];
    if(!/^\/(popup\.(html|js|css)|lib\.js|auth-config\.js|icons\/[a-zA-Z0-9._-]+)$/.test(filename)){res.writeHead(404);res.end();return;}
    try{
      const file=await readFile(path.join(tools,'..','extension',filename.slice(1)));
      res.setHeader('Content-Type',filename.endsWith('.html')?'text/html':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'image/png');res.end(file);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=await mkdtemp(path.join(tools,'.local','dom-smoke-'));
  const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','about:blank'],{stdio:'ignore'});
  let cdp;
  try{
    let lines;
    for(let i=0;i<75;i++){
      try{lines=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break;}catch{await delay(100);}
    }
    assert.ok(lines,'Chrome started');
    cdp=await CDP.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    const {targetInfos}=await cdp.call('Target.getTargets');
    const page=targetInfos.find(target=>target.type==='page');
    const session=await cdp.attach(page.targetId);
    await cdp.call('Page.enable',{},session);
    await cdp.call('Network.enable',{},session);
    await cdp.call('Network.setBlockedURLs',{urls:['https://*']},session);
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:
      `(${browserStubs.toString()})(${JSON.stringify({folderId,account,expected})});\n${recorderGuardSource({folderId,account,expected})}`},session);
    await cdp.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/popup.html`},session);
    const evaluate=expression=>cdp.evaluate(session,expression);
    for(let i=0;i<75;i++){
      if(await evaluate(`Boolean(globalThis.__fixtureRecorder) && document.querySelector('#accountEmail').textContent === '${account}'`))break;
      await delay(100);
    }
    assert.equal(await evaluate(`document.querySelector('#accountEmail').textContent`),account);
    assert.equal(await evaluate(`document.querySelectorAll('#fileList li').length`),0,'Unvalidated inventory is never displayed');
    const sequence = (await evaluate('__fixtureRecorder.authStatus()')).sequence;
    await evaluate(`__testAuth.delayNext=true;document.querySelector('#switchAccountBtn').click()`);
    for (let i=0;i<50;i++) {
      if (await evaluate('__testAuth.pending')) break;
      await delay(20);
    }
    assert.equal(await evaluate(`document.querySelector('#appBody').classList.contains('hidden')`),false,'Old connected view stays visible during sign-in');
    // This reproduces the original recorder failure in the actual popup flow.
    await assert.rejects(evaluate('__fixtureRecorder.identify()'), /sign-in is in progress/);
    let probed = false;
    const ready = waitForAuthentication(()=>evaluate('__fixtureRecorder.authStatus()'),async()=>{
      probed = true;
      return evaluate('__fixtureRecorder.authReady()');
    },{afterSequence:sequence,timeout:5000,interval:20});
    await delay(100);
    assert.equal(probed,false);
    await evaluate('__testAuth.finish()');
    assert.equal(await ready,true);
    await evaluate('globalThis.__fixtureRecorder.identify()');
    await evaluate(`globalThis.__testFiles[0].id='replacement_id_0'`);
    await assert.rejects(evaluate('__fixtureRecorder.identify()'), /ID changed/);
    await evaluate(`globalThis.__testFiles[0].id='fixture_id_0'`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#fileList li')].map(row=>row.dataset.recorderFileId)`),['fixture_id_0','fixture_id_1']);
    assert.equal(await evaluate('globalThis.__personalRendered'),false);
    await evaluate(`document.querySelector('#refreshBtn').click()`);
    await delay(100);
    assert.equal(await evaluate('globalThis.__personalRendered'),false);
    assert.equal(await evaluate(`document.querySelectorAll('#fileList li').length`),2);
    await evaluate(`document.querySelector('#fileList li[data-recorder-file-id="fixture_id_0"] input').click()`);
    await evaluate(`document.querySelector('#filterTypeSelect').value='pdf';document.querySelector('#filterTypeSelect').dispatchEvent(new Event('change'))`);
    await evaluate(`document.querySelector('#reviewSelectedBtn').click()`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#reviewList .file-name')].map(row=>row.textContent)`),[expected[0].name]);
    await evaluate('globalThis.__fixtureRecorder.verify()');
    await evaluate(`document.querySelector('#reviewTrashBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#confirmOkBtn').disabled`),true);
    await evaluate(`document.querySelector('#confirmOkBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#confirmOverlay').classList.contains('hidden')`),false,'Premature click cannot close confirmation or dispatch');
    assert.equal(await evaluate('__fixtureRecorder.snapshot().failed'),false);
    const approval = await evaluate('__fixtureRecorder.approve()');
    assert.deepEqual(approval.selected,[{id:'fixture_id_0',name:expected[0].name}]);
    assert.deepEqual(approval.visible,[],'PDF filter hides the selected TXT but does not block approval');
    assert.equal(approval.permitted,true);
    assert.equal(await evaluate(`document.querySelector('#confirmOkBtn').disabled`),false);
    await evaluate(`globalThis.__testFiles[0].trashed=true`);
    assert.deepEqual(await evaluate('__fixtureRecorder.trashStatus()'), {
      id:'fixture_id_0',name:expected[0].name,trashed:true,
      keep:{id:'fixture_id_1',name:expected[1].name,trashed:false,contentUnchanged:true},
    });
    await evaluate(`globalThis.__testFiles[0].trashed=false`);
    await evaluate(`globalThis.__testFiles[0].parents=['outside_folder']`);
    await assert.rejects(evaluate('globalThis.__fixtureRecorder.verify()'));
    assert.equal(await evaluate('globalThis.__personalRendered'),false);
    for (const scenario of ['confirmation', 'selection']) {
      await cdp.call('Page.reload',{},session);
      for(let i=0;i<75;i++) {
        if(await evaluate(`Boolean(globalThis.__fixtureRecorder) && document.querySelector('#accountEmail').textContent === '${account}'`))break;
        await delay(100);
      }
      await evaluate('__fixtureRecorder.identify()');
      await evaluate(`document.querySelector('#fileList li[data-recorder-file-id="fixture_id_0"] input').click();document.querySelector('#reviewSelectedBtn').click();document.querySelector('#reviewTrashBtn').click()`);
      if (scenario === 'confirmation') await evaluate(`document.querySelector('#confirmText').textContent='Account: wrong. 2 items will be moved to Trash.'`);
      else await evaluate(`state.selectedIds.clear();state.selectedIds.add('fixture_id_1')`);
      await assert.rejects(evaluate('__fixtureRecorder.approve()'), scenario === 'confirmation' ? /confirmation must show/ : /actual selection must be/);
      const failure = await evaluate('__fixtureRecorder.snapshot()');
      assert.equal(failure.permitted,false);
      assert.equal(failure.failed,true);
      assert.equal(await evaluate(`document.querySelector('#confirmOkBtn').disabled`),true);
      if(scenario === 'confirmation') assert.equal(failure.failure.actual.textMatches,false);
      else assert.equal(failure.failure.actual.selected[0].role,'keep');
    }
  } finally {
    if(cdp){await cdp.call('Browser.close').catch(()=>{});cdp.socket.close();}else child.kill('SIGTERM');
    await new Promise(resolve=>server.close(resolve));
  }
});
