const OFF_SEARCH = 'https://world.openfoodfacts.org/cgi/search.pl';

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
    sourceUrl: product.code ? `https://world.openfoodfacts.org/product/${encodeURIComponent(product.code)}` : 'https://world.openfoodfacts.org/'
  };
}

export async function searchNutrition(query, { signal } = {}) {
  const term = String(query || '').trim();
  if (term.length < 2) return [];
  const url = new URL(OFF_SEARCH);
  url.searchParams.set('search_terms', term.slice(0, 100));
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', '8');
  url.searchParams.set('fields', 'product_name,product_name_en,brands,nutriments,serving_size,code');
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Nutrition lookup is temporarily unavailable (${response.status}).`);
  const data = await response.json();
  return (Array.isArray(data.products) ? data.products : []).map(normalizeProduct).filter(Boolean);
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

