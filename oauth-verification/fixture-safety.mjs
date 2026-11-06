// Shared by Node tests and the in-browser recording guards. No write API here.
export function requireSafe(condition, message) {
  if (!condition) throw new Error(message);
}
export function parseFolderId(input) {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a Drive folder URL or ID.'); }
  const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})\/?$/);
  requireSafe(url.protocol === 'https:' && url.hostname === 'drive.google.com' && match && !url.username && !url.password,
    'Use an HTTPS drive.google.com/drive/folders/... URL or a folder ID.');
  return match[1];
}
export function validateSelection(account, expectedAccount, targets, pins) {
  requireSafe(account.trim().toLowerCase() === expectedAccount.trim().toLowerCase(), 'Connected account mismatch.');
  const review = pins.find(file => file.role === 'review');
  requireSafe(review && targets.length === 1 && targets[0].id === review.id && targets[0].name === review.name,
    'Only the pinned review fixture ID and name may be moved to Trash.');
}
export async function validateFixture(api, folderId, fixture, id, trashed = false) {
  const metadata = await api.metadata(id);
  const bytes = new TextEncoder().encode(fixture.content);
  requireSafe(metadata.id === id && metadata.name === fixture.name && metadata.trashed === trashed
    && metadata.ownedByMe === true && metadata.mimeType === 'text/plain'
    && Array.isArray(metadata.parents) && metadata.parents.length === 1 && metadata.parents[0] === folderId
    && String(metadata.size) === String(bytes.length), 'Fixture metadata, ownership, type, size, or parent folder mismatch.');
  const actual = await api.content(metadata.id, bytes.length);
  requireSafe(actual.length === bytes.length && bytes.every((byte, i) => actual[i] === byte), 'Fixture content does not match the generated disposable file.');
  return metadata;
}
export async function validateFixtures(api, folderId, expected, pins = null) {
  requireSafe(expected.length === 2 && new Set(expected.map(file => file.name)).size === 2,
    'Exactly two distinct generated fixtures are required.');
  const folder = await api.metadata(folderId);
  requireSafe(folder.id === folderId && folder.mimeType === 'application/vnd.google-apps.folder' && folder.trashed === false,
    'The selected folder is missing, trashed, or is not a real folder.');
  const children = await api.children(folderId);
  requireSafe(new Set(children.map(file => file.id)).size === children.length, 'Ambiguous folder listing.');
  const results = [];
  for (const fixture of expected) {
    const matches = children.filter(file => file.name === fixture.name);
    requireSafe(matches.length === 1, 'A generated fixture is missing or has duplicate names in the selected folder.');
    const candidate = matches[0];
    requireSafe(typeof candidate.id === 'string' && /^[A-Za-z0-9_-]{10,}$/.test(candidate.id), 'Missing or invalid fixture ID.');
    const pin = pins?.find(file => file.role === fixture.role);
    requireSafe(!pins || (pin && candidate.id === pin.id && candidate.name === pin.name), 'A fixture ID changed after validation.');
    const metadata = await validateFixture(api, folderId, fixture, candidate.id);
    results.push({ role: fixture.role, id: metadata.id, name: metadata.name, parentId: folderId });
  }
  requireSafe(new Set(results.map(file => file.id)).size === 2, 'Fixture IDs must be distinct.');
  return results;
}
export async function authorizeTrash({ api, folderId, expected, pins, account, expectedAccount, targets }, dispatch) {
  validateSelection(account, expectedAccount, targets, pins);
  await validateFixtures(api, folderId, expected, pins);
  // Recheck supplied selection after asynchronous validation, before dispatch.
  validateSelection(account, expectedAccount, targets, pins);
  return dispatch();
}

// GET only. Tokens stay inside the extension execution context, never in Node.
export function createFixtureApi(getToken, request = globalThis.fetch.bind(globalThis)) {
  const fields = 'id,name,mimeType,parents,trashed,ownedByMe,size';
  async function get(path) {
    const token = await getToken();
    const response = await request(`https://www.googleapis.com/drive/v3/${path}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    requireSafe(response.ok, `Fixture validation read failed (${response.status}).`);
    return response;
  }
  return {
    async metadata(id) { return (await get(`files/${encodeURIComponent(id)}?${new URLSearchParams({fields})}`)).json(); },
    async children(folderId) {
      requireSafe(/^[A-Za-z0-9_-]{10,}$/.test(folderId), 'Invalid folder ID.');
      const files = []; const seenPages = new Set(); let pageToken;
      do {
        const params = new URLSearchParams({ q: `'${folderId}' in parents and trashed = false`,
          fields: `nextPageToken,files(${fields})`, pageSize: '1000' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await (await get(`files?${params}`)).json();
        requireSafe(Array.isArray(page.files), 'Incomplete folder listing.');
        files.push(...page.files);
        requireSafe(!page.nextPageToken || !seenPages.has(page.nextPageToken), 'Repeated folder pagination token.');
        pageToken = page.nextPageToken;
        if (pageToken) seenPages.add(pageToken);
      } while (pageToken);
      return files;
    },
    async content(id, limit) {
      const response = await get(`files/${encodeURIComponent(id)}?alt=media`);
      const reader = response.body.getReader();
      const bytes = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          requireSafe(bytes.length + value.length <= limit, 'Fixture content exceeds expected byte length.');
          bytes.push(...value);
        }
      } finally { await reader.cancel(); }
      return new Uint8Array(bytes);
    },
  };
}
