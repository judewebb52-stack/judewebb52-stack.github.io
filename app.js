import { createStore, localDateKey } from './storage.js';
import { calculateComponent, searchNutrition, searchNutritionByBarcode, setNutritionCache, sumNutrition } from './nutrition.js';
import { normalizeFoodName, searchLocalNutrition } from './food-library.js';
import { identifyPhoto, inspectImageQuality, warmPhotoAnalysis } from './vision.js';

const $ = id => document.getElementById(id);
const state = {
  store: null, settings: { calorieTarget: null }, today: null, activeDate: '',
  stream: null, photo: null, draft: null, editorHost: null, foodRecords: [], foodResearchCandidate: null,
  editing: null, currentDetail: null, toastTimer: null, selectedView: 'today'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function prettyNumber(value, digits = 0) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function dateTitle(key, options = { weekday: 'long', month: 'long', day: 'numeric' }) {
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, options).format(new Date(year, month - 1, day));
}

function currentTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function suggestedMeal() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return 'Breakfast';
  if (hour >= 11 && hour < 15) return 'Lunch';
  if (hour >= 17 && hour < 22) return 'Dinner';
  return 'Snacks';
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function kcalTotal(entries) {
  return entries.reduce((total, entry) => total + (Number(entry.kcal) || 0), 0);
}

function macroTotal(entries, name) {
  const values = entries.map(entry => entry[name]);
  if (!values.length || values.some(value => value === null || value === undefined || !Number.isFinite(Number(value)))) return null;
  return values.reduce((total, value) => total + Number(value), 0);
}

async function refresh() {
  const key = localDateKey();
  state.activeDate = key;
  [state.today, state.settings] = await Promise.all([state.store.getDay(key), state.store.getSettings()]);
  renderToday();
  if (state.selectedView === 'history') await renderHistory();
  if (state.selectedView === 'foods') await renderFoods();
}

function renderToday() {
  const entries = state.today?.entries ?? [];
  const total = kcalTotal(entries);
  const goal = Number(state.settings.calorieTarget) || null;
  $('todayDate').textContent = dateTitle(state.activeDate, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  $('dailyTotal').textContent = Math.round(total).toLocaleString();
  $('targetLabel').textContent = goal ? `GOAL ${goal.toLocaleString()}` : '';
  $('targetButton').innerHTML = goal ? `Daily goal <span aria-hidden="true">${goal.toLocaleString()}</span>` : 'Set daily goal <span aria-hidden="true">＋</span>';
  $('targetButton').setAttribute('aria-label', goal ? `Change daily calorie target, ${goal} kilocalories` : 'Set daily calorie target');
  $('progressTrack').hidden = !goal;
  if (goal) {
    const percentage = Math.min(100, Math.round(total / goal * 100));
    $('progressFill').style.width = `${percentage}%`;
    $('progressTrack').setAttribute('aria-valuenow', String(percentage));
    $('dailySubline').textContent = total <= goal ? `${Math.round(goal - total).toLocaleString()} kcal remaining` : `${Math.round(total - goal).toLocaleString()} kcal over your goal`;
  } else {
    $('dailySubline').textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'food' : 'foods'} in your journal today` : 'A fresh page. Start with a photo.';
  }

  const grouped = new Map(['Breakfast', 'Lunch', 'Dinner', 'Snacks'].map(name => [name, []]));
  for (const entry of entries) (grouped.get(entry.category) ?? grouped.get('Snacks')).push(entry);
  const visibleGroups = [...grouped].filter(([, items]) => items.length);
  if (!visibleGroups.length) {
    $('diaryList').innerHTML = '<div class="empty-state"><div class="empty-illustration" aria-hidden="true">＋</div><div><strong>Nothing here yet</strong><p>Take a photo of what you ate. You will review every suggestion before it enters your diary.</p></div></div>';
    return;
  }
  $('diaryList').innerHTML = visibleGroups.map(([group, items]) => `<section class="meal-group" aria-label="${group}">
    <div class="meal-group-head"><span>${group}</span><span class="meal-count">${items.length} ${items.length === 1 ? 'entry' : 'entries'}</span></div>
    ${items.map(entry => `<button class="meal-row" type="button" data-entry="${escapeHtml(entry.id)}" data-date="${state.activeDate}" aria-label="${escapeHtml(entry.name)}, ${Math.round(Number(entry.kcal) || 0)} kilocalories, ${escapeHtml(entry.time)}">
      ${entry.photo ? `<img class="meal-photo" src="${entry.photo}" alt="">` : '<span class="meal-photo meal-placeholder" aria-hidden="true">◌</span>'}
      <span class="meal-info"><span class="meal-name">${escapeHtml(entry.name)}</span><span class="meal-meta">${escapeHtml(entry.time)}</span></span>
      <span class="meal-kcal">${Math.round(Number(entry.kcal) || 0).toLocaleString()} <small>kcal</small></span>
    </button>`).join('')}
  </section>`).join('');
}

async function renderHistory() {
  const today = localDateKey();
  const days = (await state.store.getAllDays()).filter(day => day.entries?.length).sort((a, b) => b.date.localeCompare(a.date));
  $('historyList').innerHTML = days.length ? days.map(day => `<section class="history-day">
    <button class="history-day-button" type="button" data-history-date="${day.date}" aria-label="Open diary for ${escapeHtml(dateTitle(day.date))}">
      <span class="history-day-title"><strong>${escapeHtml(day.date === today ? 'Today' : dateTitle(day.date))}</strong><span>${day.entries.length} ${day.entries.length === 1 ? 'entry' : 'entries'}</span></span>
      <span class="history-day-total">${Math.round(kcalTotal(day.entries)).toLocaleString()} kcal</span>
    </button>
    <div class="history-preview">${day.entries.slice(0, 3).map(entry => escapeHtml(entry.name)).join(' · ')}${day.entries.length > 3 ? ` · +${day.entries.length - 3} more` : ''}</div>
  </section>`).join('') : '<div class="empty-state"><div class="empty-illustration" aria-hidden="true">◷</div><div><strong>Your story starts today</strong><p>Saved meals will appear here, grouped by date.</p></div></div>';
}

function whenUsed(value) {
  if (!value) return 'Not used yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : `Last used ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

function foodCard(food) {
  const portion = Number(food.caloriesPerServing) > 0
    ? `~${Math.round(food.caloriesPerServing)} kcal${food.typicalServingSize ? ` · ${food.typicalServingSize} ${food.unit || 'g'}` : ''}`
    : food.kcalPer100 !== null && food.kcalPer100 !== undefined ? `${Math.round(food.kcalPer100)} kcal / 100 ${food.unit || 'g'}` : 'Nutrition needs review';
  return `<button class="food-library-card" type="button" data-food-detail="${escapeHtml(food.id)}">
    <span class="food-card-main"><strong>${escapeHtml(food.name)}</strong><span>${escapeHtml([food.brand, food.category].filter(Boolean).join(' · ') || 'Saved food')}</span></span>
    <span class="food-card-meta"><strong>${escapeHtml(portion)}</strong><span>${escapeHtml(whenUsed(food.lastUsed))} · used ${Math.max(0, Number(food.usageCount) || 0)}×</span></span>
  </button>`;
}

async function renderFoods(query = $('foodLibrarySearch')?.value || '') {
  if (!state.store || !$('foodLibraryList')) return;
  state.foodRecords = await state.store.getAllFoods();
  const term = normalizeFoodName(query);
  const foods = [...state.foodRecords].sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
  const matches = term ? foods.filter(food => [food.name, food.brand, ...(food.aliases || [])].some(name => normalizeFoodName(name).includes(term))) : foods;
  if (!matches.length) {
    $('foodLibraryList').innerHTML = `<div class="empty-state"><div class="empty-illustration" aria-hidden="true">⌕</div><div><strong>${term ? 'No saved food found' : 'Your Food Library is ready'}</strong><p>${term ? 'Try another name, brand, or alias.' : 'After you confirm a food in your diary, CalorieSnap keeps its nutrition here for quick offline estimates.'}</p></div></div>`;
    return;
  }
  if (term) {
    $('foodLibraryList').innerHTML = `<section class="food-library-group"><div class="meal-group-head">Search results <span class="meal-count">${matches.length}</span></div>${matches.map(foodCard).join('')}</section>`;
    return;
  }
  const recent = matches.slice(0, 5);
  const frequent = [...matches].sort((a, b) => (Number(b.usageCount) || 0) - (Number(a.usageCount) || 0) || String(b.lastUsed || '').localeCompare(String(a.lastUsed || ''))).slice(0, 5);
  const recentIds = new Set(recent.map(food => food.id));
  const extraFrequent = frequent.filter(food => !recentIds.has(food.id));
  $('foodLibraryList').innerHTML = `${recent.length ? `<section class="food-library-group"><div class="meal-group-head">Recently used</div>${recent.map(foodCard).join('')}</section>` : ''}
    ${extraFrequent.length ? `<section class="food-library-group"><div class="meal-group-head">Frequently used</div>${extraFrequent.map(foodCard).join('')}</section>` : ''}
    <section class="food-library-group"><div class="meal-group-head">Saved foods <span class="meal-count">${matches.length}</span></div>${matches.map(foodCard).join('')}</section>`;
}

function foodRecordToProduct(food) {
  return {
    ...food, name: food.name, brand: food.brand || '', code: food.barcode || '',
    unit: food.unit || 'g', kcalPer100: food.kcalPer100 ?? null,
    proteinPer100: food.proteinPer100 ?? null, carbsPer100: food.carbsPer100 ?? null,
    fatPer100: food.fatPer100 ?? null, source: food.source || 'Your Food Library',
    sourceUrl: food.sourceUrl || '', libraryFoodId: food.id, isLibrary: true,
    defaultPortion: food.typicalServingSize || null, portionLabel: food.portionLabel || '',
    packageWeight: food.packageWeight || null, caloriesPerServing: food.caloriesPerServing ?? null
  };
}

function foodMatchScore(query, food) {
  const term = normalizeFoodName(query);
  if (!term) return 0;
  const names = [food.name, food.brand ? `${food.brand} ${food.name}` : '', ...(food.aliases || [])].filter(Boolean).map(normalizeFoodName);
  if (food.barcode && term === String(food.barcode)) return 1000;
  if (names.includes(term)) return 100;
  // Approximate matching is reserved for short typos of a full saved name.
  // Never let a generic word such as "flapjack" match a branded product.
  if (food.brand && !term.includes(normalizeFoodName(food.brand))) return 0;
  const similarity = names.map(name => {
    const left = term.replace(/ /g, '');
    const right = name.replace(/ /g, '');
    if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 2) return 0;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= right.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
    const score = 100 * (1 - previous[right.length] / Math.max(left.length, right.length));
    return score >= 88 ? Math.round(score) : 0;
  });
  return Math.max(0, ...similarity);
}

async function findLibraryMatch(query) {
  const foods = await state.store.getAllFoods();
  const ranked = foods.map(food => ({ food, score: foodMatchScore(query, food) })).filter(item => item.score >= 90).sort((a, b) => Number(b.food.userConfirmed) - Number(a.food.userConfirmed) || b.score - a.score || (Number(b.food.usageCount) || 0) - (Number(a.food.usageCount) || 0));
  if (!ranked.length) return null;
  if (ranked[0].score === 1000) return ranked[0].food;
  const exactMatches = ranked.filter(item => item.score === 100);
  if (exactMatches.length > 1) {
    const recipes = exactMatches.filter(item => item.food.recipeSignature);
    if (recipes.length === 1) return recipes[0].food;
    return null;
  }
  return ranked[0].food;
}

function updateFoodLibraryUsage(product, component, category) {
  if (!component) return Promise.resolve();
  product ||= { name: component.name, unit: component.unit || 'g', source: component.source || 'Entered by you', sourceType: 'user confirmed', confidence: 'medium' };
  const now = new Date().toISOString();
  return (async () => {
    const oldId = product.libraryFoodId || product.id;
    const old = oldId ? await state.store.getFood(oldId) : null;
    const id = old?.id || product.id || state.store.makeId();
    const amount = Number(component.amount) > 0 ? Number(component.amount) : Number(product.defaultPortion) || null;
    const scale = amount && product.unit ? 100 / amount : null;
    const keepConfirmedEvidence = Boolean(old?.userConfirmed && !component.manualOverride);
    const enteredPer100 = scale ? Number(component.kcal) * scale : null;
    const record = {
      ...(old || {}), id,
      name: String(component.name || product.name || 'Food').trim(),
      brand: product.brand || old?.brand || '', barcode: product.barcode || product.code || old?.barcode || '',
      category: category || old?.category || 'Food', unit: product.unit || 'g',
      kcalPer100: keepConfirmedEvidence ? old.kcalPer100 : (product.kcalPer100 ?? (scale ? enteredPer100 : old?.kcalPer100 ?? null)),
      proteinPer100: keepConfirmedEvidence ? old.proteinPer100 : (product.proteinPer100 ?? (scale && component.protein !== '' ? Number(component.protein) * scale : old?.proteinPer100 ?? null)),
      carbsPer100: keepConfirmedEvidence ? old.carbsPer100 : (product.carbsPer100 ?? (scale && component.carbs !== '' ? Number(component.carbs) * scale : old?.carbsPer100 ?? null)),
      fatPer100: keepConfirmedEvidence ? old.fatPer100 : (product.fatPer100 ?? (scale && component.fat !== '' ? Number(component.fat) * scale : old?.fatPer100 ?? null)),
      caloriesPerServing: Number(component.kcal), typicalServingSize: amount,
      portionLabel: product.portionLabel || old?.portionLabel || '',
      packageWeight: product.packageWeight ?? old?.packageWeight ?? null,
      source: component.manualOverride ? 'Corrected by you' : (product.source || old?.source || 'Entered by you'), sourceType: component.manualOverride ? 'user-confirmed correction' : (product.sourceType || old?.sourceType || 'user confirmed'),
      sourceUrl: product.sourceUrl || old?.sourceUrl || '', confidence: old?.confidence || product.confidence || 'medium',
      evidence: component.manualOverride ? [...(old?.evidence || product.evidence || []), { value: Number(component.kcal), unit: amount ? `kcal/${amount}${product.unit || 'g'} serving` : 'kcal/portion', source: 'User-confirmed correction', url: '' }] : (old?.evidence?.length ? old.evidence : product.evidence || []),
      aliases: [...new Set([...(old?.aliases || []), ...(product.aliases || []), component.name].filter(Boolean))],
      usageCount: (Number(old?.usageCount) || 0) + 1,
      firstSeen: old?.firstSeen || now, lastUsed: now, lastResearched: old?.lastResearched || null,
      userConfirmed: true,
      image: old?.image || null,
      userValue: component.manualOverride ? { kcal: Number(component.kcal), kcalPer100: enteredPer100, amount, unit: product.unit || 'g' } : (old?.userValue || { kcal: Number(component.kcal), amount, unit: product.unit || 'g' })
    };
    await state.store.putFood(record);
    return record;
  })();
}

async function openFoodDetail(id) {
  const food = await state.store.getFood(id);
  if (!food) return;
  const recipeIngredients = Array.isArray(food.recipeIngredients) && food.recipeIngredients.length
    ? `<div class="status-card"><strong>Saved recipe</strong>${food.recipeIngredients.map(item => `<p>${escapeHtml(item.name)} · ${escapeHtml(item.amount ?? 'amount unknown')} ${escapeHtml(item.unit || '')} · ${prettyNumber(item.kcal)} kcal</p>`).join('')}</div>`
    : '';
  $('foodDetailContent').innerHTML = `<p class="eyebrow">${food.userConfirmed ? 'CONFIRMED BY YOU' : 'SAVED FOOD'}</p>
    <h2 id="foodDetailHeading" class="detail-title">${escapeHtml(food.name)}</h2>
    <div class="food-detail-stats"><span>${food.unit === 'serving' ? `~${Math.round(Number(food.caloriesPerServing) || 0)} kcal / usual serving` : `${Math.round(Number(food.kcalPer100) || 0)} kcal / 100 ${escapeHtml(food.unit || 'g')}`}</span><span>Used ${Number(food.usageCount) || 0} times</span></div>
    <label class="field-label" for="foodEditName">Food name</label><input id="foodEditName" class="text-input" maxlength="120" value="${escapeHtml(food.name)}">
    <label class="field-label" for="foodEditBrand">Brand</label><input id="foodEditBrand" class="text-input" maxlength="80" value="${escapeHtml(food.brand || '')}">
    <label class="field-label" for="foodEditBarcode">Barcode</label><div class="search-row"><input id="foodEditBarcode" class="text-input" inputmode="numeric" maxlength="14" value="${escapeHtml(food.barcode || '')}" placeholder="Optional barcode"><button class="search-button" type="button" data-food-action="barcode">Look up</button></div>
    <div class="food-edit-nutrients"><label><span class="field-label">${food.unit === 'serving' ? 'Calories per usual serving' : `kcal / 100 ${escapeHtml(food.unit || 'g')}`}</span><input id="foodEditKcal" class="text-input" inputmode="decimal" type="number" min="0" value="${escapeHtml(food.unit === 'serving' ? food.caloriesPerServing ?? '' : food.kcalPer100 ?? '')}"></label>
    <label><span class="field-label">Typical portion ${escapeHtml(food.unit || 'g')}</span><input id="foodEditPortion" class="text-input" inputmode="decimal" type="number" min="0" value="${escapeHtml(food.typicalServingSize ?? '')}"></label></div>
    <div class="food-edit-nutrients">${[['protein','Protein'],['carbs','Carbs'],['fat','Fat']].map(([key,label])=>`<label><span class="field-label">${label} / 100g</span><input id="foodEdit${key}" class="text-input" inputmode="decimal" type="number" min="0" value="${escapeHtml(food[`${key}Per100`] ?? '')}"></label>`).join('')}</div>
    <label class="field-label" for="foodEditAliases">Also known as</label><textarea id="foodEditAliases" class="text-input food-aliases" rows="2">${escapeHtml((food.aliases || []).join(', '))}</textarea>
    ${recipeIngredients}<div class="status-card"><strong>Evidence</strong><p>${escapeHtml(food.source || 'No source saved')} · ${escapeHtml(food.sourceType || 'unspecified')} · ${escapeHtml(food.confidence || 'unrated')} confidence</p>${(food.evidence || []).map(item => `<p>${escapeHtml(item.value)} ${escapeHtml(item.unit || '')} · ${escapeHtml(item.source || '')}${item.url ? ` · <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">source</a>` : ''}</p>`).join('')}<p>First saved ${escapeHtml(food.firstSeen ? new Date(food.firstSeen).toLocaleDateString() : 'unknown')}${food.lastResearched ? ` · researched ${escapeHtml(new Date(food.lastResearched).toLocaleDateString())}` : ''}</p></div>
    <div id="foodResearchConflict"></div>
    <div id="foodResearchResults"></div>
    <button class="primary-button" type="button" data-food-action="save" data-food-id="${escapeHtml(food.id)}">Save changes</button>
    <button class="secondary-button" type="button" data-food-action="confirm" data-food-id="${escapeHtml(food.id)}">Mark confirmed by me</button>
    <button class="secondary-button" type="button" data-food-action="research" data-food-id="${escapeHtml(food.id)}">Research again</button>
    <button class="quiet-button danger-text" type="button" data-food-action="delete" data-food-id="${escapeHtml(food.id)}">Delete food</button>`;
  $('foodDetailScreen').hidden = false;
}

function foodEditValues(food) {
  const amount = Number($('foodEditPortion').value) || null;
  const kcalPer100 = Number($('foodEditKcal').value);
  const caloriesPerServing = food.unit === 'serving'
    ? (Number.isFinite(kcalPer100) && $('foodEditKcal').value !== '' ? kcalPer100 : food.caloriesPerServing)
    : (amount && Number.isFinite(kcalPer100) ? Math.round(kcalPer100 * amount / 100) : food.caloriesPerServing);
  return {
    ...food,
    name: $('foodEditName').value.trim() || food.name,
    brand: $('foodEditBrand').value.trim(), barcode: $('foodEditBarcode').value.replace(/\D/g, '').slice(0, 14),
    kcalPer100: food.unit === 'serving' ? null : Number.isFinite(kcalPer100) && $('foodEditKcal').value !== '' ? kcalPer100 : null,
    typicalServingSize: amount, caloriesPerServing,
    proteinPer100: $('foodEditprotein').value === '' ? null : Number($('foodEditprotein').value),
    carbsPer100: $('foodEditcarbs').value === '' ? null : Number($('foodEditcarbs').value),
    fatPer100: $('foodEditfat').value === '' ? null : Number($('foodEditfat').value),
    aliases: $('foodEditAliases').value.split(',').map(alias => alias.trim()).filter(Boolean)
  };
}

function foodEditUserValue(food) {
  const calorieValue = $('foodEditKcal').value === '' ? null : Number($('foodEditKcal').value);
  const typicalServingSize = Number($('foodEditPortion').value) || null;
  return food.unit === 'serving'
    ? { caloriesPerServing: calorieValue, typicalServingSize }
    : { kcalPer100: calorieValue, typicalServingSize };
}

function displayFoodResearchCandidate(food, candidate) {
  state.foodResearchCandidate = candidate;
  const before = Number(food.kcalPer100);
  const after = Number(candidate.kcalPer100);
  const change = before > 0 ? Math.abs(after - before) / before : 1;
  $('foodResearchConflict').innerHTML = `<div class="status-card ${change > 0.05 ? 'warning' : ''}">
    <strong>${food.userConfirmed ? 'Existing confirmed food found' : 'New nutrition information'}</strong>
    <p>Saved: ${Number.isFinite(before) ? `${Math.round(before)} kcal / 100 ${escapeHtml(food.unit || 'g')}` : 'no per-100 value'}${food.userConfirmed ? ' · confirmed by you' : ''}</p>
    <p>Research: ${Number.isFinite(after) ? `${Math.round(after)} kcal / 100 ${escapeHtml(candidate.unit || 'g')}` : 'no usable calorie value'} · ${escapeHtml(candidate.source || '')}</p>
    ${food.userConfirmed && change > 0.05 ? '<p>These values differ substantially. Choose what to keep; CalorieSnap will not replace your confirmed value automatically.</p>' : '<p>Review the source before updating the saved value.</p>'}
    <div class="food-conflict-actions"><button class="secondary-button" type="button" data-food-action="keep">Keep previous</button><button class="secondary-button" type="button" data-food-action="update">Update food</button><button class="quiet-button" type="button" data-food-action="review">Review values</button></div>
  </div>`;
}

async function researchSavedFood(id, barcode = '') {
  const food = await state.store.getFood(id);
  if (!food) return;
  $('foodResearchResults').innerHTML = '<p class="component-source">Checking nutrition sources…</p>';
  try {
    const results = barcode ? await searchNutritionByBarcode(barcode) : await searchNutrition(food.name, { forceRemote: true });
    if (!results.length) throw new Error('No nutrition record found.');
    $('foodResearchResults').innerHTML = `<div class="section-heading"><div><p class="eyebrow">RESEARCH RESULTS</p><h2>Choose a source to compare</h2></div></div>${results.map((product, index) => `<button class="result-option" type="button" data-food-result="${index}"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml([product.brand, `${Math.round(product.kcalPer100)} kcal / 100 ${product.unit}`, product.source].filter(Boolean).join(' · '))}</span></button>`).join('')}`;
    state.foodRecords = await state.store.getAllFoods();
    state.foodResearchResults = results;
  } catch {
    $('foodResearchResults').innerHTML = '<p class="component-source">No new nutrition source could be reached. Your saved record is unchanged; you can edit it from the label.</p>';
  }
}

async function handleFoodResearchChoice(action) {
  const candidate = state.foodResearchCandidate;
  if (!candidate) return;
  const food = await state.store.getFood(candidate.foodId);
  if (!food) return;
  if (action === 'keep') {
    state.foodResearchCandidate = null;
    $('foodResearchConflict').innerHTML = '<p class="component-source">Kept your previous food record.</p>';
    return;
  }
  const applyCandidate = action === 'update';
  if (applyCandidate) {
    const next = {
      ...food, name: food.name || candidate.product.name,
      kcalPer100: candidate.product.kcalPer100,
      proteinPer100: candidate.product.proteinPer100,
      carbsPer100: candidate.product.carbsPer100,
      fatPer100: candidate.product.fatPer100,
      source: candidate.product.source, sourceType: candidate.product.sourceType || 'external product database',
      sourceUrl: candidate.product.sourceUrl, confidence: candidate.product.confidence || 'medium',
      evidence: [...(food.evidence || []), ...(candidate.product.evidence || [])],
      lastResearched: new Date().toISOString(), userConfirmed: false
    };
    await state.store.putFood(next);
    state.foodResearchCandidate = null;
    await openFoodDetail(next.id);
    showToast('Food Library updated with the selected source');
    return;
  }
  $('foodEditKcal').value = candidate.product.kcalPer100 ?? '';
  $('foodEditprotein').value = candidate.product.proteinPer100 ?? '';
  $('foodEditcarbs').value = candidate.product.carbsPer100 ?? '';
  $('foodEditfat').value = candidate.product.fatPer100 ?? '';
  $('foodResearchConflict').innerHTML = '<p class="component-source">Review the fields above, then save if you want to change the record.</p>';
}

async function lookupBarcodeForFood(foodId) {
  const barcode = $('foodEditBarcode').value.replace(/\D/g, '').slice(0, 14);
  if (barcode.length < 8) return showToast('Enter a valid product barcode first.');
  $('foodResearchResults').innerHTML = '<p class="component-source">Looking up this barcode…</p>';
  try {
    const [product] = await searchNutritionByBarcode(barcode);
    if (!product) throw new Error('No nutrition for this barcode.');
    const food = await state.store.getFood(foodId);
    if (food && food.barcode && food.barcode !== barcode) {
      $('foodResearchResults').innerHTML = '<div class="status-card warning"><strong>This is a different product</strong><p>The barcode does not match the one already saved. It will be treated as a separate food.</p><button class="secondary-button" type="button" data-food-action="save-as-new" data-food-id="'+escapeHtml(foodId)+'">Save as a separate food</button></div>';
      state.foodResearchCandidate = { foodId, product };
      return;
    }
    displayFoodResearchCandidate(food, product);
  } catch {
    $('foodResearchResults').innerHTML = '<p class="component-source">Barcode lookup failed. Check the digits or enter values from the package label.</p>';
  }
}

async function saveFoodResearchAsNew(foodId) {
  const candidate = state.foodResearchCandidate;
  if (!candidate) return;
  const product = candidate.product;
  const old = await state.store.getFood(foodId);
  const now = new Date().toISOString();
  const next = {
    ...product, id: state.store.makeId(), barcode: product.barcode || product.code,
    category: old?.category || 'Food', aliases: [], usageCount: 0,
    firstSeen: now, lastUsed: null, lastResearched: now, userConfirmed: false, evidence: product.evidence || [], image: null
  };
  await state.store.putFood(next);
  state.foodResearchCandidate = null;
  $('foodDetailScreen').hidden = true;
  await renderFoods();
  await openFoodDetail(next.id);
}

function showView(view) {
  state.selectedView = view;
  $('todayView').hidden = view !== 'today';
  $('historyView').hidden = view !== 'history';
  $('foodsView').hidden = view !== 'foods';
  $('todayTab').classList.toggle('active', view === 'today');
  $('historyTab').classList.toggle('active', view === 'history');
  $('foodsTab').classList.toggle('active', view === 'foods');
  if (view === 'today') $('todayTab').setAttribute('aria-current', 'page');
  else $('todayTab').removeAttribute('aria-current');
  if (view === 'history') $('historyTab').setAttribute('aria-current', 'page');
  else $('historyTab').removeAttribute('aria-current');
  if (view === 'foods') $('foodsTab').setAttribute('aria-current', 'page');
  else $('foodsTab').removeAttribute('aria-current');
  $('captureDock').hidden = view !== 'today';
  if (view === 'history') renderHistory();
  if (view === 'foods') renderFoods();
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
  }
  $('cameraVideo').srcObject = null;
}

async function openCamera() {
  $('cameraScreen').hidden = false;
  // Start loading the on-device model while the user frames the photo.
  // This does not block camera startup or use an external vision API.
  warmPhotoAnalysis();
  $('cameraMessage').hidden = true;
  $('shutterButton').disabled = true;
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    $('cameraMessage').textContent = 'Camera access needs Safari permission and a secure connection. You can choose a photo from your library instead.';
    $('cameraMessage').hidden = false;
    $('libraryButton').focus();
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false });
    $('cameraVideo').srcObject = state.stream;
    await $('cameraVideo').play();
    $('shutterButton').disabled = false;
  } catch (error) {
    $('cameraMessage').textContent = error?.name === 'NotAllowedError'
      ? 'Camera access is turned off. Allow camera access for CalorieSnap in your browser settings, or choose a photo from your library.'
      : 'The camera could not be opened. Choose a photo from your library to continue.';
    $('cameraMessage').hidden = false;
  }
}

function closeCamera() {
  stopCamera();
  $('cameraScreen').hidden = true;
}

function imageToDataUrl(image, maxSide = 1400) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), canvas };
}

async function loadPhoto(file) {
  if (!file || !file.type.startsWith('image/')) return;
  closeCamera();
  try {
    const bitmap = await createImageBitmap(file);
    const photo = imageToDataUrl(bitmap);
    bitmap.close?.();
    await beginAnalysis(photo.dataUrl, photo.canvas);
  } catch {
    showToast('That photo could not be opened. Please choose another one.');
  }
  $('photoLibrary').value = '';
}

function capturePhoto() {
  const video = $('cameraVideo');
  if (!video.videoWidth || !video.videoHeight) return showToast('The camera is still starting. Try again in a moment.');
  const canvas = $('captureCanvas');
  const scale = Math.min(1, 1400 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  closeCamera();
  beginAnalysis(dataUrl, canvas);
}

function openAnalysis(photo) {
  state.photo = photo;
  $('reviewPhoto').src = photo;
  $('analysisResult').hidden = true;
  $('analysisState').hidden = false;
  $('analysisScreen').hidden = false;
}

function setAnalysisProgress(title, message) {
  $('analysisProgressTitle').textContent = title;
  $('analysisProgressText').textContent = message;
}

function closeAnalysis() {
  $('analysisScreen').hidden = true;
  state.photo = null;
  state.draft = null;
}

function errorMarkup(eyebrow, title, copy, action = 'again') {
  return `<div class="result-heading"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${copy}</p></div>
    <button class="primary-button" type="button" data-action="${action}">${action === 'manual' ? 'Enter food manually' : 'Try again'}</button>
    ${action !== 'manual' ? '<button class="secondary-button" type="button" data-action="manual">Enter food manually</button>' : ''}`;
}

async function beginAnalysis(photo, existingCanvas = null) {
  openAnalysis(photo);
  let canvas = existingCanvas;
  try {
    if (!canvas) {
      const image = await createImageBitmap(await (await fetch(photo)).blob());
      canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0);
      image.close?.();
    }
    setAnalysisProgress('Checking the photo', 'Looking for clear light and detail.');
    const quality = inspectImageQuality(canvas);
    if (!quality.ok) {
      $('analysisResult').innerHTML = quality.reason === 'dark'
        ? errorMarkup('PHOTO QUALITY', "It's too dark to tell.", 'Move into brighter light, then take another photo.')
        : errorMarkup('PHOTO QUALITY', "I can't see the food clearly.", 'Move closer and try to keep the food in focus.')
        ;
      $('analysisState').hidden = true;
      $('analysisResult').hidden = false;
      return;
    }
    const result = await identifyPhoto(canvas, setAnalysisProgress);
    if (result.status === 'nonfood') {
      $('analysisResult').innerHTML = errorMarkup('PHOTO REVIEW', "This doesn't appear to be food.", 'Try taking a photo of your food or drink. No calories have been added.');
    } else if (result.status === 'empty') {
      $('analysisResult').innerHTML = errorMarkup('PHOTO REVIEW', "I can't see any food yet.", 'Add food to the plate or move closer, then try again. No calories have been added.');
    } else if (result.status === 'unclear') {
      $('analysisResult').innerHTML = errorMarkup('PHOTO QUALITY', "I can't see the food clearly.", 'Move closer or improve the lighting, then try again.');
    } else if (result.status === 'uncertain') {
      $('analysisResult').innerHTML = errorMarkup('PHOTO REVIEW', "I'm not sure this is food.", 'I would rather ask you to try again than guess. No calories have been added.');
    } else if (result.status === 'unknown') {
      $('analysisResult').innerHTML = errorMarkup('PHOTO REVIEW', "I'm not sure what this food is.", 'Try another photo, or enter the food name yourself.');
    } else {
      state.draft = newDraft(result.name, photo, result.kind);
      renderAnalysisEditor(result);
      $('analysisState').hidden = true;
      $('analysisResult').hidden = false;
      lookupComponent(0);
      return;
    }
  } catch (error) {
    state.draft = newDraft('', photo, 'food');
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error || 'Unknown browser error');
    renderAnalysisEditor({ analysisUnavailable: true, analysisDiagnostic: detail.slice(0, 240) });
  }
  $('analysisState').hidden = true;
  $('analysisResult').hidden = false;
}

function newComponent(name = '', manualEntry = false) {
  return {
    id: state.store.makeId(), name, amount: '', unit: 'g', kcal: '', protein: '', carbs: '', fat: '',
    product: null, manualEntry, manualOverride: false, searchResults: [], searchState: '',
    source: manualEntry ? 'Entered by you' : ''
  };
}

function newDraft(name = '', photo = null, kind = 'food') {
  return {
    id: null, name, recipeBaseName: name, category: suggestedMeal(), photo, kind, preparation: null,
    components: [newComponent(name, !photo)], note: '', date: localDateKey()
  };
}

function renderAnalysisEditor(result) {
  const reviewCopy = result.analysisUnavailable
    ? 'Photo recognition could not finish. Enter the food name below to get a quick estimate from your Food Library or nutrition search.'
    : result.labelMatch
    ? 'Text on the package matched a known food. Check the product and portion before saving.'
    : 'A visual suggestion from your photo. Confirm the food and amount before saving.';
  $('analysisResult').innerHTML = `<div class="result-heading"><p class="eyebrow">PLEASE REVIEW</p><h1 id="analysisTitle">${result.analysisUnavailable ? 'Enter the food for an estimate' : `Likely ${escapeHtml(result.name)}`}</h1><p>${reviewCopy}</p></div>
    <div class="quick-estimate" id="quickEstimate"><strong id="quickEstimateValue">Finding a quick estimate…</strong><p id="quickEstimateNote">Checking your Food Library and the local food guide first.</p></div>
    <div class="status-card"><strong>Photo stays on this device</strong><p>Food and package recognition run in your browser. CalorieSnap checks your saved foods and local food guide before any online lookup.</p></div>
    ${result.analysisDiagnostic ? `<details class="why-details"><summary>Photo recognition details</summary><div class="why-content">${escapeHtml(result.analysisDiagnostic)}</div></details>` : ''}
    <div id="draftEditor"></div>`;
  state.editorHost = 'draftEditor';
  renderDraftEditor();
}

function inferKind(name) {
  return /coffee|espresso|latte|cappuccino|tea|milk|juice|smoothie|cola|lemonade|water|milkshake/i.test(name) ? 'drink' : 'food';
}

function componentTotals() {
  return sumNutrition(state.draft.components.map(component => ({
    kcal: component.kcal === '' ? null : Number(component.kcal),
    protein: component.protein === '' ? null : Number(component.protein),
    carbs: component.carbs === '' ? null : Number(component.carbs),
    fat: component.fat === '' ? null : Number(component.fat)
  })));
}

function componentIsReady(component) {
  const hasCalories = component.kcal !== '' && Number.isFinite(Number(component.kcal)) && Number(component.kcal) >= 0;
  if (!hasCalories) return false;
  if (component.product && !component.manualOverride) return Number(component.amount) > 0 || Boolean(component.product.caloriesPerServing && !component.product.defaultPortion);
  return true;
}

function isDraftReady() {
  const needsPreparation = state.draft.kind === 'drink' && /coffee|espresso|latte|cappuccino|tea/i.test(state.draft.name);
  return Boolean(state.draft.name.trim() && (!needsPreparation || state.draft.preparation) && state.draft.components.length && state.draft.components.every(componentIsReady));
}

function formatNutritionLine(product) {
  if (product.unit === 'serving' && product.caloriesPerServing !== null && product.caloriesPerServing !== undefined) return `~${prettyNumber(product.caloriesPerServing)} kcal per usual serving`;
  const macros = [
    product.proteinPer100 !== null ? `${prettyNumber(product.proteinPer100, 1)}g protein` : null,
    product.carbsPer100 !== null ? `${prettyNumber(product.carbsPer100, 1)}g carbs` : null,
    product.fatPer100 !== null ? `${prettyNumber(product.fatPer100, 1)}g fat` : null
  ].filter(Boolean);
  return `${prettyNumber(product.kcalPer100, 0)} kcal per 100 ${product.unit}${macros.length ? ` · ${macros.join(' · ')}` : ''}`;
}

function nutritionLookupError() {
  return 'Nutrition data could not be reached right now. Check your connection and try again, or enter the values from the food label.';
}

function renderComponent(component, index) {
  const data = component.product;
  const sourceName = data?.isLibrary ? 'Recognised from your Food Library' : `${escapeHtml(data?.source || 'Nutrition source')}${data?.brand ? ` · ${escapeHtml(data.brand)}` : ''}`;
  const sourceMarkup = data?.sourceUrl ? `<a href="${escapeHtml(data.sourceUrl)}" target="_blank" rel="noreferrer">${sourceName}</a>` : sourceName;
  const nutritionInfo = data ? `<div class="component-source">${sourceMarkup}<br>${escapeHtml(formatNutritionLine(data))}</div><button class="quiet-button" type="button" data-component-action="reset-product" data-component-index="${index}">Change nutrition match</button>` : '<div class="component-source">No nutrition data selected yet.</div>';
  const amountFields = data ? `<label class="field-label">Estimated amount</label><div class="component-edit-row">
      <input class="text-input" type="number" inputmode="decimal" min="0" step="1" placeholder="Amount" value="${escapeHtml(component.amount)}" data-component-index="${index}" data-component-field="amount" aria-label="Amount of ${escapeHtml(component.name)}">
      <select class="select-input" data-component-index="${index}" data-component-field="unit" aria-label="Unit for ${escapeHtml(component.name)}"><option value="${data.unit}" selected>${data.unit}</option></select>
    </div>
    <p class="component-source">Visual estimates are not measured weights. Enter the amount you believe is closest.</p>` : '';
  const values = `<div class="${data ? 'macro-grid' : 'component-edit-row'}">
    <label><span class="field-label">${data ? 'Calories' : 'Calories for this portion'}</span><input class="text-input" type="number" inputmode="decimal" min="0" step="1" placeholder="kcal" value="${escapeHtml(component.kcal)}" data-component-index="${index}" data-component-field="kcal" aria-label="Calories in ${escapeHtml(component.name || `component ${index + 1}`)}"></label>
    ${data ? '' : ''}
  </div>
  <div class="macro-grid">
    ${[['protein', 'Protein (g)'], ['carbs', 'Carbs (g)'], ['fat', 'Fat (g)']].map(([key, label]) => `<label><span class="field-label">${label}</span><input class="text-input" type="number" inputmode="decimal" min="0" step="0.1" placeholder="—" value="${escapeHtml(component[key])}" data-component-index="${index}" data-component-field="${key}" aria-label="${label} for ${escapeHtml(component.name || `component ${index + 1}`)}"></label>`).join('')}
  </div>`;
  const manual = !data ? `<button class="secondary-button" type="button" data-component-action="lookup" data-component-index="${index}">Find nutrition data</button>
      ${component.searchState === 'loading' ? '<p class="component-source">Searching Open Food Facts…</p>' : ''}
      ${component.searchState === 'error' ? `<p class="component-source">${escapeHtml(component.searchMessage || 'Lookup failed. You can still enter the nutrition from a label.')}</p>` : ''}
      ${component.searchResults?.length ? `<div class="search-results">${component.searchResults.map((product, resultIndex) => `<button class="result-option" type="button" data-component-action="select-product" data-component-index="${index}" data-product-index="${resultIndex}"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml([product.brand, formatNutritionLine(product)].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>` : ''}
      <button class="quiet-button" type="button" data-component-action="manual" data-component-index="${index}">${component.manualEntry ? 'Nutrition entered by you' : 'Enter nutrition from a label'}</button>` : '';
  return `<article class="component-card">
    <div class="component-top"><input class="component-name-input" type="text" maxlength="100" placeholder="${index ? `Ingredient ${index + 1}` : 'Food'}" value="${escapeHtml(component.name)}" data-component-index="${index}" data-component-field="name" aria-label="Food component name">${index || state.draft.components.length > 1 ? `<button class="remove-component" type="button" data-component-action="remove" data-component-index="${index}">Remove</button>` : ''}</div>
    ${nutritionInfo}${amountFields}${values}${manual}
  </article>`;
}

function renderDraftEditor() {
  const host = $(state.editorHost);
  if (!host || !state.draft) return;
  const isDrinkWithAdditions = state.draft.kind === 'drink' && state.draft.preparation !== 'saved-recipe' && /coffee|espresso|latte|cappuccino|tea/i.test(state.draft.name);
  host.innerHTML = `<label class="field-label" for="draftName">Food or drink</label>
    <input id="draftName" class="text-input" type="text" maxlength="120" value="${escapeHtml(state.draft.name)}" autocomplete="off">
    ${isDrinkWithAdditions ? `<div class="field-label">Did you add milk or sugar?</div><div class="search-results preparation-options">
      ${[['plain', 'Black / plain'], ['milk', 'Milk'], ['milk-sugar', 'Milk + sugar'], ['other', 'Something else']].map(([value, label]) => `<button class="result-option ${state.draft.preparation === value ? 'selected' : ''}" type="button" data-preparation="${value}"><strong>${label}</strong></button>`).join('')}
    </div>` : ''}
    <label class="field-label" for="draftCategory">Meal</label>
    <select id="draftCategory" class="select-input">${['Breakfast', 'Lunch', 'Dinner', 'Snacks'].map(category => `<option ${state.draft.category === category ? 'selected' : ''}>${category}</option>`).join('')}</select>
    <div class="section-heading component-heading"><div><p class="eyebrow">NUTRITION</p><h2>What is in it?</h2></div></div>
    <div id="componentList" class="component-list">${state.draft.components.map(renderComponent).join('')}</div>
    <button id="addComponent" class="secondary-button" type="button">＋ Add an ingredient</button>
    <div class="estimate-total"><span>Estimated total</span><strong id="draftTotal">${prettyNumber(componentTotals().kcal)} kcal</strong></div>
    <div id="macroSummary" class="macro-grid">${[['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([key, label]) => `<div class="macro-item"><strong data-total-macro="${key}">${prettyNumber(componentTotals()[key], 1)}</strong><span>${label} · g</span></div>`).join('')}</div>
    <details class="why-details"><summary>Why this estimate?</summary><div id="whyContent" class="why-content"></div></details>
    <p class="helper-copy">Photo identification is a suggestion. Portions are not measured. Nutrition comes from the selected product record or values you enter.</p>
    <button id="saveEntry" class="primary-button" type="button" ${isDraftReady() ? '' : 'disabled'}>${state.draft.id ? 'Save changes' : 'Add to diary'}</button>
    ${state.draft.id ? '<button id="deleteEntry" class="quiet-button" type="button">Delete this entry</button>' : ''}`;
  updateEstimateSummary();
}

function updateEstimateSummary() {
  if (!state.draft) return;
  const totals = componentTotals();
  const kcal = $('draftTotal');
  if (kcal) kcal.textContent = `${prettyNumber(totals.kcal)} kcal`;
  document.querySelectorAll('[data-total-macro]').forEach(node => node.textContent = prettyNumber(totals[node.dataset.totalMacro], 1));
  const why = $('whyContent');
  if (why) {
    why.innerHTML = state.draft.components.map(component => {
      if (component.product && Number(component.amount) > 0) return `<div>${escapeHtml(component.name)} · ${escapeHtml(component.amount)} ${escapeHtml(component.unit)} × ${prettyNumber(component.product.kcalPer100, 1)} kcal / 100 ${escapeHtml(component.product.unit)} = <strong>${prettyNumber(component.kcal)} kcal</strong> <a href="${escapeHtml(component.product.sourceUrl)}" target="_blank" rel="noreferrer">Source</a></div>`;
      if (component.kcal !== '') return `<div>${escapeHtml(component.name || 'Food')} · ${prettyNumber(component.kcal)} kcal entered by you</div>`;
      return `<div>${escapeHtml(component.name || 'Ingredient')} · amount or nutrition needed before this can be calculated</div>`;
    }).join('') || 'No nutrition sources selected.';
  }
  const save = $('saveEntry');
  if (save) save.disabled = !isDraftReady();
  const quickValue = $('quickEstimateValue');
  const quickNote = $('quickEstimateNote');
  if (quickValue && quickNote) {
    if (totals.kcal !== null) {
      quickValue.textContent = `About ${prettyNumber(totals.kcal)} kcal`;
      const first = state.draft.components[0];
      const product = first?.product;
      let note = product?.portionLabel ? `${product.portionLabel} · change the amount below if needed.` : 'A rough portion estimate. You can change it below.';
      if (product?.packageWeight && Number(product.kcalPer100) > 0) {
        const packKcal = Math.round(product.kcalPer100 * product.packageWeight / 100);
        note += ` Whole ${product.packageWeight} g pack: about ${packKcal} kcal.`;
      }
      quickNote.textContent = product?.isLibrary ? `Recognised from your Food Library. ${note}` : note;
    } else {
      quickValue.textContent = 'Estimate needs a food match';
      quickNote.textContent = 'CalorieSnap will try your saved foods and local guide first. You can also edit the food name.';
    }
  }
}

function openManual(photo = null) {
  state.editing = null;
  state.draft = newDraft('', photo, 'food');
  state.editorHost = 'manualEditor';
  $('manualFoodName').value = '';
  $('manualSearchResults').innerHTML = '';
  $('manualEditor').hidden = false;
  $('manualScreen').hidden = false;
  renderDraftEditor();
  $('draftName')?.focus();
}

function reconcileDraftFoodName(value) {
  if (!state.draft) return;
  const name = String(value || '').trim();
  state.draft.name = name;
  if (state.draft.components.length !== 1) {
    updateEstimateSummary();
    return;
  }
  const component = state.draft.components[0];
  state.draft.kind = inferKind(name);
  state.draft.recipeBaseName = name;
  if (component.product && normalizeFoodName(component.name) !== normalizeFoodName(name)) {
    if (component.product.recipeSignature) state.draft.preparation = null;
    component.name = name;
    component.product = null;
    component.amount = '';
    component.kcal = component.protein = component.carbs = component.fat = '';
    component.manualOverride = false;
    component.searchResults = [];
    component.searchState = '';
    renderDraftEditor();
    lookupComponent(0);
    return;
  }
  if (!component.product) component.name = name;
  updateEstimateSummary();
}

async function lookupComponent(index) {
  const component = state.draft?.components[index];
  if (!component) return;
  const query = String(component.name || '').trim();
  if (query.length < 2) {
    component.searchState = 'error';
    component.searchMessage = 'Add a food name first.';
    renderDraftEditor();
    return;
  }
  component.searchState = 'loading';
  component.searchMessage = '';
  component.searchResults = [];
  renderDraftEditor();
  try {
    const saved = await findLibraryMatch(query);
    if (saved) {
      applyProduct(component, foodRecordToProduct(saved));
      component.searchState = 'done';
      component.source = 'Food Library';
      renderDraftEditor();
      return;
    }
    component.searchResults = await searchNutrition(query);
    const exactLocal = component.searchResults.filter(product => product.isLocal && product.score === 100);
    if (exactLocal.length === 1) {
      applyProduct(component, exactLocal[0]);
      component.searchState = 'done';
      renderDraftEditor();
      return;
    }
    component.searchState = component.searchResults.length ? 'done' : 'error';
    component.searchMessage = component.searchResults.length ? '' : 'No matching nutrition record found. Enter values from a label or try a more specific name.';
  } catch {
    component.searchState = 'error';
    component.searchMessage = nutritionLookupError();
  }
  renderDraftEditor();
}

function applyProduct(component, product) {
  component.name = product.name;
  component.product = product;
  component.unit = product.unit || 'g';
  component.amount = product.defaultPortion ? String(product.defaultPortion) : '';
  component.manualEntry = false;
  component.manualOverride = false;
  component.source = product.isLibrary ? 'Food Library' : product.source || '';
  component.searchResults = [];
  if (product.recipeSignature && state.draft.kind === 'drink') state.draft.preparation = 'saved-recipe';
  const values = product.defaultPortion ? calculateComponent(product, product.defaultPortion) : null;
  component.kcal = values?.kcal === null || values?.kcal === undefined ? '' : String(values.kcal);
  component.protein = values?.protein === null || values?.protein === undefined ? '' : String(values.protein);
  component.carbs = values?.carbs === null || values?.carbs === undefined ? '' : String(values.carbs);
  component.fat = values?.fat === null || values?.fat === undefined ? '' : String(values.fat);
  if (product.caloriesPerServing !== null && product.caloriesPerServing !== undefined && values?.kcal == null) component.kcal = String(product.caloriesPerServing);
  const componentIndex = state.draft?.components.indexOf(component);
  if (componentIndex === 0) state.draft.name = product.name;
}

function selectProduct(componentIndex, productIndex) {
  const component = state.draft?.components[componentIndex];
  const product = component?.searchResults?.[productIndex];
  if (!component || !product) return;
  applyProduct(component, product);
  renderDraftEditor();
}

function usePreparation(value) {
  state.draft.preparation = value;
  state.draft.components = state.draft.components.filter(component => !component.autoAddition);
  const labels = value === 'milk' ? ['Milk'] : value === 'milk-sugar' ? ['Milk', 'Sugar'] : value === 'other' ? ['Other ingredient'] : [];
  for (const label of labels) state.draft.components.push({ ...newComponent(label, false), autoAddition: true });
  renderDraftEditor();
  const first = state.draft.components.findIndex(component => component.autoAddition);
  if (first >= 0) lookupComponent(first);
}

function enterManualNutrition(index) {
  const component = state.draft.components[index];
  if (!component) return;
  component.product = null;
  component.manualEntry = true;
  component.source = 'Entered by you';
  component.searchResults = [];
  renderDraftEditor();
}

function removeComponent(index) {
  if (state.draft.components.length <= 1) return showToast('A diary entry needs at least one food.');
  state.draft.components.splice(index, 1);
  renderDraftEditor();
}

function updateComponentField(input) {
  const component = state.draft?.components[Number(input.dataset.componentIndex)];
  if (!component) return;
  const field = input.dataset.componentField;
  component[field] = input.value;
  if (field === 'name' && Number(input.dataset.componentIndex) === 0) {
    state.draft.name = input.value;
    if ($('draftName')) $('draftName').value = input.value;
  }
  if (component.product && field === 'amount') {
    component.manualOverride = false;
    const values = calculateComponent(component.product, component.amount);
    if (values) {
      component.kcal = values.kcal === null ? '' : String(values.kcal);
      component.protein = values.protein === null ? '' : String(values.protein);
      component.carbs = values.carbs === null ? '' : String(values.carbs);
      component.fat = values.fat === null ? '' : String(values.fat);
      const card = input.closest('.component-card');
      for (const key of ['kcal', 'protein', 'carbs', 'fat']) {
        const fieldInput = card?.querySelector(`[data-component-field="${key}"]`);
        if (fieldInput && fieldInput !== input) fieldInput.value = component[key];
      }
    } else if (component.product.caloriesPerServing && Number(component.product.defaultPortion) > 0 && Number(component.amount) > 0) {
      component.kcal = String(Math.round(component.product.caloriesPerServing * Number(component.amount) / Number(component.product.defaultPortion)));
      component.protein = component.carbs = component.fat = '';
    } else {
      component.kcal = component.protein = component.carbs = component.fat = '';
    }
  } else if (['kcal', 'protein', 'carbs', 'fat'].includes(field) && component.product) {
    component.manualOverride = true;
  }
  updateEstimateSummary();
}

async function rememberDrinkRecipe(draft, entries, total) {
  if (draft.kind !== 'drink' || entries.length < 2 || total.kcal === null) return;
  const ingredients = entries.map(item => ({
    name: item.name, amount: item.amount, unit: item.unit || 'g', kcal: item.kcal,
    protein: item.protein, carbs: item.carbs, fat: item.fat
  }));
  const signature = JSON.stringify(ingredients.map(item => `${normalizeFoodName(item.name)}:${item.amount ?? ''}:${item.unit}`).sort());
  const existing = (await state.store.getAllFoods()).find(food => food.recipeSignature === signature) || null;
  const now = new Date().toISOString();
  const ingredientNames = ingredients.map(item => item.name.toLowerCase()).join(' + ');
  const name = `${draft.name} (${ingredientNames})`;
  const userConfirmedValue = Boolean(existing?.userConfirmed);
  const recipe = {
    ...(existing || {}), id: existing?.id || state.store.makeId(),
    name: existing?.name || name, brand: '', barcode: '', category: 'Drinks', unit: 'serving',
    kcalPer100: null, caloriesPerServing: userConfirmedValue ? existing.caloriesPerServing : total.kcal,
    proteinPer100: null, carbsPer100: null, fatPer100: null,
    typicalServingSize: 1, portionLabel: 'one usual drink', packageWeight: null,
    recipeSignature: signature, recipeIngredients: ingredients,
    source: 'Your saved drink recipe', sourceType: 'user-confirmed recipe', confidence: 'high', sourceUrl: '',
    evidence: userConfirmedValue ? existing.evidence : [{ value: total.kcal, unit: 'kcal/serving', source: 'Calculated from the saved ingredients', url: '' }],
    aliases: [...new Set([...(existing?.aliases || []), draft.recipeBaseName || draft.name, draft.name, `${draft.recipeBaseName || draft.name} with ${ingredientNames}`])],
    usageCount: (Number(existing?.usageCount) || 0) + 1, firstSeen: existing?.firstSeen || now,
    lastUsed: now, lastResearched: existing?.lastResearched || null, userConfirmed: true,
    userValue: userConfirmedValue ? existing.userValue : { caloriesPerServing: total.kcal, ingredients }, image: existing?.image || null
  };
  await state.store.putFood(recipe);
}

async function saveDraft() {
  if (!isDraftReady()) return showToast('Choose nutrition data or enter calories for every ingredient first.');
  const entries = state.draft.components.map(component => ({
    name: String(component.name || 'Food').trim(),
    amount: Number(component.amount) > 0 ? Number(component.amount) : null,
    unit: component.unit,
    kcal: Number(component.kcal),
    protein: component.protein === '' ? null : Number(component.protein),
    carbs: component.carbs === '' ? null : Number(component.carbs),
    fat: component.fat === '' ? null : Number(component.fat),
    product: component.product,
    source: component.product?.source ?? component.source ?? 'Entered by you',
    manualOverride: Boolean(component.manualOverride)
  }));
  const totals = sumNutrition(entries);
  const date = state.draft.date || localDateKey();
  const day = await state.store.getDay(date);
  const existingIndex = state.draft.id ? day.entries.findIndex(entry => entry.id === state.draft.id) : -1;
  const entry = {
    id: state.draft.id || state.store.makeId(),
    name: state.draft.name.trim(), category: state.draft.category,
    kcal: totals.kcal, protein: totals.protein, carbs: totals.carbs, fat: totals.fat,
    time: state.draft.time || currentTime(), photo: state.draft.photo,
    components: entries,
    source: [...new Set(entries.map(item => item.product?.source || item.source || 'Entered by you'))].join(' · '),
    note: state.draft.preparation && state.draft.preparation !== 'saved-recipe' ? `Drink preparation confirmed by you: ${state.draft.preparation}.` : '',
    preparation: state.draft.preparation
  };
  if (existingIndex >= 0) day.entries[existingIndex] = entry;
  else day.entries.push(entry);
  await state.store.putDay(day);
  await Promise.all(state.draft.components.map(component => updateFoodLibraryUsage(component.product, component, state.draft.category)));
  await rememberDrinkRecipe(state.draft, entries, totals);
  $('analysisScreen').hidden = true;
  $('manualScreen').hidden = true;
  $('detailScreen').hidden = true;
  state.draft = null;
  state.editing = null;
  await refresh();
  showView('today');
  showToast(existingIndex >= 0 ? 'Entry updated' : 'Added to today’s diary');
}

async function deleteDraft() {
  if (!state.draft?.id) return;
  const date = state.draft.date;
  const day = await state.store.getDay(date);
  day.entries = day.entries.filter(entry => entry.id !== state.draft.id);
  await state.store.putDay(day);
  $('manualScreen').hidden = true;
  $('detailScreen').hidden = true;
  state.draft = null;
  await refresh();
  showToast('Entry deleted');
}

function detailMarkup(entry, date) {
  const components = entry.components?.length ? entry.components : [];
  return `${entry.photo ? `<img class="detail-photo" src="${entry.photo}" alt="Photo of ${escapeHtml(entry.name)}">` : ''}
    <p class="eyebrow">${escapeHtml(dateTitle(date))} · ${escapeHtml(entry.category || 'Snacks')}</p>
    <h2 id="detailHeading" class="detail-title">${escapeHtml(entry.name)}</h2>
    <div class="estimate-total"><span>Estimated calories</span><strong>${prettyNumber(entry.kcal)} kcal</strong></div>
    <div class="macro-grid">${[['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([key, label]) => `<div class="macro-item"><strong>${prettyNumber(entry[key], 1)}</strong><span>${label} · g</span></div>`).join('')}</div>
    <p class="helper-copy">${escapeHtml(entry.time)} · portions and nutrition are estimates.</p>
    ${components.length ? `<div class="detail-lines">${components.map(component => `<div class="detail-line"><span>${escapeHtml(component.name)}${component.amount ? ` · ${prettyNumber(component.amount, 1)} ${escapeHtml(component.unit || 'g')}` : ''}</span><strong>${prettyNumber(component.kcal)} kcal</strong></div>`).join('')}</div>` : ''}
    ${entry.note ? `<p class="helper-copy">${escapeHtml(entry.note)}</p>` : ''}
    <details class="why-details" open><summary>Why this estimate?</summary><div class="why-content">${components.length ? components.map(component => component.product ? `<div>${escapeHtml(component.name)} · ${prettyNumber(component.amount, 1)} ${escapeHtml(component.unit)} × ${prettyNumber(component.product.kcalPer100, 1)} kcal / 100 ${escapeHtml(component.product.unit)} · <a href="${escapeHtml(component.product.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(component.source)}</a></div>` : `<div>${escapeHtml(component.name)} · ${prettyNumber(component.kcal)} kcal entered by you</div>`).join('') : escapeHtml(entry.source || 'Imported diary entry; detailed source information is unavailable.')}</div></details>
    <button class="primary-button" type="button" data-edit-entry="${escapeHtml(entry.id)}" data-date="${date}">Edit entry</button>
    <button class="quiet-button" type="button" data-delete-entry="${escapeHtml(entry.id)}" data-date="${date}">Delete entry</button>`;
}

async function openEntryDetail(date, id) {
  const day = await state.store.getDay(date);
  const entry = day.entries.find(item => item.id === id);
  if (!entry) return;
  state.currentDetail = { date, entry };
  $('entryDetail').innerHTML = detailMarkup(entry, date);
  $('detailScreen').hidden = false;
}

async function openHistoryDay(date) {
  const day = await state.store.getDay(date);
  $('entryDetail').innerHTML = `<p class="eyebrow">FOOD JOURNAL</p><h2 id="detailHeading" class="detail-title">${escapeHtml(dateTitle(date))}</h2>
    <div class="estimate-total"><span>Estimated total</span><strong>${Math.round(kcalTotal(day.entries)).toLocaleString()} kcal</strong></div>
    <div class="detail-lines">${day.entries.map(entry => `<button class="result-option" type="button" data-entry="${escapeHtml(entry.id)}" data-date="${date}"><strong>${escapeHtml(entry.name)} · ${prettyNumber(entry.kcal)} kcal</strong><span>${escapeHtml(entry.category)} · ${escapeHtml(entry.time)}</span></button>`).join('')}</div>`;
  $('detailScreen').hidden = false;
}

async function editEntry(date, id) {
  const day = await state.store.getDay(date);
  const entry = day.entries.find(item => item.id === id);
  if (!entry) return;
  state.draft = {
    id: entry.id, name: entry.name, category: entry.category || 'Snacks', photo: entry.photo || null,
    kind: inferKind(entry.name), preparation: entry.preparation || null, date,
    time: entry.time,
    components: entry.components?.length ? entry.components.map(saved => ({
      ...newComponent(saved.name, !saved.product), ...saved,
      product: saved.product || null, amount: saved.amount ?? '',
      kcal: saved.kcal ?? '', protein: saved.protein ?? '', carbs: saved.carbs ?? '', fat: saved.fat ?? '',
      searchResults: [], searchState: '', manualEntry: !saved.product, manualOverride: saved.manualOverride || false
    })) : [{ ...newComponent(entry.name, true), kcal: String(entry.kcal), protein: entry.protein ?? '', carbs: entry.carbs ?? '', fat: entry.fat ?? '' }]
  };
  state.editorHost = 'manualEditor';
  $('detailScreen').hidden = true;
  $('manualScreen').hidden = false;
  $('manualEditor').hidden = false;
  renderDraftEditor();
}

async function setTarget() {
  const value = Number($('targetInput').value);
  if (!Number.isFinite(value) || value < 1 || value > 10000) return showToast('Enter a daily target between 1 and 10,000 kcal.');
  state.settings.calorieTarget = Math.round(value);
  await state.store.saveSettings(state.settings);
  $('targetScreen').hidden = true;
  await refresh();
}

async function clearTarget() {
  state.settings.calorieTarget = null;
  await state.store.saveSettings(state.settings);
  $('targetScreen').hidden = true;
  await refresh();
}

function closeModal(id) {
  const node = $(id);
  if (node) node.hidden = true;
}

function installEvents() {
  $('takePhotoButton').addEventListener('click', openCamera);
  $('closeCamera').addEventListener('click', closeCamera);
  $('libraryButton').addEventListener('click', () => $('photoLibrary').click());
  $('photoLibrary').addEventListener('change', event => loadPhoto(event.target.files?.[0]));
  $('shutterButton').addEventListener('click', capturePhoto);
  $('analysisBack').addEventListener('click', closeAnalysis);
  $('todayTab').addEventListener('click', () => showView('today'));
  $('historyTab').addEventListener('click', () => showView('history'));
  $('foodsTab').addEventListener('click', () => showView('foods'));
  $('foodLibrarySearch').addEventListener('input', event => renderFoods(event.target.value));
  $('targetButton').addEventListener('click', () => {
    $('targetInput').value = state.settings.calorieTarget || '';
    $('targetScreen').hidden = false;
    $('targetInput').focus();
  });
  $('saveTarget').addEventListener('click', setTarget);
  $('clearTarget').addEventListener('click', clearTarget);
  $('manualButton').addEventListener('click', () => openManual());
  $('manualSearchButton').addEventListener('click', async () => {
    const term = $('manualFoodName').value.trim();
    if (!term) return showToast('Enter a food name to search.');
    if (!state.draft || state.draft.id) state.draft = newDraft(term, null, inferKind(term));
    else {
      state.draft.name = term;
      state.draft.recipeBaseName = term;
      state.draft.kind = inferKind(term);
      state.draft.preparation = null;
      state.draft.components[0].name = term;
      state.draft.components[0].manualEntry = false;
    }
    state.editorHost = 'manualEditor';
    renderDraftEditor();
    await lookupComponent(0);
  });
  $('manualFoodName').addEventListener('keydown', event => { if (event.key === 'Enter') $('manualSearchButton').click(); });

  document.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.close) { closeModal(target.dataset.close); return; }
    if (target.classList.contains('closeScreen')) { closeModal(target.dataset.close); return; }
    if (target.dataset.foodDetail) { await openFoodDetail(target.dataset.foodDetail); return; }
    if (target.dataset.foodAction === 'save') {
      const food = await state.store.getFood(target.dataset.foodId);
      if (!food) return;
      const next = { ...foodEditValues(food), userConfirmed: true, userValue: foodEditUserValue(food), updatedAt: new Date().toISOString() };
      if (state.foodResearchCandidate?.foodId === food.id) next.lastResearched = new Date().toISOString();
      await state.store.putFood(next);
      state.foodResearchCandidate = null;
      $('foodDetailScreen').hidden = true;
      await renderFoods();
      showToast('Saved to your Food Library');
      return;
    }
    if (target.dataset.foodAction === 'confirm') {
      const food = await state.store.getFood(target.dataset.foodId);
      if (!food) return;
      const next = { ...foodEditValues(food), userConfirmed: true, userValue: foodEditUserValue(food) };
      await state.store.putFood(next);
      await openFoodDetail(next.id);
      showToast('Your values will be preferred next time');
      return;
    }
    if (target.dataset.foodAction === 'delete') {
      await state.store.deleteFood(target.dataset.foodId);
      $('foodDetailScreen').hidden = true;
      await renderFoods();
      showToast('Removed from your Food Library');
      return;
    }
    if (target.dataset.foodAction === 'research') { await researchSavedFood(target.dataset.foodId); return; }
    if (target.dataset.foodAction === 'barcode') { await lookupBarcodeForFood(target.closest('[role="dialog"]')?.querySelector('[data-food-id]')?.dataset.foodId || $('foodDetailContent').querySelector('[data-food-id]')?.dataset.foodId); return; }
    if (target.dataset.foodAction === 'save-as-new') { await saveFoodResearchAsNew(target.dataset.foodId); return; }
    if (['keep', 'update', 'review'].includes(target.dataset.foodAction)) { await handleFoodResearchChoice(target.dataset.foodAction); return; }
    if (target.dataset.foodResult !== undefined) {
      const product = state.foodResearchResults?.[Number(target.dataset.foodResult)];
      const foodId = $('foodDetailContent').querySelector('[data-food-id]')?.dataset.foodId;
      const food = await state.store.getFood(foodId);
      if (food && product) displayFoodResearchCandidate(food, product);
      return;
    }
    if (target.dataset.action === 'again') { closeAnalysis(); openCamera(); return; }
    if (target.dataset.action === 'manual') { const photo = state.photo; $('analysisScreen').hidden = true; openManual(photo); return; }
    if (target.dataset.preparation) { usePreparation(target.dataset.preparation); return; }
    if (target.id === 'addComponent') {
      state.draft.components.push(newComponent('', false));
      renderDraftEditor();
      const index = state.draft.components.length - 1;
      document.querySelector(`[data-component-index="${index}"][data-component-field="name"]`)?.focus();
      return;
    }
    const componentAction = target.dataset.componentAction;
    const index = Number(target.dataset.componentIndex);
    if (componentAction === 'lookup') { await lookupComponent(index); return; }
    if (componentAction === 'manual') { enterManualNutrition(index); return; }
    if (componentAction === 'remove') { removeComponent(index); return; }
    if (componentAction === 'select-product') { selectProduct(index, Number(target.dataset.productIndex)); return; }
    if (componentAction === 'reset-product') {
      const component = state.draft?.components[index];
      if (component) { component.product = null; component.amount = ''; component.kcal = ''; component.protein = ''; component.carbs = ''; component.fat = ''; component.manualOverride = false; component.searchResults = []; renderDraftEditor(); }
      return;
    }
    if (target.id === 'saveEntry') { await saveDraft(); return; }
    if (target.id === 'deleteEntry' && state.draft?.id) { await deleteDraft(); return; }
    if (target.dataset.entry && target.dataset.date) { await openEntryDetail(target.dataset.date, target.dataset.entry); return; }
    if (target.dataset.historyDate) { await openHistoryDay(target.dataset.historyDate); return; }
    if (target.dataset.editEntry) { await editEntry(target.dataset.date, target.dataset.editEntry); return; }
    if (target.dataset.deleteEntry) {
      const day = await state.store.getDay(target.dataset.date);
      day.entries = day.entries.filter(entry => entry.id !== target.dataset.deleteEntry);
      await state.store.putDay(day);
      $('detailScreen').hidden = true;
      await refresh();
      showToast('Entry deleted');
    }
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'foodLibrarySearch') return;
    if (event.target.id === 'draftName' && state.draft) {
      state.draft.name = event.target.value;
      if (state.draft.kind === 'drink') state.draft.recipeBaseName = event.target.value;
      if (!state.draft.components[0]?.product && state.draft.components.length === 1) state.draft.components[0].name = event.target.value;
      updateEstimateSummary();
      return;
    }
    if (event.target.id === 'draftCategory' && state.draft) { state.draft.category = event.target.value; return; }
    if (event.target.matches('[data-component-field]')) updateComponentField(event.target);
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'draftCategory' && state.draft) state.draft.category = event.target.value;
    if (event.target.matches('[data-component-field]')) updateComponentField(event.target);
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'draftName') reconcileDraftFoodName(event.target.value);
  });
  document.addEventListener('focusout', event => {
    if (event.target.id === 'draftName') reconcileDraftFoodName(event.target.value);
  });

  window.addEventListener('pageshow', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());
}

async function init() {
  try {
    state.store = await createStore();
    setNutritionCache(state.store);
    await state.store.migrateLegacy();
    installEvents();
    await refresh();
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  } catch {
    document.querySelector('.app-frame').innerHTML = '<div class="empty-state"><div><strong>Your diary could not be opened</strong><p>Check that browser storage is available, then reload CalorieSnap.</p></div></div>';
  }
}

init();

