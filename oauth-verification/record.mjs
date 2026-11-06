import {beginRun,finishRun,retentionCLI,freshExportPath,failedCleanupCommand} from './retention.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFile, readdir, writeFile, mkdir, access, cp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { waitForAuthentication } from './auth-readiness.mjs';
import { parseFolderId, validateSelection } from './fixture-safety.mjs';
import { recorderGuardSource, workerGuardSource, diagnosticReadOnlyGuard } from './browser-guard.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { audit, assert, CDP, delay, diagnosticError, EXTENSION_ID, exportVideo } from './support.mjs';

let activeRun;
async function main() {
const tools = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(tools);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const native = process.argv.includes('--native');
const args = process.argv.slice(2);
if (await retentionCLI({root:path.join(tools,'.local'),workflow:'oauth',args})) process.exit(process.exitCode || 0);
const options = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  assert(['--check', '--native', '--diagnose-run', '--resume-run', '--keep-intermediates'].includes(arg) && !options[arg], 'Unknown or duplicate recorder option.');
  if (arg.endsWith('-run')) {
    const value = args[++index];
    assert(value && !value.startsWith('--'), `${arg} requires a run directory.`);
    options[arg] = value;
  } else options[arg] = true;
}
const diagnoseRun = options['--diagnose-run'];
const resumeRun = options['--resume-run'];
const reuseRun = diagnoseRun || resumeRun;
assert(!(diagnoseRun && resumeRun) && !(reuseRun && (native || options['--check'])), 'Use one primary resume/diagnostic mode at a time.');
let previousContext = {};
if (reuseRun) {
  try { previousContext = JSON.parse(await readFile(path.resolve(reuseRun, 'context.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const config = await audit(root);
if (process.argv.includes('--check')) {
  await access(chrome);
  console.log(JSON.stringify(config, null, 2));
  console.log('Static/live-public-config check only. No OAuth or recording performed.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(tools, '.local', stamp);
const outputRoot = path.join(tools, '.local');
await beginRun({root:outputRoot,directory,workflow:'oauth',keepIntermediates:!!options['--keep-intermediates'],dependencies:reuseRun?[path.resolve(reuseRun)]:[]});
activeRun = {root:outputRoot,directory,workflow:'oauth'};
const temporary = path.join(directory, 'temp');
const output = freshExportPath(path.join(os.homedir(), 'Downloads'), native ? 'GooSweep-OAuth-Native-Fallback.mp4' : 'GooSweep-OAuth-Demo.mp4', stamp);
if (!diagnoseRun) {
  try { await access(output); throw new Error(`Output already exists. Move it before recording: ${output}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await access(chrome);
await access(path.dirname(output));
if (!diagnoseRun) {
  console.log('Preparing offline captions (first run may take a moment)...');
  await import('./support.mjs').then(({ run }) => run('swiftc', [path.join(tools, 'captions.swift'), '-o', `${temporary}/caption-renderer`]));
}
let extension = path.join(root, 'extension');
if (native) {
  // An ignored staging copy only. Production sources/configuration stay intact.
  extension = path.join(directory, 'native-extension');
  await cp(path.join(root, 'extension'), extension, {
    recursive: true, filter: source => !['key.pem', '.DS_Store', 'tests'].includes(path.basename(source)),
  });
  await writeFile(path.join(extension, 'auth-config.js'), '"use strict";\nglobalThis.GC_AUTH_CONFIG = {authOrigin: ""};\n');
}
const fixtures = path.join(directory, 'fixtures');
await mkdir(fixtures);
let prefix = `GooSweep-demo-${stamp.slice(0, 19)}`;
const disposable = `${prefix}-review.txt`;
const keep = `${prefix}-keep.txt`;
let expectedFixtures = [
  { role: 'review', name: disposable, content: `Disposable OAuth verification example. Run: ${stamp}. Move only this file to Trash.\n` },
  { role: 'keep', name: keep, content: `Disposable verification example. Run: ${stamp}. Keep this file in the test folder.\n` },
];
const fixtureDirectory = reuseRun ? previousContext.fixtureDirectory || path.resolve(reuseRun, 'fixtures') : fixtures;
if (reuseRun) {
  const original = fixtureDirectory;
  const names = (await readdir(original)).filter(name => name.endsWith('.txt'));
  assert(names.length === 2 && names.some(name => name.endsWith('-review.txt'))
    && names.some(name => name.endsWith('-keep.txt')), 'Original fixture pair not found.');
  expectedFixtures = await Promise.all(names.map(async name => ({
    role: name.endsWith('-review.txt') ? 'review' : 'keep', name,
    content: await readFile(path.join(original, name), 'utf8'),
  })));
  prefix = expectedFixtures.find(file => file.role === 'review').name.replace(/-review\.txt$/, '');
} else {
  for (const file of expectedFixtures) await writeFile(path.join(fixtures, file.name), file.content);
}
let previousPins = null;
if (reuseRun) {
  try {
    previousPins = JSON.parse(await readFile(path.resolve(reuseRun, 'fixtures.json'), 'utf8')).files;
    assert(Array.isArray(previousPins) && previousPins.length === 2, 'Saved fixture pins are incomplete.');
    for (const file of expectedFixtures) {
      const pin = previousPins.find(pin => pin.role === file.role);
      assert(pin?.name === file.name && pin.parentId === parseFolderId(pin.parentId)
        && pin.sha256 === createHash('sha256').update(file.content).digest('hex'), 'Saved fixture pins differ from the original local files.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const controller = new AbortController();
process.on('SIGINT', () => { controller.abort(); rl.close(); });
const ask = question => rl.question(`\n${question}\n> `, { signal: controller.signal });
const confirm = async question => assert((await ask(`${question} Type YES.`)).trim() === 'YES', 'Stopped at manual checkpoint.');
let browser, cdp, recorder, recordingStarted, ended = false;
const captions = [];
const checks = {
  mode: native ? 'native-fallback-staging-copy' : 'configured-web-client-local-extension',
  publicConfiguration: config, productionModified: false,
  brandingMismatch: 'GoogleCleaner extension uses OAuth app GooSweep; resolve before submission.',
  consentEnglish: 'NOT VERIFIED', fullConsentAndWarning: 'NOT VERIFIED',
  driveTrashConfirmed: 'NOT VERIFIED', privacyReview: 'NOT VERIFIED',
  observedAuthorizations: [],
  otherImplementation: native ? 'Configured web flow requires the primary recording.' : 'Inactive native fallback requires --native if included in review.',
};
let session, workerSession, workerTargetId, appTarget, authorizationPhase = null, folderId, pins, workerLost = false;
const now = () => recordingStarted ? (performance.now() - recordingStarted) / 1000 : 0;
function caption(text) {
  if (!recordingStarted) { console.log(`\n${text}`); return; }
  if (captions.length) captions.at(-1).end = now();
  captions.push({ start: captions.length ? now() : 0, text });
  console.log(`\n${text}`);
}
const evalApp = (expression, operation, timeout) => cdp.evaluate(session, expression, operation, timeout);
const click = selector => {
  assert(!workerLost, 'The guarded worker stopped; no further recording actions are allowed.');
  return evalApp(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node || node.disabled || !node.getClientRects().length) throw new Error('Control unavailable');
  node.click(); return true;
})()`, `click ${selector}`);
};
const set = (selector, value, event = 'change') => evalApp(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node || !node.getClientRects().length) throw new Error('Control unavailable');
  node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); return true;
})()`, `set ${selector}`);
const text = selector => evalApp(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`, `read text ${selector}`);
async function waitFor(expression, message, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evalApp(expression)) return;
    await delay(300);
  }
  throw new Error(message);
}
async function foreground() {
  await cdp.call('Target.activateTarget', { targetId: appTarget });
}
let failureNumber = 0;
async function saveFailure(error, operation) {
  const diagnostic = diagnosticError(error, error.operation || operation);
  await writeFile(`${directory}/diagnostic-attempt-${++failureNumber}.json`, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
  console.error(`Stopped ${diagnostic.operation}: ${diagnostic.message}`);
  return diagnostic;
}
async function triggerAuthentication() {
  const available = await evalApp(`document.querySelector('#connectBtn').getClientRects().length > 0`);
  if (available) await click('#connectBtn');
  else { await click('#accountMenuBtn'); await click('#switchAccountBtn'); }
}
async function consent(label, action = triggerAuthentication) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await waitFor(`!globalThis.__fixtureRecorder.authStatus().pending`, 'The app is still signing in; finish or cancel that attempt before retrying.', 45000);
      const before = await evalApp('globalThis.__fixtureRecorder.authStatus()', 'authentication status before UI action');
      caption(native ? `${label}: the real Chrome identity fallback. Complete the real Google screens manually.`
        : `${label}: GoogleCleaner connects through the OAuth app GooSweep. Complete the real Google screens manually.`);
      authorizationPhase = label;
      await action();
      console.log('MANUAL: Choose the expected account. Use English.');
      if (recordingStarted) {
        console.log('Show the real unverified warning and expand every permission.');
        console.log('Hold each screen for at least 4 seconds. Do not enter a password during capture.');
      }
      await waitForAuthentication(
        () => evalApp('globalThis.__fixtureRecorder.authStatus()', 'wait for real app authentication'),
        () => evalApp('globalThis.__fixtureRecorder.authReady()', 'same-session Drive about readiness', 45000),
        { afterSequence: before.sequence },
      );
      checks.authenticationReadiness = 'PASS: real UI operation completed; same-session Drive about succeeded';
      await foreground();
      if (recordingStarted) await confirm('Was the entire English warning and consent sequence readable?');
      for (const entry of checks.observedAuthorizations) {
        assert(entry.clientId === (native ? config.nativeFallbackClientId : config.activeClientId)
          && JSON.stringify([...entry.scopes].sort()) === JSON.stringify([config.scope]),
        'Observed authorization client/scopes differ from the audited configuration.');
      }
      authorizationPhase = null;
      return;
    } catch (error) {
      authorizationPhase = null;
      await saveFailure(error, 'authentication readiness');
      if (workerLost || attempt === 1) throw error;
      const answer = await ask('Finish or cancel any open Google window. Type RETRY for one new UI sign-in attempt, or STOP. Setup and fixtures are preserved.');
      if (answer.trim() !== 'RETRY') throw error;
    }
  }
}
async function identifyFixtures() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await evalApp('globalThis.__fixtureRecorder.authReady()', 'same-session Drive about before fixture reads', 45000);
      const presence = await evalApp('globalThis.__fixtureRecorder.fixturePresence()', 'exact fixture names in test folder', 45000);
      await writeFile(`${directory}/preflight.json`, JSON.stringify({
        authentication: 'PASS', folderAccessible: true,
        fixtures: presence.map(fixture => ({...fixture,
          localPath: path.join(fixtureDirectory, expectedFixtures.find(file => file.role === fixture.role).name),
        })),
      }, null, 2), {mode:0o600});
      const invalid = presence.filter(fixture => fixture.count !== 1);
      for (const fixture of presence) {
        if (fixture.count !== 1) {
          const file = expectedFixtures.find(file => file.role === fixture.role);
          console.error(`${fixture.role}: ${fixture.count === 0 ? 'missing' : 'duplicate names'} in the selected folder. Local original:`);
          console.error(path.join(fixtureDirectory, file.name));
        }
      }
      if (invalid.length) {
        checks.readOnlyPreflight = 'INCOMPLETE: original fixture names missing or duplicated';
        throw Object.assign(new Error(invalid.map(file => `Expected exactly one ${file.role} fixture; found ${file.count}.`).join(' ')), {operation:'fixture presence'});
      }
      pins = await evalApp('globalThis.__fixtureRecorder.identify()', 'exact fixture metadata and bytes', 120000);
      assert(pins.length === 2, 'Both fixtures must validate.');
      checks.fixtures = pins.map(pin => ({ ...pin, sha256: createHash('sha256').update(expectedFixtures.find(file => file.role === pin.role).content).digest('hex') }));
      checks.testFolderId = folderId;
      await writeFile(`${directory}/fixtures.json`, JSON.stringify({folderId, files: checks.fixtures}, null, 2), {mode:0o600});
      checks.readOnlyPreflight = 'PASS: real account, folder, exact IDs, metadata and content';
      return;
    } catch (error) {
      await saveFailure(error, 'read-only fixture validation');
      if (workerLost || attempt === 1) throw error;
      if ((await ask('Type RETRY to repeat these reads once with the same fixtures, or STOP.')).trim() !== 'RETRY') throw error;
    }
  }
}
let expected;
async function stopRecorder() {
  if (!recorder || ended) return;
  recorder.stdin.write('q\n');
  await new Promise(resolve => {
    const timer = setTimeout(() => { recorder.kill('SIGINT'); }, 5000);
    recorder.once('exit', () => { clearTimeout(timer); resolve(); });
    if (ended) { clearTimeout(timer); resolve(); }
  });
}
async function record() {
try {
  expected = previousContext.account || (await ask('Enter the Google account email you will use (never a password):')).trim();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expected), 'An expected account email is required.');
  folderId = parseFolderId(previousContext.folderId || await ask('Enter the test folder Google Drive URL or ID:'));
  assert(!previousPins || previousPins.every(pin => pin.parentId === folderId), 'The selected folder differs from the saved fixture pins.');
  console.log('OAuth still grants account-wide Drive access. The recorder limits');
  console.log('its display and Trash actions to exact, validated disposable fixtures.');
  console.log('This is NOT a folder-scoped OAuth permission.');
  await confirm('Proceed with account-wide OAuth and fixture-only recorder safeguards, with no existing cleanup job running?');
  const profilePointer = path.join(tools, '.local', native ? 'native-profile-path.txt' : 'profile-path.txt');
  let defaultProfile = path.join(tools, '.local', native ? 'native-chrome-profile' : 'chrome-profile');
  try { defaultProfile = (await readFile(profilePointer, 'utf8')).trim(); }
  catch {
    const previous = (await readdir(path.join(tools, '.local'))).filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort().reverse();
    for (const name of previous) {
      const candidate = path.join(tools, '.local', name, 'chrome-profile');
      try { await access(candidate); defaultProfile = candidate; break; } catch { /* not a previous profile */ }
    }
  }
  const chosen = previousContext.profile || (await ask(`Chrome user-data folder (Enter reuses this existing recorder profile):\n${defaultProfile}`)).trim();
  const profile = path.resolve(chosen ? chosen.replace(/^~(?=\/)/, os.homedir()) : defaultProfile);
  assert(profile !== path.join(os.homedir(), 'Library/Application Support/Google/Chrome'),
    'Chrome cannot automate its normal default user-data folder. Reuse the existing recorder profile; your normal Chrome profile stays untouched.');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(profilePointer, profile + '\n');
  await writeFile(`${directory}/context.json`, JSON.stringify({account:expected, folderId, profile, fixtureDirectory}, null, 2), {mode:0o600});
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  browser = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--lang=en-US', '--no-first-run', '--no-default-browser-check', 'chrome://extensions/'],
  { stdio: 'ignore' });
  let browserError;
  browser.on('error', () => { browserError = true; });
  let debuggerUrl;
  for (let i = 0; i < 100; i++) {
    assert(!browserError, 'Could not launch isolated Chrome.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      debuggerUrl = (await response.json()).webSocketDebuggerUrl;
      if (debuggerUrl) break;
    } catch { /* Chrome is still starting. */ }
    await delay(200);
  }
  assert(debuggerUrl, 'Isolated Chrome did not start its local automation connection.');
  const debug = new URL(debuggerUrl);
  assert(debug.hostname === '127.0.0.1' && debug.port === String(port), 'Unexpected debugger endpoint.');
  cdp = await CDP.connect(debuggerUrl);
  // Retain public authorization parameters only, never full URLs or state/code.
  cdp.onEvent = event => {
    if (workerTargetId && event.method === 'Target.targetDestroyed' && event.params.targetId === workerTargetId) {
      workerLost = true;
      controller.abort(); rl.close();
    }
    if (!authorizationPhase) return;
    if (!['Target.targetCreated', 'Target.targetInfoChanged'].includes(event.method)) return;
    try {
      const url = new URL(event.params.targetInfo.url);
      if (url.hostname !== 'accounts.google.com' || !url.pathname.includes('oauth') || !url.searchParams.has('scope')) return;
      const entry = { entryPoint: authorizationPhase, clientId: url.searchParams.get('client_id'),
        scopes: url.searchParams.get('scope').split(/\s+/).filter(Boolean),
        redirectUri: url.searchParams.get('redirect_uri') };
      if (!checks.observedAuthorizations.some(row => JSON.stringify(row) === JSON.stringify(entry))) checks.observedAuthorizations.push(entry);
    } catch { /* Non-URL target; nothing to retain. */ }
  };
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  console.log('\nUsing the selected Chrome profile; no profile reset or copy.');
  console.log('If the local extension is already loaded, keep it. Otherwise:');
  console.log('Enable Developer mode, click Load unpacked, select:');
  console.log(extension);
  await confirm('Has the local extension loaded without errors?');
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  appTarget = targetId; session = await cdp.attach(targetId);
  await cdp.call('Page.enable', {}, session);
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: recorderGuardSource({ folderId, account: expected, expected: expectedFixtures, pins: previousPins }),
  }, session);
  await cdp.call('Page.navigate', { url: `chrome-extension://${EXTENSION_ID}/popup.html` }, session);
  await waitFor(`document.querySelector('#connectBtn') !== null`, 'Actual extension popup did not load. Check extension ID and unpacked folder.');
  const actualManifest = await evalApp('chrome.runtime.getManifest()');
  assert(await evalApp(`Boolean(globalThis.GC_AUTH_CONFIG?.authOrigin)`) === !native, 'Loaded extension uses the wrong auth mode; reload the printed unpacked folder without changing OAuth settings.');
  assert(actualManifest.name === 'GoogleCleaner' && JSON.stringify(actualManifest.oauth2.scopes) === JSON.stringify([config.scope]), 'Loaded extension does not match audited identity/scopes.');
  await waitFor(`Boolean(globalThis.__fixtureRecorder)`, 'Fixture-only recording guard did not load.');
  const existingJob = await evalApp(`sendMessage({type:'getJob'}).then(response => {
    if (!response?.ok) throw new Error('Job state unavailable');
    return response.job ? {status: response.job.status} : null;
  })`);
  assert(!existingJob || existingJob.status === 'done', 'An existing cleanup job is active or paused. Finish it outside this recorder first.');
  // Keep the worker alive while recording and prevent a second, unguarded
  // toolbar popup from exposing the full account inventory after consent.
  const {targetInfos} = await cdp.call('Target.getTargets');
  assert(!targetInfos.some(target => target.targetId !== appTarget && target.url === `chrome-extension://${EXTENSION_ID}/popup.html`),
    'Close other GoogleCleaner popup tabs before recording; only the guarded tab may display file listings.');
  const worker = targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${EXTENSION_ID}/background.js`);
  assert(worker, 'The real extension worker was not found.');
  workerTargetId = worker.targetId;
  workerSession = await cdp.attach(worker.targetId);
  await cdp.call('Debugger.enable', {}, workerSession);
  {
    // Block mutations before asking for consent, including accidental UI use.
    // Tokens and Google responses stay inside Chrome.
    const readOnly = `(${diagnosticReadOnlyGuard.toString()})()`;
    await cdp.evaluate(workerSession, readOnly, 'install diagnostic write block in worker');
    await evalApp(readOnly, 'install diagnostic write block in app');
  }
  await cdp.evaluate(workerSession, `(() => {
    if (globalThis.__recorderOriginalPopup) throw new Error('Another recorder is active');
    globalThis.__recorderOriginalPopup = chrome.action.openPopup;
    chrome.action.openPopup = async () => {};
    return true;
  })()`);
  await cdp.call('Target.createTarget', { url: `https://drive.google.com/drive/folders/${folderId}?hl=en` });
  console.log('\nBEFORE recording, sign into your expected Google account.');
  console.log(reuseRun ? 'Reuse the original uploaded fixture pair. Do not upload or change files.'
    : 'Open ONLY the selected test folder. Upload BOTH generated files there:');
  console.log(fixtureDirectory);
  console.log('Do not revoke access or reset your Chrome profile. Existing sessions');
  console.log('are preserved. The account chooser requests real consent again.');
  if (native) console.log('The native fallback needs the expected account signed into Chrome.');
  await confirm('Are you signed into the expected account, with both generated files inside the selected folder?');
  await foreground();
  // The configured web flow can explicitly re-consent after preflight.
  // The inactive native branch has no Switch account UI support.
  if (!native) {
    await consent('Read-only preflight authorization');
    await identifyFixtures();
  }
  if (diagnoseRun) {
    await writeFile(`${directory}/diagnostic.json`, JSON.stringify({result: checks.readOnlyPreflight}, null, 2), {mode:0o600});
    console.log(`Read-only preflight passed: ${directory}/diagnostic.json`);
    return;
  }
  if (!diagnoseRun) {
    console.log('\nMove Chrome onto the display you will capture. Enlarge the app');
    console.log('using Chrome zoom if needed. Keep the whole consent window visible.');
    console.log('Close unrelated windows, hide notifications, and keep Terminal off');
    console.log('the captured display when possible. This records the WHOLE display.');
    console.log('Captions are burned BELOW the screen after recording, never over Google.');
    const devices = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' }).stderr || '';
    const screens = [...devices.matchAll(/\[(\d+)\] (Capture screen \d+)/g)].map(match => ({ index: match[1], name: match[2] }));
    assert(screens.length, 'No screen capture device found. See README manual fallback.');
    for (const screen of screens) console.log(`${screen.index}: ${screen.name}`);
    const device = (await ask('Enter the screen device number above (camera/audio are never selected):')).trim();
    assert(screens.some(screen => screen.index === device), 'Choose a listed screen, not a camera.');
    console.log('macOS must allow Screen & System Audio Recording for your terminal.');
    console.log('If a permission dialog appears, cancel/restart after enabling it.');
    await confirm('Start whole-screen video now, with no credentials or unrelated private information visible?');
    const captureLog = createWriteStream(`${temporary}/capture.log`, { mode: 0o600 });
    recorder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'avfoundation',
      '-capture_cursor', '1', '-framerate', '15', '-i', `${device}:none`,
      '-vf', "scale=w='min(1920,iw)':h=-2", '-an', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-progress', 'pipe:1', `${temporary}/raw.mp4`], { stdio: ['pipe', 'pipe', 'pipe'] });
    recorder.stdin.on('error', () => { /* capture already stopped */ });
    recorder.stderr.pipe(captureLog);
    recorder.on('error', () => { ended = true; });
    recorder.on('exit', () => { ended = true; captureLog.end(); });
    await new Promise((resolve, reject) => {
      let progress = '';
      const timer = setTimeout(() => reject(new Error('Screen capture did not start. Enable macOS permission and rerun.')), 15000);
      recorder.stdout.on('data', data => {
        progress += data;
        if (/frame=\s*[1-9]/.test(progress)) { clearTimeout(timer); resolve(); }
      });
      recorder.once('exit', () => { clearTimeout(timer); reject(new Error('Screen capture failed. See private capture.log and README.')); });
    });
    recordingStarted = performance.now();
  }
  caption(native ? 'GoogleCleaner: supplemental recording of the native Chrome identity fallback using disposable Drive files.' : 'GoogleCleaner reviews owned Google Drive files and moves confirmed selections to Trash. Its OAuth app is named GooSweep.');
  await delay(6000);
  await consent('Authorize Google Drive');
  checks.consentEnglish = 'MANUALLY ATTESTED'; checks.fullConsentAndWarning = 'MANUALLY ATTESTED';
  assert(!ended, 'Screen capture stopped unexpectedly.');
  await identifyFixtures();
  caption('OAuth grants account-wide Drive access. This recording view shows only the two ID-, folder-, and content-validated fixtures.');
  await click('#refreshBtn'); await delay(3500);
  await set('#searchInput', prefix, 'input');
  await set('#sortSelect', 'name-asc');
  await set('#dateFilterSelect', '7d');
  caption('Search, type, date, and sort controls filter the fetched inventory locally. Only disposable test files are shown.');
  await delay(5000);
  await set('#dateFilterSelect', 'any'); // Reused fixtures may be older than seven days.
  const reviewId = pins.find(file => file.role === 'review').id;
  await evalApp(`(() => {
    const matches = [...document.querySelectorAll('#fileList li')].filter(row => row.dataset.recorderFileId === ${JSON.stringify(reviewId)});
    if (matches.length !== 1) throw new Error('Fixture ID not unique');
    const box = matches[0].querySelector('input[type=checkbox]');
    if (!box || box.checked) throw new Error('Unexpected fixture selection');
    box.click(); return true;
  })()`);
  await set('#filterTypeSelect', 'pdf');
  await delay(2000);
  await click('#reviewSelectedBtn');
  caption('Review retains selections hidden by a filter. This text file stays selected when the view is filtered to PDFs.');
  await delay(6000);
  await click('#reviewCloseBtn'); await set('#filterTypeSelect', 'all');
  await click('#reviewSelectedBtn');
  validateSelection(await text('#accountEmail'), expected,
    (await evalApp(`globalThis.__fixtureRecorder.snapshot()`)).selected, pins);
  await evalApp(`globalThis.__fixtureRecorder.verify()`);
  await click('#reviewTrashBtn');
  caption('Confirmation names the account and selection. Only the single disposable review file will move to Trash.');
  await delay(5000);
  assert((await text('#confirmText')).includes(expected), 'Confirmation account differs.');
  await confirm('Move ONLY the pinned review fixture to Trash? Answer here in Terminal; the recorder will click the Chrome confirmation after validation.');
  // Re-check the complete selection immediately before the real mutation.
  validateSelection(await text('#accountEmail'), expected,
    (await evalApp(`globalThis.__fixtureRecorder.snapshot()`)).selected, pins);
  await evalApp(`globalThis.__fixtureRecorder.verify()`);
  assert((await text('#selectedCount')).trim() === '1 selected', 'Selection count changed.');
  assert(await evalApp(`document.querySelector('#confirmFolderWarning').classList.contains('hidden')`), 'Folders may never be trashed by the recorder.');
  await cdp.evaluate(workerSession, `globalThis.__diagnosticRestoreFetch?.();\n${workerGuardSource({ folderId, account: expected, expected: expectedFixtures, pins })}`, 'install exact-file-ID Trash dispatch guard');
  checks.approval = await evalApp(`globalThis.__fixtureRecorder.approve()`, 'approve actual selected IDs and confirmation', 120000);
  await writeFile(`${directory}/approval.json`, JSON.stringify(checks.approval, null, 2), {mode:0o600});
  await click('#confirmOkBtn');
  await waitFor(`(() => { if (globalThis.__fixtureRecorder.snapshot().failed) throw new Error('Safety check failed'); return document.querySelector('#jobStatusText').textContent === 'Done: 1 moved, 0 failed'; })()`, 'Cleanup did not complete successfully. Inspect the real app; do not claim success.', 45000);
  await click('#jobDetailsToggle');
  caption('The background worker updates the selected file with trashed: true using Drive files.update. Nothing is permanently deleted.');
  await delay(6000);
  checks.confirmedTrashStatus = await evalApp(`globalThis.__fixtureRecorder.trashStatus()`, 'verify exact Trash ID and unchanged keep fixture', 120000);
  // Direct file view avoids revealing unrelated filenames in account-wide Trash.
  await cdp.call('Target.createTarget', { url: `https://drive.google.com/file/d/${reviewId}/view?hl=en` });
  caption('Open the exact fixture by Drive ID and verify its Trash status. The account-wide Trash listing is never opened.');
  console.log('MANUAL: Verify this exact disposable file shows as trashed in Drive.');
  await confirm('Does the direct file view visibly confirm the test file is in Trash? Hold the evidence for 4 seconds. If not, stop; never open an unfiltered Trash list during capture.');
  checks.driveTrashConfirmed = 'MANUALLY ATTESTED';
  await foreground();
  if (!native) {
    await click('#accountMenuBtn');
    await consent('Switch account entry point', async () => {
      // The menu was opened above; reopening on a retry is handled here.
      if (await evalApp("document.querySelector('#accountMenu').classList.contains('hidden')")) await click('#accountMenuBtn');
      await click('#switchAccountBtn');
    });
    caption('The account chooser uses the same OAuth client and account-wide scope. The recording view remains restricted to the fixture IDs.');
    await delay(4000);
  } else checks.nativeSwitchAccount = 'NOT SUPPORTED: production code requires the configured web client for account switching.';
  await click('#accountMenuBtn');
  caption('The account menu offers Disconnect. This recorder leaves the Chrome profile and its existing sign-in intact.');
  await delay(4000);
  await confirm('Finish recording?');
  captions.at(-1).end = now();
  await stopRecorder();
  assert(!controller.signal.aborted, 'Recording cancelled.');
  await confirm('Review check: no passwords, tokens, unrelated personal information, or unreadable consent steps were recorded?');
  checks.privacyReview = 'MANUALLY ATTESTED; final MP4 playback still required';
  const duration = await exportVideo(`${temporary}/raw.mp4`, directory, output, captions, temporary);
  checks.durationSeconds = duration;
  checks.output = output;
  checks.result = 'DRAFT: inspect the final MP4. Branding mismatch and other-flow coverage remain review items.';
  await writeFile(`${directory}/review.json`, JSON.stringify(checks, null, 2));
  await writeFile(`${tools}/.local/latest-run.txt`, directory + '\n');
  console.log(`\nVideo: ${output}\nCaptions and checklist: ${directory}`);
  console.log('Play the entire video before sharing. Nothing was uploaded or submitted.');
} catch (error) {
  checks.result = 'INCOMPLETE: no claim of successful OAuth verification evidence.';
  if (cdp && session) {
    try { checks.guardSnapshot = await evalApp('globalThis.__fixtureRecorder.snapshot()', 'retain safe failure and selection snapshot'); }
    catch { /* Keep the original error if the guarded tab is unavailable. */ }
  }
  checks.failure = diagnosticError(error);
  await writeFile(`${directory}/diagnostic.json`, JSON.stringify(checks.failure, null, 2), { mode: 0o600 });
  await writeFile(`${directory}/review.json`, JSON.stringify(checks, null, 2));
  // Do not print raw CDP/Google responses or token-bearing URLs.
  console.error(`\nStopped: ${checks.failure.message}`);
  console.error(`Private run directory: ${directory}`);
  process.exitCode = 1;
} finally {
  await stopRecorder();
  rl.close();
  if (cdp) {
    workerTargetId = null;
    if (workerSession) {
      if (pins && !diagnoseRun) {
        try { await cdp.evaluate(workerSession, `(async () => {
          globalThis.__fixtureWorkerGuard?.stop();
          // Pause only this take's single-fixture job before restoring APIs.
          await withJobLock(async () => {
            const job = await getJob();
            if (job?.account === ${JSON.stringify(expected)} && job.items?.length === 1
                && job.items[0].id === ${JSON.stringify(pins.find(file => file.role === 'review').id)}
                && GCLib.isJobActive(job)) {
              job.status = 'paused_disconnected';
              job.updatedAt = Date.now();
              await saveJob(job);
              await clearAlarm();
            }
          });
          return true;
        })()`); } catch { /* worker already closed; do not switch to a replacement */ }
      }
      try { await cdp.evaluate(workerSession, `(() => {
        globalThis.__fixtureWorkerGuard?.restore();
        globalThis.__diagnosticRestoreFetch?.();
        if (globalThis.__recorderOriginalPopup) {
          chrome.action.openPopup = globalThis.__recorderOriginalPopup;
          delete globalThis.__recorderOriginalPopup;
        }
        return true;
      })()`); await cdp.call('Debugger.disable', {}, workerSession); } catch { /* worker already closed */ }
    }
    try { await cdp.call('Browser.close'); } catch { /* already closed */ }
    cdp.socket.close();
  } else if (browser) browser.kill('SIGTERM');
}
}
await record();
const successful = checks.result?.startsWith('DRAFT:');
const metadata = successful ? JSON.parse(await import('./support.mjs').then(({run}) => run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',`${directory}/export.mp4`]))) : null;
const video = metadata?.streams.find(stream => stream.codec_type === 'video');
await finishRun({root:outputRoot,directory,workflow:'oauth',state:successful?'success':'failed',
  dependencies:[fixtureDirectory,...(previousContext.profile?[previousContext.profile]:[])],
  finals:successful?[`${directory}/export.mp4`,output]:[],
  expected:successful?{width:1920,height:video.height,minDuration:Math.max(.1,checks.durationSeconds-1),maxDuration:checks.durationSeconds+1}:undefined});

activeRun = null;
}
try { await main(); }
catch (error) {
  console.error(JSON.stringify(diagnosticError(error), null, 2));
  if (activeRun) {
    try {
      await writeFile(path.join(activeRun.directory,'diagnostic.json'),JSON.stringify(diagnosticError(error),null,2),{mode:0o600,flag:'wx'}).catch(failure=>{if(failure.code!=='EEXIST')throw failure;});
      await finishRun({...activeRun,state:'failed'});
    } catch {
      console.error(`Run preserved. Cleanup command:\n${failedCleanupCommand(activeRun.root,activeRun.directory)}`);
    }
  }
  process.exitCode = 1;
}
