// Поиск в открытой базе Open Food Facts по названию (M2 этап 2, В. 09.10).
// Онлайн-секция в поиске; сохранение найденного — свой продукт source 'off' (КБЖУ на 100 г).
import { db, newId, LOCAL_USER, type Food } from './db';
import { guessCategory } from './lib';
import { track } from './store';

export interface OffHit {
  id: string; name: string; brand?: string;
  kcal: number; p: number; f: number; c: number;
}

interface OffProduct {
  code?: string;
  product_name?: string; product_name_ru?: string; generic_name?: string;
  brands?: string;
  nutriments?: Record<string, number | string>;
}

const num = (n: unknown): number => {
  const v = typeof n === 'string' ? parseFloat(n.replace(',', '.')) : (n as number);
  return Number.isFinite(v) ? (v as number) : 0;
};

export async function searchOff(query: string): Promise<OffHit[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q)
    + '&search_simple=1&action=process&json=1&page_size=10'
    + '&fields=code,product_name,product_name_ru,generic_name,brands,nutriments';
  const res = await fetch(url, { headers: { 'User-Agent': 'DeepDish/0.4 (family tracker; github.com/lichmanenko)' }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error('OFF ' + res.status);
  const r = await res.json();
  const hits: OffHit[] = [];
  for (const p of (r.products ?? []) as OffProduct[]) {
    const name = (p.product_name_ru || p.product_name || p.generic_name || '').trim();
    const n = p.nutriments ?? {};
    const kcal = num(n['energy-kcal_100g']) || Math.round(num(n['energy_100g']) / 4.184);
    if (!name || !kcal) continue;
    hits.push({
      id: p.code ?? '',
      name: name.slice(0, 60),
      brand: (p.brands ?? '').split(',')[0]?.trim().slice(0, 30) || undefined,
      kcal: Math.round(kcal), p: Math.round(num(n['proteins_100g']) * 10) / 10,
      f: Math.round(num(n['fat_100g']) * 10) / 10, c: Math.round(num(n['carbohydrates_100g']) * 10) / 10,
    });
    if (hits.length >= 8) break;
  }
  track('off_search', { q: q.slice(0, 20), found: hits.length }); // замер охвата РФ копится в метриках
  return hits;
}

/** Сохранить находку в каталог (КБЖУ на 100 г, свой продукт — уедет семье при синке). */
export async function saveOffHit(h: OffHit): Promise<string> {
  const food: Food = {
    id: newId(), name: h.name, brand: h.brand,
    category: guessCategory(h.name) ?? 'Импорт OFF',
    kcalPer100g: h.kcal, pPer100g: h.p, fPer100g: h.f, cPer100g: h.c,
    unit: 'g', source: 'off', ownerId: LOCAL_USER, isPublic: true,
    createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
  };
  await db.foods.add(food);
  track('off_saved', {});
  return food.id;
}
