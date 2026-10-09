'use strict';

// Funciones puras de la app: sin DOM, sin Supabase y sin leer el reloj.
// Script clásico: en el navegador quedan como globales; en Node se exportan (D-3).

// ===== Constantes (ids y claves: los valores de la base de datos) =====

const MEAL_TYPES = [
  { id: 'desayuno', name: 'Desayuno' },
  { id: 'comida', name: 'Comida' },
  { id: 'cena', name: 'Cena' },
];
const UNITS = { und: 'und.', kg: 'kg.', gr: 'gr.' };

// ===== Fechas (sin toISOString: trabaja en hora local) =====

// Fecha → 'aaaa-mm-dd'
function toISODate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// 'aaaa-mm-dd' → fecha local a las 00:00
function fromISODate(text) {
  const [year, month, day] = text.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Suma días por calendario, no por milisegundos: respeta el cambio de hora
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// Lunes de la semana de la fecha
function weekStart(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

// Mismo día del calendario (sin mirar la hora)
function isSameDay(a, b) {
  return toISODate(a) === toISODate(b);
}

// Texto de una fecha en español
function formatDate(date, options) {
  return new Intl.DateTimeFormat('es-ES', options).format(date);
}

// "lunes, 5 de enero de 2099"
function longDate(date) {
  return formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ===== Periodos ('day' | 'week' | 'month') =====

// Primer y último día visibles: el día, de lunes a domingo o las semanas completas del mes
function visibleRange(view, refDate) {
  if (view === 'day') return { from: refDate, to: refDate };
  if (view === 'week') {
    const monday = weekStart(refDate);
    return { from: monday, to: addDays(monday, 6) };
  }
  const first = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
  const last = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0);
  return { from: weekStart(first), to: addDays(weekStart(last), 6) };
}

// Nuevo día de referencia al pulsar ‹ (-1) o › (1); en el mes, el día 1
function movePeriod(view, refDate, direction) {
  if (view === 'day') return addDays(refDate, direction);
  if (view === 'week') return addDays(refDate, 7 * direction);
  return new Date(refDate.getFullYear(), refDate.getMonth() + direction, 1);
}

// Título del periodo visible
function periodTitle(view, refDate) {
  if (view === 'month') return formatDate(refDate, { month: 'long', year: 'numeric' });
  if (view === 'week') {
    const { from, to } = visibleRange('week', refDate);
    return formatDate(from, { day: 'numeric', month: 'short' }) + ' – '
      + formatDate(to, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return formatDate(refDate, { weekday: 'long', day: 'numeric', month: 'long' });
}

// ===== Rejillas del calendario ("hoy" llega como dato) =====

// Días de la vista mensual: semanas completas, con los de otros meses marcados
function monthGrid(refDate, today) {
  const { from, to } = visibleRange('month', refDate);
  const cells = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    cells.push({ date, outside: date.getMonth() !== refDate.getMonth(), isToday: isSameDay(date, today) });
  }
  return cells;
}

// Los siete días de la semana, de lunes a domingo
function weekDays(refDate, today) {
  const monday = weekStart(refDate);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    return { date, isToday: isSameDay(date, today) };
  });
}

// Fecha inicial de "+ Añadir comida": el día visible en la vista diaria; hoy en las demás
function initialFormDate(view, refDate, today) {
  return view === 'day' ? refDate : today;
}

// ===== Textos de comidas y enlaces =====

// Clave de una comida en el mapa del periodo: 'aaaa-mm-dd|tipo'
function mealKey(isoDate, type) {
  return isoDate + '|' + type;
}

// "Plato 1 · Plato 2"
function dishNames(meal) {
  return meal.platos.map((dish) => dish.nombre).join(' · ');
}

// Título de cada plato en el detalle
function dishTitle(type, index) {
  if (type === 'desayuno') return 'Plato';
  return index === 0 ? 'Primer plato' : 'Segundo plato';
}

// "Harina: 0,5 kg."; una unidad desconocida se muestra tal cual
function formatIngredient(ingredient) {
  const quantity = Number(ingredient.cantidad).toLocaleString('es-ES');
  return `${ingredient.nombre}: ${quantity} ${UNITS[ingredient.unidad] || ingredient.unidad}`;
}

// Devuelve el enlace normalizado solo si es http/https válido; si no, null
function safeLink(text) {
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// "¿Borrar cena del lunes, 5 de enero de 2099?"
function deleteConfirmText(meal) {
  const type = MEAL_TYPES.find((t) => t.id === meal.tipo);
  return `¿Borrar ${type.name.toLowerCase()} del ${longDate(fromISODate(meal.fecha))}?`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    MEAL_TYPES, UNITS,
    toISODate, fromISODate, addDays, weekStart, isSameDay, formatDate, longDate,
    visibleRange, movePeriod, periodTitle, monthGrid, weekDays, initialFormDate,
    mealKey, dishNames, dishTitle, formatIngredient, safeLink, deleteConfirmText,
  };
}
