const DATABASE = 'caloriesnap-local';
const VERSION = 3;
const LEGACY_KEY = 'caloriesnap-v4';

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('nutritionCache')) db.createObjectStore('nutritionCache', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local diary storage.'));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read local diary storage.'));
  });
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function createStore() {
  const db = await openDatabase();

  async function transaction(storeName, mode, callback) {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('Could not save your diary.'));
      tx.onabort = () => reject(tx.error ?? new Error('Your diary change was cancelled.'));
    });
    return result;
  }

  async function getDay(date) {
    return (await requestValue(db.transaction('days', 'readonly').objectStore('days').get(date))) ?? { date, entries: [] };
  }

  async function putDay(day) {
    await transaction('days', 'readwrite', store => store.put(day));
  }

  async function getAllDays() {
    return (await requestValue(db.transaction('days', 'readonly').objectStore('days').getAll())) ?? [];
  }

  async function getFood(id) {
    return (await requestValue(db.transaction('foods', 'readonly').objectStore('foods').get(id))) ?? null;
  }

  async function getAllFoods() {
    return (await requestValue(db.transaction('foods', 'readonly').objectStore('foods').getAll())) ?? [];
  }

  async function putFood(food) {
    await transaction('foods', 'readwrite', store => store.put(food));
  }

  async function deleteFood(id) {
    await transaction('foods', 'readwrite', store => store.delete(id));
  }

  async function getCachedNutrition(key) {
    return (await requestValue(db.transaction('nutritionCache', 'readonly').objectStore('nutritionCache').get(key))) ?? null;
  }

  async function putCachedNutrition(key, products) {
    await transaction('nutritionCache', 'readwrite', store => store.put({ key, products, cachedAt: new Date().toISOString() }));
  }

  async function getSettings() {
    const result = await requestValue(db.transaction('settings', 'readonly').objectStore('settings').get('preferences'));
    return result?.value ?? { calorieTarget: null };
  }

  async function saveSettings(value) {
    await transaction('settings', 'readwrite', store => store.put({ key: 'preferences', value }));
  }

  async function migrateLegacy() {
    let legacy;
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch { legacy = null; }
    if (!legacy || typeof legacy !== 'object') return;
    const existing = await getAllDays();
    if (existing.length) return;
    for (const [date, oldEntries] of Object.entries(legacy)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(oldEntries)) continue;
      const entries = oldEntries.filter(item => Number.isFinite(Number(item.kcal))).map(item => ({
        id: makeId(), name: String(item.name || 'Food').slice(0, 120), kcal: Number(item.kcal),
        protein: null, carbs: null, fat: null, time: String(item.time || '12:00'),
        category: 'Snacks', photo: null, components: [], note: 'Imported from an earlier CalorieSnap diary.',
        source: 'Previous diary entry'
      }));
      if (entries.length) await putDay({ date, entries });
    }
  }

  return { getDay, putDay, getAllDays, getFood, getAllFoods, putFood, deleteFood, getCachedNutrition, putCachedNutrition, getSettings, saveSettings, migrateLegacy, makeId };
}
