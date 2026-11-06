import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { srt, CDP, diagnosticError } from './support.mjs';
import { parseFolderId, validateFixture, validateFixtures, authorizeTrash, createFixtureApi } from './fixture-safety.mjs';
import { recorderGuardSource, workerGuardSource, diagnosticReadOnlyGuard } from './browser-guard.mjs';

const folderId = 'test_folder_12345';
const account = 'owner@example.com';
const expected = [
  { role: 'review', name: 'generated-review.txt', content: 'Unique disposable review bytes.\n' },
  { role: 'keep', name: 'generated-keep.txt', content: 'Unique disposable keep bytes.\n' },
];
function fixtureStore() {
  return new Map([
    [folderId, { id: folderId, name: 'Test folder', mimeType: 'application/vnd.google-apps.folder', trashed: false }],
    ...expected.map((file, i) => [`fixture_id_${i}`, { id: `fixture_id_${i}`, name: file.name,
      parents: [folderId], ownedByMe: true, mimeType: 'text/plain', trashed: false,
      size: String(new TextEncoder().encode(file.content).length), content: file.content }]),
  ]);
}
function mockApi(store) {
  return {
    async metadata(id) { return structuredClone(store.get(id) || {}); },
    async children(id) { return [...store.values()].filter(file => file.parents?.includes(id) && !file.trashed).map(file => structuredClone(file)); },
    async content(id) { return new TextEncoder().encode(store.get(id)?.content || ''); },
  };
}
async function setup() {
  const store = fixtureStore();
  const api = mockApi(store);
  const pins = await validateFixtures(api, folderId, expected);
  return { store, api, pins, options: { api, folderId, expected, pins,
    account, expectedAccount: account, targets: [{ id: pins[0].id, name: pins[0].name }] } };
}
async function mustBlock(options) {
  let dispatched = false;
  await assert.rejects(authorizeTrash(options, () => { dispatched = true; }));
  assert.equal(dispatched, false, 'Unsafe request reached the mutation dispatcher');
}

test('accepts only Drive folder URLs or strict IDs', () => {
  assert.equal(parseFolderId(`https://drive.google.com/drive/u/1/folders/${folderId}?usp=sharing`), folderId);
  assert.equal(parseFolderId(folderId), folderId);
  for (const input of ['https://evil.example/drive/folders/test_folder_12345', 'https://drive.google.com/file/d/test_folder_12345/view', "bad'id", '', 'https://drive.google.com.evil.example/drive/folders/test_folder_12345']) assert.throws(() => parseFolderId(input));
});
test('pins both exact IDs, names and parents, then allows only review fixture', async () => {
  const { options, pins } = await setup();
  assert.deepEqual(pins.map(file => file.id), ['fixture_id_0', 'fixture_id_1']);
  let dispatched = 0;
  await authorizeTrash(options, () => { dispatched++; });
  assert.equal(dispatched, 1);
  await mustBlock({ ...options, targets: [{ id: pins[1].id, name: pins[1].name }] });
});
test('unrelated IDs, duplicate selections, missing targets and wrong accounts never dispatch', async () => {
  const {options} = await setup();
  for (const targets of [[], [{id:'unrelated_file',name:expected[0].name}], [...options.targets,...options.targets], [{id:folderId,name:expected[0].name}], [{id:'fixture_id_0',name:'personal.txt'}]]) await mustBlock({...options, targets});
  await mustBlock({...options, account:'other@example.com'});
});
test('duplicate names inside the test folder abort instead of choosing one', async () => {
  const {store, options} = await setup();
  store.set('duplicate_id', {...store.get('fixture_id_0'), id:'duplicate_id'});
  await mustBlock(options);
});
test('same-name file outside the folder can never replace the pinned file', async () => {
  const {store, options} = await setup();
  store.set('outside_id', {...store.get('fixture_id_0'), id:'outside_id', parents:['other_folder_12345']});
  await mustBlock({...options, targets:[{id:'outside_id',name:expected[0].name}]});
  store.get('fixture_id_0').parents=['other_folder_12345'];
  await mustBlock(options);
});
test('renamed, replaced, trashed, non-owned, folder and changed-content fixtures abort', async () => {
  for (const change of [
    file => { file.name='renamed.txt'; }, file => { file.trashed=true; },
    file => { file.ownedByMe=false; }, file => { file.mimeType='application/vnd.google-apps.folder'; },
    file => { file.content='X'.repeat(file.content.length); }, file => { file.size='999'; },
  ]) {
    const {store,options}=await setup(); change(store.get('fixture_id_0')); await mustBlock(options);
  }
  const {store,options}=await setup();
  const original=store.get('fixture_id_0'); store.delete('fixture_id_0');
  store.set('replacement_id',{...original,id:'replacement_id'});
  await mustBlock(options);
});
test('both fixtures must still be valid immediately before dispatch', async () => {
  const {store,options}=await setup();
  store.delete('fixture_id_1');
  await mustBlock(options);
});
test('post-Trash evidence requires the pinned review trashed and the keep fixture unchanged', async () => {
  const {store,api,pins} = await setup();
  store.get(pins[0].id).trashed = true;
  await validateFixture(api,folderId,expected[0],pins[0].id,true);
  await validateFixture(api,folderId,expected[1],pins[1].id,false);
  store.get(pins[1].id).content = 'X'.repeat(expected[1].content.length);
  await assert.rejects(validateFixture(api,folderId,expected[1],pins[1].id,false), /content/);
  store.get(pins[1].id).content = expected[1].content;
  store.get(pins[1].id).trashed = true;
  await assert.rejects(validateFixture(api,folderId,expected[1],pins[1].id,false), /metadata/);
});
test('pagination is folder-scoped and bounded content reads reject excess bytes', async () => {
  const requests=[];
  const api=createFixtureApi(async()=> 'unit-test-only', async(url,options)=>{
    assert.equal(options.method,'GET'); requests.push(new URL(url));
    if(url.includes('alt=media')) return new Response('too long');
    return Response.json(requests.length===1 ? {files:[{id:'a'}],nextPageToken:'second'} : {files:[{id:'b'}]});
  });
  assert.deepEqual((await api.children(folderId)).map(file=>file.id),['a','b']);
  for(const url of requests) assert.equal(url.searchParams.get('q'),`'${folderId}' in parents and trashed = false`);
  assert.equal(requests[1].searchParams.get('pageToken'),'second');
  await assert.rejects(api.content('fixture_id_0',3),/exceeds/);
});

function fakeFetch(store, mutations) {
  return async (input, options={}) => {
    const url=new URL(typeof input==='string'?input:input.url);
    if((options.method||'GET')!=='GET') { mutations.push({input,options}); return Response.json({id:'fixture_id_0',trashed:true}); }
    if(url.pathname.endsWith('/about')) return Response.json({user:{emailAddress:account}});
    if(url.pathname.endsWith('/files')) return Response.json({files:await mockApi(store).children(folderId)});
    const id=decodeURIComponent(url.pathname.split('/').at(-1));
    if(url.searchParams.get('alt')==='media') return new Response(store.get(id)?.content||'');
    return Response.json(await mockApi(store).metadata(id));
  };
}
function context(settings, store) {
  return { settings, console, URL, URLSearchParams, Response, TextEncoder, Uint8Array, AbortSignal,
    fetch: fakeFetch(store, []), getAuthToken: async()=> 'unit-test-only',
    connect: async()=>{}, accountConnectionPending:false };
}
test('actual worker guard blocks unrelated PATCH, DELETE, folders and metadata changes', async () => {
  const {store,pins}=await setup();
  const mutations=[];
  const ctx=vm.createContext({...context({},store),fetch:fakeFetch(store,mutations)});
  vm.runInContext(workerGuardSource({folderId,account,expected,pins}),ctx);
  for (const id of ['unrelated_id', folderId]) await assert.rejects(ctx.fetch(`https://www.googleapis.com/drive/v3/files/${id}`,{method:'PATCH',body:'{"trashed":true}'}));
  await assert.rejects(ctx.fetch('https://www.googleapis.com/drive/v3/files/fixture_id_0',{method:'DELETE'}));
  await assert.rejects(ctx.fetch('https://www.googleapis.com/drive/v3/files/fixture_id_0',{method:'PATCH',body:'{"trashed":true,"name":"other"}'}));
  store.get('fixture_id_0').parents=['outside_folder_12345'];
  await assert.rejects(ctx.fetch('https://www.googleapis.com/drive/v3/files/fixture_id_0',{method:'PATCH',body:'{"trashed":true}'}));
  assert.equal(mutations.length,0);
});
test('actual worker guard revalidates bytes for every retry/dispatch', async () => {
  const {store,pins}=await setup(); const mutations=[];
  const ctx=vm.createContext({...context({},store),fetch:fakeFetch(store,mutations)});
  vm.runInContext(`(${diagnosticReadOnlyGuard.toString()})()`, ctx);
  assert.throws(()=>ctx.fetch('https://www.googleapis.com/drive/v3/files/fixture_id_0',{method:'PATCH',body:'{"trashed":true}'}), /blocks Drive writes/);
  ctx.__diagnosticRestoreFetch();
  vm.runInContext(workerGuardSource({folderId,account,expected,pins}),ctx);
  const url='https://www.googleapis.com/drive/v3/files/fixture_id_0';
  await ctx.fetch(url,{method:'PATCH',body:'{"trashed":true}'});
  assert.equal(mutations.length,1);
  store.get('fixture_id_0').content='X'.repeat(expected[0].content.length);
  await assert.rejects(ctx.fetch(url,{method:'PATCH',body:'{"trashed":true}'}));
  assert.equal(mutations.length,1);
  ctx.__fixtureWorkerGuard.restore();
});
test('recording view exposes no personal rows before/after fixture identification', async () => {
  const {store}=await setup();
  store.set('personal_id',{id:'personal_id',name:'personal finances.txt',parents:['other_folder_12345']});
  let ready;
  const makeNode=()=>({style:{},dataset:{},classList:{add(){},contains:()=>true},replaceChildren(){},remove(){},textContent:''});
  const doc={documentElement:{append(){}},body:{prepend(){}},createElement:makeNode,querySelector:makeNode,
    addEventListener(event,callback){if(event==='DOMContentLoaded')ready=callback;}};
  const all=[...store.values()];
  const ctx=vm.createContext({...context({},store),document:doc,MutationObserver:class{observe(){} disconnect(){}},
    state:{email:account,selectedIds:new Set(),filesById:store},
    getFilteredFiles:()=>all,sendMessage:async()=>({ok:true}),renderJob:()=>{},
    buildFileRow:()=>makeNode(),renderFileList:()=>{},fetchAccountEmail:async()=>account,
  });
  vm.runInContext(recorderGuardSource({folderId,account,expected}),ctx); ready();
  assert.equal(ctx.getFilteredFiles().length,0);
  await ctx.__fixtureRecorder.identify();
  assert.deepEqual(Array.from(ctx.getFilteredFiles(),file=>file.id),['fixture_id_0','fixture_id_1']);
  assert.throws(()=>ctx.buildFileRow(store.get('personal_id'),{}));
  assert.equal(ctx.__fixtureRecorder.snapshot().failed,true);
});
test('an unapproved startJob retains its first specific failure through approve', async () => {
  const {store}=await setup();
  let ready, forwarded = 0;
  const nodes = new Map();
  const node = () => ({style:{},dataset:{},classList:{add(){},contains:()=>true},replaceChildren(){},remove(){},textContent:''});
  const doc = {documentElement:{append(){}},body:{prepend(){}},createElement:node,
    querySelector(selector) { if(!nodes.has(selector)) nodes.set(selector,node()); return nodes.get(selector); },
    addEventListener(event,callback) { if(event==='DOMContentLoaded') ready=callback; }};
  const ctx = vm.createContext({...context({},store),document:doc,MutationObserver:class{observe(){} disconnect(){}},
    state:{email:account,selectedIds:new Set(['fixture_id_0']),filesById:store},
    getFilteredFiles:()=>[...store.values()],sendMessage:async()=>{forwarded++;return {ok:true};},
    renderJob(){},buildFileRow:node,renderFileList(){},fetchAccountEmail:async()=>account,
  });
  vm.runInContext(recorderGuardSource({folderId,account,expected}),ctx);ready();
  await ctx.__fixtureRecorder.identify();
  let first;
  await assert.rejects(ctx.sendMessage({type:'startJob',account,items:[{id:'fixture_id_0',name:expected[0].name}]}), error=>{
    first=error; assert.match(error.message,/startJob requires prior recorder approval/); return true;
  });
  await assert.rejects(ctx.__fixtureRecorder.approve(), error=>error===first);
  assert.equal(forwarded,0);
  const snapshot=ctx.__fixtureRecorder.snapshot();
  assert.equal(snapshot.failure.expected.permitted,true);
  assert.equal(snapshot.failure.actual.permitted,false);
  assert.equal(snapshot.failure.actual.selected[0].role,'review');
});
test('captions retain timing across minutes and hours', () => {
  assert.equal(srt([{start:59.125,end:3601.5,text:'Real consent stays intact.'}]),
    '1\n00:00:59,125 --> 01:00:01,500\nReal consent stays intact.\n');
});

test('CDP preserves the failing operation and sanitized browser exception stack', async () => {
  const listeners = {};
  const socket = {
    addEventListener(name, listener) { listeners[name] = listener; },
    send(data) {
      const {id} = JSON.parse(data);
      queueMicrotask(() => listeners.message({data:JSON.stringify({id,result:{exceptionDetails:{
        text:'Uncaught (in promise)',
        exception:{description:'Error: Fixture validation read failed (403).\n    at get (popup.html:4:5)'},
        stackTrace:{callFrames:[{functionName:'get',url:'chrome-extension://test/popup.html',lineNumber:3,columnNumber:4}]},
      }}})}));
    },
  };
  const cdp = new CDP(socket);
  await assert.rejects(cdp.evaluate('session', 'private expression', 'fixture identification'), error => {
    const saved = diagnosticError(error);
    assert.equal(saved.operation, 'fixture identification');
    assert.match(saved.message, /read failed \(403\)/);
    assert.match(saved.browserStack, /at get/);
    assert.match(saved.stack, /CDP.evaluate/);
    assert.ok(!JSON.stringify(saved).includes('private expression'));
    return true;
  });
});

test('diagnostics remove credential text, private URLs and account identity', () => {
  const secret = 'ya29.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const error = new Error(`Bearer ${secret} access_token=${secret} state=private-state code=private-code owner@example.com https://example.com/callback?code=secret&state=private`);
  error.browserStack = `at callback (https://example.com/?access_token=${secret}:1:2)`;
  const saved = JSON.stringify(diagnosticError(error));
  for (const value of [secret, 'private-state', 'private-code', 'owner@example.com', 'https://example.com']) assert.ok(!saved.includes(value));
});

test('read-only diagnostics block Drive mutations before dispatch and restore fetch', async () => {
  const requests = [];
  const fetch = async (...args) => { requests.push(args); return Response.json({}); };
  const ctx = vm.createContext({URL, fetch});
  vm.runInContext(`(${diagnosticReadOnlyGuard.toString()})()`, ctx);
  await ctx.fetch('https://www.googleapis.com/drive/v3/files/test');
  for (const method of ['PATCH', 'POST', 'DELETE', 'PUT']) {
    assert.throws(() => ctx.fetch('https://www.googleapis.com/drive/v3/files/test', {method}), /blocks Drive writes/);
    assert.throws(() => ctx.fetch({url:'https://www.googleapis.com/drive/v3/files/test', method}), /blocks Drive writes/);
  }
  assert.equal(requests.length, 1);
  ctx.__diagnosticRestoreFetch();
  assert.equal(ctx.fetch, fetch);
});
