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

// ===== Formulario: distribución de los platos y filas vacías =====
// Las filas y los platos llegan en bruto desde el formulario (D-6):
// row = { name, quantity, badInput, unit }; rawDish = { name, recipe, reference, rows }

// Una fila vacía no se guarda; una cantidad no numérica (badInput) cuenta como dato
function isIngredientRowEmpty(row) {
  return !row.name.trim() && row.quantity === '' && !row.badInput && !row.unit;
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
// invalid: lista de campos que fallan, { dish, field, row? } o { field: 'date' }; app.js los marca (D-6)

const INGREDIENT_ERROR = 'Completa cada ingrediente: nombre, cantidad mayor que 0 y unidad.';
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
    const name = row.name.trim();
    const quantity = Number(row.quantity);
    const quantityOk = !row.badInput && row.quantity !== '' && Number.isFinite(quantity) && quantity > 0;
    const unitOk = Boolean(UNITS[row.unit]);
    if (!name) fail(INGREDIENT_ERROR, 'name', i);
    if (!quantityOk) fail(INGREDIENT_ERROR, 'quantity', i);
    if (!unitOk) fail(INGREDIENT_ERROR, 'unit', i);
    if (name && quantityOk && unitOk) ingredients.push({ nombre: name, cantidad: quantity, unidad: row.unit });
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
// check: { libraryLoaded, keysDefined, status }; status es null si el servidor no responde.
// Los textos citan los nombres actuales de app.js.
function configMessage(check) {
  if (!check.libraryLoaded) {
    return 'No se ha podido cargar la librería de Supabase. Comprueba que el archivo supabase.js está junto a index.html.';
  }
  if (!check.keysDefined) {
    return 'Faltan las claves de Supabase. Abre app.js y rellena SUPABASE_URL y SUPABASE_PUBLIC_KEY con los datos de tu proyecto.';
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
// 'show' (mostrar el aviso), 'recover' (quitarlo y recargar) o 'none'
function syncStatusAction(channelStatus, noticeKind) {
  if (channelStatus === 'SUBSCRIBED') return noticeKind === 'sync' ? 'recover' : 'none';
  if (channelStatus === 'CHANNEL_ERROR' || channelStatus === 'TIMED_OUT') return 'show';
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

if (typeof module !== 'undefined') {
  module.exports = {
    MEAL_TYPES, UNITS,
    toISODate, fromISODate, addDays, weekStart, isSameDay, formatDate, longDate,
    visibleRange, movePeriod, periodTitle, monthGrid, weekDays, initialFormDate,
    mealKey, dishNames, dishTitle, formatIngredient, safeLink, deleteConfirmText,
    formDishLayout, isIngredientRowEmpty, dishHasData, validateDish, validateMealForm,
    keysDefined, configMessage, loginInputError, isNetworkError, translateLoginError,
    translateError, syncStatusAction, isOtherMeal, wasDeleted,
    duplicateMessage, saveErrorMessage,
    RECOVERY_SENT_MESSAGE, recoveryInputError, translateRecoveryError,
    LINK_EXPIRED_MESSAGE, PASSWORD_CHANGED_MESSAGE, SESSION_CLOSED_MESSAGE, MIN_PASSWORD_LENGTH,
    newPasswordError, isSessionGone, translatePasswordError,
    readAuthLink, urlWithoutAuthData, recoveryRedirect, startScreen, authEventScreen,
  };
}
