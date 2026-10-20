/**
 * Armazenamento seguro: IndexedDB + Web Crypto API.
 *
 * - A chave AES-256-GCM é derivada da senha mestra com PBKDF2-SHA-256.
 * - A chave é "não extraível" e só existe em memória enquanto o cofre está aberto.
 * - Cada registro é cifrado com um IV aleatório e vinculado ao seu ID (AAD),
 *   impedindo a troca de registros cifrados entre si.
 */

const DB_NAME = 'faceid-seguro';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_PEOPLE = 'people';
const VAULT_KEY = 'vault';
const VERIFIER_TEXT = 'faceid-seguro:vault-ok:v1';
export const PBKDF2_ITERATIONS = 600_000;
const BACKUP_FORMAT = 'faceid-seguro-backup';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class WrongPasswordError extends Error {
  constructor() {
    super('Senha incorreta.');
    this.name = 'WrongPasswordError';
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('O cofre está bloqueado.');
    this.name = 'VaultLockedError';
  }
}

let cryptoKey = null;
let dbPromise = null;

export function isSupported() {
  return Boolean(globalThis.indexedDB && globalThis.crypto?.subtle && globalThis.isSecureContext);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_PEOPLE)) db.createObjectStore(STORE_PEOPLE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(new Error('Não foi possível abrir o banco de dados local (IndexedDB). Verifique se o navegador não está em modo que bloqueia armazenamento.')); };
    req.onblocked = () => reject(new Error('O banco de dados está aberto em outra aba. Feche as outras abas do sistema e tente novamente.'));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Falha na transação do banco de dados.'));
    tx.onabort = () => reject(tx.error || new Error('Transação do banco de dados abortada (espaço insuficiente?).'));
  });
}

async function getMeta() {
  const db = await openDb();
  return reqToPromise(db.transaction(STORE_META).objectStore(STORE_META).get(VAULT_KEY));
}

async function deriveKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptWith(key, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return { iv, data: new Uint8Array(data) };
}

async function decryptWith(key, { iv, data }, aad) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    data,
  );
  return dec.decode(plain);
}

function requireKey() {
  if (!cryptoKey) throw new VaultLockedError();
  return cryptoKey;
}

async function buildVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const verifier = await encryptWith(key, VERIFIER_TEXT, VAULT_KEY);
  return { key, meta: { version: 1, salt, iterations: PBKDF2_ITERATIONS, verifier, createdAt: new Date().toISOString() } };
}

/* ------------------------------ API pública ------------------------------ */

export async function isVaultInitialized() {
  return Boolean(await getMeta());
}

export function isUnlocked() {
  return cryptoKey !== null;
}

export async function createVault(password) {
  if (await isVaultInitialized()) throw new Error('O cofre já existe.');
  const { key, meta } = await buildVault(password);
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put(meta, VAULT_KEY);
  await txDone(tx);
  cryptoKey = key;
  try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
}

export async function unlock(password) {
  const meta = await getMeta();
  if (!meta) throw new Error('Cofre não encontrado.');
  const key = await deriveKey(password, meta.salt, meta.iterations);
  try {
    const text = await decryptWith(key, meta.verifier, VAULT_KEY);
    if (text !== VERIFIER_TEXT) throw new WrongPasswordError();
  } catch {
    throw new WrongPasswordError();
  }
  cryptoKey = key;
}

export function lock() {
  cryptoKey = null;
}

export async function listPeople() {
  const key = requireKey();
  const db = await openDb();
  const records = await reqToPromise(db.transaction(STORE_PEOPLE).objectStore(STORE_PEOPLE).getAll());
  const people = [];
  let corrupted = 0;
  for (const rec of records) {
    try {
      people.push(JSON.parse(await decryptWith(key, rec, rec.id)));
    } catch {
      corrupted += 1;
    }
  }
  people.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { people, corrupted };
}

export async function savePerson(person) {
  const key = requireKey();
  if (!person?.id) throw new Error('Registro inválido.');
  const { iv, data } = await encryptWith(key, JSON.stringify(person), person.id);
  const db = await openDb();
  const tx = db.transaction(STORE_PEOPLE, 'readwrite');
  tx.objectStore(STORE_PEOPLE).put({ id: person.id, iv, data });
  await txDone(tx);
}

export async function deletePerson(id) {
  requireKey();
  const db = await openDb();
  const tx = db.transaction(STORE_PEOPLE, 'readwrite');
  tx.objectStore(STORE_PEOPLE).delete(id);
  await txDone(tx);
}

export async function changePassword(oldPassword, newPassword) {
  await unlock(oldPassword);
  const oldKey = requireKey();
  const db = await openDb();
  const records = await reqToPromise(db.transaction(STORE_PEOPLE).objectStore(STORE_PEOPLE).getAll());
  const { key: newKey, meta } = await buildVault(newPassword);
  const reEncrypted = [];
  for (const rec of records) {
    const plain = await decryptWith(oldKey, rec, rec.id);
    const { iv, data } = await encryptWith(newKey, plain, rec.id);
    reEncrypted.push({ id: rec.id, iv, data });
  }
  const tx = db.transaction([STORE_META, STORE_PEOPLE], 'readwrite');
  tx.objectStore(STORE_META).put(meta, VAULT_KEY);
  const store = tx.objectStore(STORE_PEOPLE);
  reEncrypted.forEach((r) => store.put(r));
  await txDone(tx);
  cryptoKey = newKey;
}

export async function wipeAll() {
  cryptoKey = null;
  if (dbPromise) {
    try { (await dbPromise).close(); } catch { /* ignore */ }
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new Error('Não foi possível apagar o banco de dados.'));
    req.onblocked = () => reject(new Error('Feche as outras abas do sistema para apagar os dados.'));
  });
}

/* ------------------------------ Backup ------------------------------ */

const toB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const packEnc = ({ iv, data }) => ({ iv: toB64(new Uint8Array(iv)), data: toB64(new Uint8Array(data)) });
const unpackEnc = ({ iv, data }) => ({ iv: fromB64(iv), data: fromB64(data) });

/** Exporta os dados ainda cifrados. Só podem ser lidos com a senha mestra. */
export async function exportBackup() {
  requireKey();
  const meta = await getMeta();
  const db = await openDb();
  const records = await reqToPromise(db.transaction(STORE_PEOPLE).objectStore(STORE_PEOPLE).getAll());
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    vault: {
      version: meta.version,
      salt: toB64(new Uint8Array(meta.salt)),
      iterations: meta.iterations,
      verifier: packEnc(meta.verifier),
      createdAt: meta.createdAt,
    },
    people: records.map((r) => ({ id: r.id, ...packEnc(r) })),
  };
}

/** Substitui todos os dados locais pelo backup informado. */
export async function importBackup(backup) {
  const isStr = (v) => typeof v === 'string' && v.length > 0;
  const validEnc = (e) => e && isStr(e.iv) && isStr(e.data);
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== 1) throw new Error('Arquivo de backup inválido ou de versão não suportada.');
  const v = backup.vault;
  if (!v || !isStr(v.salt) || !Number.isInteger(v.iterations) || v.iterations < 100_000 || !validEnc(v.verifier)) throw new Error('Backup corrompido (cofre).');
  if (!Array.isArray(backup.people) || !backup.people.every((p) => isStr(p.id) && validEnc(p))) throw new Error('Backup corrompido (registros).');

  let meta;
  let people;
  try {
    meta = { version: 1, salt: fromB64(v.salt), iterations: v.iterations, verifier: unpackEnc(v.verifier), createdAt: v.createdAt || new Date().toISOString() };
    people = backup.people.map((p) => ({ id: p.id, ...unpackEnc(p) }));
  } catch {
    throw new Error('Backup corrompido (codificação inválida).');
  }
  cryptoKey = null;
  const db = await openDb();
  const tx = db.transaction([STORE_META, STORE_PEOPLE], 'readwrite');
  tx.objectStore(STORE_META).put(meta, VAULT_KEY);
  const store = tx.objectStore(STORE_PEOPLE);
  store.clear();
  people.forEach((p) => store.put(p));
  await txDone(tx);
  return people.length;
}
