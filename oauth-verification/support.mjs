import {inspectVideo} from './retention.mjs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';

export const SCOPE = 'https://www.googleapis.com/auth/drive';
export const EXTENSION_ID = 'acijddppbcekpnlddndfomahlpgcnfoe';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Never retain evaluation expressions, response bodies, URL parameters or
// remote objects: they can contain OAuth credentials. Sanitize text too.
export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/\b(?:https?|wss?):\/\/[^\s)]+/gi, '[redacted URL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization|password|state|code)["']?\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+/g, '[redacted email]')
    .replace(/[A-Za-z0-9_+%-]{32,}/g, '[redacted value]');
}
export function diagnosticError(error, operation = error.operation || 'recording') {
  return {
    operation: sanitizeDiagnostic(operation),
    message: sanitizeDiagnostic(error.message),
    stack: sanitizeDiagnostic(error.stack),
    ...(error.browserStack ? { browserStack: sanitizeDiagnostic(error.browserStack) } : {}),
  };
}
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(stdout) :
      reject(new Error(`${command} failed (${code}). ${stderr.slice(-1400)}`)));
  });
}

// Only inspect local source and the public configuration endpoint. No secrets.
export async function audit(root) {
  const manifest = JSON.parse(await readFile(`${root}/extension/manifest.json`, 'utf8'));
  const authConfig = await readFile(`${root}/extension/auth-config.js`, 'utf8');
  const origin = authConfig.match(/"authOrigin"\s*:\s*"([^"]+)"/)?.[1];
  assert(origin && new URL(origin).protocol === 'https:', 'Configured HTTPS auth origin required.');
  assert(JSON.stringify(manifest.oauth2.scopes) === JSON.stringify([SCOPE]), 'Manifest scopes changed; review the workflow.');
  const response = await fetch(`${origin}/api/config`, {
    headers: { 'X-GoogleCleaner-Extension': EXTENSION_ID }, signal: AbortSignal.timeout(10000),
  });
  assert(response.ok, `Public auth configuration returned ${response.status}.`);
  const { clientId, redirectUri, scope } = await response.json();
  assert(scope === SCOPE && redirectUri === `https://${EXTENSION_ID}.chromiumapp.org/`, 'Public scope/redirect mismatch.');
  assert(typeof clientId === 'string' && clientId.endsWith('.apps.googleusercontent.com'), 'Invalid public client ID.');
  return { extensionName: manifest.name, consentName: 'GooSweep', scope,
    activeClientId: clientId, nativeFallbackClientId: manifest.oauth2.client_id,
    redirectUri, authOrigin: origin, brandingMismatch: true };
}

// CDP operates the extension view and recording-only worker guards.
// No Google form inspection, network logs, cookie/token export or tracing.
export class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (!data.id) { this.onEvent?.(data); return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      if (data.error) pending.reject(Object.assign(new Error(sanitizeDiagnostic(data.error.message)), {
        operation: pending.method, stack: pending.stack,
      }));
      else pending.resolve(data.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(new Error('Chrome connection closed.'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to isolated Chrome.')), { once: true });
    });
    return new CDP(socket);
  }
  call(method, params = {}, sessionId, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`Chrome command timed out: ${method}`), {operation:method})); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, stack: new Error(`Chrome command: ${method}`).stack });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(targetId) {
    return (await this.call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  }
  async evaluate(session, expression, operation = 'Runtime.evaluate', timeout = 15000) {
    const result = await this.call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, session, timeout);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = details.exception?.description || details.text;
      const frames = details.stackTrace?.callFrames || [];
      throw Object.assign(new Error(sanitizeDiagnostic(description)), {
        operation,
        browserStack: sanitizeDiagnostic([description, ...frames.map(frame =>
          `    at ${frame.functionName || '<anonymous>'} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`)].join('\n')),
      });
    }
    return result.result.value;
  }
}

export function srt(rows) {
  const stamp = value => {
    const ms = Math.round(value * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return rows.map((row, i) => `${i + 1}\n${stamp(row.start)} --> ${stamp(row.end)}\n${row.text}\n`).join('\n');
}
export async function exportVideo(raw, directory, output, rows, temporary = directory) {
  assert(rows.length > 0 && rows.every(row => row.end > row.start), 'Invalid caption timing.');
  await writeFile(`${directory}/captions.json`, JSON.stringify(rows, null, 2));
  await writeFile(`${directory}/captions.srt`, srt(rows));
  await run(`${temporary}/caption-renderer`, [`${directory}/captions.json`, temporary]);
  // The entire capture is retained. Only scaling, padding, and captions are added.
  const args = ['-hide_banner', '-loglevel', 'error', '-n', '-i', raw];
  for (let i = 0; i < rows.length; i++) args.push('-i', `${temporary}/caption-${i}.png`);
  const filters = ['[0:v]scale=1920:-2,pad=1920:ih+128:0:0:color=0x121212[v0]'];
  rows.forEach((row, i) => filters.push(`[v${i}][${i + 1}:v]overlay=0:H-h:enable='gte(t,${row.start.toFixed(3)})*lt(t,${row.end.toFixed(3)})'[v${i + 1}]`));
  args.push('-filter_complex_threads', '1', '-filter_complex', filters.join(';'),
    '-map', `[v${rows.length}]`, '-an', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/export.mp4`);
  await run('ffmpeg', args);
  const metadata = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', `${directory}/export.mp4`]));
  assert(metadata.streams.some(stream => stream.codec_type === 'video') && Number(metadata.format.duration) > 0, 'Export has no playable video.');
  const source = JSON.parse(await run('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',raw]));
  const original = source.streams.find(stream => stream.codec_type === 'video');
  const expected = {width:1920,height:Math.round(original.height*1920/original.width/2)*2+128,minDuration:Math.max(.1,Number(source.format.duration)-1),maxDuration:Number(source.format.duration)+1};
  await inspectVideo(`${directory}/export.mp4`, expected);
  await copyFile(`${directory}/export.mp4`, output, constants.COPYFILE_EXCL);
  await inspectVideo(output, expected);
  return Number(metadata.format.duration);
}
