'use strict';

// Funciones puras de la app: sin DOM, sin Supabase y sin leer el reloj.
// Script clásico: en el navegador quedan como globales; en Node se exportan (D-3).

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

if (typeof module !== 'undefined') {
  module.exports = {
    toISODate, fromISODate, addDays, weekStart, visibleRange, movePeriod,
  };
}
