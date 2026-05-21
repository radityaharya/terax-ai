const DB_NAME = "terax-bg-images";
const STORE = "images";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putBgImage(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBgImage(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBgImage(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const MAX_DIM = 3840;
const JPEG_QUALITY = 0.88;
const MAX_ANIMATED_BYTES = 30 * 1024 * 1024;

const ANIMATED_TYPES = new Set(["image/gif", "image/webp", "image/apng"]);

function isAnimatedType(t: string): boolean {
  return ANIMATED_TYPES.has(t.toLowerCase());
}

export async function importBgImageFromFile(file: File): Promise<{ id: string; blob: Blob }> {
  const id = crypto.randomUUID();
  if (isAnimatedType(file.type)) {
    if (file.size > MAX_ANIMATED_BYTES) {
      throw new Error(
        `animated image exceeds ${Math.round(MAX_ANIMATED_BYTES / 1024 / 1024)}MB limit`,
      );
    }
    const blob = file.slice(0, file.size, file.type);
    await putBgImage(id, blob);
    return { id, blob };
  }
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("canvas 2D context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("failed to encode image"))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
  await putBgImage(id, blob);
  return { id, blob };
}
