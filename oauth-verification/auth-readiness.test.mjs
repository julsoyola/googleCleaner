import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeAuthentication, waitForAuthentication } from './auth-readiness.mjs';

function app() {
  let resolve, reject;
  const auth = new Promise((yes, no) => { resolve = yes; reject = no; });
  const ctx = vm.createContext({
    document:{querySelector:()=>({classList:{contains:()=>true}})},
    state:{token:'previous-session',email:'owner@example.com'},
    accountConnectionPending:false,
    getAuthToken: async interactive => interactive ? auth : ctx.state.token,
    fetchAccountEmail:async()=>ctx.state.email,
    requireSafe(condition, message) { if (!condition) throw new Error(message); },
  });
  // Mirrors the real app's retained old view and caught UI errors.
  vm.runInContext(`async function connect() {
    accountConnectionPending = true;
    try { state.token = await getAuthToken(true); } catch (_) {}
    finally { accountConnectionPending = false; }
  }`, ctx);
  const observer = vm.runInContext(`(${observeAuthentication.toString()})()`, ctx);
  return {ctx, observer, resolve, reject};
}

test('old connected state cannot pass while a new sign-in is delayed', async () => {
  const {ctx,observer,resolve} = app();
  const baseline = observer.status().sequence;
  const connection = ctx.connect();
  assert.equal(observer.status().pending,true);
  assert.equal(ctx.state.token,'previous-session');
  let probes = 0;
  const ready = waitForAuthentication(()=>observer.status(), async()=>{
    probes++;
    return observer.ready('owner@example.com');
  },{afterSequence:baseline,interval:1});
  await new Promise(done=>setTimeout(done,20));
  assert.equal(probes,0);
  resolve('new-session');
  await connection;
  assert.equal(await ready,true);
  assert.equal(probes,1);
});

for (const message of ['User canceled sign-in', 'Google sign-in response did not match this request.', 'Google could not authorize this session.']) {
  test(`readiness preserves ${message}`, async () => {
    const {ctx,observer,reject} = app();
    const connection = ctx.connect();
    reject(new Error(message));
    await connection;
    // The old session still exists, but must never count as this success.
    assert.equal(ctx.state.token,'previous-session');
    await assert.rejects(waitForAuthentication(()=>observer.status(),()=>observer.ready('owner@example.com'),{afterSequence:0}), error=>error.message===message);
  });
}

test('readiness timeout is bounded and never probes the previous session', async () => {
  let clock = 0, probes = 0;
  await assert.rejects(waitForAuthentication(
    async()=>({sequence:2,phase:'pending',pending:true}),
    async()=>{ probes++; },
    {afterSequence:1,timeout:10,interval:2,now:()=>clock,sleep:async ms=>{clock+=ms;}},
  ), /readiness timed out/);
  assert.equal(clock,10);
  assert.equal(probes,0);
});

test('same-session readiness rejects wrong account and different app token', async () => {
  const {ctx,observer,resolve} = app();
  const connection = ctx.connect(); resolve('new-session'); await connection;
  await assert.rejects(observer.ready('other@example.com'), /account mismatch/);
  ctx.getAuthToken = async()=> 'different-session';
  await assert.rejects(observer.ready('owner@example.com'), /different authenticated sessions/);
});
