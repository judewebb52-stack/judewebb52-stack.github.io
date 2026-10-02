import { foodGuideRecords, normalizeFoodName } from './food-library.js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const OCR_MODULE = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/+esm';
const GUIDE_RECORDS = foodGuideRecords();

const broadChoices = [
  { label: 'a clear photo of a meal, plate of food, or food ingredients', type: 'food' },
  { label: 'a clear photo of a drink in a glass, cup, or bottle', type: 'food' },
  { label: 'a photo showing food beside a phone or another everyday object', type: 'food' },
  { label: 'a clear photo of a fruit or vegetable', type: 'food' },
  { label: 'a packaged food product with a printed label in a wrapper or box', type: 'package' },
  { label: 'a clear photo of an empty plate with no food', type: 'empty' },
  { label: 'a clear photo of an empty table or counter with no food', type: 'empty' },
  { label: 'a photo of a phone, laptop, computer, or screen', type: 'nonfood' },
  { label: 'a photo of a person or a group of people', type: 'nonfood' },
  { label: 'a photo of a pet or other animal', type: 'nonfood' },
  { label: 'a photo of a car, vehicle, machine, or tool', type: 'nonfood' },
  { label: 'a photo of a book, clothing, shoes, or household object', type: 'nonfood' },
  { label: 'a photo of a room, wall, floor, or scenery with no food', type: 'nonfood' },
  { label: 'a very dark, blurred, obstructed, or unusable photo', type: 'poor' }
];

const foods = [
  'apple', 'banana', 'orange', 'pear', 'grapes', 'strawberry', 'avocado', 'fruit salad', 'salad', 'tomato', 'broccoli', 'carrot', 'corn', 'mushrooms',
  'chicken breast', 'roast chicken', 'chicken curry', 'chicken and rice', 'beef steak', 'beef stew', 'hamburger', 'cheeseburger', 'hot dog', 'pork chop', 'bacon and eggs',
  'grilled salmon', 'fried fish', 'shrimp', 'sushi', 'fish and chips', 'rice', 'fried rice', 'pasta', 'spaghetti bolognese', 'lasagna', 'pizza', 'sandwich', 'toast',
  'bread', 'bagel', 'croissant', 'oatmeal porridge', 'pancakes', 'waffles', 'scrambled eggs', 'omelette', 'soup', 'curry', 'burrito', 'tacos', 'dumplings',
  'french fries', 'oven chips', 'flapjack', 'granola bar', 'cereal bar', 'chocolate cake', 'cheesecake', 'cookie', 'donut', 'ice cream', 'yogurt', 'cereal', 'nuts', 'potato chips', 'coffee', 'espresso', 'latte', 'cappuccino',
  'black tea', 'tea with milk', 'milk', 'orange juice', 'apple juice', 'smoothie', 'cola', 'lemonade', 'water', 'milkshake'
];

let pipelinePromise;
let pipelineLoaded = false;
let ocrModulePromise;
const pipelineProgressListeners = new Set();

export function inspectImageQuality(canvas) {
  const sample = document.createElement('canvas');
  sample.width = 72;
  sample.height = 72;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
  const { data } = ctx.getImageData(0, 0, sample.width, sample.height);
  const gray = new Float32Array(sample.width * sample.height);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    gray[p] = value;
    sum += value;
  }
  const mean = sum / gray.length;
  let variance = 0;
  for (const value of gray) variance += (value - mean) ** 2;
  variance /= gray.length;
  let lapSum = 0;
  let lapSquareSum = 0;
  let count = 0;
  for (let y = 1; y < sample.height - 1; y += 1) {
    for (let x = 1; x < sample.width - 1; x += 1) {
      const i = y * sample.width + x;
      const edge = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - sample.width] - gray[i + sample.width];
      lapSum += edge;
      lapSquareSum += edge * edge;
      count += 1;
    }
  }
  const sharpness = count ? lapSquareSum / count - (lapSum / count) ** 2 : 0;
  if (mean < 29) return { ok: false, reason: 'dark', mean, sharpness };
  if (variance < 18 || sharpness < 24) return { ok: false, reason: 'unclear', mean, sharpness };
  return { ok: true, mean, sharpness };
}

async function getPipeline(onProgress) {
  if (onProgress) pipelineProgressListeners.add(onProgress);
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      broadcastProgress('Loading photo recognition', 'The first setup may take a little while. Your photo stays on this device.');
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      const progress_callback = info => {
        if (info.status === 'progress_total' && Number.isFinite(info.progress)) {
          broadcastProgress(`Preparing photo recognition · ${Math.floor(info.progress)}%`, 'Downloading a small on-device model. Your photo stays on this device.');
        } else if (info.status === 'download') {
          broadcastProgress('Preparing photo recognition', 'Downloading a small on-device model. Your photo stays on this device.');
        }
      };
      try {
        const classifier = await pipeline('zero-shot-image-classification', MODEL_ID, { device: 'webgpu', dtype: 'q4f16', progress_callback });
        pipelineLoaded = true;
        pipelineProgressListeners.clear();
        return classifier;
      } catch {
        const classifier = await pipeline('zero-shot-image-classification', MODEL_ID, { device: 'wasm', dtype: 'q8', progress_callback });
        pipelineLoaded = true;
        pipelineProgressListeners.clear();
        return classifier;
      }
    })().catch(error => {
      pipelinePromise = null;
      pipelineLoaded = false;
      pipelineProgressListeners.clear();
      throw error;
    });
  }
  return pipelinePromise;
}

function broadcastProgress(title, message) {
  for (const listener of pipelineProgressListeners) listener(title, message);
}

export function warmPhotoAnalysis() {
  if (pipelineLoaded || !navigator.onLine) return;
  getPipeline().catch(() => {});
}

export function matchPackageLabel(text) {
  const normalized = normalizeFoodName(text);
  const tokens = new Set(normalized.split(' ').filter(Boolean));
  if (!tokens.size) return null;
  const hasTerm = word => tokens.has(word) || [...tokens].some(token => {
    if (word.startsWith(token) && token.length >= 4) return true;
    if (word.length < 5 || token.length < 5 || Math.abs(word.length - token.length) > 1) return false;
    let previous = Array.from({ length: token.length + 1 }, (_, index) => index);
    for (let i = 1; i <= word.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= token.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (word[i - 1] === token[j - 1] ? 0 : 1));
      previous = current;
    }
    return previous[token.length] <= 1;
  });
  const ranked = GUIDE_RECORDS.map(food => {
    const brand = normalizeFoodName(food.brand || '');
    const aliases = [food.name, ...(food.aliases || [])].map(normalizeFoodName);
    let score = 0;
    for (const alias of aliases) {
      const words = alias.split(' ').filter(word => word.length > 1);
      if (!words.length || !words.every(hasTerm)) continue;
      const aliasScore = words.length * 4 + (brand && hasTerm(brand) ? 8 : 0);
      score = Math.max(score, aliasScore);
    }
    if (brand && hasTerm(brand)) {
      const foodTerms = normalizeFoodName(food.name).split(' ').filter(word => word !== brand && !['plain', 'delicious', 'savers', 'british', 'fat', 'percent'].includes(word));
      const matchingFoodTerms = foodTerms.filter(hasTerm).length;
      if (matchingFoodTerms) score = Math.max(score, 12 + matchingFoodTerms * 3);
    }
    return { food, score };
  }).filter(item => item.score >= 4).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score && ranked[0].food.id !== ranked[1].food.id)) return null;
  return ranked[0].food;
}

async function readPackageLabel(canvas, onProgress) {
  onProgress?.('Reading the package label', 'Checking printed food text on this device; your photo is not uploaded.');
  try {
    if (typeof globalThis.TextDetector === 'function') {
      try {
        const detector = new globalThis.TextDetector();
        const text = await detector.detect(canvas);
        const match = matchPackageLabel(text.map(line => line.rawValue || '').join(' '));
        if (match) return match;
      } catch { /* Use the local OCR worker if the browser's text detector is unavailable. */ }
    }
    if (!ocrModulePromise) {
      ocrModulePromise = import(OCR_MODULE).catch(error => {
        ocrModulePromise = null;
        throw error;
      });
    }
    const { createWorker } = await ocrModulePromise;
    const worker = await createWorker('eng', 1, {
      logger: message => {
        if (message.status === 'recognizing text' && Number.isFinite(message.progress)) {
          onProgress?.(`Reading the package label · ${Math.floor(message.progress * 100)}%`, 'Text stays on this device.');
        }
      }
    });
    try {
      const result = await worker.recognize(canvas);
      return matchPackageLabel(result.data.text);
    } finally {
      await worker.terminate();
    }
  } catch {
    return null;
  }
}

export async function identifyPhoto(canvas, onProgress) {
  // Read obvious printed product names before downloading or starting the
  // large image model. This is both faster for packaged foods and avoids
  // letting a visual guess (e.g. fries) override readable package text.
  const packageFood = await readPackageLabel(canvas, onProgress);
  if (packageFood) return { status: 'food', name: packageFood.name, kind: 'food', labelMatch: true };
  const classifier = await getPipeline(onProgress);
  onProgress?.('Checking whether this is food', 'Looking for food or drink before suggesting anything.');
  const coarse = await classifier(canvas, broadChoices.map(choice => choice.label));
  const types = new Map(broadChoices.map(choice => [choice.label, choice.type]));
  const top = [...coarse].sort((a, b) => b.score - a.score);
  const first = top[0];
  const second = top[1];
  const firstType = types.get(first.label);
  const separation = first.score - (second?.score ?? 0);
  const decisive = first.score >= 0.20 && separation >= 0.04;
  if (!decisive) return { status: 'uncertain' };
  if (firstType === 'poor') return { status: 'unclear' };
  if (firstType === 'empty') return { status: 'empty' };
  // A wrapper can score as food (for example, fries) even when the broad
  // classifier also sees packaging. Read the label whenever packaging is a
  // plausible alternative, before asking CLIP to guess the food itself.
  const packageChoice = coarse.find(choice => types.get(choice.label) === 'package');
  const packageScore = packageChoice ? packageChoice.score : 0;
  const packagingPossible = firstType === 'package' || (packageScore >= 0.10 && first.score - packageScore <= 0.10);
  if (packagingPossible) {
    const latePackageFood = await readPackageLabel(canvas, onProgress);
    if (latePackageFood) return { status: 'food', name: latePackageFood.name, kind: 'food', visualMatch: first.score, labelMatch: true };
  }
  if (firstType === 'nonfood') return { status: 'nonfood' };
  if (firstType !== 'food' && firstType !== 'package') return { status: 'uncertain' };

  onProgress?.('Finding a likely food or drink', 'You will review the name and nutrition before saving.');
  const fineChoices = foods.map(name => ({ label: `a photo of ${name}`, name }));
  // CLIP often mistakes the wrapper image on a UK flapjack pack for chips.
  // Give wrapped oat bars a packaging-aware visual prompt, without claiming
  // that the model can read or verify the brand printed on the label.
  fineChoices.push(
    { label: 'a photo of a flapjack bar in a clear plastic wrapper', name: 'flapjack' },
    { label: 'a photo of packaged oat flapjack snack bar on its product packaging', name: 'flapjack' }
  );
  const fine = await classifier(canvas, fineChoices.map(choice => choice.label));
  const bestByFood = new Map();
  for (const result of fine) {
    const choice = fineChoices.find(item => item.label === result.label);
    if (choice && (!bestByFood.has(choice.name) || bestByFood.get(choice.name).score < result.score)) bestByFood.set(choice.name, { ...result, name: choice.name });
  }
  const ranked = [...bestByFood.values()].sort((a, b) => b.score - a.score);
  const match = ranked[0];
  const runnerUp = ranked[1];
  if (!match || match.score < 0.05 || (runnerUp && match.score - runnerUp.score < 0.006)) return { status: 'unknown' };
  const name = match.name;
  const drink = /coffee|espresso|latte|cappuccino|tea|milk|juice|smoothie|cola|lemonade|water|milkshake/.test(name);
  return { status: 'food', name, kind: drink ? 'drink' : 'food', visualMatch: match.score };
}

