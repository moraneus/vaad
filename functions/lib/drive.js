// Google Drive integration — OAuth + file CRUD.
// Uses the `drive.file` scope which restricts the app to ONLY files it created.
// The app cannot see, read, or modify any other file in the user's Drive.

import { encryptString, decryptString, randomToken } from './crypto.js';

const FOLDER_NAME = 'vaad-docs';
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

const ensureSecret = (env) => env.SESSION_SECRET || 'dev-only-secret-change-me-in-production-please-1234567890';

// Build the OAuth consent URL the admin clicks.
export function buildAuthURL(env, redirectURI, state) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectURI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange the authorization code for tokens (refresh + access).
export async function exchangeCode(env, code, redirectURI) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectURI,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Refresh an access token using the stored refresh token.
async function refreshAccessToken(env, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Get user email (for UI display).
export async function fetchUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

// Save tokens encrypted in D1.
export async function saveDriveConfig(db, env, { refreshToken, folderId, accountEmail }) {
  const enc = await encryptString(refreshToken, ensureSecret(env));
  await db.prepare(
    `INSERT INTO drive_config (id, refresh_token_encrypted, refresh_token_iv, folder_id, account_email, connected_at, updated_at)
     VALUES (1, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       refresh_token_iv = excluded.refresh_token_iv,
       folder_id = excluded.folder_id,
       account_email = excluded.account_email,
       connected_at = excluded.connected_at,
       updated_at = excluded.updated_at`
  ).bind(enc.ciphertext, enc.iv, folderId, accountEmail).run();
}

export async function getDriveStatus(db) {
  const row = await db.prepare('SELECT folder_id AS folderId, account_email AS accountEmail, connected_at AS connectedAt FROM drive_config WHERE id = 1').first();
  return row && row.folderId ? { connected: true, ...row } : { connected: false };
}

export async function disconnectDrive(db) {
  await db.prepare('DELETE FROM drive_config WHERE id = 1').run();
}

// Get an access token, transparently refreshing if needed.
export async function getAccessToken(db, env) {
  const row = await db.prepare('SELECT refresh_token_encrypted AS ct, refresh_token_iv AS iv, folder_id AS folderId FROM drive_config WHERE id = 1').first();
  if (!row || !row.ct) throw new Error('Drive not connected');
  const refreshToken = await decryptString(row.ct, row.iv, ensureSecret(env));
  const tokens = await refreshAccessToken(env, refreshToken);
  return { accessToken: tokens.access_token, folderId: row.folderId };
}

// Find or create the dedicated folder. Returns folder ID.
export async function ensureFolder(accessToken, name = FOLDER_NAME) {
  // Search for existing folder with this name
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (search.ok) {
    const data = await search.json();
    if (data.files?.length) return data.files[0].id;
  }
  // Create
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!create.ok) throw new Error(`folder create failed: ${create.status} ${await create.text()}`);
  const data = await create.json();
  return data.id;
}

// Upload a file (multipart). Returns drive file id.
export async function uploadFile(accessToken, folderId, { name, mimeType, body }) {
  const boundary = `----vaad${randomToken(8)}`;
  const meta = JSON.stringify({ name, mimeType, parents: [folderId] });

  // Combine multipart manually (boundary + metadata + boundary + body)
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const bodyBytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
  const combined = new Uint8Array(head.length + bodyBytes.length + tail.length);
  combined.set(head, 0);
  combined.set(bodyBytes, head.length);
  combined.set(tail, head.length + bodyBytes.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body: combined,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

// Stream a file's contents.
export async function downloadFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return res; // caller streams from res.body
}

export async function deleteFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  // 404 is fine — file already gone
  if (!res.ok && res.status !== 404) throw new Error(`delete failed: ${res.status}`);
}

// List all files inside the folder (used for cleanup).
export async function listFolderFiles(accessToken, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1000`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.files || [];
}

export const DRIVE_FOLDER_NAME = FOLDER_NAME;
export const DRIVE_SCOPE = SCOPE;
