'use strict';

// Funciones puras de la app: sin DOM, sin Supabase y sin leer el reloj.
// Script clásico: en el navegador quedan como globales; en Node se exportan (D-3).

// ===== Constantes (ids y claves: los valores de la base de datos) =====

const MEAL_TYPES = [
  { id: 'desayuno', name: 'Desayuno' },
  { id: 'comida', name: 'Comida' },
  { id: 'cena', name: 'Cena' },
];
// Etiquetas de todas las unidades; cada formulario acepta las de su lista (D-23)
const UNITS = {
  und: 'und.', kg: 'kg.', gr: 'gr.', l: 'l.', ml: 'ml.', cda: 'cda.', cdta: 'cdta.',
  pizca: 'pizca', vaso: 'vaso', vasito: 'vasito', taza: 'taza', diente: 'diente',
  bote: 'bote', lata: 'lata', paquete: 'paquete', chorrito: 'chorrito', loncha: 'loncha',
  sobre: 'sobre', docena: 'docena', botella: 'botella',
};
// Plural de las unidades que son palabras; las abreviaturas no cambian (D-15; 013 C-8)
const UNIT_PLURALS = {
  pizca: 'pizcas', vaso: 'vasos', vasito: 'vasitos', taza: 'tazas', diente: 'dientes',
  bote: 'botes', lata: 'latas', paquete: 'paquetes', chorrito: 'chorritos', loncha: 'lonchas',
  sobre: 'sobres', docena: 'docenas', botella: 'botellas',
};
// Orden de los desplegables de ingrediente y de artículo (013 C-10, C-11)
const INGREDIENT_UNITS = ['und', 'kg', 'gr', 'l', 'ml', 'bote', 'lata', 'paquete', 'cda', 'cdta',
  'pizca', 'chorrito', 'vaso', 'vasito', 'taza', 'diente', 'loncha', 'sobre'];
const ARTICLE_UNITS = ['und', 'kg', 'gr', 'l', 'ml', 'docena', 'bote', 'lata', 'paquete', 'botella'];

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

// Tope de años del panel de meses: la app solo trabaja bien con años de cuatro cifras
const PANEL_YEARS = { min: 1001, max: 9998 };

// Año con que abre el panel: el del mes visible, llevado al tope más cercano si se sale
function initialPanelYear(refDate) {
  return Math.min(Math.max(refDate.getFullYear(), PANEL_YEARS.min), PANEL_YEARS.max);
}

// Si se puede bajar (‹) o subir (›) de año desde el año del panel
function panelArrows(year) {
  return { canGoBack: year > PANEL_YEARS.min, canGoForward: year < PANEL_YEARS.max };
}

// Los doce meses del panel de un año, con el mes visible y el de hoy marcados
function monthPanel(year, refDate, today) {
  const inMonth = (date, month) => date.getFullYear() === year && date.getMonth() === month;
  return Array.from({ length: 12 }, (_, month) => ({
    month,
    label: formatDate(new Date(year, month, 1), { month: 'short' }),
    isVisible: inMonth(refDate, month),
    isToday: inMonth(today, month),
  }));
}

// Vista y día de referencia al elegir un mes del panel: el día 1 en la vista Mes.
// Solo se recargan las comidas si cambia el rango visible (no si ya estaba en ese mes en Mes).
function chooseMonth(view, refDate, year, month) {
  const sameMonth = refDate.getFullYear() === year && refDate.getMonth() === month;
  return {
    view: 'month',
    refDate: new Date(year, month, 1), // año de 4 cifras por el tope del panel (D-4)
    reload: !(view === 'month' && sameMonth),
  };
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

// ===== Cantidades: escrita (texto) y mostrada (013-unidades-fracciones) =====

// Fracciones reconocidas, como [numerador, denominador] (Definiciones)
const KNOWN_FRACTIONS = [[1, 2], [1, 3], [1, 4], [3, 4], [2, 3]];
// Caracteres de fracción que se leen como " n/d" (C-1, D-2)
const FRACTION_CHARS = { '½': ' 1/2', '⅓': ' 1/3', '¼': ' 1/4', '¾': ' 3/4', '⅔': ' 2/3' };

// Cantidad escrita → número mayor que 0, o null si no es una de las formas válidas
// (entero, decimal con coma o punto, fracción, entero con fracción menor que 1) · C-1, C-2, D-2
function parseAmountText(text) {
  const normal = String(text)
    .replace(/[½⅓¼¾⅔]/g, (char) => FRACTION_CHARS[char])
    .replace(/^ +| +$/g, '') // solo el espacio normal: un tabulador o un espacio duro dan error
    .replace(/ *\/ */g, '/')
    .replace(/ {2,}/g, ' ');
  let value = null;
  let parts;
  if (/^(\d+([.,]\d*)?|[.,]\d+)$/.test(normal)) {
    value = Number(normal.replace(',', '.'));
  } else if ((parts = normal.match(/^(\d+)\/(\d+)$/))) {
    if (Number(parts[2]) > 0) value = Number(parts[1]) / Number(parts[2]);
  } else if ((parts = normal.match(/^(\d+) (\d+)\/(\d+)$/))) {
    const [num, den] = [Number(parts[2]), Number(parts[3])];
    if (den > 0 && num < den) value = Number(parts[1]) + num / den;
  }
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

// Número → "1 1/2" si la parte decimal coincide (a menos de 0,001) con una fracción reconocida;
// si no, en formato español con 3 decimales como mucho (C-6, C-7, D-3)
function amountText(cantidad, useGrouping) {
  const value = Number(cantidad);
  const whole = Math.floor(value);
  const fraction = KNOWN_FRACTIONS.find(([num, den]) => Math.abs(value - whole - num / den) < 0.001);
  const number = (n) => n.toLocaleString('es-ES', useGrouping ? {} : { useGrouping: false });
  if (!fraction) return number(value);
  const text = `${fraction[0]}/${fraction[1]}`;
  return whole ? `${number(whole)} ${text}` : text;
}

// Cantidad mostrada: "1/2", "2 1/4", "0,375", "10.000" (C-6, C-7)
function formatAmount(cantidad) {
  return amountText(cantidad, true);
}

// Texto del campo al editar: como formatAmount, sin separador de miles (en el campo el punto
// es decimal: "10.000" se leería como 10) · C-5, D-3
function amountFieldText(cantidad) {
  return amountText(cantidad, false);
}

// Cantidad y unidad del formulario tras elegir una sugerencia: con las dos vacías, las del
// artículo guardado (vacías si no tiene); con alguna escrita, sin cambios (016 C-4)
function pickedAmountFields(item, quantity, unit) {
  if (quantity.trim() !== '' || unit !== '') return { quantity, unit };
  if (item.cantidad === null || item.cantidad === undefined) return { quantity: '', unit: '' };
  return { quantity: amountFieldText(item.cantidad), unit: item.unidad || '' };
}

// Cantidad de un campo: si el texto sigue siendo el del número guardado, ese número tal cual
// (0,333 se ve "1/3" y sigue 0,333); si no, la cantidad escrita · C-5, D-4
function amountFromField(text, original) {
  if (original !== null && original !== undefined && text === amountFieldText(original)) return Number(original);
  return parseAmountText(text);
}

// "1/2 kg.", "2 dientes" o '' sin cantidad; una unidad desconocida se muestra tal cual
// (007-lista-compra RF-8, D-10). Las palabras, en plural solo con más de 1 tal como se ve
// (013-unidades-fracciones C-8, D-3)
function formatQuantity(cantidad, unidad) {
  if (cantidad === null || cantidad === undefined) return '';
  const plural = roundQuantity(Number(cantidad)) > 1 && UNIT_PLURALS[unidad];
  return `${formatAmount(cantidad)} ${plural || UNITS[unidad] || unidad}`;
}

// "Harina: 0,5 kg."; sin cantidad, solo el nombre ("Sal"); una unidad desconocida se muestra tal cual
function formatIngredient(ingredient) {
  const amount = formatQuantity(ingredient.cantidad, ingredient.unidad);
  return amount ? `${ingredient.nombre}: ${amount}` : ingredient.nombre;
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

// ===== Formulario: distribución de los platos y filas vacías =====
// Las filas y los platos llegan en bruto desde el formulario (D-6):
// row = { name, quantity, original, unit }: quantity es el texto del campo y original, el número
// guardado con que se rellenó (o null) · 013-unidades-fracciones D-5
// rawDish = { name, recipe, reference, rows }

// Una fila vacía no se guarda; una cantidad que no se puede leer cuenta como dato
function isIngredientRowEmpty(row) {
  return !row.name.trim() && !row.quantity.trim() && !row.unit;
}

function dishHasData(rawDish) {
  return Boolean(rawDish.name.trim() || rawDish.recipe.trim() || rawDish.reference.trim())
    || rawDish.rows.some((row) => !isIngredientRowEmpty(row));
}

// Títulos y visibilidad de los platos según el tipo; el desayuno solo tiene un plato
function formDishLayout(type, secondHasData) {
  const isBreakfast = type === 'desayuno';
  const blocked = isBreakfast && secondHasData;
  return {
    firstTitle: isBreakfast ? 'Plato' : 'Primer plato',
    secondTitle: 'Segundo plato (opcional)',
    secondHidden: isBreakfast && !secondHasData,
    showRemoveSecond: blocked,
    error: blocked ? 'El desayuno solo tiene un plato. Elimina el segundo plato para poder guardar.' : null,
  };
}

// ===== Formulario: validación =====

// Saltos de línea y tabuladores que pasan a espacio en el nombre del ingrediente (CL-1)
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]/g;

// Cambia cada salto de línea o tabulador por un espacio, sin cambiar la longitud (CL-1)
function flattenLineBreaks(text) {
  return text.replace(LINE_BREAKS, ' ');
}

// Nombre del ingrediente en una línea: sin saltos, sin espacios repetidos ni en los extremos (CL-1)
function cleanIngredientName(text) {
  return flattenLineBreaks(text).replace(/ {2,}/g, ' ').trim();
}

// Cantidad (texto del campo y número original, ver amountFromField) y unidad, las dos o
// ninguna: { cantidad, unidad, invalid } con los campos que fallan ('quantity', 'unit'). La
// comparten ingrediente y artículo (D-17). Solo espacios cuenta como vacía (013 D-5)
function checkAmount(text, original, unit, units) {
  const empty = !text.trim();
  if (empty && !unit) return { cantidad: null, unidad: null, invalid: [] };
  const cantidad = empty ? null : amountFromField(text, original);
  const invalid = [];
  if (cantidad === null) invalid.push('quantity');
  if (!units.includes(unit)) invalid.push('unit');
  return { cantidad, unidad: unit, invalid };
}

// invalid: lista de campos que fallan, { dish, field, row? } o { field: 'date' }; app.js los marca (D-6)

const INGREDIENT_ERROR = 'Completa cada ingrediente: nombre y, si lleva cantidad, cantidad mayor que 0 y unidad.';
const REFERENCE_ERROR = 'La referencia debe ser un enlace que empiece por http:// o https://';

// Valida un plato en bruto: { dish } con las claves de la base de datos, o { error, invalid }
function validateDish(rawDish, index, nameMessage) {
  const invalid = [];
  let error = null;
  const fail = (message, field, row) => {
    invalid.push(row === undefined ? { dish: index, field } : { dish: index, field, row });
    error = error || message;
  };

  const dishName = rawDish.name.trim();
  if (!dishName) fail(nameMessage, 'name');

  const ingredients = [];
  rawDish.rows.forEach((row, i) => {
    if (isIngredientRowEmpty(row)) return;
    const name = cleanIngredientName(row.name);
    const amount = checkAmount(row.quantity, row.original, row.unit, INGREDIENT_UNITS);
    if (!name) fail(INGREDIENT_ERROR, 'name', i);
    amount.invalid.forEach((field) => fail(INGREDIENT_ERROR, field, i));
    // Sin cantidad ni unidad: { nombre, cantidad: null, unidad: null } (D-16)
    if (name && !amount.invalid.length) ingredients.push({ nombre: name, cantidad: amount.cantidad, unidad: amount.unidad });
  });

  const reference = rawDish.reference.trim();
  if (reference && !safeLink(reference)) fail(REFERENCE_ERROR, 'reference');

  if (error) return { error, invalid };
  return { dish: { nombre: dishName, ingredientes: ingredients, receta: rawDish.recipe.trim(), referencia: reference } };
}

// Valida el formulario en bruto { date, type, dishes }: { data } listo para guardar, o { error, invalid }.
// Orden actual: fecha (sale enseguida), tipo (sin marca), desayuno con dos platos y los dos platos marcados
function validateMealForm(rawForm) {
  const { date, type, dishes } = rawForm;
  if (!date) return { error: 'Elige una fecha.', invalid: [{ field: 'date' }] };
  if (!type) return { error: 'Elige el tipo: desayuno, comida o cena.', invalid: [] };

  const secondHasData = dishHasData(dishes[1]);
  const layoutError = formDishLayout(type, secondHasData).error;
  if (layoutError) return { error: layoutError, invalid: [] };

  const firstName = type === 'desayuno' ? 'Escribe el nombre del plato.' : 'Escribe el nombre del primer plato.';
  const results = [validateDish(dishes[0], 0, firstName)];
  if (secondHasData) results.push(validateDish(dishes[1], 1, 'El segundo plato necesita un nombre de receta.'));

  const failed = results.filter((r) => r.error);
  if (failed.length) return { error: failed[0].error, invalid: failed.flatMap((r) => r.invalid) };
  return { data: { fecha: date, tipo: type, platos: results.map((r) => r.dish) } };
}

// ===== Conexión y login =====

// Las claves están rellenas y no son las de la plantilla
function keysDefined(url, key) {
  return Boolean(url && key)
    && !url.includes('YOUR_URL')
    && !key.includes('YOUR_PUBLIC_KEY');
}

// Texto de la pantalla "No se puede conectar", o null si todo va bien.
// check: { libraryLoaded, keysDefined, status, online }; status es null si el servidor no
// responde; online es navigator.onLine leído después (sin el campo, como con red).
// Los textos citan los nombres actuales de app.js.
function configMessage(check) {
  if (!check.libraryLoaded) {
    return 'No se ha podido cargar la librería de Supabase. Comprueba que el archivo supabase.js está junto a index.html.';
  }
  if (!check.keysDefined) {
    return 'Faltan las claves de Supabase. Abre app.js y rellena SUPABASE_URL y SUPABASE_PUBLIC_KEY con los datos de tu proyecto.';
  }
  if (check.status === null && check.online === false) {
    return 'No hay conexión a internet. La app entrará sola cuando vuelva.'; // 011 RF-14
  }
  if (check.status === null) {
    return 'Supabase no responde. Comprueba tu conexión a internet y que SUPABASE_URL en app.js es correcta.';
  }
  if (check.status === 401 || check.status === 403) {
    return 'Supabase rechaza la clave pública. Revisa SUPABASE_PUBLIC_KEY en app.js.';
  }
  const ok = check.status >= 200 && check.status < 300;
  return ok ? null : 'Supabase responde con un error. Prueba de nuevo en unos minutos.';
}

function loginInputError(email, password) {
  return email && password ? null : 'Escribe tu email y tu contraseña.';
}

// online: navigator.onLine, que lo pasa app.js
function isNetworkError(error, online) {
  return !online
    || error?.name === 'AuthRetryableFetchError'
    || /fetch|network|load failed/i.test(error?.message || '');
}

function translateLoginError(error, online) {
  const message = (error.message || '').toLowerCase();
  if (error.code === 'invalid_credentials' || message.includes('invalid login')) return 'Email o contraseña incorrectos.';
  if (error.code === 'email_not_confirmed') return 'Esta cuenta todavía no tiene el email confirmado.';
  if (error.code === 'validation_failed') return 'El email no tiene un formato válido.';
  if (error.status === 429 || error.code === 'over_request_rate_limit') return 'Demasiados intentos. Espera un momento y vuelve a probar.';
  if (isNetworkError(error, online)) return 'No hay conexión con el servidor. Revisa tu conexión a internet.';
  return 'No se ha podido iniciar sesión. Inténtalo de nuevo.';
}

// ===== Recuperar contraseña (002-recuperar-contrasena) =====

// Mismo texto exista o no la cuenta, para no revelar cuáles hay (RNF-3)
const RECOVERY_SENT_MESSAGE = 'Si el email es de una cuenta, te llegará un enlace para cambiar la contraseña.';

// email llega ya recortado desde app.js (RF-4)
function recoveryInputError(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : 'Escribe un email válido.';
}

// Los dos límites de envío dan el mismo mensaje (RF-7, CL-3)
function translateRecoveryError(error, online) {
  const code = error?.code;
  if (error?.status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
    return 'Demasiados intentos. Espera un momento y vuelve a probar.';
  }
  if (isNetworkError(error, online)) return 'No hay conexión con el servidor. Revisa tu conexión a internet.';
  return 'Ha ocurrido un error inesperado. Inténtalo de nuevo.';
}

const LINK_EXPIRED_MESSAGE = 'El enlace ha caducado o ya se ha usado. Pide otro.';
const PASSWORD_CHANGED_MESSAGE = 'Contraseña cambiada. Entra con la nueva.';
const SESSION_CLOSED_MESSAGE = 'La sesión se ha cerrado. Vuelve a entrar.';
const MIN_PASSWORD_LENGTH = 8;

// Primer fallo de la contraseña nueva, sin recortar espacios; cuenta caracteres, no unidades UTF-16 (RF-9)
function newPasswordError(password, repeat) {
  if (!password) return 'Escribe la contraseña nueva.';
  if ([...password].length < MIN_PASSWORD_LENGTH) return 'La contraseña debe tener al menos 8 caracteres.';
  if (password !== repeat) return 'Las contraseñas no coinciden.';
  return null;
}

const SESSION_GONE_CODES = ['session_not_found', 'session_expired', 'refresh_token_not_found',
  'refresh_token_already_used', 'user_not_found', 'bad_jwt'];

// La sesión ya no existe en el servidor; un error de red nunca lo es (RF-15, CL-6)
function isSessionGone(error) {
  if (!error || isNetworkError(error, true)) return false;
  return error.name === 'AuthSessionMissingError'
    || SESSION_GONE_CODES.includes(error.code)
    || error.status === 401 || error.status === 403;
}

// Error al guardar la contraseña nueva; linkExpired: la sesión del enlace ha caducado (RF-12, CL-6)
function translatePasswordError(error, online) {
  const result = (message, linkExpired = false) => ({ message, linkExpired });
  if (error?.code === 'weak_password') return result('El servidor no acepta esa contraseña. Prueba con otra más larga o distinta.');
  if (error?.code === 'same_password') return result('La contraseña nueva debe ser distinta de la actual.');
  if (isSessionGone(error)) return result(LINK_EXPIRED_MESSAGE, true);
  if (isNetworkError(error, online)) return result('No hay conexión con el servidor. Revisa tu conexión a internet.');
  return result('Ha ocurrido un error inesperado. Inténtalo de nuevo.');
}

// Traduce un error de Supabase a un mensaje en español (online: navigator.onLine)
function translateError(error, online) {
  if (isNetworkError(error, online)) return 'No hay conexión con el servidor. Revisa tu conexión a internet.';
  if (error?.code === '23505') return 'Ya hay otra comida con esa fecha y ese tipo.';
  if (error?.code === '23514') return 'Los datos no son válidos para guardarlos.';
  if (error?.code === 'PGRST301' || error?.code === '42501' || error?.status === 401) {
    return 'Tu sesión ha caducado o no tienes permiso. Cierra sesión y vuelve a entrar.';
  }
  return 'Ha ocurrido un error inesperado. Inténtalo de nuevo.';
}

// Avisos de duplicado del formulario, con el tipo y su concordancia (RF-42).
// kind: 'confirm' (pregunta antes de cargarla), 'editing' (aviso al cargarla) o 'error' (al guardar)
function duplicateMessage(type, kind) {
  const masculine = type === 'desayuno';
  const head = masculine ? 'Ya hay un desayuno registrado ese día' : `Ya hay una ${type} registrada ese día`;
  if (kind === 'confirm') return head + (masculine ? '. ¿Quieres editarlo?' : '. ¿Quieres editarla?') + ' Se perderá lo que has escrito.';
  if (kind === 'editing') return head + (masculine ? ': lo estás editando.' : ': la estás editando.');
  return head;
}

// Mensaje de un error al guardar: un duplicado nombra el tipo; el resto, translateError (CL-6)
function saveErrorMessage(error, type, online) {
  if (error?.code === '23505') return duplicateMessage(type, 'error');
  return translateError(error, online);
}

// Qué hacer con el aviso según el estado del canal de tiempo real:
// 'show' (mostrar el aviso), 'recover' (quitarlo y recargar) o 'none'; en modo copia, nunca
// 'show' (011-sin-conexion RF-21)
function syncStatusAction(channelStatus, noticeKind, copyMode = false) {
  if (channelStatus === 'SUBSCRIBED') return noticeKind === 'sync' ? 'recover' : 'none';
  if (channelStatus === 'CHANNEL_ERROR' || channelStatus === 'TIMED_OUT') return copyMode ? 'none' : 'show';
  return 'none';
}

// Hay otra comida en esa fecha y tipo que no es la que se edita
function isOtherMeal(existing, editingId) {
  return !!existing && existing.id !== editingId;
}

// La edición no cambió ninguna fila: la otra persona la borró
function wasDeleted(updatedRows) {
  return updatedRows.length === 0;
}

// Datos de autenticación que trae la dirección (hash: "#…", search: "?…"):
// 'recovery' (enlace de recuperación válido), 'error' (enlace caducado o ya usado) o 'none' (RF-16)
const AUTH_ERROR_PARAMS = ['error', 'error_code', 'error_description'];

function readAuthLink(hash, search) {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(search);
  const hasError = AUTH_ERROR_PARAMS.some((name) => hashParams.has(name) || searchParams.has(name));
  if (hasError) return { kind: 'error' };
  if (hashParams.has('access_token') && hashParams.get('type') === 'recovery') return { kind: 'recovery' };
  return { kind: 'none' };
}

// Dirección de la app sin el "#…" ni los parámetros de error del enlace; conserva el resto (RF-16)
function urlWithoutAuthData(pathname, search) {
  const params = new URLSearchParams(search);
  AUTH_ERROR_PARAMS.forEach((name) => params.delete(name));
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

// Dirección a la que vuelve el enlace de recuperación: sin index.html; en la raíz, solo el
// origen, como está en Redirect URLs (RNF-4, D-8)
function recoveryRedirect(origin, pathname) {
  const path = pathname.replace(/index\.html$/, '');
  return path === '/' ? origin : origin + path;
}

// Pantalla al arrancar: link es el tipo de readAuthLink, linkOk dice si supabase-js aceptó el
// enlace, pending es la marca de un cambio de contraseña a medias (D-4) o null.
// closeSession: hay que cerrar la sesión de este dispositivo antes de mostrarla (CL-1, CL-4)
function startScreen({ link, linkOk, hasSession, pending }) {
  if (link === 'recovery' && linkOk && hasSession) return { screen: 'newPassword', closeSession: false }; // RF-8, CL-7
  if (link === 'error' || link === 'recovery') return { screen: 'linkExpired', closeSession: hasSession }; // CL-1
  if (pending) return { screen: 'linkExpired', closeSession: hasSession }; // CL-4
  if (hasSession) return { screen: 'app', closeSession: false }; // 000-base RF-9
  return { screen: 'login', closeSession: false };
}

// Qué hacer con un evento de sesión de supabase-js: 'app' (abrir el calendario),
// 'sessionClosed' (login con el aviso de RF-15) o 'none'
function authEventScreen(event, { onNewPassword, signingOut }) {
  if (event === 'SIGNED_OUT') return signingOut ? 'none' : 'sessionClosed'; // RF-15
  if (event === 'SIGNED_IN') return onNewPassword || signingOut ? 'none' : 'app'; // 000-base RF-4
  return 'none';
}

// 004-edicion-simultanea: otros formularios abiertos (peers) y su caducidad (D-4, D-6)
const PEER_REFRESH_MS = 8000; // cada cuánto se reanuncia el formulario propio
const PEER_MAX_AGE_MS = 20000; // sin reanuncio en este tiempo, el peer caduca (RNF-4)
const PEER_CHECK_MS = 2000; // cada cuánto se revisa la caducidad
const PEER_LEAVE_GRACE_MS = 1500; // margen tras salir, para que un guardado pase a RF-3 (RF-6)

// true si los dos tienen fecha y tipo elegidos y son iguales
function sameSlot(a, b) {
  if (!a || !b || !a.date || !a.type || !b.date || !b.type) return false;
  return a.date === b.date && a.type === b.type;
}

// Peers vigentes: vistos hace como mucho PEER_MAX_AGE_MS y, si salieron, dentro del margen
function activePeers(peers, now) {
  return peers.filter((p) => now - p.seenAt <= PEER_MAX_AGE_MS
    && (p.goneAt === undefined || now - p.goneAt <= PEER_LEAVE_GRACE_MS));
}

// true si el formulario propio coincide con algún peer vigente (RF-1, RF-6)
function hasMatch(own, peers, now) {
  return activePeers(peers, now).some((p) => sameSlot(own, p));
}

// true si es un mensaje "form" bien formado: anuncio { key, date, type, seq } o salida { key, seq, gone: true } (D-3)
function isFormMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (typeof message.key !== 'string' || message.key === '') return false;
  if (!Number.isInteger(message.seq) || message.seq < 0) return false;
  if (message.gone === true) return true;
  return typeof message.date === 'string' && message.date !== ''
    && typeof message.type === 'string' && message.type !== '';
}

// Peers que se recuerdan: los vigentes y las salidas de hace PEER_MAX_AGE_MS o menos (guardan su seq)
function keptPeers(peers, now) {
  const active = new Set(activePeers(peers, now));
  return peers.filter((p) => active.has(p)
    || (p.goneAt !== undefined && now - p.goneAt <= PEER_MAX_AGE_MS));
}

// Lista nueva de peers tras recibir un mensaje "form" de otro formulario (D-3); no modifica la que recibe
function updatePeers(peers, message, ownKey, now) {
  const kept = keptPeers(peers, now);
  if (!isFormMessage(message) || message.key === ownKey) return kept;
  const old = kept.find((p) => p.key === message.key);
  if (old && old.seq >= message.seq) return kept; // atrasado o repetido
  const others = kept.filter((p) => p !== old);
  const { key, seq } = message;
  if (message.gone !== true) {
    return [...others, { key, date: message.date, type: message.type, seq, seenAt: now }];
  }
  const left = old
    ? { ...old, seq, goneAt: old.goneAt === undefined ? now : old.goneAt }
    : { key, seq, seenAt: now, goneAt: now }; // clave desconocida: sin fecha ni tipo, no coincide
  return [...others, left];
}

// Qué mensaje "form" enviar ahora, sin key ni seq (D-3, D-8): anuncio con fecha y tipo si el
// formulario está abierto y a la vista; si no, salida si estaba anunciado o null (RF-1, RF-6, RNF-5).
// El primer anuncio tras no estar anunciado siempre pide respuesta (hello), para no perderla
function formMessage({ open, date, type, visible, announced, hello }) {
  if (open && visible && date && type) return { date, type, hello: Boolean(hello || !announced) };
  return announced ? { gone: true } : null;
}

// true si hay que contestar: anuncio válido de otro formulario que pide respuesta (RF-1)
function needsReply(message, ownKey) {
  return isFormMessage(message) && message.gone !== true
    && message.key !== ownKey && message.hello === true;
}

// 004-edicion-simultanea: textos de los avisos (RF-1, RF-3)
const MATCH_MESSAGE = 'Esta comida también se está editando en otro sitio.';
const SAVED_ELSEWHERE_MESSAGE = 'Esta comida se ha guardado desde otro sitio. Cambia el día o el tipo para poder guardar la tuya.';

// Qué aviso toca y si "Guardar" queda desactivado (RF-3, RF-4, RF-7, RF-8, CL-3, 000-base RF-36)
function matchNotice({ match, savedElsewhere, saving }) {
  let text = null;
  if (savedElsewhere) text = SAVED_ELSEWHERE_MESSAGE;
  else if (match) text = MATCH_MESSAGE;
  return { text, saveDisabled: Boolean(savedElsewhere || saving) };
}

// Qué hacer con lo que devuelve guardar_comida_si_no_cambio (CL-4, CL-5)
function saveOutcome(result) {
  if (result === 'guardada') return 'saved';
  if (result === 'cambiada') return 'changed';
  if (result === 'borrada') return 'deleted';
  return 'error';
}

// Igualdad por contenido: el orden de las claves no cuenta, el de las listas sí (D-12)
function sameContent(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameContent(a[k], b[k]));
}

// true si la comida de la fecha y el tipo del formulario se ha guardado desde que
// el formulario supo lo que había en ellos (RF-3, D-12); una borrada no cuenta (CL-5)
function savedSince(seen, slot, current) {
  if (!seen || !sameSlot(seen, slot) || !current) return false;
  if (!seen.meal) return true;
  if (seen.meal.id !== current.id) return true;
  return !sameContent(seen.meal.platos, current.platos);
}

// true si, con el aviso de RF-3, el cambio de fecha o tipo cuenta para RF-5: otro tipo, u
// otra fecha no vacía (también una intermedia al teclear). Se compara siempre con prev, la
// fecha y el tipo que había al llegar el aviso (CL-7: el mismo día y tipo no cuenta)
function leavesSlot(prev, next) {
  if (next.type !== prev.type) return true;
  return next.date !== '' && next.date !== prev.date;
}

// ===== Lista de la compra (007-lista-compra) =====
// Artículo como llega de la base de datos: { id, nombre, cantidad, unidad, lista, tachado }

const MAX_ARTICLE_NAME = 200; // caracteres del nombre (RF-13, RF-14)
const MAX_SUGGESTIONS = 5; // sugerencias bajo el campo rápido (RF-21)
const ARTICLE_NAME_ERROR = 'Escribe el nombre del artículo.';
const ARTICLE_QUANTITY_ERROR = 'Indica la cantidad (mayor que 0) y la unidad, o deja las dos vacías.';

// Valida el formulario de artículo (añadir o editar, RF-29): { data } con las claves de la base de
// datos, o { error, invalid } con los campos que fallan ('name', 'quantity', 'unit'). Con los dos
// fallos se marcan todos y sale el mensaje del nombre (RF-16, RF-17, RF-18, CL-7)
function validateArticleForm({ name, quantity, original, unit }) {
  const invalid = [];
  const nombre = cleanIngredientName(name);
  if (!nombre) invalid.push('name');

  const amount = checkAmount(quantity, original, unit, ARTICLE_UNITS);
  invalid.push(...amount.invalid);

  if (invalid.length) {
    return { error: invalid[0] === 'name' ? ARTICLE_NAME_ERROR : ARTICLE_QUANTITY_ERROR, invalid };
  }
  return { data: { nombre, cantidad: amount.cantidad, unidad: amount.unidad } };
}

// Clave de "Nombre equivalente": sin espacios sobrantes, en minúsculas y sin acentos salvo la ñ.
// Misma regla que public.clave_articulo (D-2) · RF-19, RF-20, RF-30, CL-6
function articleKey(name) {
  return cleanIngredientName(name).normalize('NFC').toLowerCase()
    .replace(/ñ/g, '\u0001').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0001/g, 'ñ');
}

const ARTICLE_COLLATOR = new Intl.Collator('es', { sensitivity: 'base' });

// Orden alfabético español, sin distinguir mayúsculas ni tildes; la ñ va después de la n (RF-7)
function compareArticles(a, b) {
  return ARTICLE_COLLATOR.compare(a.nombre, b.nombre);
}

// Las dos listas en orden, con los tachados al final de Por comprar, y sus cuentas (RF-6, RF-7, RF-41)
function shoppingLists(items) {
  const sorted = [...items].sort(compareArticles);
  const unstruck = sorted.filter((item) => item.lista === 'por_comprar' && !item.tachado);
  const struck = sorted.filter((item) => item.lista === 'por_comprar' && item.tachado);
  const saved = sorted.filter((item) => item.lista === 'guardados');
  return {
    pending: [...unstruck, ...struck],
    saved,
    pendingCount: unstruck.length,
    savedCount: saved.length,
    struckCount: struck.length,
  };
}

// Alguna palabra del nombre empieza por lo escrito, sin mayúsculas ni acentos; lo escrito
// vacío o solo con espacios no coincide con nada (RF-21; 014 Definiciones)
function matchesTyped(name, typed) {
  const key = articleKey(typed);
  return key !== '' && (' ' + articleKey(name)).includes(' ' + key);
}

// Hasta MAX_SUGGESTIONS artículos de Guardados, en orden, con alguna palabra que empieza por
// lo escrito (sin mayúsculas ni acentos); [] si lo escrito queda vacío (RF-21, RF-22)
function suggestions(items, typed) {
  return shoppingLists(items).saved
    .filter((item) => matchesTyped(item.nombre, typed))
    .slice(0, MAX_SUGGESTIONS);
}

// Marca de las sugerencias con ↑/↓ (014 C-11, D-12): index -1 es ninguna; ↓ marca la
// siguiente (sin marcada, la primera; en la última se queda), ↑ la anterior (desde la primera,
// ninguna; sin marcada, nada)
function moveMark(index, count, key) {
  if (count === 0) return -1;
  const current = Math.min(index, count - 1);
  if (key === 'down') return Math.min(current + 1, count - 1);
  return current <= 0 ? -1 : current - 1;
}

// Marca tras recalcular la lista: la misma sugerencia si sigue (por nombre), si no ninguna (014 D-13)
function keptMark(oldList, oldIndex, newList) {
  return oldIndex < 0 ? -1 : newList.indexOf(oldList[oldIndex]);
}

// Sugerencias de una fila de ingrediente (014 Definiciones, C-1 a C-6; plan D-10, D-11): hasta
// MAX_SUGGESTIONS nombres que coinciden con lo escrito, primero los artículos (las dos listas)
// y luego los nombres de comidas que no son equivalentes a ningún artículo, cada grupo en
// orden alfabético. No salen un nombre idéntico a lo escrito (sin los espacios de los extremos)
// ni uno equivalente a otherNames (las demás filas del plato). Las exclusiones van antes del tope.
function ingredientSuggestions({ items, mealNames, typed, otherNames }) {
  const taken = new Set(otherNames.map(articleKey).filter((key) => key !== ''));
  const articleNames = items.map((item) => item.nombre);
  const seen = new Set(articleNames.map(articleKey));
  const fromMeals = [];
  for (const name of mealNames) {
    const key = articleKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    fromMeals.push(name);
  }
  const byName = (a, b) => ARTICLE_COLLATOR.compare(a, b);
  const exact = typed.trim();
  return [...articleNames.sort(byName), ...fromMeals.sort(byName)]
    .filter((name) => matchesTyped(name, typed) && name !== exact && !taken.has(articleKey(name)))
    .slice(0, MAX_SUGGESTIONS);
}

// Artículo con nombre equivalente (RF-20) que no es excludeId, en cualquiera de las dos
// listas, o null; al editar, el propio artículo no cuenta (RF-19, RF-30, CL-6, RF-45)
function findEquivalent(items, name, excludeId = null) {
  const key = articleKey(name);
  return items.find((item) => item.id !== excludeId && articleKey(item.nombre) === key) ?? null;
}

// Aviso de nombre repetido, con el nombre guardado y según la lista del otro (RF-19, RF-30, RF-45)
function articleExistsMessage(name, list) {
  return list === 'guardados' ? `«${name}» ya está en Guardados.` : `«${name}» ya está en la lista.`;
}

// Confirmación de borrar un artículo (RF-31, RF-43)
function articleDeleteText(name) {
  return `¿Borrar «${name}»?`;
}

// Confirmación de "Terminar compra" con el número de tachados (RF-42)
function finishConfirmText(count) {
  return count === 1
    ? '¿Pasar 1 artículo comprado a Guardados?'
    : `¿Pasar ${count} artículos comprados a Guardados?`;
}

// Resultado de anadir_articulo ({ resultado, nombre }) → { kind, name, list }; name es el nombre
// guardado y list solo se da con 'exists'; cualquier otro valor es 'error' (RF-15, RF-19, RF-20, RF-39, CL-4)
const ADD_KINDS = { anadido: 'added', recuperado: 'recovered', en_lista: 'exists', en_guardados: 'exists' };

function addOutcome(result) {
  const kind = (result && Object.hasOwn(ADD_KINDS, result.resultado)) ? ADD_KINDS[result.resultado] : 'error';
  if (kind === 'error') return { kind, name: null, list: null };
  let list = null;
  if (result.resultado === 'en_lista') list = 'por_comprar';
  if (result.resultado === 'en_guardados') list = 'guardados';
  return { kind, name: result.nombre ?? null, list };
}

const ARTICLE_UNEXPECTED_MESSAGE = 'No se ha podido guardar el artículo. Ha ocurrido un error inesperado. Inténtalo de nuevo.';
const ARTICLE_GONE_MESSAGE = 'Ese artículo ya no existe.'; // CL-2
const ARTICLE_CHANGED_MESSAGE = 'Ese artículo ya ha cambiado.'; // CL-14
const NO_STRUCK_MESSAGE = 'No hay artículos tachados.'; // CL-11

const ARTICLE_ERROR_PREFIXES = {
  load: 'No se ha podido cargar la lista de la compra. ',
  save: 'No se ha podido guardar el artículo. ',
  finish: 'No se ha podido terminar la compra. ',
  delete: 'No se ha podido borrar el artículo. ',
};

// Error de la lista: prefijo de la acción ('load', 'save', 'finish', 'delete') y la causa de las
// comidas; un duplicado (23505) no usa el texto de las comidas (RF-36, RF-45)
function articleErrorMessage(action, error, online) {
  if (error?.code === '23505') return ARTICLE_UNEXPECTED_MESSAGE;
  return ARTICLE_ERROR_PREFIXES[action] + translateError(error, online);
}

// Error al guardar un artículo: un duplicado nombra el equivalente de items (ya recargados) con su
// nombre guardado y su lista; sin equivalente, el error inesperado (RF-45, RF-36)
function articleSaveErrorMessage(error, items, name, excludeId, online) {
  if (error?.code !== '23505') return articleErrorMessage('save', error, online);
  const other = findEquivalent(items, name, excludeId);
  return other ? articleExistsMessage(other.nombre, other.lista) : ARTICLE_UNEXPECTED_MESSAGE;
}

// Pantalla al cargar la página o al entrar: desde el login, siempre Comidas (RF-4); si no, la
// recordada en la pestaña o, sin ella (null), la del navegador (RF-46, CL-20, CL-21). Compra
// solo si lo recordado es 'list': sin nada, bloqueado o con otro valor, Comidas (CL-19, D-21)
function openingScreen({ fromLogin, tabScreen, browserScreen }) {
  if (fromLogin) return 'meals';
  const stored = tabScreen ?? browserScreen;
  return stored === 'list' ? 'list' : 'meals';
}

// ===== Barra superior y barra lateral (008-barra-menu) =====

// Inicial del círculo del usuario: el primer carácter del email, en mayúscula (RF-4, D-6)
function userInitial(email) {
  if (typeof email !== 'string' || email === '') return '';
  return Array.from(email)[0].toLocaleUpperCase('es');
}

// Estado recordado de la barra lateral: contraída solo si se guardó así; sin nada guardado o
// con el almacenamiento bloqueado (null), expandida (RF-12, CL-5)
function isSidebarCollapsed(stored) {
  return stored === 'collapsed';
}

// Día abreviado de la semana en el pc estrecho: "Mié. 21". Lista fija y no Intl, que da
// "mié" sin punto y cambia según el navegador (RF-15, D-11). De domingo a sábado, como getDay()
const WEEKDAY_ABBR = ['Dom.', 'Lun.', 'Mar.', 'Mié.', 'Jue.', 'Vie.', 'Sáb.'];

function shortWeekDate(date) {
  return WEEKDAY_ABBR[date.getDay()] + ' ' + date.getDate();
}

// ¿Hay que abreviar la semana? Si el nombre completo más ancho, con un espacio y el número de
// dos cifras más ancho, no cabe en la columna (RF-15, D-11). Los anchos, en px, los mide app.js
function needsShortWeekDates(nameWidths, numberWidths, spaceWidth, available) {
  if (nameWidths.length === 0) return false;
  return Math.max(...nameWidths) + spaceWidth + Math.max(...numberWidths) > available;
}

// ===== 009-ingredientes-automaticos: momentos, periodo y suma de cantidades =====

const PERIOD_ORDER_MESSAGE = 'El final del periodo no puede ser anterior al principio.';
const PERIOD_DATES_MESSAGE = 'Elige el día de principio y el de fin del periodo.';
// Tipo de cada unidad de compra: solo se suman las del mismo tipo (RF-5, RF-11); cada unidad
// de recuento es su propio tipo (013 D-7)
const UNIT_KINDS = {
  und: 'count', kg: 'weight', gr: 'weight', l: 'volume', ml: 'volume',
  bote: 'jar', lata: 'can', paquete: 'pack', docena: 'dozen', botella: 'bottle',
};
// Unidad de cada tipo de recuento, y orden de los tipos en el detalle (013 D-7, C-17)
const KIND_UNITS = { count: 'und', jar: 'bote', can: 'lata', pack: 'paquete', dozen: 'docena', bottle: 'botella' };
const KIND_ORDER = ['count', 'jar', 'can', 'pack', 'weight', 'volume', 'dozen', 'bottle'];

// De la comida del sábado (hoy si es sábado; si no, el próximo) a la cena del viernes (RF-2)
function defaultPeriod(today) {
  const saturday = addDays(today, (6 - today.getDay() + 7) % 7);
  return {
    from: { date: toISODate(saturday), type: 'comida' },
    to: { date: toISODate(addDays(saturday, 6)), type: 'cena' },
  };
}

// Orden de dos momentos { date, type }: la fecha como números (un año de 5 cifras no se
// ordena por texto) y, el mismo día, el orden de MEAL_TYPES
function compareMoments(a, b) {
  const da = a.date.split('-').map(Number);
  const db = b.date.split('-').map(Number);
  for (let i = 0; i < 3; i++) {
    if (da[i] !== db[i]) return da[i] - db[i];
  }
  const order = (type) => MEAL_TYPES.findIndex((t) => t.id === type);
  return order(a.type) - order(b.type);
}

// Mensaje del periodo o null si es válido: primero las fechas vacías (RF-30), luego el orden (RF-19)
function periodError(from, to) {
  if (!from.date || !to.date) return PERIOD_DATES_MESSAGE;
  return compareMoments(to, from) < 0 ? PERIOD_ORDER_MESSAGE : null;
}

// ¿Es la última carga pedida? Si no, sus comidas se ignoran (RF-32, D-12)
function isCurrentLoad(load, review) {
  return load.id === review.requestId;
}

// Comidas con su momento entre "Desde" y "Hasta" (los dos incluidos), por orden de momento (RF-3)
function mealsInPeriod(meals, from, to) {
  const momentOf = (meal) => ({ date: meal.fecha, type: meal.tipo });
  return meals
    .filter((meal) => compareMoments(from, momentOf(meal)) <= 0 && compareMoments(momentOf(meal), to) <= 0)
    .sort((a, b) => compareMoments(momentOf(a), momentOf(b)));
}

// Ingrediente de compra: con cantidad y en una unidad de artículo (RF-29; 013 C-14)
function isPurchaseIngredient(ingredient) {
  return ingredient.cantidad !== null && ingredient.cantidad !== undefined
    && ARTICLE_UNITS.includes(ingredient.unidad);
}

// Redondeo a 3 decimales con el exponente en texto, sin restos de coma flotante (D-4)
function roundQuantity(value) {
  return Number(Math.round(Number(value + 'e3')) + 'e-3');
}

// Cantidad en la unidad base del tipo (gr., ml., und.); kg. y l. con el exponente en texto (D-4)
function baseQuantity(cantidad, unidad) {
  return unidad === 'kg' || unidad === 'l' ? Number(Number(cantidad) + 'e3') : Number(cantidad);
}

// Total de un tipo en su unidad: kg. (o l.) si todo venía así o llega a 1000; si no, gr. (o ml.).
// Los de recuento, con roundUp, al entero de arriba tras quitar restos (013 C-15, D-8)
function kindTotal(kind, list, roundUp = false) {
  const total = list.reduce((sum, a) => sum + baseQuantity(a.cantidad, a.unidad), 0);
  if (KIND_UNITS[kind]) {
    const exact = roundQuantity(total);
    return { cantidad: roundUp ? Math.ceil(exact) : exact, unidad: KIND_UNITS[kind] };
  }
  const [big, small] = kind === 'weight' ? ['kg', 'gr'] : ['l', 'ml'];
  if (list.every((a) => a.unidad === big) || total >= 1000) {
    return { cantidad: roundQuantity(Number(total + 'e-3')), unidad: big };
  }
  return { cantidad: roundQuantity(total), unidad: small };
}

// Suma de cantidades de compra: un tipo → { cantidad, unidad }; varios → detail
// "2 und. + 1 lata + 160 gr." en el orden de KIND_ORDER (RF-5, RF-11, RF-15; 013 C-17).
// roundUp: solo las líneas de la revisión; "Sumar" suma sin volver a redondear (013 D-8)
function combineAmounts(amounts, { roundUp = false } = {}) {
  const totals = KIND_ORDER
    .map((kind) => [kind, amounts.filter((a) => UNIT_KINDS[a.unidad] === kind)])
    .filter(([, list]) => list.length > 0)
    .map(([kind, list]) => kindTotal(kind, list, roundUp));
  if (totals.length === 1) return { ...totals[0], detail: null };
  return {
    cantidad: null,
    unidad: null,
    detail: totals.map((t) => formatQuantity(t.cantidad, t.unidad)).join(' + '),
  };
}

// ===== 009-ingredientes-automaticos: líneas de la revisión y opciones =====

// Línea de la revisión por cada grupo de ingredientes de compra con nombre equivalente:
// { key, nombre, cantidad, unidad, detail, status, article, tooLong }. Nombre del artículo
// equivalente o del primer ingrediente (momento, plato, ingrediente); nuevas y en Guardados
// en orden alfabético y después las ya en la lista (RF-5, RF-6, RF-7, RF-29, CL-3, CL-4)
function periodLines(meals, from, to, items) {
  const groups = new Map();
  for (const meal of mealsInPeriod(meals, from, to)) {
    for (const dish of meal.platos ?? []) {
      for (const ingredient of dish.ingredientes ?? []) {
        if (!isPurchaseIngredient(ingredient)) continue;
        const key = articleKey(ingredient.nombre);
        if (!groups.has(key)) groups.set(key, { name: cleanIngredientName(ingredient.nombre), amounts: [] });
        groups.get(key).amounts.push(ingredient);
      }
    }
  }
  const lines = [...groups].map(([key, group]) => {
    const article = findEquivalent(items, group.name);
    const nombre = article ? article.nombre : group.name;
    const status = !article ? 'new' : article.lista === 'guardados' ? 'saved' : 'listed';
    return { key, nombre, ...combineAmounts(group.amounts, { roundUp: true }), status, article, tooLong: nombre.length > MAX_ARTICLE_NAME };
  });
  const listed = (line) => line.status === 'listed';
  return [
    ...lines.filter((line) => !listed(line)).sort(compareArticles),
    ...lines.filter(listed).sort(compareArticles),
  ];
}

// Textos de una línea ya en la lista: "Ya en la lista: 2 und.", "Dejar 2 und.", "Sumar: 8 und."
// (null si no se puede sumar) y "Cambiar a 6 und." (null si la línea no tiene cantidad);
// null si la línea no está en la lista (RF-10, RF-11, RF-28)
function lineOptions(line) {
  if (line.status !== 'listed') return null;
  const article = line.article;
  const hasArticleAmount = article.cantidad !== null && article.cantidad !== undefined && UNIT_KINDS[article.unidad];
  const hasLineAmount = line.cantidad !== null;
  const current = hasArticleAmount ? formatQuantity(article.cantidad, article.unidad) : '';
  let sum = null;
  if (hasArticleAmount && hasLineAmount) {
    const total = combineAmounts([article, line]);
    if (!total.detail) sum = `Sumar: ${formatQuantity(total.cantidad, total.unidad)}`;
  }
  return {
    listed: current ? `Ya en la lista: ${current}` : 'Ya en la lista',
    keep: current ? `Dejar ${current}` : 'Dejar',
    sum,
    change: hasLineAmount ? `Cambiar a ${formatQuantity(line.cantidad, line.unidad)}` : null,
  };
}

// ===== 009-ingredientes-automaticos: elecciones, lo que se ve y cambios a enviar =====

const NO_INGREDIENTS_MESSAGE = 'No hay ingredientes que comprar en las comidas de este periodo.';
const LINE_TOO_LONG_MESSAGE = 'Nombre demasiado largo para la lista (más de 200 caracteres).';
const SAVED_LINE_TEXT = 'En Guardados';
const ADD_RETRIES = 3; // intentos de "Añadir (n)" si la otra persona cambia la lista (D-2)

// Elección de una línea al abrir: marcada si es nueva o en Guardados (salvo nombre demasiado
// largo) y "Dejar" si ya está en la lista (RF-8, RF-10, CL-4)
function openingChoice(line) {
  if (line.status === 'listed') return 'keep';
  return line.tooLong ? 'off' : 'on';
}

// Elecciones de las líneas nuevas a partir de las anteriores, por key (RF-23, D-9, D-11)
function mergeChoices(previous, previousLines, lines) {
  const choices = new Map();
  for (const line of lines) {
    const before = previousLines.find((l) => l.key === line.key);
    const choice = before ? previous.get(line.key) : undefined;
    let next = openingChoice(line);
    if (before && choice && before.status === line.status) {
      // Mismo estado: se conserva, salvo Sumar o Cambiar a que ya no se ofrecen (RF-11, RF-28)
      const options = lineOptions(line);
      const gone = (choice === 'sum' && !options.sum) || (choice === 'change' && !options.change);
      next = gone ? 'keep' : choice;
    } else if (before && choice && before.status === 'listed') {
      // De "Ya en la lista" a Guardados o nueva: Sumar o Cambiar a → marcada; Dejar → desmarcada
      next = choice === 'keep' ? 'off' : 'on';
    }
    choices.set(line.key, next);
  }
  return choices;
}

// ¿Enseña la revisión líneas? No con periodo no válido, error de carga, "Cargando…" ni
// periodo sin ingredientes (RF-19, RF-20, RF-21, RF-30, RF-31, D-11)
function linesInView(review) {
  return !periodError(review.from, review.to) && !review.loadError && !review.loading && !review.noIngredients;
}

// Líneas, elecciones y noIngredients tras recalcular: nada cambia mientras se añade ni sin
// líneas a la vista; un periodo sin ingredientes no pierde lo elegido (RF-17, RF-20, RF-23, D-11)
function recalcReview(review, newLines) {
  const { lines, choices, noIngredients } = review;
  if (review.saving || periodError(review.from, review.to) || review.loadError || review.loading) {
    return { lines, choices, noIngredients };
  }
  if (newLines.length === 0) return { lines, choices, noIngredients: true };
  return { lines: newLines, choices: mergeChoices(choices, lines, newLines), noIngredients: false };
}

// "Añadir (n)": marcadas (sin nombre demasiado largo) más las de Sumar o Cambiar a (RF-9, RF-12, CL-4)
function addCount(lines, choices) {
  return lines.filter((line) => countsForAdd(line, choices.get(line.key))).length;
}

function countsForAdd(line, choice) {
  return (choice === 'on' && !line.tooLong) || choice === 'sum' || choice === 'change';
}

function addButtonText(count) {
  return `Añadir (${count})`;
}

// Lo que se ve: mode 'period', 'error', 'loading', 'empty' o 'lines', su mensaje, las líneas,
// el número de "Añadir (n)" y qué está desactivado (RF-12, RF-17, RF-19 a RF-22, RF-30, RF-31)
function reviewView(review) {
  const saving = Boolean(review.saving);
  const blocked = (mode, message) => ({
    mode, message, lines: [], count: 0, addDisabled: true, controlsDisabled: saving,
  });
  const period = periodError(review.from, review.to);
  if (period) return blocked('period', period);
  if (review.loadError) return blocked('error', review.loadError);
  if (review.loading) return blocked('loading', null);
  if (review.noIngredients) return blocked('empty', NO_INGREDIENTS_MESSAGE);
  const count = addCount(review.lines, review.choices);
  return {
    mode: 'lines',
    message: review.saveError || null,
    lines: review.lines,
    count,
    addDisabled: count === 0 || saving || Boolean(review.offline), // sin red (009 CL-8)
    controlsDisabled: saving,
  };
}

// Cambios para anadir_ingredientes, decididos con los artículos actuales (D-2, CL-6):
// nuevo → anadir; en Guardados → recuperar con la cantidad de la línea o la guardada;
// en Por comprar → solo Sumar o Cambiar a que se sigan ofreciendo (RF-13 a RF-16, RF-26, CL-4)
function addChanges(lines, choices, items) {
  const changes = [];
  for (const line of lines) {
    const choice = choices.get(line.key);
    if (!countsForAdd(line, choice)) continue;
    const article = findEquivalent(items, line.nombre);
    if (!article) {
      changes.push({ accion: 'anadir', nombre: line.nombre, cantidad: line.cantidad, unidad: line.unidad });
      continue;
    }
    const change = (cantidad, unidad) => ({
      accion: 'cambiar',
      id: article.id,
      antes: { lista: article.lista, cantidad: article.cantidad, unidad: article.unidad },
      cantidad,
      unidad,
    });
    if (article.lista === 'guardados') {
      const own = line.cantidad !== null;
      changes.push(change(own ? line.cantidad : article.cantidad, own ? line.unidad : article.unidad));
      continue;
    }
    if (choice === 'on') continue; // ya en Por comprar: como "Dejar"
    const options = lineOptions({ ...line, status: 'listed', article });
    if (choice === 'sum' && options.sum) {
      const total = combineAmounts([article, line]);
      changes.push(change(total.cantidad, total.unidad));
    } else if (choice === 'change' && options.change) {
      changes.push(change(line.cantidad, line.unidad));
    }
  }
  return changes;
}

// Error de la revisión: action 'load' (comidas del periodo) o 'add' (Añadir), con la causa;
// un 23505 no habla de comidas (RF-21, RF-22)
function ingredientsErrorMessage(action, error, online) {
  const prefix = action === 'load'
    ? 'No se han podido cargar las comidas del periodo. '
    : 'No se han podido añadir los ingredientes. ';
  const cause = error?.code === '23505' && !isNetworkError(error, online)
    ? 'Ha ocurrido un error inesperado. Inténtalo de nuevo.'
    : translateError(error, online);
  return prefix + cause;
}

// ===== Plazo de conexión (010-instalacion-webapp) =====

// Espera máxima a Supabase (000-base RF-2) y a la versión publicada (CL-1): la comparten
// app.js y sw.js (D-5)
const CONNECTION_TIMEOUT = 8000;

// ===== Archivos de una versión (010-instalacion-webapp) =====

// Archivos que forman una versión de la app, relativos a su carpeta; './' es la página.
// Sin sw.js: lo gestiona el navegador (RF-10, RF-11, RNF-1)
const APP_FILES = [
  './', './styles.css', './supabase.js', './logic.js', './app.js', './manifest.json',
  './favicon.png', './icon-192.png', './icon-512.png', './icon-maskable.png',
];

// ===== Versiones de los archivos (010-instalacion-webapp) =====

// Versión de un archivo: prefijo del ETag de Pages ("<hora del despliegue>-<tamaño>",
// en hex, con W/ si va comprimido); null sin ETag o con otra forma (D-3, RF-10)
function etagVersion(etag) {
  const match = /^(?:W\/)?"([0-9a-f]+)-[0-9a-f]+"$/i.exec(etag || '');
  return match ? match[1] : null;
}

// Dos horas de despliegue separadas como mucho estos segundos son la misma versión:
// Pages no siempre pone la misma hora a todos los archivos (D-13, CL-10)
const SAME_VERSION_SECONDS = 10;

// Segundos entre las horas de dos versiones (el hex del prefijo del ETag)
function versionGap(a, b) {
  return Math.abs(parseInt(a, 16) - parseInt(b, 16));
}

// ¿Son todos los archivos de la misma versión? Sí si sus horas se separan 10 s como mucho,
// con id la más baja; ninguno con versión (servidor local) también cuenta como entera,
// sin id; cualquier mezcla, no (RF-10, CL-2, CL-10)
function commonVersion(etags) {
  const ids = etags.map(etagVersion);
  if (ids.every((id) => id === null)) return { whole: true, id: null };
  if (ids.some((id) => id === null)) return { whole: false, id: null };
  const sorted = [...ids].sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
  const lowest = sorted[0];
  const whole = versionGap(lowest, sorted[sorted.length - 1]) <= SAME_VERSION_SECONDS;
  return whole ? { whole, id: lowest } : { whole: false, id: null };
}

// La versión guardada es la publicada solo si las dos tienen id y se separan
// 10 s como mucho (RF-9, CL-10)
function isSavedCurrent(savedId, publishedId) {
  return savedId != null && publishedId != null
    && versionGap(savedId, publishedId) <= SAME_VERSION_SECONDS;
}

// ¿Es una navegación a la página de la app? La carpeta de scope o su index.html, del mismo
// origen y con cualquier ?… o #… (enlace de recuperación); nada más (RF-9, RF-15, CL-8)
function isAppPage(url, scope) {
  const page = new URL(url);
  const base = new URL(scope);
  return page.origin === base.origin &&
    (page.pathname === base.pathname || page.pathname === base.pathname + 'index.html');
}

// ===== 011-sin-conexion: copia guardada para ver sin red =====

// Clave de localStorage y versión del formato de la copia (D-1)
const COPY_KEY = 'offline-copy';
const COPY_FORMAT = 1;

// Intervalo guardado: del lunes de 4 semanas antes de la de hoy al domingo de 2 semanas
// después, 7 semanas enteras (RF-1)
function copyRange(today) {
  const monday = weekStart(today);
  return { from: addDays(monday, -28), to: addDays(monday, 20) };
}

// Copia lista para guardar: fechas en 'aaaa-mm-dd' y savedAt en milisegundos (RF-2); con
// mealNames, los nombres de comidas para sugerir, campo opcional del mismo formato (014 D-9)
function buildCopy({ savedAt, from, to, meals, articles, mealNames }) {
  const copy = { format: COPY_FORMAT, savedAt, from: toISODate(from), to: toISODate(to), meals, articles };
  return mealNames === undefined ? copy : { ...copy, mealNames };
}

// Nombres de comidas de la respuesta de nombres_ingredientes: un array de textos, sin los
// vacíos; null si no tiene esa forma (entonces se quedan los anteriores, 014 C-21, D-7)
function cleanMealNames(value) {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) return null;
  return value.filter((name) => name.trim() !== '');
}

// Nombres de comidas de una copia; [] si no hay copia o es de una versión anterior o el campo
// está mal (014 C-20, D-9)
function copyMealNames(copy) {
  return cleanMealNames(copy?.mealNames) ?? [];
}

// Texto guardado → copia, o null si falta o no se sabe leer: cuenta como sin copia (CL-2)
function parseCopy(text) {
  if (!text) return null;
  let copy;
  try {
    copy = JSON.parse(text);
  } catch {
    return null;
  }
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const valid = copy !== null && typeof copy === 'object' && copy.format === COPY_FORMAT &&
    Number.isFinite(copy.savedAt) && isDate(copy.from) && isDate(copy.to) &&
    Array.isArray(copy.meals) && Array.isArray(copy.articles);
  return valid ? copy : null;
}

// ¿Queda el día ('aaaa-mm-dd') fuera del intervalo de la copia? (RF-15)
function isOutsideCopy(isoDate, copy) {
  return isoDate < copy.from || isoDate > copy.to;
}

// ¿Algún día del periodo visible (fechas from…to) queda fuera de la copia? El intervalo no
// tiene huecos, así que basta mirar los extremos (RF-15)
function hasCopyGap(from, to, copy) {
  return isOutsideCopy(toISODate(from), copy) || isOutsideCopy(toISODate(to), copy);
}

// Tablas fijas del aviso del modo copia: Intl no da "oct." ni "sept." igual en todos (D-8)
const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTH_ABBR = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sept.', 'oct.', 'nov.', 'dic.'];

// Aviso del modo copia con la fecha y hora locales de la copia; el año, solo si no es el de
// hoy (RF-5)
function copyNoticeText(savedAt, today) {
  const saved = new Date(savedAt);
  const year = saved.getFullYear() === today.getFullYear() ? '' : ` de ${saved.getFullYear()}`;
  const time = `${String(saved.getHours()).padStart(2, '0')}:${String(saved.getMinutes()).padStart(2, '0')}`;
  return `Sin conexión. Mostrando lo guardado el ${WEEKDAY_NAMES[saved.getDay()]} ${saved.getDate()} ` +
    `de ${MONTH_ABBR[saved.getMonth()]}${year} a las ${time}.`;
}

// Clave de localStorage con que supabase-js 2.117.2 guarda la sesión (D-4)
function authStorageKey(url) {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
}

// Email de la sesión guardada por supabase-js, o null si no hay sesión que se pueda
// renovar; no mira si el token ha caducado (RF-4, D-4)
function storedSessionEmail(text) {
  if (!text) return null;
  let session;
  try {
    session = JSON.parse(text);
  } catch {
    return null;
  }
  if (!session || typeof session !== 'object') return null;
  const email = session.user?.email;
  const valid = typeof session.refresh_token === 'string' && session.refresh_token !== '' &&
    typeof email === 'string' && email !== '';
  return valid ? email : null;
}

// ¿Se abre en modo copia? Solo sin respuesta del servidor, con sesión y copia guardadas, sin
// enlace de acceso en la dirección y sin cambio de contraseña a medias (RF-4, RF-14, D-4)
function opensInCopy({ status, hasSession, hasCopy, link, pending }) {
  return status === null && Boolean(hasSession) && Boolean(hasCopy) && link === 'none' && !pending;
}

// ===== Reintento en modo copia (011-sin-conexion) =====

// Resultado de un reintento; meals y list son { error, timedOut } de cada carga (online:
// navigator.onLine). Sin respuesta de alguna, 'noResponse'; sesión cerrada, 'sessionGone';
// si no, el error de carga de hoy: el de las comidas o, si solo falla la lista, el suyo
// (RF-12, RF-13, CL-4, CL-7)
function retryOutcome(meals, list, online) {
  const noAnswer = (load) => load.timedOut || (Boolean(load.error) && isNetworkError(load.error, online));
  if (noAnswer(meals) || noAnswer(list)) return { kind: 'noResponse' };
  if (isSessionGone(meals.error) || isSessionGone(list.error)) return { kind: 'sessionGone' };
  if (meals.error) {
    return { kind: 'error', message: 'No se han podido cargar las comidas. ' + translateError(meals.error, online), notice: 'load' };
  }
  if (list.error) return { kind: 'error', message: articleErrorMessage('load', list.error, online), notice: 'listLoad' };
  return { kind: 'ok' };
}

// ===== Cierre de sesión sin red (011-sin-conexion) =====

// Resultado de "Cerrar sesión" (timedOut: pasaron los 8 s). Sin error y a tiempo, 'done';
// plazo vencido o cualquier error (de red o de Supabase), 'local': cierre en este dispositivo (D-12)
function logOutOutcome({ error, timedOut }) {
  return timedOut || error ? 'local' : 'done';
}

// ===== 012-tachar-sin-red: cola de tachados sin red =====

// Clave de localStorage y versión del formato de la cola (D-1). Un cambio en cola es
// { id, name, from, value }: tachado al tocarlo la primera vez y tachado querido
const STRIKE_QUEUE_KEY = 'strike-queue';
const STRIKE_QUEUE_FORMAT = 1;

// Cola lista para guardar (RF-7)
function buildStrikeQueue(changes) {
  return { format: STRIKE_QUEUE_FORMAT, changes };
}

// ¿Es un cambio en cola bien formado? (RF-7)
function isQueuedStrike(change) {
  return change !== null && typeof change === 'object' && typeof change.id === 'string' &&
    typeof change.name === 'string' && typeof change.from === 'boolean' &&
    typeof change.value === 'boolean' && change.from !== change.value;
}

// Texto guardado → lista de cambios; [] si falta o no se sabe leer. Sin repetidos por id:
// se queda el primero (RF-7, CL-3)
function parseStrikeQueue(text) {
  if (!text) return [];
  let queue;
  try {
    queue = JSON.parse(text);
  } catch {
    return [];
  }
  if (queue === null || typeof queue !== 'object' || queue.format !== STRIKE_QUEUE_FORMAT ||
    !Array.isArray(queue.changes) || !queue.changes.every(isQueuedStrike)) return [];
  const seen = new Set();
  return queue.changes.filter((change) => !seen.has(change.id) && seen.add(change.id));
}

// Toque en la casilla de un artículo: un solo cambio por artículo, en el puesto del primer
// toque; si vuelve a como estaba, sale de la cola; si no tenía, entra al final (RF-1, RF-6, D-12)
function toggleQueuedStrike(changes, item, value) {
  const current = changes.find((change) => change.id === item.id);
  if (!current) return [...changes, { id: item.id, name: item.nombre, from: item.tachado, value }];
  if (value === current.from) return changes.filter((change) => change.id !== item.id);
  return changes.map((change) => (change.id === item.id ? { ...change, value } : change));
}

// La cola sin el cambio de ese artículo (RF-19)
function removeQueuedStrike(changes, id) {
  return changes.filter((change) => change.id !== id);
}

// Lista que se ve: el tachado querido en los artículos de Por comprar con cambio en cola, y
// sus ids en unsent; si el artículo falta o está en Guardados, ni se aplica ni se marca (RF-3, RF-7)
function applyStrikeQueue(items, changes) {
  const wanted = new Map(changes.map((change) => [change.id, change.value]));
  const unsent = new Set();
  const shown = items.map((item) => {
    if (item.lista !== 'por_comprar' || !wanted.has(item.id)) return item;
    unsent.add(item.id);
    return { ...item, tachado: wanted.get(item.id) };
  });
  return { items: shown, unsent };
}

// Aviso del modo copia con "<n> cambios sin enviar." al final; sin cambios, igual (RF-4)
function withUnsentCount(notice, n) {
  if (n === 0) return notice;
  return notice + (n === 1 ? ' 1 cambio sin enviar.' : ` ${n} cambios sin enviar.`);
}

// Aviso de los cambios no aplicados, con los nombres en el orden de la cola (RF-12)
function conflictNoticeText(names) {
  const start = names.length === 1 ? 'No se ha aplicado 1 cambio' : `No se han aplicado ${names.length} cambios`;
  return `${start} porque el artículo cambió mientras estabas sin conexión: ${names.join(', ')}.`;
}

// Qué hacer con un cambio en cola al enviarlo, según la fila de la base de datos
// ({ lista, tachado } o null): 'apply' si sigue como se vio (también con otro nombre o
// cantidad, o devuelto a Por comprar); 'done' si ya tiene el valor querido; 'conflict' si
// falta o está en Guardados (RF-10, RF-11, RF-13, CL-1, CL-4)
function queuedStrikeOutcome(change, row) {
  if (!row || row.lista !== 'por_comprar') return 'conflict';
  return row.tachado === change.value ? 'done' : 'apply';
}

// ¿Sigue en la cola el mismo cambio (id, from y value)? Se mira antes de cada envío (D-9)
function isStillQueued(changes, change) {
  return changes.some((queued) => queued.id === change.id && queued.from === change.from &&
    queued.value === change.value);
}

// Cola que queda tras un envío (stored: releída al acabar; settled: [{ change, result }]).
// Un conflicto sale siempre; lo aplicado o ya hecho sale si sigue igual; si se tocó durante
// el envío y volvió a su from, entra al final el cambio inverso; lo demás sigue (D-9, D-12)
function settleStrikeQueue(stored, settled) {
  let queue = stored;
  const inverses = [];
  for (const { change, result } of settled) {
    const current = queue.find((queued) => queued.id === change.id);
    if (result === 'conflict' || (current && current.value === change.value)) {
      queue = queue.filter((queued) => queued.id !== change.id);
    } else if (!current) {
      inverses.push({ id: change.id, name: change.name, from: change.value, value: change.from });
    }
  }
  return [...queue, ...inverses];
}

// Clasifica una respuesta del envío de la cola, también la de getUser (result: forma de
// timedQuery; online: reachable(result)): null si salió bien; 'noResponse' sin respuesta en
// plazo o error de red; 'sessionGone' con la sesión no válida; si no, 'error' (D-5, CL-6, CL-7)
function strikeSendFailure(result, online) {
  if (!result.error) return null;
  if (result.timedOut || isNetworkError(result.error, online)) return 'noResponse';
  if (isSessionGone(result.error) || result.status === 401) return 'sessionGone';
  return 'error';
}

// ¿Arranca el reintento de la cola? (sent: resultado de sendStrikeQueue; pending: cambios
// que quedan) Sí si queda cola, salvo cola vacía o sesión no válida (D-8, RF-16, RF-17)
function needsQueueRetry(sent, pending) {
  return pending > 0 && sent !== 'empty' && sent !== 'sessionGone';
}

if (typeof module !== 'undefined') {
  module.exports = {
    MEAL_TYPES, UNITS, UNIT_PLURALS, INGREDIENT_UNITS, ARTICLE_UNITS,
    toISODate, fromISODate, addDays, weekStart, isSameDay, formatDate, longDate,
    visibleRange, movePeriod, periodTitle, monthGrid, weekDays, initialFormDate,
    initialPanelYear, panelArrows, monthPanel, chooseMonth,
    mealKey, dishNames, dishTitle, formatIngredient, safeLink, deleteConfirmText,
    formDishLayout, isIngredientRowEmpty, dishHasData, validateDish, validateMealForm,
    flattenLineBreaks, cleanIngredientName, checkAmount, formatQuantity,
    parseAmountText, formatAmount, amountFieldText, amountFromField, pickedAmountFields,
    keysDefined, configMessage, loginInputError, isNetworkError, translateLoginError,
    translateError, syncStatusAction, isOtherMeal, wasDeleted,
    duplicateMessage, saveErrorMessage,
    RECOVERY_SENT_MESSAGE, recoveryInputError, translateRecoveryError,
    LINK_EXPIRED_MESSAGE, PASSWORD_CHANGED_MESSAGE, SESSION_CLOSED_MESSAGE, MIN_PASSWORD_LENGTH,
    newPasswordError, isSessionGone, translatePasswordError,
    readAuthLink, urlWithoutAuthData, recoveryRedirect, startScreen, authEventScreen,
    PEER_REFRESH_MS, PEER_MAX_AGE_MS, PEER_CHECK_MS, PEER_LEAVE_GRACE_MS,
    sameSlot, activePeers, updatePeers, hasMatch, formMessage, needsReply,
    MATCH_MESSAGE, SAVED_ELSEWHERE_MESSAGE, matchNotice, saveOutcome, savedSince, leavesSlot,
    MAX_ARTICLE_NAME, MAX_SUGGESTIONS, validateArticleForm, articleKey, compareArticles,
    shoppingLists, suggestions, matchesTyped, ingredientSuggestions, moveMark, keptMark,
    findEquivalent, articleExistsMessage, articleDeleteText, finishConfirmText, addOutcome,
    articleErrorMessage, articleSaveErrorMessage, ARTICLE_UNEXPECTED_MESSAGE, ARTICLE_GONE_MESSAGE,
    ARTICLE_CHANGED_MESSAGE, NO_STRUCK_MESSAGE, openingScreen,
    userInitial, isSidebarCollapsed, shortWeekDate, needsShortWeekDates,
    PERIOD_ORDER_MESSAGE, PERIOD_DATES_MESSAGE, UNIT_KINDS, defaultPeriod, compareMoments,
    periodError, isCurrentLoad, mealsInPeriod, isPurchaseIngredient, roundQuantity, combineAmounts,
    periodLines, lineOptions,
    NO_INGREDIENTS_MESSAGE, LINE_TOO_LONG_MESSAGE, SAVED_LINE_TEXT, ADD_RETRIES,
    mergeChoices, linesInView, recalcReview, addCount, addButtonText, reviewView, addChanges,
    ingredientsErrorMessage,
    etagVersion, commonVersion, isSavedCurrent, isAppPage, CONNECTION_TIMEOUT, APP_FILES,
    SAME_VERSION_SECONDS,
    COPY_KEY, COPY_FORMAT, copyRange, buildCopy, parseCopy, isOutsideCopy, hasCopyGap,
    cleanMealNames, copyMealNames,
    WEEKDAY_NAMES, MONTH_ABBR, copyNoticeText, authStorageKey, storedSessionEmail, opensInCopy,
    retryOutcome, logOutOutcome,
    STRIKE_QUEUE_KEY, STRIKE_QUEUE_FORMAT, buildStrikeQueue, parseStrikeQueue,
    toggleQueuedStrike, removeQueuedStrike, applyStrikeQueue, withUnsentCount, conflictNoticeText,
    queuedStrikeOutcome, isStillQueued, settleStrikeQueue, strikeSendFailure, needsQueueRetry,
  };
}
