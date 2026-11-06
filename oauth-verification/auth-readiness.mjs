import { delay } from './support.mjs';

// A visible app body can belong to the previous account connection.
// Require completion of a NEW real UI Connect attempt, then a Drive probe.
export async function waitForAuthentication(status, probe, {
  afterSequence, timeout = 180000, interval = 300,
  now = Date.now, sleep = delay,
} = {}) {
  const until = now() + timeout;
  while (now() < until) {
    const current = await status();
    if (current.sequence > afterSequence && !current.pending) {
      if (current.phase === 'failed' || current.phase === 'succeeded') {
        return await probe(); // Propagates the actual callback/Drive error.
      }
    }
    await sleep(interval);
  }
  throw Object.assign(new Error('Authentication readiness timed out; finish or cancel the Google window before retrying.'), {
    operation: 'authentication readiness',
  });
}

// Installed before popup.js registers its DOMContentLoaded UI listeners.
// The real functions still handle sign-in, callback, tokens and session checks.
// No token or storage value is exposed by this observer.
export function observeAuthentication() {
  const originalConnect = connect;
  const originalGetToken = getAuthToken;
  let sequence = 0, phase = 'idle', failure = null;
  getAuthToken = async (...args) => {
    try { return await originalGetToken(...args); }
    catch (error) {
      if (args[0] === true) failure = error;
      throw error;
    }
  };
  connect = async function (...args) {
    sequence++;
    phase = 'pending';
    failure = null;
    try {
      await originalConnect.apply(this, args);
      const banner = document.querySelector('#errorBanner');
      if (failure) throw failure;
      if (!banner.classList.contains('hidden')) throw new Error(banner.textContent);
      if (!state.token) throw new Error('The app did not establish an authenticated session.');
      phase = 'succeeded';
    } catch (error) {
      failure = error;
      phase = 'failed';
      // UI event listeners do not consume rejections. The readiness probe
      // rethrows this error, preserving the original failure and stack.
    }
  };
  return {
    status() { return { sequence, phase, pending: accountConnectionPending || phase === 'pending' }; },
    async ready(account) {
      if (failure) throw failure;
      requireSafe(phase === 'succeeded' && !accountConnectionPending, 'Real app authentication has not completed.');
      const token = await getAuthToken(false);
      requireSafe(token === state.token, 'The app and fixture reader have different authenticated sessions.');
      // This is the real app's Drive about request with its current token.
      const actual = await fetchAccountEmail();
      requireSafe(actual.trim().toLowerCase() === account.trim().toLowerCase()
        && state.email.trim().toLowerCase() === account.trim().toLowerCase(), 'Connected account mismatch.');
      requireSafe((await getAuthToken(false)) === state.token, 'The authenticated session changed during the Drive readiness probe.');
      return true;
    },
  };
}
