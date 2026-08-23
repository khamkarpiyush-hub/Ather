
// ─── Vault key (one persistent AES-GCM key per browser, never leaves it) ───
const VAULT_KEY_STORAGE = 'swarmvault_master_key';
const IV_LENGTH = 12; // AES-GCM standard nonce length

// Thrown when a payload cannot be decrypted with this browser's vault key —
// i.e. it belongs to another peer's vault. Distinct from a network failure so
// the UI can label it 'Locked Vault File' rather than reporting an error.
export class VaultLockedError extends Error {
  constructor(message = 'Encrypted with a different vault key') {
    super(message);
    this.name = 'VaultLockedError';
    this.isVaultLocked = true;
  }
}

let cachedVaultKey = null;

function readStoredJwk() {
  try {
    const raw = localStorage.getItem(VAULT_KEY_STORAGE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    // Private-mode / disabled storage, or corrupt JSON
    console.warn('Could not read the stored vault key:', e.message);
    return null;
  }
}

/**
 * Returns this browser's AES-GCM 256 vault key, generating and persisting one
 * as a JWK in localStorage on first use so it survives reloads.
 */
export async function getVaultKey() {
  if (cachedVaultKey) return cachedVaultKey;

  const stored = readStoredJwk();
  if (stored) {
    try {
      cachedVaultKey = await window.crypto.subtle.importKey(
        'jwk',
        stored,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      return cachedVaultKey;
    } catch (e) {
      // Never silently mint a replacement — that would orphan every existing
      // file. Keep the unusable value so it can be recovered by hand.
      try {
        localStorage.setItem(`${VAULT_KEY_STORAGE}_corrupt`, JSON.stringify(stored));
      } catch (_) {}
      throw new Error(
        `Your stored vault key is unreadable (${e.message}). It has been kept at ` +
        `"${VAULT_KEY_STORAGE}_corrupt" — restore it to regain access to existing files.`
      );
    }
  }

  const key = await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable, so it can be exported for backup
    ['encrypt', 'decrypt']
  );
  const jwk = await window.crypto.subtle.exportKey('jwk', key);
  try {
    localStorage.setItem(VAULT_KEY_STORAGE, JSON.stringify(jwk));
  } catch (e) {
    console.warn('Vault key could not be persisted — it will not survive a reload:', e.message);
  }
  cachedVaultKey = key;
  return key;
}

/** Short, non-secret identifier for the current key, for display in the UI. */
export async function getVaultKeyFingerprint() {
  const jwk = await window.crypto.subtle.exportKey('jwk', await getVaultKey());
  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(jwk.k)
  );
  return Array.from(new Uint8Array(digest).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Exports the vault key as a JWK string so the user can back it up. */
export async function exportVaultKey() {
  return JSON.stringify(await window.crypto.subtle.exportKey('jwk', await getVaultKey()));
}

/**
 * The vault key as a single base64 token — what the user copies to move their
 * vault to another device.
 */
export async function exportVaultKeyBase64() {
  return btoa(await exportVaultKey());
}

/**
 * Replaces the key in localStorage with a pasted one. Accepts either the
 * base64 token from exportVaultKeyBase64() or raw JWK JSON. Returns the new
 * fingerprint. Throws with a readable reason if the input isn't a vault key.
 */
export async function importVaultKey(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Paste a vault key first.');

  let jwk = null;
  const attempts = [
    () => JSON.parse(text),
    () => JSON.parse(atob(text.replace(/\s+/g, ''))),
  ];
  for (const attempt of attempts) {
    try {
      const parsed = attempt();
      if (parsed && typeof parsed === 'object') { jwk = parsed; break; }
    } catch (e) { /* try the next shape */ }
  }
  if (!jwk) throw new Error('That is not a vault key — expected the base64 token or JWK JSON.');
  if (jwk.kty !== 'oct' || typeof jwk.k !== 'string') {
    throw new Error('That key is the wrong type — a vault key is a symmetric AES key.');
  }

  let key;
  try {
    key = await window.crypto.subtle.importKey(
      'jwk',
      { ...jwk, kty: 'oct', alg: 'A256GCM', ext: true },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  } catch (e) {
    throw new Error(`That key could not be loaded (${e.message}). Check for missing characters.`);
  }

  const normalized = await window.crypto.subtle.exportKey('jwk', key);
  try {
    localStorage.setItem(VAULT_KEY_STORAGE, JSON.stringify(normalized));
  } catch (e) {
    throw new Error(`Key loaded but could not be saved (${e.message}). It will be lost on reload.`);
  }
  cachedVaultKey = key;
  return getVaultKeyFingerprint();
}

// ─── Encrypted file metadata ───
// Filename, size and MIME type are as revealing as the bytes, so they travel
// as one AES-GCM blob rather than as plaintext fields.

const LOCKED_LABEL = 'Locked Vault File';
export { LOCKED_LABEL };

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypts a metadata object into one base64 token: [IV][ciphertext+tag]. */
export async function encryptMetadata(meta) {
  const key = await getVaultKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(meta));
  const ciphertext = new Uint8Array(
    await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );

  const payload = new Uint8Array(IV_LENGTH + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, IV_LENGTH);
  return bytesToBase64(payload);
}

/** Reverses encryptMetadata. Throws VaultLockedError for another peer's data. */
export async function decryptMetadata(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new VaultLockedError('No metadata to read');
  }

  let payload;
  try {
    payload = base64ToBytes(token);
  } catch (e) {
    throw new VaultLockedError('Metadata is not readable base64');
  }
  if (payload.length <= IV_LENGTH) {
    throw new VaultLockedError('Metadata payload is too short to contain an IV');
  }

  const key = await getVaultKey();
  try {
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.subarray(0, IV_LENGTH) },
      key,
      payload.subarray(IV_LENGTH)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (e) {
    throw new VaultLockedError('Metadata belongs to a different vault key');
  }
}

/**
 * Turns a stored record into one the UI can render, decrypting its metadata.
 * A record that cannot be opened comes back flagged `vaultLocked` with no
 * plaintext fields, so a locked file can never leak a name it shouldn't have.
 */
export async function hydrateFileRecord(record) {
  if (!record || typeof record !== 'object') return null;

  // Records written before metadata encryption keep their plaintext fields and
  // their own per-file key; leaving them alone keeps them openable.
  if (!record.meta) {
    return { ...record, vaultLocked: false, isLegacy: true };
  }

  try {
    const meta = await decryptMetadata(record.meta);
    return {
      ...record,
      name: typeof meta.name === 'string' ? meta.name : LOCKED_LABEL,
      size: typeof meta.size === 'number' ? meta.size : null,
      mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : null,
      vaultLocked: false,
    };
  } catch (e) {
    return {
      ...record,
      name: LOCKED_LABEL,
      size: null,
      mimeType: null,
      vaultLocked: true,
      lockedReason: e.message,
    };
  }
}

/**
 * The inverse projection: what actually gets written to Firestore or handed to
 * peers. Everything the UI added in memory is dropped, so no plaintext
 * filename, size, MIME type or thumbnail can escape this function.
 */
export function toStoredFileRecord(record) {
  if (!record.meta) {
    // Legacy record — persist as it was, minus transient UI state.
    const { unlocked, decryptedUrl, vaultLocked, isLegacy, lockedReason, ...rest } = record;
    return rest;
  }
  return {
    meta: record.meta,
    manifest: record.manifest,
    uploadedAt: record.uploadedAt,
  };
}

// Helper to convert File/Blob into a permanent Base64 Data URL
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function encryptAndShard(file, chunkSize = 1024 * 1024) {
  const key = await getVaultKey();

  const rawIv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const fileBuffer = await file.arrayBuffer();

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: rawIv },
    key,
    fileBuffer
  );

  // Prepend the IV so the distributed payload carries its own nonce:
  // [ 12-byte IV ][ ciphertext + 16-byte GCM tag ]
  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const payload = new Uint8Array(IV_LENGTH + encryptedBytes.length);
  payload.set(rawIv, 0);
  payload.set(encryptedBytes, IV_LENGTH);

  // Slice the IV-prefixed payload — chunk 0 therefore begins with the IV.
  const chunks = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    chunks.push(payload.slice(i, i + chunkSize));
  }

  // No thumbnail is produced: a 200px preview of an image is the image, and it
  // would have travelled to peers and Firestore in the clear.
  const mimeType = file.type;

  // IV is not secret and is already inside the payload; returned only so the
  // "Peer View" panel can show real bytes.
  const iv = Array.from(rawIv);

  return { chunks, iv, mimeType };
}

function joinChunks(chunks) {
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combinedBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combinedBuffer.set(chunk, offset);
    offset += chunk.length;
  }
  return combinedBuffer;
}

/**
 * Reassembles chunks, strips the leading 12-byte IV and decrypts with the
 * vault key. Pass `legacy` ({ exportedKey, iv }) for files written by the old
 * per-file-key scheme, where the IV lived in the metadata instead.
 */
export async function reassembleAndDecrypt(chunks, mimeType, legacy = null) {
  const combinedBuffer = joinChunks(chunks);

  let key;
  let iv;
  let ciphertext;

  if (legacy && legacy.exportedKey) {
    key = await window.crypto.subtle.importKey(
      'jwk',
      legacy.exportedKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    iv = new Uint8Array(Object.values(legacy.iv));
    ciphertext = combinedBuffer;
  } else {
    if (combinedBuffer.length <= IV_LENGTH) {
      throw new VaultLockedError('Payload is too short to contain an IV');
    }
    key = await getVaultKey();
    iv = combinedBuffer.subarray(0, IV_LENGTH);
    ciphertext = combinedBuffer.subarray(IV_LENGTH);
  }

  let decryptedBuffer;
  try {
    decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  } catch (e) {
    // AES-GCM authentication failed: wrong key, or the shards were altered.
    // WebCrypto deliberately gives no detail, so both surface as "locked".
    throw new VaultLockedError();
  }

  return URL.createObjectURL(new Blob([decryptedBuffer], { type: mimeType }));
}




//  it cant handle base 64 bit needs change of convertion
// export async function encryptAndShard(file, chunkSize = 1024 * 1024) {
//   const key = await window.crypto.subtle.generateKey(
//     { name: 'AES-GCM', length: 256 },
//     true,
//     ['encrypt', 'decrypt']
//   );
//   const iv = window.crypto.getRandomValues(new Uint8Array(12));
//   const fileBuffer = await file.arrayBuffer();

//   const encryptedBuffer = await window.crypto.subtle.encrypt(
//     { name: 'AES-GCM', iv },
//     key,
//     fileBuffer
//   );

//   const encryptedBytes = new Uint8Array(encryptedBuffer);
//   const chunks = [];
//   for (let i = 0; i < encryptedBytes.length; i += chunkSize) {
//     chunks.push(encryptedBytes.slice(i, i + chunkSize));
//   }

//   const exportedKey = await window.crypto.subtle.exportKey('jwk', key);
//   const thumbnail = URL.createObjectURL(file);
//   const mimeType = file.type;

//   return { chunks, exportedKey, iv, thumbnail, mimeType };
// }

// export async function reassembleAndDecrypt(chunks, exportedKey, iv, mimeType) {
//   const key = await window.crypto.subtle.importKey(
//     'jwk',
//     exportedKey,
//     { name: 'AES-GCM', length: 256 },
//     false,
//     ['decrypt']
//   );

//   const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
//   const combinedBuffer = new Uint8Array(totalLength);
//   let offset = 0;
//   for (const chunk of chunks) {
//     combinedBuffer.set(chunk, offset);
//     offset += chunk.length;
//   }

//   const decryptedBuffer = await window.crypto.subtle.decrypt(
//     { name: 'AES-GCM', iv },
//     key,
//     combinedBuffer
//   );

//   return URL.createObjectURL(new Blob([decryptedBuffer], { type: mimeType }));
// }