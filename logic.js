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

// "0,5 kg." o '' sin cantidad; una unidad desconocida se muestra tal cual (007-lista-compra RF-8, D-10)
function formatQuantity(cantidad, unidad) {
  if (cantidad === null || cantidad === undefined) return '';
  return `${Number(cantidad).toLocaleString('es-ES')} ${UNITS[unidad] || unidad}`;
}

// "Harina: 0,5 kg."; una unidad desconocida se muestra tal cual
function formatIngredient(ingredient) {
  return `${ingredient.nombre}: ${formatQuantity(ingredient.cantidad, ingredient.unidad)}`;
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

// Cantidad del campo en bruto: número mayor que 0, o null si está vacía, no es un número
// (badInput, CL-5) o no es mayor que 0. La comparten ingrediente y artículo (007-lista-compra D-10)
function parseQuantity(raw, badInput) {
  const quantity = Number(raw);
  return !badInput && raw !== '' && Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

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
    const name = cleanIngredientName(row.name);
    const quantity = parseQuantity(row.quantity, row.badInput);
    const quantityOk = quantity !== null;
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
function validateArticleForm({ name, quantity, badInput, unit }) {
  const invalid = [];
  const nombre = cleanIngredientName(name);
  if (!nombre) invalid.push('name');

  const noQuantity = quantity === '' && !badInput;
  const noUnit = !unit;
  let cantidad = null;
  if (!noQuantity || !noUnit) {
    cantidad = parseQuantity(quantity, badInput);
    if (cantidad === null) invalid.push('quantity');
    if (!UNITS[unit]) invalid.push('unit');
  }

  if (invalid.length) {
    return { error: invalid[0] === 'name' ? ARTICLE_NAME_ERROR : ARTICLE_QUANTITY_ERROR, invalid };
  }
  return { data: { nombre, cantidad, unidad: cantidad === null ? null : unit } };
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

// Hasta MAX_SUGGESTIONS artículos de Guardados, en orden, con alguna palabra que empieza por
// lo escrito (sin mayúsculas ni acentos); [] si lo escrito queda vacío (RF-21, RF-22)
function suggestions(items, typed) {
  const key = articleKey(typed);
  if (!key) return [];
  return shoppingLists(items).saved
    .filter((item) => (' ' + articleKey(item.nombre)).includes(' ' + key))
    .slice(0, MAX_SUGGESTIONS);
}

if (typeof module !== 'undefined') {
  module.exports = {
    MEAL_TYPES, UNITS,
    toISODate, fromISODate, addDays, weekStart, isSameDay, formatDate, longDate,
    visibleRange, movePeriod, periodTitle, monthGrid, weekDays, initialFormDate,
    initialPanelYear, panelArrows, monthPanel, chooseMonth,
    mealKey, dishNames, dishTitle, formatIngredient, safeLink, deleteConfirmText,
    formDishLayout, isIngredientRowEmpty, dishHasData, validateDish, validateMealForm,
    flattenLineBreaks, cleanIngredientName, parseQuantity, formatQuantity,
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
    shoppingLists, suggestions,
  };
}
