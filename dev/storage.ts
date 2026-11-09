// Standalone-only persistence. The sandboxed add-on continues to use mnx.storage.
const fallback = new Map<string, string>()
let database: Promise<IDBDatabase> | undefined
function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('laboratory-standalone', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('settings-and-sessions')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}
export async function load(key: string): Promise<string | null> {
  try {
    const db = await open()
    return await new Promise((resolve, reject) => {
      const request = db.transaction('settings-and-sessions').objectStore('settings-and-sessions').get(key)
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
      request.onerror = () => reject(request.error)
    })
  } catch { return fallback.get(key) ?? null }
}
export async function save(key: string, value: string): Promise<void> {
  fallback.set(key, value)
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('settings-and-sessions', 'readwrite')
      transaction.objectStore('settings-and-sessions').put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } catch { /* private/storage-denied browsers retain the in-memory session */ }
}
export async function remove(key: string): Promise<boolean> {
  fallback.delete(key)
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('settings-and-sessions', 'readwrite')
      transaction.objectStore('settings-and-sessions').delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } catch { /* memory fallback */ }
  return true
}
export async function keys(): Promise<string[]> {
  try {
    const db = await open()
    return await new Promise((resolve, reject) => {
      const request = db.transaction('settings-and-sessions').objectStore('settings-and-sessions').getAllKeys()
      request.onsuccess = () => resolve(request.result.map(String))
      request.onerror = () => reject(request.error)
    })
  } catch { return [...fallback.keys()] }
}
