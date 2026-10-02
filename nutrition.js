import { normalizeFoodName, searchLocalNutrition } from './food-library.js';

const OFF_TEXT_SEARCH = 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_PRODUCT_API = 'https://world.openfoodfacts.org/api/v3/product';
const remoteQueryCache = new Map();
let lastTextSearch = 0;
let textSearchQueue = Promise.resolve();
const textSearchInFlight = new Map();
let persistentCache = null;

export function setNutritionCache(cache) {
  persistentCache = cache;
}

async function getCached(key) {
  if (remoteQueryCache.has(key)) return remoteQueryCache.get(key);
  try {
    const record = await persistentCache?.getCachedNutrition(key);
    if (record?.products?.length) {
      remoteQueryCache.set(key, record.products);
      return record.products;
    }
  } catch { /* Local guide remains available if storage cannot be read. */ }
  return null;
}

async function saveCached(key, products) {
  if (!products?.length) return;
  remoteQueryCache.set(key, products);
  try { await persistentCache?.putCachedNutrition(key, products); } catch { /* Diary and library do not depend on the cache. */ }
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function getPer100(nutriments, nutrient, unit) {
  const key = `${nutrient}_100${unit}`;
  return numeric(nutriments?.[key]);
}

function normalizeProduct(product) {
  const n = product?.nutriments ?? {};
  const unit = numeric(n['energy-kcal_100ml']) !== null ? 'ml' : 'g';
  let kcal = getPer100(n, 'energy-kcal', unit);
  if (kcal === null) {
    const kj = numeric(n[`energy_100${unit}`]);
    if (kj !== null) kcal = kj / 4.184;
  }
  if (kcal === null) return null;
  const name = String(product.product_name || product.product_name_en || '').trim();
  if (!name) return null;
  return {
    name,
    brand: String(product.brands || '').trim(),
    code: String(product.code || ''),
    unit,
    kcalPer100: kcal,
    proteinPer100: getPer100(n, 'proteins', unit),
    carbsPer100: getPer100(n, 'carbohydrates', unit),
    fatPer100: getPer100(n, 'fat', unit),
    servingSize: String(product.serving_size || '').trim(),
    source: 'Open Food Facts',
    sourceType: 'Open Food Facts product data',
    confidence: 'medium',
    aliases: [],
    evidence: [{ value: kcal, unit: `kcal/100${unit}`, source: 'Open Food Facts', url: product.code ? `https://world.openfoodfacts.org/product/${encodeURIComponent(product.code)}` : 'https://world.openfoodfacts.org/' }],
    sourceUrl: product.code ? `https://world.openfoodfacts.org/product/${encodeURIComponent(product.code)}` : 'https://world.openfoodfacts.org/'
  };
}

export async function searchNutrition(query, { signal, forceRemote = false } = {}) {
  const term = String(query || '').trim();
  if (term.length < 2) return [];
  const local = searchLocalNutrition(term);
  if (!forceRemote && local[0]?.score === 100) return local;
  const cacheKey = `search:${normalizeFoodName(term)}`;
  const cached = await getCached(cacheKey);
  if (cached) return forceRemote ? cached : [...local, ...cached].slice(0, 8);

  // OFF's current v3 API supports barcode reads but not full-text product search.
  // Their v1 search endpoint is the documented full-text fallback; keep it to
  // explicit searches (never autocomplete) and below OFF's 10 requests/minute limit.
  let request = textSearchInFlight.get(cacheKey);
  if (!request) {
    const previous = textSearchQueue;
    request = previous.catch(() => {}).then(async () => {
      const delay = Math.max(0, 6500 - (Date.now() - lastTextSearch));
      if (delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(done, delay);
        function done() { signal?.removeEventListener('abort', aborted); resolve(); }
        function aborted() { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }
        signal?.addEventListener('abort', aborted, { once: true });
      });
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const url = new URL(OFF_TEXT_SEARCH);
    url.searchParams.set('search_terms', term.slice(0, 100));
    url.searchParams.set('search_simple', '1');
    url.searchParams.set('action', 'process');
    url.searchParams.set('json', '1');
    url.searchParams.set('page_size', '6');
    url.searchParams.set('fields', 'product_name,product_name_en,brands,nutriments,serving_size,code');
    lastTextSearch = Date.now();
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Nutrition lookup is temporarily unavailable (${response.status}).`);
    const data = await response.json();
    return (Array.isArray(data.products) ? data.products : []).map(normalizeProduct).filter(Boolean);
    });
    textSearchInFlight.set(cacheKey, request);
    textSearchQueue = request.catch(() => {});
  }
  try {
    const results = await request;
    await saveCached(cacheKey, results);
    return forceRemote ? results : [...local, ...results].slice(0, 8);
  } catch (error) {
    if (local.length) return local;
    throw error;
  } finally {
    if (textSearchInFlight.get(cacheKey) === request) textSearchInFlight.delete(cacheKey);
  }
}

export async function searchNutritionByBarcode(barcode, { signal } = {}) {
  const code = String(barcode || '').replace(/\D/g, '').slice(0, 14);
  if (code.length < 8) return [];
  const cacheKey = `barcode:${code}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;
  const url = new URL(`${OFF_PRODUCT_API}/${encodeURIComponent(code)}`);
  url.searchParams.set('fields', 'code,product_name,product_name_en,brands,nutriments,serving_size,product_quantity,product_quantity_unit');
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Product lookup is temporarily unavailable (${response.status}).`);
  const data = await response.json();
  const product = data.product ?? data.result?.product;
  const normalized = normalizeProduct({ ...product, code: product?.code || code });
  if (!normalized || data.status === 'failure' || data.status === 0) return [];
  normalized.packageWeight = numeric(product?.product_quantity);
  normalized.barcode = code;
  normalized.confidence = 'high';
  await saveCached(cacheKey, [normalized]);
  return [normalized];
}

export function calculateComponent(product, quantity) {
  const amount = Number(quantity);
  if (!product || !Number.isFinite(amount) || amount <= 0) return null;
  const scale = amount / 100;
  const scaled = (value, digits) => {
    if (value === null || value === undefined) return null;
    const factor = 10 ** digits;
    return Math.round(value * scale * factor) / factor;
  };
  return {
    kcal: scaled(product.kcalPer100, 0),
    protein: scaled(product.proteinPer100, 1),
    carbs: scaled(product.carbsPer100, 1),
    fat: scaled(product.fatPer100, 1)
  };
}

export function sumNutrition(components) {
  const fields = ['kcal', 'protein', 'carbs', 'fat'];
  return Object.fromEntries(fields.map(field => {
    const values = components.map(component => component[field]);
    if (!values.length || values.some(value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)))) return [field, null];
    return [field, values.reduce((total, value) => total + Number(value), 0)];
  }));
}
