import { Injectable } from '@angular/core';
import { BackendCalendarPayload } from '../models/wildfire.model';

const DB_NAME = 'kmd-wildfires-offline';
const DB_VERSION = 1;
const STORE_CALENDARS = 'calendarResponses';
const STORE_CUSTOM = 'customDatasets';
const CUSTOM_ACTIVE_KEY = 'activeCustomCsv';
const MAX_CACHED_CALENDARS = 40;

export interface CachedCalendarRecord {
  key: string;
  payload: BackendCalendarPayload;
  cachedAt: number;
}

export interface CachedCustomDatasetRecord {
  key: string;
  filename: string;
  rawText: string;
  cachedAt: number;
}

/**
 * Browser IndexedDB store for persisting `/api/calendar` payloads and custom uploaded
 * hotspot datasets across reloads and offline sessions.
 */
@Injectable({
  providedIn: 'root'
})
export class OfflineCacheService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private openDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase | null>(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_CALENDARS)) {
            const store = db.createObjectStore(STORE_CALENDARS, { keyPath: 'key' });
            store.createIndex('cachedAt', 'cachedAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_CUSTOM)) {
            db.createObjectStore(STORE_CUSTOM, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async getCalendar(key: string): Promise<CachedCalendarRecord | null> {
    const db = await this.openDb();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_CALENDARS, 'readonly');
        const req = tx.objectStore(STORE_CALENDARS).get(key);
        req.onsuccess = () => resolve((req.result as CachedCalendarRecord | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async putCalendar(key: string, payload: BackendCalendarPayload): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE_CALENDARS, 'readwrite');
        const store = tx.objectStore(STORE_CALENDARS);
        store.put({ key, payload, cachedAt: Date.now() } satisfies CachedCalendarRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    void this.pruneCalendars(db);
  }

  private async pruneCalendars(db: IDBDatabase): Promise<void> {
    try {
      const tx = db.transaction(STORE_CALENDARS, 'readwrite');
      const store = tx.objectStore(STORE_CALENDARS);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const total = countReq.result;
        if (total <= MAX_CACHED_CALENDARS) return;
        let toDelete = total - MAX_CACHED_CALENDARS;
        const idx = store.index('cachedAt');
        const curReq = idx.openCursor();
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (!cursor || toDelete <= 0) return;
          cursor.delete();
          toDelete -= 1;
          cursor.continue();
        };
      };
    } catch {
      // Ignore quota/transaction cleanup failures cleanly
    }
  }

  async getCustomDataset(): Promise<CachedCustomDatasetRecord | null> {
    const db = await this.openDb();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_CUSTOM, 'readonly');
        const req = tx.objectStore(STORE_CUSTOM).get(CUSTOM_ACTIVE_KEY);
        req.onsuccess = () => resolve((req.result as CachedCustomDatasetRecord | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async putCustomDataset(filename: string, rawText: string): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE_CUSTOM, 'readwrite');
        tx.objectStore(STORE_CUSTOM).put({
          key: CUSTOM_ACTIVE_KEY,
          filename,
          rawText,
          cachedAt: Date.now()
        } satisfies CachedCustomDatasetRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async clearCustomDataset(): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE_CUSTOM, 'readwrite');
        tx.objectStore(STORE_CUSTOM).delete(CUSTOM_ACTIVE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}
