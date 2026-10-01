const MODEL_ID = 'Xenova/clip-vit-base-patch32';

const broadChoices = [
  { label: 'a clear photo of a meal, plate of food, or food ingredients', type: 'food' },
  { label: 'a clear photo of a drink in a glass, cup, or bottle', type: 'food' },
  { label: 'a photo showing food beside a phone or another everyday object', type: 'food' },
  { label: 'a clear photo of a fruit or vegetable', type: 'food' },
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
  'french fries', 'chocolate cake', 'cheesecake', 'cookie', 'donut', 'ice cream', 'yogurt', 'cereal', 'nuts', 'potato chips', 'coffee', 'espresso', 'latte', 'cappuccino',
  'black tea', 'tea with milk', 'milk', 'orange juice', 'apple juice', 'smoothie', 'cola', 'lemonade', 'water', 'milkshake'
];

let pipelinePromise;

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
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      onProgress?.('Loading the on-device photo model', 'This first download can take a little while. Your photo stays in the browser.');
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      const progress_callback = info => {
        if (info.status === 'progress_total' && Number.isFinite(info.progress)) {
          onProgress?.(`Preparing photo recognition · ${Math.floor(info.progress)}%`, 'Downloading the on-device model. Your photo stays in the browser.');
        } else if (info.status === 'download') {
          onProgress?.('Preparing photo recognition', 'Downloading the on-device model. Your photo stays in the browser.');
        }
      };
      try {
        return await pipeline('zero-shot-image-classification', MODEL_ID, { device: 'webgpu', dtype: 'q4f16', progress_callback });
      } catch {
        return await pipeline('zero-shot-image-classification', MODEL_ID, { device: 'wasm', dtype: 'q8', progress_callback });
      }
    })().catch(error => {
      pipelinePromise = null;
      throw error;
    });
  }
  return pipelinePromise;
}

export async function identifyPhoto(canvas, onProgress) {
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
  if (firstType === 'nonfood') return { status: 'nonfood' };
  if (firstType !== 'food') return { status: 'uncertain' };

  onProgress?.('Finding a likely food or drink', 'You will review the name and nutrition before saving.');
  const fine = await classifier(canvas, foods.map(name => `a photo of ${name}`));
  const ranked = [...fine].sort((a, b) => b.score - a.score);
  const labelToName = new Map(foods.map(name => [`a photo of ${name}`, name]));
  const match = ranked[0];
  const runnerUp = ranked[1];
  if (!match || match.score < 0.05 || (runnerUp && match.score - runnerUp.score < 0.006)) return { status: 'unknown' };
  const name = labelToName.get(match.label);
  const drink = /coffee|espresso|latte|cappuccino|tea|milk|juice|smoothie|cola|lemonade|water|milkshake/.test(name);
  return { status: 'food', name, kind: drink ? 'drink' : 'food', visualMatch: match.score };
}

