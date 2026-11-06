import { requireSafe, validateSelection, validateFixture, validateFixtures, authorizeTrash, createFixtureApi } from './fixture-safety.mjs';
import { observeAuthentication } from './auth-readiness.mjs';
import { sanitizeDiagnostic } from './support.mjs';

export function diagnosticReadOnlyGuard() {
  const original = globalThis.fetch;
  globalThis.__diagnosticRestoreFetch = () => { globalThis.fetch = original; delete globalThis.__diagnosticRestoreFetch; };
  globalThis.fetch = (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href);
    const method = (options.method || input.method || 'GET').toUpperCase();
    if (url.hostname === 'www.googleapis.com' && method !== 'GET') throw new Error('Read-only diagnostic blocks Drive writes.');
    return original(input, options);
  };
  return true;
}

// Injected into the real extension tab before its first navigation/render.
// This is a labeled recording-only view; Google/API responses remain real.
export function recorderGuardSource(settings) {
  return `${[requireSafe, validateSelection, validateFixture, validateFixtures, authorizeTrash, createFixtureApi, observeAuthentication, sanitizeDiagnostic].map(fn => fn.toString()).join('\n')}\n(${installView.toString()})(${JSON.stringify(settings)});`;
}
function installView(settings) {
  const gate = document.createElement('style');
  gate.textContent = 'body{visibility:hidden!important}';
  const observe = new MutationObserver(() => {
    if (document.documentElement && !gate.isConnected) document.documentElement.append(gate);
  });
  observe.observe(document, { childList: true, subtree: true });
  if (document.documentElement) document.documentElement.append(gate);
  document.addEventListener('DOMContentLoaded', () => {
    const authentication = observeAuthentication();
    let pins = [], permitted = false, failure = null;
    const api = createFixtureApi(() => getAuthToken(false));
    const originalFilter = getFilteredFiles;
    const originalSend = sendMessage;
    const originalJob = renderJob;
    const originalRow = buildFileRow;
    function fail(condition, expected, actual) {
      permitted = false;
      document.querySelector('#confirmOkBtn').disabled = true;
      if (!failure) {
        failure = Object.assign(new Error(`Recorder safety: ${condition}. Expected ${JSON.stringify(expected)}; actual ${JSON.stringify(actual)}.`),
          {condition, expected, actual});
      }
      throw failure; // Preserve the FIRST rejection, including its stack.
    }
    function eligible(file) { return pins.some(pin => file.id === pin.id && file.name === pin.name); }
    getFilteredFiles = () => originalFilter().filter(eligible);
    buildFileRow = (file, options) => {
      if (!eligible(file)) return fail('rendered row must match a validated fixture', {matchesPinned:true}, {matchesPinned:false});
      const row = originalRow(file, options);
      row.dataset.recorderFileId = file.id;
      return row;
    };
    renderJob = job => {
      if (job && (!job.items?.length || job.items.some(item => !eligible(item)))) {
        document.querySelector('#jobBar').classList.add('hidden');
        document.querySelector('#jobResultList').replaceChildren();
        return;
      }
      return originalJob(job);
    };
    function targets() {
      return [...state.selectedIds].map(id => ({ id, name: state.filesById.get(id)?.name }));
    }
    function safeTargets() {
      return targets().map(file => {
        const pin = pins.find(pin => pin.id === file.id);
        return pin ? {id:pin.id, nameMatches:file.name === pin.name, role:pin.role}
          : {id:'[unrecognized ID]', nameMatches:false, role:'unrecognized'};
      });
    }
    function checkApproval() {
      if (failure) throw failure;
      try { validateSelection(state.email, settings.account, targets(), pins); }
      catch { return fail('actual selection must be the pinned review fixture', {roles:['review'], count:1, accountMatches:true},
        {selected:safeTargets(), count:state.selectedIds.size, accountMatches:state.email?.trim().toLowerCase() === settings.account.trim().toLowerCase()}); }
      const expectedText = `Account: ${state.email}. 1 item will be moved to Trash.`;
      const confirmation = document.querySelector('#confirmOverlay');
      const actual = {
        open:!confirmation.classList.contains('hidden'),
        textMatches:document.querySelector('#confirmText').textContent === expectedText,
        noFolderWarning:document.querySelector('#confirmFolderWarning').classList.contains('hidden'),
        reviewMatches:[...document.querySelectorAll('#reviewList li')].length === 1
          && document.querySelector('#reviewList li')?.dataset.recorderFileId === pins.find(pin=>pin.role==='review').id
          && document.querySelector('#reviewAccountText').textContent === `Account: ${state.email}. 1 item selected.`,
      };
      if (!actual.open || !actual.textMatches || !actual.noFolderWarning || !actual.reviewMatches) {
        return fail('confirmation must show the selected account and exactly one non-folder item',
          {open:true,textMatches:true,noFolderWarning:true,reviewMatches:true},actual);
      }
    }
    // Approval is entered in Terminal. A premature Chrome click must not
    // close the dialog or call startTrashJob before that approval exists.
    const confirmButton = document.querySelector('#confirmOkBtn');
    confirmButton.disabled = true;
    sendMessage = async message => {
      if (message.type === 'retryFailed' || message.type === 'resumeJob') return fail('recorder forbids retry/resume dispatch', {allowed:false}, {operation:message.type});
      if (message.type !== 'startJob') return originalSend(message);
      if (failure) throw failure;
      if (!permitted) return fail('startJob requires prior recorder approval', {permitted:true}, {permitted:false, selected:safeTargets()});
      permitted = false; // One explicit approval, one dispatch. No fallback/retry.
      try {
        return await authorizeTrash({ api, folderId: settings.folderId,
          expected: settings.expected, pins, account: message.account,
          expectedAccount: settings.account, targets: message.items }, async () => {
          validateSelection(state.email, settings.account, targets(), pins);
          return originalSend(message);
        });
      } catch (error) { return fail('dispatch validation must pass', {validation:'passed'}, {error:sanitizeDiagnostic(error.message)}); }
    };
    const note = document.createElement('p');
    note.textContent = 'Recording view: validated fixtures only. OAuth grants account-wide Drive access.';
    note.style.cssText = 'font:12px/1.4 Tahoma,Arial,sans-serif;padding:8px 12px;margin:0;background:#E5DFF0;color:#302B3D;max-width:400px';
    document.body.prepend(note);
    // These read-only controls run in the extension; no token crosses CDP.
    globalThis.__fixtureRecorder = {
      authStatus: () => authentication.status(),
      authReady: () => authentication.ready(settings.account),
      async fixturePresence() {
        const folder = await api.metadata(settings.folderId);
        requireSafe(folder.id === settings.folderId && folder.mimeType === 'application/vnd.google-apps.folder'
          && folder.trashed === false, 'The selected folder is missing, trashed, or is not a real folder.');
        const children = await api.children(settings.folderId);
        return settings.expected.map(file => ({role: file.role, count: children.filter(child => child.name === file.name).length}));
      },
      async identify() {
        pins = await validateFixtures(api, settings.folderId, settings.expected, pins.length ? pins : settings.pins || null);
        renderFileList();
        return pins;
      },
      async verify() {
        const account = await fetchAccountEmail();
        const selected = targets();
        await authorizeTrash({ api, folderId: settings.folderId, expected: settings.expected,
          pins, account, expectedAccount: settings.account, targets: selected }, async () => {
          validateSelection(state.email, settings.account, targets(), pins);
        });
        return selected;
      },
      async trashStatus() {
        const review = pins.find(file => file.role === 'review');
        const keep = pins.find(file => file.role === 'keep');
        requireSafe(review && keep, 'Both original fixture IDs must be pinned.');
        const file = await validateFixture(api, settings.folderId,
          settings.expected.find(file => file.role === 'review'), review.id, true);
        const kept = await validateFixture(api, settings.folderId,
          settings.expected.find(file => file.role === 'keep'), keep.id, false);
        return { id: file.id, name: file.name, trashed: true,
          keep: {id: kept.id, name: kept.name, trashed: false, contentUnchanged: true} };
      },
      async approve() {
        if (failure) throw failure;
        checkApproval();
        try {
          await authorizeTrash({api, folderId:settings.folderId, expected:settings.expected, pins,
            account:state.email, expectedAccount:settings.account, targets:targets()}, async()=>checkApproval());
        } catch (error) {
          if (failure) throw failure;
          return fail('approval fixture validation must pass', {validation:'passed'}, {error:sanitizeDiagnostic(error.message)});
        }
        if (failure) throw failure;
        permitted = true;
        confirmButton.disabled = false;
        return this.snapshot();
      },
      snapshot() {
        return { selected: targets().map(file => eligible(file) ? file : {id:'[unrecognized ID]',name:'[unrecognized name]'}),
          visible: getFilteredFiles().map(file => file.id), failed:Boolean(failure),
          failure:failure ? {condition:failure.condition,expected:failure.expected,actual:failure.actual} : null,
          permitted, confirmationOpen:!document.querySelector('#confirmOverlay').classList.contains('hidden') };
      },
    };
    observe.disconnect(); gate.remove();
  }, { once: true });
}

// Per-dispatch guard in the real background worker. Revalidates metadata,
// parent, bytes, and account immediately before EVERY actual PATCH/retry.
export function workerGuardSource(settings) {
  return `${[requireSafe, validateSelection, validateFixture, validateFixtures, authorizeTrash, createFixtureApi].map(fn => fn.toString()).join('\n')}\n(${installWorker.toString()})(${JSON.stringify(settings)});`;
}
function installWorker(settings) {
  if (globalThis.__fixtureWorkerGuard) throw new Error('Recorder worker guard already installed.');
  const originalFetch = globalThis.fetch;
  let stopped = false;
  const api = createFixtureApi(() => getAuthToken(false), originalFetch.bind(globalThis));
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const method = (options.method || input.method || 'GET').toUpperCase();
    if (url.hostname !== 'www.googleapis.com' || method === 'GET') return originalFetch(input, options);
    requireSafe(!stopped, 'Recorder has stopped; no further Drive mutations are allowed.');
    requireSafe(method === 'PATCH' && url.origin === 'https://www.googleapis.com', 'Recorder blocks other Drive mutations.');
    const id = decodeURIComponent(url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)?.[1] || '');
    const body = JSON.parse(options.body || '{}');
    requireSafe(Object.keys(body).length === 1 && body.trashed === true, 'Only moving the pinned fixture to Trash is allowed.');
    const review = settings.pins.find(file => file.role === 'review');
    const about = await originalFetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
      method: 'GET', headers: options.headers, signal: AbortSignal.timeout(15000),
    });
    requireSafe(about.ok, 'Could not verify dispatch account.');
    const account = (await about.json()).user?.emailAddress || '';
    return authorizeTrash({ api, folderId: settings.folderId, expected: settings.expected,
      pins: settings.pins, account, expectedAccount: settings.account,
      targets: [{ id, name: review.name }] }, () => originalFetch(input, options));
  };
  globalThis.__fixtureWorkerGuard = { stop() { stopped = true; }, restore() { globalThis.fetch = originalFetch; delete globalThis.__fixtureWorkerGuard; } };
  return true;
}
