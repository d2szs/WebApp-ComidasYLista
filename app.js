'use strict';

// ===== Claves de Supabase (solo la clave pública, nunca la secreta) =====
const SUPABASE_URL = 'https://beyarsihdhzpxzvsxeep.supabase.co';
const SUPABASE_PUBLIC_KEY = 'sb_publishable_BLEWWv74RigJ6Jo977E59A_2vs3nYk2';

// ===== Estado =====
const state = {
  view: 'week',         // 'month' | 'week' | 'day'
  refDate: getToday(),  // día de referencia del periodo visible
  meals: new Map(),     // 'aaaa-mm-dd|tipo' → fila
  openType: null,       // tipo desplegado en la vista diaria
  requestId: 0,         // para descartar respuestas antiguas
  noticeKind: null,     // origen del aviso visible: 'load' | 'offline' | 'listLoad' | 'sync' | 'copy' | 'action'
  copyMode: false,      // 011: mostrando la copia guardada (000-base D-19)
  offline: false,       // 011: sin red, con o sin copia (009 D-14)
  channelStatus: null,  // último estado del canal de tiempo real (000-base CL-15)
};
// 011: copia para ver sin red; saveId descarta guardados adelantados por otro (D-3);
// retryTimer y probing, el reintento de cada 30 s (RF-16, D-6)
const copyState = { copy: null, saveTimer: null, saveId: 0, retryTimer: null, probing: false, rerun: false };

let panelYear = null;   // año que muestra el panel de meses (006 RF-2, RF-6)
let panelPressedOutside = false; // la pulsación empezó fuera del panel (006 D-1)
let menuPressedOutside = false;  // lo mismo en el menú del usuario (008 RF-7)

const formState = {
  id: null,             // id de la entrada en edición (null = nueva)
  type: null,
  dish1: null,
  dish2: null,
  searchId: 0,          // para descartar búsquedas antiguas de entradas existentes
  open: false,          // el formulario está abierto (004 RF-1)
  saving: false,        // guardado en curso (000-base RF-36)
  savedElsewhere: false, // aviso de 004 RF-3 activo
  savedSlot: null,       // fecha y tipo al llegar el aviso de RF-3 (RF-5, CL-7)
  snapshot: null,        // { fecha, tipo, platos } de la comida abierta, o null si es nueva (CL-4)
  seen: null,            // { date, type, meal }: qué había en la fecha y el tipo del formulario (D-12)
  recheckId: 0,          // para descartar relecturas antiguas (D-12)
};

let client = null;
let channel = null;
let sessionActive = false;
let reloadTimer = null;
let listReloadTimer = null; // 007: agrupa recargas seguidas de la lista
let reviewReloadTimer = null; // 009: agrupa recargas de la revisión por cambios de comidas (D-8)
let ready = false;          // connect() ya eligió la pantalla de arranque (D-2)
let signingOut = false;     // la app está cerrando la sesión ella misma (no es RF-15)
let onNewPassword = false;  // en la pantalla de nueva contraseña
let recoveryUserId = null;  // id de la cuenta del enlace de recuperación (D-4)
let currentScreen = 'meals'; // pantalla de la app: 'meals' | 'list' (007 RF-1)

// Lista de la compra (007): artículos como llegan de la base de datos; loaded = primera carga
// hecha (RF-11). requestId sigue subiendo al cerrar sesión, para descartar respuestas viejas (CL-10)
function initialListState(requestId = 0) {
  return { items: [], loaded: false, requestId, savedOpen: false, quickPending: false, finishing: false };
}
let listState = initialListState();
// Revisión de ingredientes de comidas (009, plan § Algoritmo); requestId nunca vuelve a
// empezar mientras la app está abierta (D-12)
function initialReviewState(requestId = 0) {
  return {
    open: false, from: null, to: null, meals: [], lines: [], choices: new Map(), loading: false,
    loadError: null, noIngredients: false, saveError: null, saving: false, reloadPending: false, requestId,
  };
}
let reviewState = initialReviewState();
// Formulario de artículo (007 T9): id null = "Añadir artículo"; opened sube al abrirlo
const articleForm = { id: null, item: null, saving: false, opened: 0 };

// Formularios abiertos en otras pestañas o dispositivos (004-edicion-simultanea)
let formsChannel = null;    // canal privado 'meal-forms' (D-1)
let formsReady = false;     // canal suscrito (CL-3)
let peers = [];             // otros formularios (updatePeers)
// Clave de esta pestaña en los mensajes "form" (D-3): 32 cifras hexadecimales aleatorias.
// getRandomValues también funciona sin HTTPS; randomUUID no (005 D-6).
const tabKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
let announceSeq = 0;        // sube con cada mensaje "form", anuncio o salida (D-3)
let announced = false;      // el último mensaje "form" enviado fue un anuncio
let refreshTimer = null;    // reanuncio del formulario propio (RNF-4)
let peerTimer = null;       // revisión de la caducidad de los peers (RNF-4)

// Datos del enlace de recuperación, leídos al cargar y antes de crear el cliente (D-2)
let authLink = readAuthLink(location.hash, location.search);

const PENDING_KEY = 'pending-recovery';
const SIDEBAR_KEY = 'sidebar'; // 'collapsed' o 'expanded' (008 RF-11)
const SCREEN_KEY = 'screen'; // 'meals' o 'list', en la pestaña y en el navegador (007 D-19)

const $ = (id) => document.getElementById(id);

// ===== Hoy: único sitio que lee el reloj; se pasa a logic.js como dato (D-5) =====
function getToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ===== Utilidades del DOM =====
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function showScreen(name) {
  for (const screen of ['config', 'start', 'login', 'new-password', 'app']) {
    $('screen-' + screen).hidden = screen !== name;
  }
}

// Cambia entre Comidas y Compra sin tocar el calendario (007 RF-2, RF-3, D-7)
function showAppScreen(name) {
  currentScreen = name;
  $('screen-app').dataset.screen = name;
  $('app-title').textContent = name === 'list' ? 'Compra' : 'Comidas';
  document.querySelectorAll('.screen-button').forEach((b) => {
    const active = b.dataset.screen === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'list') {
    listState.savedOpen = false; // RF-6: Guardados plegado al abrir Compra
    renderShopping();
  }
  rememberScreen(name); // 007 RF-46: la "pantalla abierta" (barra, carga o entrada)
}

// Recuerda la pantalla en esta pestaña y como la última del navegador (007 D-19).
// Sin almacenamiento, la barra funciona igual mientras dure la página (CL-19)
function rememberScreen(name) {
  try {
    sessionStorage.setItem(SCREEN_KEY, name);
  } catch {
    // Sin sessionStorage, la pestaña no recuerda su pantalla
  }
  try {
    localStorage.setItem(SCREEN_KEY, name);
  } catch {
    // Sin localStorage, el navegador no recuerda la última pantalla
  }
}

// Pantalla recordada, o null si no hay o el almacenamiento está bloqueado (CL-19).
// window[storageName] va dentro del try: leer la propiedad ya puede lanzar SecurityError
function readStoredScreen(storageName) {
  try {
    return window[storageName].getItem(SCREEN_KEY);
  } catch {
    return null;
  }
}

// ===== Avisos y errores =====
function showError(text, kind = 'action') {
  $('error-notice-text').textContent = text;
  $('error-notice').hidden = false;
  state.noticeKind = kind;
}

// Oculta el aviso (si se indica kind, solo cuando el aviso es de ese origen)
function hideError(kind) {
  if (kind && state.noticeKind !== kind) return;
  $('error-notice').hidden = true;
  state.noticeKind = null;
}

// ===== Arranque y conexión =====
function showConfig(message) {
  $('config-message').textContent = message;
  showScreen('config');
}

// Pregunta a Supabase si responde. Devuelve el código HTTP, o null si no responde a tiempo.
async function checkServer() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT);
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/health', {
      headers: { apikey: SUPABASE_PUBLIC_KEY },
      signal: controller.signal,
    });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function connect() {
  showScreen('start');
  const check = {
    libraryLoaded: Boolean(window.supabase),
    keysDefined: keysDefined(SUPABASE_URL, SUPABASE_PUBLIC_KEY),
    status: null,
  };
  // Solo se pregunta al servidor si hay librería y claves
  if (check.libraryLoaded && check.keysDefined) check.status = await checkServer();
  check.online = navigator.onLine; // 000-base D-19: leído después de preguntar al servidor
  if (check.libraryLoaded && check.keysDefined) {
    // 011 RF-4, D-4: la sesión se lee de localStorage, sin esperar a supabase-js
    const email = readStoredSessionEmail();
    const opens = opensInCopy({
      status: check.status, hasSession: email !== null, hasCopy: hasSavedCopy(),
      link: authLink.kind, pending: readPending(),
    });
    if (opens) return openInCopyMode(email);
  }
  const problem = configMessage(check); // 011 RF-14
  if (problem) return showConfig(problem);

  createClientOnce();
  // initialize() devuelve el resultado de leer el enlace de la dirección
  const { error } = await client.auth.initialize();
  const { data } = await client.auth.getSession();
  const session = data.session;
  history.replaceState(null, '', urlWithoutAuthData(location.pathname, location.search)); // RF-16 (D-3)
  const pending = readPending();
  const route = startScreen({ link: authLink.kind, linkOk: !error, hasSession: Boolean(session), pending });
  authLink = { kind: 'none' }; // "Reintentar" no vuelve a usarlo
  ready = true;

  if (route.screen === 'newPassword') {
    showNewPassword(session.user); // RF-8, CL-7
  } else if (route.screen === 'linkExpired') {
    if (route.closeSession) await closeLocalSession(); // CL-1, CL-4: solo en este dispositivo
    const email = pending?.email || $('login-email').value.trim();
    clearPending(); // CL-4 ya atendido: la marca no debe repetirlo en el siguiente arranque
    applySession(null);
    showRecovery(email, LINK_EXPIRED_MESSAGE);
  } else if (route.screen === 'app') {
    applySession(session, { pageLoad: true }); // 007 RF-46: abre la pantalla recordada
    checkSessionAlive(); // RF-15 al abrir la app
  } else {
    applySession(null);
  }
}

function createClientOnce() {
  if (client) return;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);
  // setTimeout evita bloquear el cliente; los eventos no deciden la pantalla de arranque (D-2)
  client.auth.onAuthStateChange((event, session) => setTimeout(() => onAuthEvent(event, session), 0));
}

// Email de la sesión que guardó supabase-js, o null (011 D-4); sin localStorage, sin sesión
function readStoredSessionEmail() {
  try {
    return storedSessionEmail(localStorage.getItem(authStorageKey(SUPABASE_URL)));
  } catch {
    return null;
  }
}

// Abre sin red con la sesión y la copia guardadas (011 RF-4, D-4). El cliente se crea para
// Realtime, la salida y "Cerrar sesión", sin esperar a initialize(), que sin red no acaba
function openInCopyMode(email) {
  createClientOnce();
  ready = true;
  enterCopyMode();
  applySession({ user: { email } }, { pageLoad: true }); // 007 RF-46; sus cargas pintan la copia
}

// Pregunta al servidor si la sesión sigue existiendo; un error de red no la cierra (D-7, RF-15)
async function checkSessionAlive() {
  if (!sessionActive) return;
  const { error } = await client.auth.getUser();
  if (!error || !isSessionGone(error) || !sessionActive) return;
  await closeLocalSession();
  applySession(null);
  showLoginForm('login');
  showLoginInfo(SESSION_CLOSED_MESSAGE);
}

// Eventos de sesión tras el arranque: entrar (aquí o en otra pestaña) y cierre desde fuera (RF-15)
async function onAuthEvent(event) {
  if (!ready) return;
  const action = authEventScreen(event, { onNewPassword, signingOut });
  if (action === 'app') {
    // 011 D-6: en modo copia solo el reintento sale (CL-7); el SIGNED_IN no recarga
    if (state.copyMode) return retryConnection();
    const { data } = await client.auth.getSession();
    if (data.session) applySession(data.session);
  } else if (action === 'sessionClosed') {
    clearPending();
    applySession(null);
    showLoginForm('login');
    showLoginInfo(SESSION_CLOSED_MESSAGE);
  }
}

// Marca de un cambio de contraseña a medias (D-4); sin localStorage, no hay marca
function readPending() {
  try {
    const value = localStorage.getItem(PENDING_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

// Sin localStorage, CL-4 no se detecta, pero la sesión del enlace caduca en el servidor (D-4)
function savePending(email) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email }));
  } catch {
    // Sin localStorage no se guarda la marca
  }
}

function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Sin localStorage no hay marca que borrar
  }
}

// signingOut se mantiene hasta que se atiende el SIGNED_OUT propio (también va por setTimeout)
function finishSigningOut() {
  setTimeout(() => { signingOut = false; }, 0);
}

// Cierra la sesión solo en este dispositivo; sin respuesta del servidor, la borra igualmente (D-6)
async function closeLocalSession() {
  signingOut = true;
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) localStorage.removeItem(client.auth.storageKey);
  } catch {
    // Sin localStorage no queda sesión guardada que borrar
  }
  finishSigningOut();
}

// pageLoad: arranque de la página con la sesión guardada; si no, se entra desde el login (007 D-20)
function applySession(session, { pageLoad = false } = {}) {
  if (session && !sessionActive) {
    sessionActive = true;
    showUser(session.user.email); // 008 CL-4: la cuenta con que acaba de entrar
    resetView(); // RF-54: semana de hoy al entrar, también si se abre Compra (007 RF-46)
    // 007 RF-4, RF-46: desde el login, Comidas; al cargar, la recordada. Antes de enseñar la app
    showAppScreen(openingScreen({
      fromLogin: !pageLoad,
      tabScreen: readStoredScreen('sessionStorage'),
      browserScreen: readStoredScreen('localStorage'),
    }));
    showScreen('app');
    render();
    subscribeChanges();
    loadData();
    loadList(); // 007 RF-44: la lista se carga aunque se vea Comidas
    scheduleCopySave(); // 011 RF-1
  } else if (!session) {
    sessionActive = false;
    if (state.copyMode) {
      // 011 CL-3: sale del modo copia; la copia guardada se queda en el dispositivo
      state.copyMode = false;
      copyState.copy = null;
      setOffline(false);
    }
    stopRetry(); // 011 RF-16: sin sesión no se reintenta
    clearTimeout(copyState.saveTimer);
    copyState.saveId++; // 011: descarta un guardado en curso de la sesión anterior
    onNewPassword = false;
    closeDialogs(); // CL-13: antes de quitar el canal, para anunciar el formulario cerrado
    unsubscribeChanges();
    state.meals.clear();
    listState = initialListState(listState.requestId + 1); // 007 RF-11: "Cargando…" al volver a entrar
    renderShopping();
    hideError();
    closeMonthPanel(); // 006 CL-6
    closeUserMenu(); // 008 CL-3: abierto en una sección oculta, dejaría la página inerte
    showScreen('login');
  }
}

// CL-13: cierra la confirmación (askConfirm resuelve "no") y el formulario, sin guardar
function closeDialogs() {
  const confirmDialog = $('confirm-dialog');
  if (confirmDialog.open) confirmDialog.close();
  closeArticleForm(); // 007 CL-8
  if (reviewState.open) closeReview(); // 009 CL-5
  const mealDialog = $('meal-dialog');
  if (!mealDialog.open) return;
  formState.open = false;
  announceForm(); // síncrono: el evento close llega ya sin canal (plan D-14)
  mealDialog.close();
}

// Vista inicial: semana de hoy sin tipo desplegado (RF-11, RF-54); "hoy" se lee al entrar
function resetView() {
  state.view = 'week';
  state.refDate = getToday();
  state.openType = null;
}

// Pantalla de nueva contraseña con la cuenta del enlace (RF-8); la marca detecta CL-4
function showNewPassword(user) {
  onNewPassword = true;
  recoveryUserId = user.id;
  savePending(user.email);
  $('new-password-email').textContent = user.email;
  $('new-password').value = '';
  $('new-password-repeat').value = '';
  $('new-password-error').hidden = true;
  showScreen('new-password');
}

function showNewPasswordError(text) {
  $('new-password-error').textContent = text || '';
  $('new-password-error').hidden = !text;
}

// Guarda la contraseña nueva y cierra las sesiones de la cuenta en todos los dispositivos (RF-10, RF-14)
async function submitNewPassword(event) {
  event.preventDefault();
  const password = $('new-password').value;
  const inputError = newPasswordError(password, $('new-password-repeat').value);
  showNewPasswordError(inputError); // RF-9: sin consultar al servidor
  if (inputError) return;

  const email = $('new-password-email').textContent;
  const { data } = await client.auth.getSession();
  if (data.session?.user.id !== recoveryUserId) return endRecovery(email, LINK_EXPIRED_MESSAGE); // como CL-6

  const button = $('new-password-save');
  button.disabled = true;
  button.textContent = 'Guardando…';
  const { error } = await client.auth.updateUser({ password });
  button.disabled = false;
  button.textContent = 'Guardar';
  if (error) {
    const { message, linkExpired } = translatePasswordError(error, navigator.onLine);
    if (linkExpired) return endRecovery(email, message); // CL-6
    return showNewPasswordError(message); // RF-12: sigue el formulario para reintentar
  }

  signingOut = true;
  const { error: signOutError } = await client.auth.signOut({ scope: 'global' }); // RF-14 (D-5)
  if (signOutError) await closeLocalSession(); // CL-5: al menos la de este dispositivo
  else finishSigningOut();
  clearPending();
  applySession(null);
  showLoginForm('login');
  showLoginInfo(PASSWORD_CHANGED_MESSAGE);
}

// Cierra solo aquí la sesión del enlace y muestra el formulario de recuperación (CL-6)
async function endRecovery(email, message) {
  await closeLocalSession();
  clearPending();
  applySession(null);
  showRecovery(email, message);
}

// Sale sin cambiar la contraseña, cerrando solo la sesión de este dispositivo (RF-13)
async function cancelNewPassword() {
  await closeLocalSession();
  clearPending();
  applySession(null);
  showLoginForm('login');
}

// ===== Inicio y cierre de sesión =====
function showLoginError(text) {
  $('login-error').textContent = text;
  $('login-error').hidden = !text;
}

function showLoginInfo(text) {
  $('login-info').textContent = text;
  $('login-info').hidden = !text;
}

// Alterna los dos formularios de la pantalla de login
function showLoginForm(name) {
  $('form-login').hidden = name !== 'login';
  $('form-recovery').hidden = name !== 'recovery';
  showLoginInfo('');
}

// message: el error con el que se abre (CL-1, CL-4, CL-6), o vacío
function showRecovery(email, message = '') {
  $('recovery-email').value = email;
  showRecoveryError(message);
  $('recovery-info').hidden = true;
  showLoginForm('recovery');
}

async function submitLogin(event) {
  event.preventDefault();
  showLoginInfo('');
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const inputError = loginInputError(email, password);
  if (inputError) return showLoginError(inputError);

  showLoginError('');
  signingOut = false; // 011 D-12: un cierre colgado no se traga el SIGNED_IN de este inicio
  $('login-button').disabled = true;
  $('login-button').textContent = 'Entrando…';
  const { error } = await client.auth.signInWithPassword({ email, password });
  $('login-button').disabled = false;
  $('login-button').textContent = 'Entrar';
  if (error) return showLoginError(translateLoginError(error, navigator.onLine));
  $('login-password').value = '';
}

// Pide el enlace de recuperación; el mensaje es el mismo exista o no la cuenta (RNF-3)
async function submitRecovery(event) {
  event.preventDefault();
  const email = $('recovery-email').value.trim();
  const inputError = recoveryInputError(email);
  $('recovery-info').hidden = true;
  showRecoveryError(inputError);
  if (inputError) return;

  const button = $('recovery-button');
  button.disabled = true;
  button.textContent = 'Enviando…';
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: recoveryRedirect(location.origin, location.pathname),
  });
  button.disabled = false;
  button.textContent = 'Enviar enlace';
  if (error) return showRecoveryError(translateRecoveryError(error, navigator.onLine));
  $('recovery-info').textContent = RECOVERY_SENT_MESSAGE;
  $('recovery-info').hidden = false;
}

function showRecoveryError(text) {
  $('recovery-error').textContent = text || '';
  $('recovery-error').hidden = !text;
}

async function logOut() {
  // Solo en este dispositivo: la otra sesión abierta sigue funcionando. Sin el aviso de RF-15
  // aquí; las otras pestañas sí lo muestran
  if (signingOut) return; // ya hay un cierre en marcha
  const button = $('user-menu-logout');
  button.disabled = true; // 011 RF-23: desactivado mientras espera
  signingOut = true;
  // signingOut dura lo que el cierre de fondo: su SIGNED_OUT tardío no da el aviso de RF-15 (011 D-12)
  const pending = client.auth.signOut({ scope: 'local' }).catch((error) => ({ error }));
  pending.finally(finishSigningOut);
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CONNECTION_TIMEOUT); });
  const result = await Promise.race([pending, clock]);
  clearTimeout(timer);
  button.disabled = false;
  const outcome = logOutOutcome({ error: result?.error ?? null, timedOut: result === null });
  // 011 RF-22: cualquier cierre fallido cierra en este dispositivo, sin mensaje
  if (outcome === 'local') removeStoredSession();
  applySession(null);
}

// Quita la sesión guardada en este dispositivo, como closeLocalSession (011 D-12)
function removeStoredSession() {
  try {
    localStorage.removeItem(client.auth.storageKey);
  } catch {
    // Sin localStorage no queda sesión guardada que borrar
  }
}

// ===== Carga de datos =====
function mealAt(date, type) {
  return state.meals.get(mealKey(toISODate(date), type)) || null;
}

// Periodo visible según la vista y el día de referencia (logic.js)
function currentRange() {
  return visibleRange(state.view, state.refDate);
}

// ===== Peticiones con plazo de 8 s (011 D-5): las lecturas y el tachado (007 D-25); el resto de
// guardados y borrados, como antes =====
// El reloj cubre también la espera de getSession() de supabase-js; sin respuesta a tiempo,
// la petición se corta y cuenta como sin red (timedOut)
async function timedQuery(builder) {
  const controller = new AbortController();
  let timer;
  const clock = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, CONNECTION_TIMEOUT);
  });
  let result;
  try {
    result = await Promise.race([builder.abortSignal(controller.signal), clock]);
  } catch (error) {
    result = { data: null, error };
  }
  clearTimeout(timer);
  const timedOut = controller.signal.aborted;
  if (timedOut) return { data: null, error: { name: 'TimeoutError', message: 'Network timeout' }, timedOut };
  return { ...result, timedOut };
}

// "online" para isNetworkError y translateError: sin respuesta en plazo cuenta como sin red
function reachable(result) {
  return navigator.onLine && !result.timedOut;
}

// Consultas compartidas por las cargas y la copia (011 D-3)
function mealsQuery(from, to) {
  return client.from('comidas').select('*').gte('fecha', toISODate(from)).lte('fecha', toISODate(to));
}

function listQuery() {
  return client.from('articulos').select('id, nombre, cantidad, unidad, lista, tachado');
}

// ===== Copia para ver sin red (011 RF-1, RF-2, RF-3, CL-1, RNF-1) =====
// Agrupa disparadores seguidos (entrar, primer plano, red, tiempo real) en un guardado (D-3)
function scheduleCopySave() {
  clearTimeout(copyState.saveTimer);
  copyState.saveTimer = setTimeout(saveCopy, 1000);
}

// Descarga las comidas del intervalo y la lista entera; solo con las dos bien, sustituye la copia
async function saveCopy() {
  if (!sessionActive || state.copyMode || state.offline) return;
  let session = null;
  try {
    ({ data: { session } } = await client.auth.getSession());
  } catch {
    return;
  }
  if (!session) return; // D-3: sin sesión, la RLS daría una copia vacía
  const id = ++copyState.saveId;
  const { from, to } = copyRange(getToday());
  const savedAt = Date.now(); // D-2: justo antes de las descargas
  const [meals, list] = await Promise.all([timedQuery(mealsQuery(from, to)), timedQuery(listQuery())]);
  if (id !== copyState.saveId || !sessionActive) return;
  if (meals.error || list.error) return; // CL-1: se queda la anterior, sin aviso
  writeCopy(buildCopy({ savedAt, from, to, meals: meals.data, articles: list.data }));
}

// Una sola escritura; no pisa una copia más nueva de otra pestaña (D-2). Si no cabe, nada (CL-1)
function writeCopy(copy) {
  try {
    if ((readSavedCopy()?.savedAt ?? -Infinity) > copy.savedAt) return;
    localStorage.setItem(COPY_KEY, JSON.stringify(copy));
  } catch {
    // Sin espacio o sin localStorage: la anterior sigue entera
  }
}

function readSavedCopy() {
  try {
    return parseCopy(localStorage.getItem(COPY_KEY));
  } catch {
    return null;
  }
}

function hasSavedCopy() {
  return readSavedCopy() !== null;
}

// ===== Modo copia (011 RF-5, RF-7, RF-8, RF-17; 000-base D-19, 007 D-24) =====
// Nunca se llama ya en modo copia. copyMode, antes de pintar, para que las cargas en curso
// no pinten encima (000-base RF-48, 007 CL-10)
function enterCopyMode() {
  state.copyMode = true;
  copyState.copy = readSavedCopy();
  // RF-5; el ✕ u otro aviso lo quitan hasta la próxima entrada (RF-6, RF-20)
  showError(copyNoticeText(copyState.copy.savedAt, getToday()), 'copy');
  loadMealsFromCopy();
  loadListFromCopy();
  setOffline(true);
  startRetry(); // RF-16
}

// Todas las comidas del intervalo guardado; la navegación filtra al pintar (RF-8)
function loadMealsFromCopy() {
  $('loading-indicator').hidden = true; // 000-base RF-52
  state.meals = new Map(copyState.copy.meals.map((c) => [mealKey(c.fecha, c.tipo), c]));
  render();
}

// Lista entera de la copia, con loaded en true: sin "Cargando…" (RF-7, 007 RF-11)
function loadListFromCopy() {
  listState.items = copyState.copy.articles;
  listState.loaded = true;
  renderShopping();
  if (reviewState.open) recalcLines();
}

// Sin red, con o sin copia (009 D-14)
function setOffline(value) {
  if (state.offline === value) return;
  state.offline = value;
  applyWriteControls(); // RF-10, CL-6
  renderShopping();
  onReviewNetworkChange(); // 009 CL-8, CL-9
  // D-6: el reintento corre también sin copia; en modo copia solo lo para la salida
  if (value) startRetry();
  else if (!state.copyMode) stopRetry();
}

// Pasa a "sin red": evento offline y tachado que falla sin red (012 RF-18)
function goOffline() {
  setOffline(true); // 009 D-14
  // 011 RF-17, RF-18 (000-base RF-50); ya en modo copia, nada
  if (sessionActive && !state.copyMode) {
    if (hasSavedCopy()) enterCopyMode();
    else showError('Sin conexión a internet. Los datos se actualizarán al recuperarla.', 'offline'); // 007 D-8
  }
}

// ===== Reintento y salida del modo copia (011 RF-12, RF-13, RF-16, CL-4, CL-7; D-6) =====
// Cada 30 s, solo en primer plano
function startRetry() {
  stopRetry();
  if (document.visibilityState === 'visible') copyState.retryTimer = setInterval(retryConnection, 30000);
}

function stopRetry() {
  clearInterval(copyState.retryTimer);
  copyState.retryTimer = null;
}

// getSession() con plazo: con Supabase sin responder, renovar el token puede tardar ~30 s (D-6)
function sessionWithTimeout() {
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CONNECTION_TIMEOUT); });
  return Promise.race([client.auth.getSession().catch(() => null), clock]).finally(() => clearTimeout(timer));
}

// Carga las comidas del periodo visible y la lista; en modo copia, solo con las dos bien sale
// (RF-12); sin copia, cada una pinta lo suyo en cuanto Supabase responde (D-6)
async function retryConnection() {
  if (!sessionActive || !(state.copyMode || state.offline) || document.hidden) return;
  if (signingOut) return; // 011 RF-23: mientras espera el cierre, nada cambia (D-12)
  if (copyState.probing) { // uno a la vez; el que llega mientras tanto se repite al acabar
    copyState.rerun = true;
    return;
  }
  copyState.probing = true;
  copyState.rerun = false;
  try {
    const session = await sessionWithTimeout();
    if (!session?.data?.session) return; // CL-4; si supabase-js la borró, su SIGNED_OUT da RF-13
    if (!sessionActive) return;
    const mealsId = ++state.requestId;
    const listId = ++listState.requestId;
    const { from, to } = currentRange();
    const [meals, list] = await Promise.all([timedQuery(mealsQuery(from, to)), timedQuery(listQuery())]);
    if (mealsId !== state.requestId || listId !== listState.requestId) { // navegó mientras tanto
      copyState.rerun = true;
      return;
    }
    if (!sessionActive || !(state.copyMode || state.offline)) return;
    const outcome = retryOutcome(meals, list, navigator.onLine);
    if (outcome.kind === 'noResponse') return; // CL-4, 007 RF-36: sin mensaje
    if (outcome.kind === 'sessionGone') {
      checkSessionAlive(); // RF-13
      return;
    }
    if (!state.copyMode) {
      applyRetryLoads(meals, list); // D-6: Supabase responde
      return;
    }
    if (outcome.kind === 'error') {
      showError(outcome.message, outcome.notice); // CL-7: sigue en modo copia
      return;
    }
    leaveCopyMode(meals.data, list.data);
  } finally {
    copyState.probing = false;
    if (copyState.rerun) {
      copyState.rerun = false;
      retryConnection();
    }
  }
}

// Sale del modo copia con las dos cargas correctas (RF-12)
function leaveCopyMode(meals, items) {
  state.copyMode = false; // 000-base D-19, 007 D-24: antes de pintar
  stopRetry();
  copyState.copy = null;
  hideError('copy');
  hideError('load');
  hideError('listLoad');
  $('loading-indicator').hidden = true;
  state.meals = new Map(meals.map((c) => [mealKey(c.fecha, c.tipo), c]));
  render();
  listState.items = items;
  listState.loaded = true;
  renderShopping();
  if (reviewState.open) recalcLines();
  setOffline(false); // 009 D-14: solo tras la recarga correcta
  resumeSyncNotice(); // 000-base CL-15
  scheduleCopySave(); // RF-12: renueva la copia (RF-2)
  checkSessionAlive(); // RF-13 con el token aún válido
}

// Sin copia (D-6): como el final de loadData y loadList, sin "Cargando…"
function applyRetryLoads(meals, list) {
  $('loading-indicator').hidden = true;
  if (meals.error) {
    showError('No se han podido cargar las comidas. ' + translateError(meals.error, reachable(meals)), 'load');
  } else {
    hideError('load');
    hideError('offline');
    state.meals = new Map(meals.data.map((c) => [mealKey(c.fecha, c.tipo), c]));
  }
  if (list.error) {
    showError(articleErrorMessage('load', list.error, reachable(list)), 'listLoad');
  } else {
    hideError('listLoad');
    hideError('offline');
    listState.items = list.data;
    listState.loaded = true;
  }
  setOffline(false); // Supabase respondió: reactiva los controles y para el reintento
  render();
  renderShopping();
  if (!list.error && reviewState.open) recalcLines();
  if (!meals.error && !list.error) scheduleCopySave(); // RF-1
}

// Al salir del modo copia, el aviso de tiempo real si el canal sigue caído (000-base CL-15)
function resumeSyncNotice() {
  if (syncStatusAction(state.channelStatus, state.noticeKind, false) === 'show') {
    showError('Se ha perdido la sincronización en tiempo real. Reintentando…', 'sync');
  }
}

// Activa o desactiva lo que guarda, mueve o borra según state.offline (RF-10, D-7); tachar,
// "Cerrar sesión", "Editar" y los campos de los formularios no cambian (RF-11, RF-19, CL-6)
function applyWriteControls() {
  for (const id of ['add-button', 'add-article-button', 'quick-add-input', 'quick-add-button', 'article-delete']) {
    $(id).disabled = state.offline;
  }
  $('article-save').disabled = state.offline || articleForm.saving;
  $('finish-button').disabled = state.offline || listState.finishing;
  refreshMatch(); // "Guardar" del formulario de comida
  if (sessionActive) render(); // "Borrar" del detalle, "Añadir" del día, filas vacías de la semana
}

async function loadData() {
  if (!sessionActive) return;
  const requestId = ++state.requestId; // 000-base RF-48: también en modo copia
  if (state.copyMode) return loadMealsFromCopy(); // RF-52: sin "Cargando…"
  const { from, to } = currentRange();
  $('loading-indicator').hidden = false;

  const result = await timedQuery(mealsQuery(from, to));
  // Llegó una petición más reciente, o empezó antes del modo copia (000-base RF-48)
  if (requestId !== state.requestId || state.copyMode) return;

  $('loading-indicator').hidden = true;
  if (result.error && isNetworkError(result.error, reachable(result))) {
    if (hasSavedCopy()) {
      enterCopyMode(); // 000-base RF-49: sin el mensaje de carga
      return;
    }
    setOffline(true); // 011 RF-10: sin copia, controles desactivados y el mensaje de hoy
  }
  if (result.error) {
    showError('No se han podido cargar las comidas. ' + translateError(result.error, reachable(result)), 'load');
    return;
  }
  hideError('load');
  hideError('offline'); // 007 D-8
  state.meals = new Map(result.data.map((c) => [mealKey(c.fecha, c.tipo), c]));
  setOffline(false); // 011 RF-10: Supabase responde, se activan sin recargar
  render();
}

// ===== Lista de la compra (007) =====

// Carga todos los artículos; solo vale la respuesta de la última petición (RF-11, RF-36, CL-10).
// Devuelve el error de la carga, o null si ha ido bien o la ha dejado atrasada otra (009 D-2)
async function loadList() {
  if (!sessionActive) return null;
  const requestId = ++listState.requestId; // CL-10: también en modo copia
  if (state.copyMode) { // 011 D-24: la copia, sin pedir nada
    loadListFromCopy();
    return null;
  }
  if (!listState.loaded) renderShopping(); // RF-11: "Cargando…" solo hasta la primera carga

  const result = await timedQuery(listQuery());
  // CL-10, CL-8; también si empezó antes del modo copia (D-24)
  if (requestId !== listState.requestId || !sessionActive || state.copyMode) return null;

  if (result.error && isNetworkError(result.error, reachable(result))) {
    if (hasSavedCopy()) {
      enterCopyMode(); // RF-36: sin el mensaje de carga
      return null;
    }
    setOffline(true); // 011 RF-10: sin copia, controles desactivados y el mensaje de hoy
  }
  if (result.error) {
    showError(articleErrorMessage('load', result.error, reachable(result)), 'listLoad'); // D-8
    return result.error;
  }
  hideError('listLoad');
  hideError('offline'); // RF-38 (D-8)
  listState.items = result.data;
  listState.loaded = true;
  setOffline(false); // 011 RF-10
  renderShopping();
  if (reviewState.open) recalcLines(); // 009 RF-25 (D-8); mientras se añade no cambia nada (D-11)
  return null;
}

// Pinta la pantalla Compra con lo que hay en listState (RF-6 a RF-12); todo con textContent (RNF-6)
function renderShopping() {
  const loading = !listState.loaded;
  $('list-loading').hidden = !loading; // RF-11, D-13
  $('list-content').hidden = loading;
  renderSuggestions(); // cada recarga recalcula las sugerencias de lo escrito (RF-22, CL-16, CL-18)
  // 009 RF-33: hasta la primera carga correcta; v4.1: sin red, también en modo copia (D-14)
  $('ingredients-button').disabled = loading || state.offline;
  if (loading) return;

  // 012 RF-3, RF-7 (D-2): la cola se aplica solo al pintar; listState.items sigue siendo lo cargado
  const { items, unsent } = applyStrikeQueue(listState.items, readStrikeQueue());
  const { pending, saved, pendingCount, savedCount, struckCount } = shoppingLists(items);

  $('pending-title').textContent = `Por comprar (${pendingCount})`;
  $('pending-list').replaceChildren(...pending.map((item) => buildPendingRow(item, unsent.has(item.id))));
  $('pending-empty').hidden = pending.length > 0; // RF-10
  $('finish-button').hidden = struckCount === 0; // RF-41
  $('finish-button').disabled = listState.finishing || state.offline; // 011 RF-10

  $('saved-title').textContent = `Guardados (${savedCount})`;
  $('saved-toggle').setAttribute('aria-expanded', String(listState.savedOpen)); // RF-12
  $('saved-body').hidden = !listState.savedOpen;
  $('saved-list').replaceChildren(...(listState.savedOpen ? saved.map(buildSavedRow) : []));
  $('saved-empty').hidden = saved.length > 0; // RF-10
}

// Nombre y cantidad de una fila (RF-8); tocar el nombre abre "Editar artículo" (RF-27)
function articleNameParts(item) {
  const name = button('article-name', item.nombre, () => openArticleForm(item));
  const quantity = el('span', 'article-quantity', formatQuantity(item.cantidad, item.unidad));
  return [name, quantity];
}

// Fila de Por comprar: [casilla] [nombre] [cantidad] (RF-8, RF-24, D-11), y [sin enviar] si
// tiene un cambio en cola (012 RF-3). item ya lleva la cola aplicada: CL-1 con la cola (012 RF-6)
function buildPendingRow(item, isUnsent) {
  const row = el('li', 'article-row');
  row.classList.toggle('struck', item.tachado);
  row.classList.toggle('unsent', isUnsent);
  const check = button('article-check', '', () => setStruck(item, !item.tachado));
  check.setAttribute('aria-pressed', String(item.tachado));
  check.setAttribute('aria-label', `Tachar «${item.nombre}»`);
  row.append(check, ...articleNameParts(item));
  if (isUnsent) row.append(el('span', 'article-unsent', 'sin enviar'));
  return row;
}

// Fila de Guardados: [nombre] [cantidad] [↺] [✕] (RF-8, RF-26, RF-31)
function buildSavedRow(item) {
  const row = el('li', 'article-row saved-row');
  const recover = el('button', 'article-action', '↺');
  recover.type = 'button';
  recover.setAttribute('aria-label', `Pasar «${item.nombre}» a Por comprar`);
  recover.disabled = state.offline; // 011 RF-10
  recover.addEventListener('click', () => recoverArticle(item)); // RF-26
  const remove = el('button', 'article-action', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Borrar «${item.nombre}»`);
  remove.disabled = state.offline; // 011 RF-10
  remove.addEventListener('click', () => deleteArticle(item, false)); // RF-31
  row.append(...articleNameParts(item), recover, remove);
  return row;
}

// Sugerencias de Guardados para lo escrito en el campo rápido (RF-21, RF-22); como texto (RNF-6)
function renderSuggestions() {
  const found = suggestions(listState.items, $('quick-add-input').value);
  $('quick-suggestions').replaceChildren(...found.map((item) => {
    const li = el('li');
    const pick = button('suggestion', item.nombre, () => pickSuggestion(item));
    pick.disabled = state.offline; // 011 RF-10: recuperar
    li.append(pick);
    return li;
  }));
  $('quick-suggestions').hidden = found.length === 0;
}

// Tocar una sugerencia la recupera (RF-23); el campo solo se vacía si se recuperó y nadie
// lo cambió mientras esperaba (CL-16, CL-18)
async function pickSuggestion(item) {
  if (state.offline) return; // 011 RF-10
  const input = $('quick-add-input');
  const sent = input.value;
  const ok = await recoverArticle(item);
  if (!sessionActive) return;
  if (ok && input.value === sent) input.value = '';
  renderSuggestions();
  input.focus();
}

// Alta con anadir_articulo (RF-13, RF-19, RF-20, RF-39, CL-4); true si quedó añadido o recuperado.
// fromForm: los mensajes van dentro del formulario de artículo (llega en T9)
async function addArticle({ nombre, cantidad, unidad }, fromForm = false) {
  const report = (text) => (fromForm ? showArticleFormError(text) : showError(text));
  let result;
  try {
    result = await client.rpc('anadir_articulo', { p_nombre: nombre, p_cantidad: cantidad, p_unidad: unidad });
  } catch (error) {
    result = { error };
  }
  if (!sessionActive) return false;
  if (result.error) {
    report(articleErrorMessage('save', result.error, navigator.onLine)); // RF-36, RF-37
    return false;
  }
  const outcome = addOutcome(result.data);
  if (outcome.kind === 'exists') { // RF-19, CL-4, RF-45
    report(articleExistsMessage(outcome.name, outcome.list));
    loadList();
    return false;
  }
  if (outcome.kind === 'error') {
    report(ARTICLE_UNEXPECTED_MESSAGE); // RF-36
    return false;
  }
  loadList(); // añadido o recuperado: sin mensaje (RF-20)
  return true;
}

// Intro o [+] en el campo rápido (RF-13, RF-16, CL-16, CL-17)
async function submitQuickAdd(event) {
  event.preventDefault();
  if (state.offline || listState.quickPending) return; // 011 RF-10; CL-17: otro Intro o [+] mientras espera no hace nada
  const input = $('quick-add-input');
  const name = cleanIngredientName(input.value);
  if (!name) return; // RF-16: sin mensaje
  const sent = input.value; // CL-16: lo escrito mientras espera no se borra
  listState.quickPending = true; // el campo sigue editable (CL-17)
  try {
    const ok = await addArticle({ nombre: name, cantidad: null, unidad: null }, false);
    if (!sessionActive) return;
    if (ok && input.value === sent) input.value = '';
    renderSuggestions();
    input.focus();
  } finally {
    listState.quickPending = false;
  }
}

// Sustituye un artículo por el que devuelve el servidor y repinta (RF-37, D-9)
function replaceItem(row) {
  listState.items = listState.items.map((item) => (item.id === row.id ? row : item));
  renderShopping();
}

// Pasa un artículo de Guardados a Por comprar (RF-23, RF-26); true si quedó recuperado (CL-18)
async function recoverArticle(item) {
  if (state.offline) return false; // 011 RF-10
  const { data: rows, error } = await client.from('articulos')
    .update({ lista: 'por_comprar', tachado: false })
    .eq('id', item.id).eq('lista', 'guardados')
    .select('id, nombre, cantidad, unidad, lista, tachado');
  if (!sessionActive) return false;
  if (error) {
    showError(articleErrorMessage('save', error, navigator.onLine)); // RF-36, RF-37
    return false;
  }
  if (rows.length === 0) return missingOrMoved(item.id, null); // CL-2 → false, CL-12 → true
  replaceItem(rows[0]);
  return true;
}

// Tacha o desmarca un artículo de Por comprar (RF-24, RF-40); value es fijo, lo contrario de lo
// que se veía, para que dos toques a la vez en dos dispositivos den lo mismo (CL-1).
// Sin red, o si falla sin red, va a la cola de la 012 (D-25)
async function setStruck(item, value) {
  if (state.copyMode || state.offline) { // 012 RF-1: sin pedir nada
    if (!queueStrike(item, value)) showError(articleErrorMessage('save', null, false)); // 012 CL-3
    return;
  }
  const result = await timedQuery(client.from('articulos')
    .update({ tachado: value })
    .eq('id', item.id).eq('lista', 'por_comprar')
    .select('id, nombre, cantidad, unidad, lista, tachado'));
  if (!sessionActive) return;
  // 012 RF-2: el plazo cuenta como sin red aunque no haya error; la respuesta tardía no cuenta (CL-7)
  if (result.timedOut || (result.error && isNetworkError(result.error, reachable(result)))) {
    if (!queueStrike(item, value)) {
      showError(articleErrorMessage('save', result.error, false)); // 012 CL-3: sin pasar a sin red
      return;
    }
    strikeWentOffline(); // 012 RF-18
    return;
  }
  if (result.error) {
    showError(articleErrorMessage('save', result.error, reachable(result))); // RF-36, RF-37, 012 CL-2
    return;
  }
  if (result.data.length === 0) {
    await missingOrMoved(item.id, ARTICLE_CHANGED_MESSAGE, () => dropQueuedStrike(item.id)); // CL-2 o CL-14
    return;
  }
  dropQueuedStrike(item.id); // 012 RF-19: guardado como hoy, fuera de la cola
  replaceItem(result.data[0]);
}

// ===== Cola de tachados sin red (012 RF-1, RF-6, RF-7, CL-3; D-1; contrato de 007 D-25) =====
function readStrikeQueue() {
  try {
    return parseStrikeQueue(localStorage.getItem(STRIKE_QUEUE_KEY));
  } catch {
    return [];
  }
}

// Lanza si no puede guardar: lo decide quien la llama. Vacía, se borra la clave (D-1)
function writeStrikeQueue(changes) {
  if (changes.length) localStorage.setItem(STRIKE_QUEUE_KEY, JSON.stringify(buildStrikeQueue(changes)));
  else localStorage.removeItem(STRIKE_QUEUE_KEY);
}

// Anota el cambio (o lo quita si vuelve a como estaba, RF-6) y repinta; false si no puede (CL-3)
function queueStrike(item, value) {
  try {
    writeStrikeQueue(toggleQueuedStrike(parseStrikeQueue(localStorage.getItem(STRIKE_QUEUE_KEY)), item, value));
  } catch {
    return false;
  }
  renderShopping();
  return true;
}

// Quita el cambio de ese artículo, sin repintar; si no se puede guardar, el envío lo da por hecho (D-1)
function dropQueuedStrike(id) {
  try {
    writeStrikeQueue(removeQueuedStrike(readStrikeQueue(), id));
  } catch {
    // RF-10: el siguiente envío lo verá con el valor querido
  }
}

// Tachar falló sin red con la app fuera del modo copia: como el evento offline (012 RF-18)
function strikeWentOffline() {
  goOffline();
}

// "Terminar compra": pasa a Guardados los tachados de la base de datos, no los de la pantalla,
// en una sola sentencia (RF-25, RF-42, CL-5, CL-11)
async function finishShopping() {
  if (state.offline || listState.finishing) return; // 011 RF-10
  const { struckCount } = shoppingLists(listState.items);
  if (!(await askConfirm(finishConfirmText(struckCount), 'Aceptar'))) return; // RF-42
  if (!sessionActive) return;
  listState.finishing = true;
  $('finish-button').disabled = true;
  const { data: rows, error } = await client.from('articulos')
    .update({ lista: 'guardados', tachado: false })
    .eq('lista', 'por_comprar').eq('tachado', true)
    .select('id');
  if (!sessionActive) return;
  listState.finishing = false;
  $('finish-button').disabled = state.offline; // 011 D-7
  if (error) {
    // RF-36, RF-37: la lista se queda como estaba; recargar sin red taparía este aviso con el de carga
    showError(articleErrorMessage('finish', error, navigator.onLine));
    return;
  }
  if (rows.length === 0) showError(NO_STRUCK_MESSAGE); // CL-11
  loadList();
}

// El artículo no estaba como se esperaba: ¿lo han borrado (CL-2) o movido (CL-12, CL-14)?
// onAnswered: solo setStruck lo pasa, para quitar de la cola cuando la lectura respondió (007 D-25)
async function missingOrMoved(id, movedMessage, onAnswered) {
  const { data, error } = await client.from('articulos').select('id').eq('id', id);
  if (!sessionActive) return false;
  if (error) {
    showError(articleErrorMessage('save', error, navigator.onLine)); // RF-36, RF-37: sin red no es CL-2
    return false;
  }
  onAnswered?.();
  if (data.length === 0) {
    articleGone();
    return false;
  }
  if (movedMessage) showError(movedMessage); // CL-14
  loadList();
  return true;
}

// Borra un artículo tras confirmarlo, con ✕ o con "Borrar" del formulario (RF-31, RF-43).
// Sin filtrar por lista: si la otra persona lo acaba de recuperar, se borra igual (CL-15)
async function deleteArticle(item, fromForm) {
  if (state.offline) return; // 011 RF-10
  if (!(await askConfirm(articleDeleteText(item.nombre), 'Borrar'))) return; // al cancelar, el formulario sigue abierto
  if (!sessionActive) return; // CL-8
  const { data: rows, error } = await client.from('articulos').delete().eq('id', item.id).select('id');
  if (!sessionActive) return;
  if (error) {
    // RF-36, RF-37: la lista se queda como estaba (sin recargar, para no tapar el aviso)
    const text = articleErrorMessage('delete', error, navigator.onLine);
    return fromForm ? showArticleFormError(text) : showError(text);
  }
  if (rows.length === 0) return articleGone(); // CL-2: ya lo habían borrado
  if (fromForm) closeArticleForm();
  listState.items = listState.items.filter((other) => other.id !== item.id);
  renderShopping(); // también recalcula las sugerencias (RF-31)
}

// "Borrar" del formulario "Editar artículo" (RF-43); no mientras se guarda (RF-32)
function deleteFromArticleForm() {
  if (state.offline || articleForm.saving || !articleForm.item) return; // 011 RF-10
  deleteArticle(articleForm.item, true);
}

// Otra persona ya lo ha borrado (CL-2): se cierra el formulario de artículo si estaba abierto
function articleGone() {
  closeArticleForm();
  showError(ARTICLE_GONE_MESSAGE);
  loadList();
}

// ===== Formulario de artículo (RF-14, RF-15, RF-27 a RF-30, RF-32) =====
const ARTICLE_FIELDS = { name: 'article-name', quantity: 'article-quantity', unit: 'article-unit' };

function showArticleFormError(text) {
  $('article-form-error').textContent = text;
  $('article-form-error').hidden = !text;
}

function clearArticleMarks() {
  document.querySelectorAll('#article-form .invalid-field').forEach((n) => n.classList.remove('invalid-field'));
}

// Sin item, "Añadir artículo"; con item, "Editar artículo" con sus datos (RF-14, RF-27)
function openArticleForm(item = null) {
  articleForm.id = item ? item.id : null;
  articleForm.item = item;
  articleForm.opened++;
  $('article-form-title').textContent = item ? 'Editar artículo' : 'Añadir artículo';
  $('article-delete').hidden = !item; // RF-43: "Añadir artículo" no tiene "Borrar"
  $('article-name').value = item ? item.nombre : '';
  $('article-quantity').value = item && item.cantidad !== null ? String(item.cantidad) : '';
  $('article-unit').value = (item && item.unidad) || '';
  clearArticleMarks();
  showArticleFormError('');
  $('article-dialog').showModal();
}

function closeArticleForm() {
  if ($('article-dialog').open) $('article-dialog').close();
}

// ===== Revisión de ingredientes de comidas (009) =====
const PERIOD_FIELDS = {
  from: { date: 'ingredients-from-date', type: 'ingredients-from-type' },
  to: { date: 'ingredients-to-date', type: 'ingredients-to-type' },
};

// Abre la revisión con el periodo por defecto de hoy; modal, la barra queda inerte (RF-2, CL-7)
function openReview() {
  if (!listState.loaded || state.offline) return; // RF-33; v4.1: sin red (D-14)
  const { from, to } = defaultPeriod(getToday());
  reviewState = { ...initialReviewState(reviewState.requestId), open: true, from, to }; // D-12
  for (const side of ['from', 'to']) {
    $(PERIOD_FIELDS[side].date).value = reviewState[side].date;
    $(PERIOD_FIELDS[side].type).value = reviewState[side].type;
  }
  $('ingredients-dialog').showModal();
  loadReviewMeals({ showLoading: true });
}

// Lee los cuatro campos y recarga el periodo (RF-3, RF-22)
function onPeriodFieldChange() {
  for (const side of ['from', 'to']) {
    reviewState[side] = { date: $(PERIOD_FIELDS[side].date).value, type: $(PERIOD_FIELDS[side].type).value };
  }
  reviewState.saveError = null;
  loadReviewMeals({ showLoading: true });
}

const REVIEW_PAGE_SIZE = 1000; // D-3: filas por petición; vale con cualquier "Max rows"

// Comidas del periodo, por páginas; solo vale la última carga pedida (RF-3, RF-19, RF-30 a RF-32, D-3)
async function loadReviewMeals({ showLoading }) {
  const load = { id: ++reviewState.requestId }; // RF-32: deja atrasada cualquier carga en marcha
  const { from, to } = reviewState;
  if (periodError(from, to)) { // RF-19, RF-30: sin pedir nada
    reviewState.loading = false;
    renderReview();
    return;
  }
  if (showLoading) { // RF-31
    reviewState.loading = true;
    reviewState.loadError = null;
    renderReview();
  }

  const rows = [];
  let error = null;
  try {
    for (;;) {
      const result = await client.from('comidas').select('fecha, tipo, platos', { count: 'exact' })
        .gte('fecha', from.date).lte('fecha', to.date).order('fecha').order('id')
        .range(rows.length, rows.length + REVIEW_PAGE_SIZE - 1);
      if (result.error) { error = result.error; break; }
      rows.push(...result.data);
      // D-3: para también con una página vacía (un borrado entre páginas no deja el bucle sin fin)
      if (result.data.length === 0 || rows.length >= (result.count ?? 0)) break;
      if (!isCurrentLoad(load, reviewState)) return;
    }
  } catch (caught) {
    error = caught;
  }
  if (!reviewState.open || !sessionActive || !isCurrentLoad(load, reviewState)) return; // RF-32
  if (reviewState.saving) { // RF-17: llegó durante el guardado; se repite al terminar
    reviewState.reloadPending = true;
    return;
  }
  reviewState.loading = false;
  if (error) { // RF-21; RF-22: sustituye al de añadir
    reviewState.loadError = ingredientsErrorMessage('load', error, navigator.onLine);
    reviewState.saveError = null;
    renderReview();
    return;
  }
  reviewState.loadError = null; // RF-21: una carga correcta quita el error
  reviewState.meals = rows;
  recalcLines();
}

// Recalcula las líneas con las comidas y los artículos que se ven en Compra (RF-20, RF-23, RF-34, D-11)
function recalcLines() {
  const { from, to, meals } = reviewState;
  const newLines = periodLines(meals, from, to, listState.items);
  Object.assign(reviewState, recalcReview(reviewState, newLines));
  renderReview();
}

// Pinta la revisión según reviewView: líneas, "Cargando…", el mensaje y "Añadir (n)"
// (RF-8 a RF-12, RF-19 a RF-21, RF-27, RF-30, RF-31, RNF-5)
function renderReview() {
  const view = reviewView({ ...reviewState, offline: state.offline }); // v4.1: CL-8 (D-14)
  $('ingredients-loading').hidden = view.mode !== 'loading';
  $('ingredients-message').textContent = view.message || '';
  $('ingredients-message').hidden = !view.message;
  $('ingredients-retry').hidden = view.mode !== 'error'; // RF-21
  renderReviewLines(view);
  $('ingredients-add').textContent = addButtonText(view.count);
  $('ingredients-add').disabled = view.addDisabled;
  for (const side of ['from', 'to']) { // RF-17: mientras se añade
    $(PERIOD_FIELDS[side].date).disabled = view.controlsDisabled;
    $(PERIOD_FIELDS[side].type).disabled = view.controlsDisabled;
  }
  $('ingredients-cancel').disabled = view.controlsDisabled;
}

// Vuelve a pintar las líneas conservando el desplazamiento y el foco de la casilla u opción
function renderReviewLines(view) {
  const list = $('ingredients-lines');
  const active = list.contains(document.activeElement) ? document.activeElement : null;
  const focus = active && { key: active.dataset.key, value: active.value };
  const scroll = list.scrollTop;
  list.replaceChildren(...view.lines.map((line, index) => reviewLineElement(line, index, view.controlsDisabled)));
  list.hidden = view.lines.length === 0;
  list.scrollTop = scroll;
  if (!focus) return;
  const again = [...list.querySelectorAll('input')]
    .find((input) => input.dataset.key === focus.key && input.value === focus.value);
  if (again) again.focus({ preventScroll: true });
}

// Una línea: casilla (nueva o en Guardados), nombre, cantidad, detalle o estado y, si ya está
// en la lista, sus opciones; todo el texto con textContent (RF-8, RF-10, RF-11, RF-28, CL-4, RNF-5)
function reviewLineElement(line, index, disabled) {
  const choice = reviewState.choices.get(line.key);
  const row = document.createElement('li');
  row.className = 'review-line';
  if (!line.tooLong && line.status !== 'listed') {
    const label = document.createElement('label');
    label.className = 'review-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = 'on';
    box.dataset.key = line.key;
    box.checked = choice === 'on';
    box.disabled = disabled;
    box.setAttribute('aria-label', line.nombre);
    label.append(box);
    row.append(label);
  }
  row.append(reviewText('review-name', line.nombre));
  row.append(reviewText('review-quantity', formatQuantity(line.cantidad, line.unidad)));
  if (line.detail) row.append(reviewText('review-meta', line.detail));
  if (line.tooLong) {
    row.append(reviewText('review-meta', LINE_TOO_LONG_MESSAGE));
    return row;
  }
  if (line.status === 'saved') row.append(reviewText('review-meta', SAVED_LINE_TEXT));
  const options = lineOptions(line);
  if (!options) return row;
  row.append(reviewText('review-meta', options.listed));
  const group = document.createElement('div');
  group.className = 'review-options';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', line.nombre);
  for (const value of ['keep', 'sum', 'change']) {
    if (!options[value]) continue; // RF-11, RF-28
    const label = document.createElement('label');
    label.className = 'review-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `choice-${index}`;
    radio.value = value;
    radio.dataset.key = line.key;
    radio.checked = choice === value;
    radio.disabled = disabled;
    label.append(radio, reviewText('', options[value]));
    group.append(label);
  }
  row.append(group);
  return row;
}

function reviewText(className, text) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

// Casilla u opción tocada: cambia lo elegido y vuelve a pintar (RF-9, RF-12)
function onReviewLineChange(event) {
  const input = event.target;
  if (!input.dataset.key) return;
  if (input.type === 'checkbox') reviewState.choices.set(input.dataset.key, input.checked ? 'on' : 'off');
  else if (input.checked) reviewState.choices.set(input.dataset.key, input.value);
  renderReview();
}

// "Añadir (n)": aplica lo elegido al pulsar entero o nada; si la otra persona ha cambiado la
// lista, la recarga y vuelve a decidir, hasta ADD_RETRIES veces (RF-13 a RF-17, RF-22, RF-26, D-2, RNF-3)
async function submitReview(event) {
  event.preventDefault();
  // RF-17: un solo envío; v4.1: sin red no hace nada (CL-8)
  if (reviewState.saving || reviewView({ ...reviewState, offline: state.offline }).addDisabled) return;
  reviewState.saveError = null; // RF-22: el mensaje se quita al pulsar
  reviewState.saving = true;
  renderReview();
  const { lines, choices } = reviewState; // lo elegido al pulsar
  let saveError = ingredientsErrorMessage('add', {}, true); // D-2: tras ADD_RETRIES 'cambiado'
  for (let attempt = 1; attempt <= ADD_RETRIES; attempt++) {
    const changes = addChanges(lines, choices, listState.items);
    let result;
    try {
      result = await client.rpc('anadir_ingredientes', { p_cambios: changes });
    } catch (error) {
      result = { error };
    }
    if (!sessionActive) return;
    const outcome = result.data?.resultado;
    if (result.error || (outcome !== 'hecho' && outcome !== 'cambiado')) { // RF-22: sigue abierta
      saveError = ingredientsErrorMessage('add', result.error || {}, navigator.onLine);
      break;
    }
    if (outcome === 'hecho') { // RF-13
      reviewState.saving = false;
      closeReview();
      loadList();
      return;
    }
    const listError = await loadList(); // 'cambiado': la otra persona ha cambiado la lista
    if (!sessionActive) return;
    if (listError) { // D-2: la causa real, sin más intentos
      saveError = ingredientsErrorMessage('add', listError, navigator.onLine);
      break;
    }
  }
  reviewState.saveError = saveError;
  reviewState.saving = false; // RF-17: todo activo, mismas marcas y opciones
  if (reviewState.reloadPending) { // RF-17: los cambios de comidas que esperaban, con RF-23
    reviewState.reloadPending = false;
    loadReviewMeals({ showLoading: false });
  } else {
    recalcLines(); // cambios de la lista llegados durante el guardado (RF-17, RF-23)
  }
}

// Cierra sin cambiar la lista; deja atrasada cualquier carga en marcha (RF-4, RF-22, CL-5)
function closeReview() {
  reviewState.open = false;
  reviewState.saveError = null;
  reviewState.requestId++;
  if ($('ingredients-dialog').open) $('ingredients-dialog').close();
}

// Esc (D-13): mientras se añade no cierra; si no, siempre por closeReview
function onReviewKeydown(event) {
  if (event.key === 'Escape' && reviewState.saving) event.preventDefault();
}

function onReviewCancel(event) {
  event.preventDefault();
  if (!reviewState.saving) closeReview();
}

// Valores en bruto del formulario, para validateArticleForm (CL-7: badInput)
function readArticleForm() {
  const quantity = $('article-quantity');
  return { name: $('article-name').value, quantity: quantity.value, badInput: quantity.validity.badInput, unit: $('article-unit').value };
}

async function saveArticle(event) {
  event.preventDefault();
  if (state.offline || articleForm.saving) return; // RF-32; 011 RF-10 (también con Intro)
  clearArticleMarks();
  showArticleFormError('');
  const result = validateArticleForm(readArticleForm()); // RF-16, RF-17, RF-18, RF-29
  if (result.error) {
    result.invalid.forEach((field) => $(ARTICLE_FIELDS[field]).classList.add('invalid-field'));
    return showArticleFormError(result.error);
  }
  const { id, opened } = articleForm;
  if (id) {
    const other = findEquivalent(listState.items, result.data.nombre, id); // RF-30, CL-6
    if (other) return showArticleFormError(articleExistsMessage(other.nombre, other.lista));
  }

  articleForm.saving = true;
  $('article-save').disabled = true;
  try {
    const ok = id ? await updateArticle(id, result.data) : await addArticle(result.data, true);
    if (ok && articleForm.opened === opened) closeArticleForm(); // RF-15, RF-28
  } finally {
    articleForm.saving = false;
    $('article-save').disabled = state.offline; // 011 D-7
  }
}

// Cambia solo nombre, cantidad y unidad: nunca la lista ni el tachado (CL-3); true si se guardó
async function updateArticle(id, data) {
  let result;
  try {
    result = await client.from('articulos').update(data).eq('id', id)
      .select('id, nombre, cantidad, unidad, lista, tachado');
  } catch (error) {
    result = { error };
  }
  if (!sessionActive) return false; // CL-8
  const { data: rows, error } = result;
  if (error?.code === '23505') { // RF-45: otro ya tiene un nombre equivalente
    await loadList();
    if (!sessionActive) return false;
    showArticleFormError(articleSaveErrorMessage(error, listState.items, data.nombre, id, navigator.onLine));
    return false;
  }
  if (error) {
    showArticleFormError(articleErrorMessage('save', error, navigator.onLine)); // RF-36, RF-37
    return false;
  }
  if (rows.length === 0) { // CL-2: lo han borrado
    articleGone();
    return false;
  }
  replaceItem(rows[0]);
  return true;
}

// Despliega o pliega Guardados (RF-12)
function toggleSaved() {
  listState.savedOpen = !listState.savedOpen;
  renderShopping();
}

// Agrupa varias recargas seguidas en una sola
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadData, 300);
}

// Igual para la lista de la compra (007 RF-33, CL-10)
function scheduleListReload() {
  clearTimeout(listReloadTimer);
  listReloadTimer = setTimeout(loadList, 300);
}

// Recarga las comidas de la revisión abierta sin "Cargando…"; mientras se añade, espera
// (009 RF-17, RF-24, RF-31, D-8)
function scheduleReviewReload() {
  if (!reviewState.open) return;
  clearTimeout(reviewReloadTimer);
  reviewReloadTimer = setTimeout(() => {
    if (!reviewState.open) return;
    if (reviewState.saving) reviewState.reloadPending = true;
    else loadReviewMeals({ showLoading: false });
  }, 300);
}

// La red cambió con la revisión abierta: se repinta ("Añadir (n)") y, al volver, se recarga
// sin "Cargando…"; lo elegido no cambia (009 CL-8, CL-9, D-14)
function onReviewNetworkChange() {
  if (!reviewState.open) return;
  renderReview();
  if (!state.offline) scheduleReviewReload();
}

// Un cambio de comidas recarga el calendario y, si está abierta, la revisión (009 RF-24)
function onMealsChange() {
  scheduleReload();
  scheduleReviewReload();
  scheduleCopySave(); // 011 RF-1
}

// Un cambio de la lista la recarga y renueva la copia (007 RF-33; 011 RF-1)
function onArticlesChange() {
  scheduleListReload();
  scheduleCopySave();
}

// ===== Sincronización en tiempo real =====
function subscribeChanges() {
  unsubscribeChanges();
  subscribeForms();
  channel = client.channel('meal-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comidas' }, onMealsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'articulos' }, onArticlesChange) // 007 RF-33 (D-4)
    .subscribe((channelStatus) => {
      state.channelStatus = channelStatus; // 000-base CL-15
      const action = syncStatusAction(channelStatus, state.noticeKind, state.copyMode); // 011 RF-21
      if (action === 'recover') {
        hideError('sync');
        scheduleReload();
        scheduleListReload(); // 007 RF-35
        scheduleReviewReload(); // 009 RF-24, RF-25
        scheduleCopySave(); // 011 RF-1
      } else if (action === 'show') {
        showError('Se ha perdido la sincronización en tiempo real. Reintentando…', 'sync');
      }
    });
}

function unsubscribeChanges() {
  if (channel) client.removeChannel(channel);
  channel = null;
  state.channelStatus = null;
  unsubscribeForms();
}

// ===== Formularios abiertos en otro sitio (004-edicion-simultanea) =====
// Se abre con la sesión, junto a 'meal-changes' (D-2); su caída no da el aviso global
function subscribeForms() {
  unsubscribeForms();
  formsChannel = client.channel('meal-forms', { config: { private: true } })
    .on('broadcast', { event: 'form' }, ({ payload }) => onPeerMessage(payload))
    .on('broadcast', { event: 'saved' }, ({ payload }) => onSavedElsewhere(payload))
    .subscribe((status) => {
      formsReady = status === 'SUBSCRIBED';
      if (formsReady) {
        announceForm({ hello: true }); // CL-3: vuelve a anunciarse y pide respuesta
        recheckSaved(); // RF-3 perdido (D-12)
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        peers = [];
        refreshMatch();
      }
    });
  peerTimer = setInterval(refreshMatch, PEER_CHECK_MS); // RNF-4
}

function unsubscribeForms() {
  clearInterval(peerTimer);
  peerTimer = null;
  if (formsChannel) client.removeChannel(formsChannel);
  formsChannel = null;
  formsReady = false;
  announced = false;
  peers = [];
}

// Envía solo con el canal unido y el socket conectado, sin esperar (D-3, D-6)
function sendForms(event, payload) {
  if (!formsReady || !client.realtime.isConnected()) return false;
  formsChannel.send({ type: 'broadcast', event, payload }).catch(() => {});
  return true;
}

// Fecha y tipo elegidos en el formulario propio
function ownSlot() {
  return { date: $('form-date').value, type: formState.type };
}

// Anuncio o salida del formulario propio: qué se envía lo decide formMessage (D-3, D-8)
function announceForm({ hello = false } = {}) {
  const message = formMessage({
    open: formState.open, ...ownSlot(),
    visible: document.visibilityState === 'visible', announced, hello,
  });
  if (!message) return;
  if (sendForms('form', { key: tabKey, seq: ++announceSeq, ...message })) announced = !message.gone;
}

// Mensaje "form" de otro formulario (D-3): actualiza los peers y contesta a un hello
function onPeerMessage(message) {
  peers = updatePeers(peers, message, tabKey, Date.now());
  refreshMatch();
  if (needsReply(message, tabKey)) announceForm();
}

// Mensaje "saved" (RF-3): otro formulario guardó esta fecha y tipo; el aviso queda
// puesto hasta cambiar de fecha o tipo (RF-4)
function onSavedElsewhere(slot) {
  if (!formState.open || !sameSlot(ownSlot(), slot)) return;
  markSavedElsewhere();
}

// Aviso de RF-3: único sitio que lo pone; guarda la fecha y el tipo de ese momento (D-7)
function markSavedElsewhere() {
  formState.savedElsewhere = true;
  formState.savedSlot = ownSlot();
  refreshMatch();
}

// Relectura (D-12): por si el "saved" no llegó (página congelada, socket caído, sin conexión)
async function recheckSaved() {
  if (!formState.open || formState.savedElsewhere || formState.saving) return;
  const slot = ownSlot();
  if (!slot.date || !slot.type) return;
  const recheckId = ++formState.recheckId;
  let current;
  try {
    current = await fetchMeal(slot.date, slot.type);
  } catch {
    return; // sin errores en pantalla: CL-4 protege al guardar
  }
  if (recheckId !== formState.recheckId || !formState.open || formState.saving) return;
  if (formState.savedElsewhere || !sameSlot(ownSlot(), slot)) return;
  if (savedSince(formState.seen, slot, current)) markSavedElsewhere(); // RF-3, RNF-6
}

// Pestaña o app oculta = formulario abandonado (RNF-5); al volver a verse, otra vez (RNF-6)
function onVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    stopRefresh();
    announceForm(); // salida: el otro quita el aviso; se siguen recibiendo "form" y "saved"
    return;
  }
  announceForm({ hello: true });
  if (formState.open) startRefresh();
  refreshMatch();
  recheckSaved();
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => announceForm(), PEER_REFRESH_MS); // RNF-4
}

function stopRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

// Pinta el aviso de coincidencia; único sitio que activa o desactiva "Guardar"
function refreshMatch() {
  const match = formState.open && hasMatch(ownSlot(), peers, Date.now());
  const { text, saveDisabled } = matchNotice({ match, savedElsewhere: formState.savedElsewhere, saving: formState.saving });
  const shown = formState.open && text ? text : '';
  $('form-match-text').textContent = shown;
  $('form-match-notice').hidden = !shown;
  $('form-save').disabled = saveDisabled || state.offline; // 011 RF-10, CL-6
}

// Cambio de fecha o tipo en el formulario (RF-6 en el otro formulario). Con el aviso de
// RF-3, solo un cambio real (leavesSlot) pasa a comida nueva (RF-5, D-7); si no, el
// formulario se queda como está (CL-7). checkExisting aplica 000-base RF-39/RF-40 (CL-2)
function onSlotChange() {
  if (formState.savedElsewhere) {
    if (!leavesSlot(formState.savedSlot, ownSlot())) {
      announceForm();
      refreshMatch();
      return;
    }
    formState.savedElsewhere = false;
    formState.savedSlot = null;
    formState.id = null;
    formState.snapshot = null;
    $('form-title').textContent = 'Añadir comida';
    showFormNotice(''); // el aviso de 000-base RF-39 ya no vale: no se edita la existente
  }
  announceForm();
  refreshMatch();
  checkExisting();
}

function onFormClosed() {
  formState.open = false;
  stopRefresh();
  announceForm();
  refreshMatch();
}

// ===== Navegación =====
function changeView(view) {
  state.view = view;
  state.openType = null;
  render();
  loadData();
}

function shiftPeriod(direction) {
  state.refDate = movePeriod(state.view, state.refDate, direction);
  state.openType = null;
  render();
  loadData();
}

function goToToday() {
  state.refDate = getToday();
  state.openType = null;
  render();
  loadData();
}

function openDay(date, openType = null) {
  state.view = 'day';
  state.refDate = date;
  state.openType = openType;
  render();
  loadData();
}

// Panel de meses (006): abre en el año del día de referencia, debajo de la cabecera
function openMonthPanel() {
  panelYear = initialPanelYear(state.refDate);
  renderMonthPanel();
  placeMonthPanel();
  $('month-panel').showModal();
  $('period-button').setAttribute('aria-expanded', 'true');
}

function renderMonthPanel() {
  $('panel-year').textContent = String(panelYear);
  const arrows = panelArrows(panelYear);
  $('panel-prev').disabled = !arrows.canGoBack;
  $('panel-next').disabled = !arrows.canGoForward;
  const cells = monthPanel(panelYear, state.refDate, getToday()).map(({ month, label, isVisible, isToday }) => {
    const cell = button('panel-month', label, () => pickMonth(month));
    cell.classList.toggle('visible', isVisible);
    cell.classList.toggle('today', isToday);
    if (isVisible) cell.setAttribute('aria-current', 'date');
    return cell;
  });
  $('panel-months').replaceChildren(...cells);
}

// ‹ (-1) o › (1) del panel: cambia solo el año del panel, sin tocar el calendario (RF-6).
// Una flecha desactivada no lanza `click`; la guarda es por si llega igual (CL-7).
function shiftPanelYear(direction) {
  const arrows = panelArrows(panelYear);
  if ((direction < 0 && !arrows.canGoBack) || (direction > 0 && !arrows.canGoForward)) return;
  panelYear += direction;
  renderMonthPanel();
}

// Elegir un mes: vista Mes con el día 1 de ese mes (RF-7). Carga como ‹ › salvo si
// ya estaba en ese mes en la vista Mes (CL-4, D-7); si falla, el aviso de siempre (CL-2)
function pickMonth(month) {
  const next = chooseMonth(state.view, state.refDate, panelYear, month);
  $('month-panel').close();
  state.view = next.view;
  state.refDate = next.refDate;
  state.openType = null;
  render();
  if (next.reload) loadData();
}

// Una pulsación fuera de un diálogo modal (panel de meses o menú del usuario) cae en su fondo,
// que también es el <dialog> (006 D-1, 008 D-3)
function isOutsideDialog(dialog, event) {
  if (event.target !== dialog) return false;
  const r = dialog.getBoundingClientRect();
  return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
}

// Solo cierra si la pulsación empezó y acabó fuera: pulsar dentro y soltar fuera no cierra (RF-9)
function onMonthPanelClick(event) {
  if (panelPressedOutside && isOutsideDialog($('month-panel'), event)) $('month-panel').close();
  panelPressedOutside = false;
}

function closeMonthPanel() {
  if ($('month-panel').open) $('month-panel').close();
}

// ===== Menú del usuario (008) =====
// Inicial en el círculo y email en el menú, siempre como texto (RF-4, RNF-4)
function showUser(email) {
  $('user-initial').textContent = userInitial(email);
  $('user-menu-email').textContent = email;
}

// Modal como el panel de meses: lo de detrás no se puede pulsar (RF-7, D-1); el foco va al
// email por su autofocus, no a "Cerrar sesión" (D-5)
function openUserMenu() {
  $('user-menu').showModal();
  $('user-button').setAttribute('aria-expanded', 'true');
}

function closeUserMenu() {
  if ($('user-menu').open) $('user-menu').close();
}

// Una pulsación que empieza y acaba fuera del menú (también sobre el círculo) solo lo cierra (RF-7)
function onUserMenuClick(event) {
  if (menuPressedOutside && isOutsideDialog($('user-menu'), event)) closeUserMenu();
  menuPressedOutside = false;
}

// "Cerrar sesión" del menú: sin confirmación, como el botón de antes (RF-8)
function logOutFromMenu() {
  closeUserMenu();
  logOut();
}

// ===== Barra lateral (008) =====
// Se lee una vez al arrancar, no al entrar: sobrevive al cierre de sesión (RF-11, D-8).
// Sin localStorage, expandida (CL-5)
function readSidebar() {
  let stored;
  try {
    stored = localStorage.getItem(SIDEBAR_KEY);
  } catch {
    stored = null;
  }
  setSidebar(isSidebarCollapsed(stored));
}

// El CSS solo lo usa en el pc ancho; en el pc estrecho la barra va contraída igual (D-10)
function setSidebar(collapsed) {
  if (collapsed) $('screen-app').dataset.sidebar = 'collapsed';
  else delete $('screen-app').dataset.sidebar;
  $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
}

// ☰ (RF-9); sin escuchar 'storage': la otra pestaña no cambia hasta recargar (CL-7)
function toggleSidebar() {
  const collapsed = !('sidebar' in $('screen-app').dataset);
  setSidebar(collapsed);
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Sin localStorage, ☰ funciona mientras dure la página (CL-5)
  }
}

function placeMonthPanel() {
  const panel = $('month-panel');
  panel.style.top = document.querySelector('.header').getBoundingClientRect().bottom + 'px';
  panel.style.left = document.querySelector('.navigation').getBoundingClientRect().left + 'px';
}

// ===== Render =====
function render() {
  updateHeader();
  const { from, to } = currentRange();
  $('copy-gap').hidden = !(state.copyMode && hasCopyGap(from, to, copyState.copy)); // 011 RF-15
  const calendar = $('calendar');
  if (state.view === 'month') calendar.replaceChildren(buildMonthView());
  else if (state.view === 'week') {
    calendar.replaceChildren(buildWeekView());
    updateWeekDates(); // antes de que se vea (008 RF-15)
  } else calendar.replaceChildren(buildDayView());
}

function updateHeader() {
  document.querySelectorAll('.view-button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  $('period-title').textContent = periodTitle(state.view, state.refDate);
}

// ¿Día fuera de la copia, en modo copia? Se ve vacío y atenuado (011 RF-15)
function isNoCopyDay(date) {
  return state.copyMode && isOutsideCopy(toISODate(date), copyState.copy);
}

// Vista mensual: cuadrícula de días con puntos (móvil) o nombres (pantalla grande)
function buildMonthView() {
  const grid = el('div', 'month');
  for (const initial of ['L', 'M', 'X', 'J', 'V', 'S', 'D']) grid.append(el('div', 'month-header', initial));

  for (const { date, outside, isToday } of monthGrid(state.refDate, getToday())) {
    const cell = button('month-day', undefined, () => openDay(date));
    if (outside) cell.classList.add('outside');
    if (isToday) cell.classList.add('today');
    if (isNoCopyDay(date)) cell.classList.add('no-copy');
    cell.setAttribute('aria-label', longDate(date));
    cell.append(el('div', 'month-number', String(date.getDate())));

    const list = el('div', 'month-meals');
    for (const type of MEAL_TYPES) {
      const meal = mealAt(date, type.id);
      if (!meal) continue;
      const item = el('div', 'month-meal type-' + type.id);
      item.title = type.name + ': ' + meal.platos[0].nombre;
      item.append(el('span', 'dot'), el('span', 'month-meal-name', meal.platos[0].nombre));
      list.append(item);
    }
    cell.append(list);
    grid.append(cell);
  }
  return grid;
}

// Vista semanal: siete días con sus tres comidas
function buildWeekView() {
  const week = el('div', 'week');
  for (const { date, isToday } of weekDays(state.refDate, getToday())) {
    const card = el('section', 'week-day' + (isToday ? ' today' : '') + (isNoCopyDay(date) ? ' no-copy' : ''));
    // Dos fechas: el CSS muestra la abreviada en el pc estrecho; el lector de pantalla lee
    // siempre la completa (008 RF-15, RNF-5, D-11)
    const fullName = formatDate(date, { weekday: 'long', day: 'numeric' });
    const dateButton = button('week-date', undefined, () => openDay(date));
    dateButton.setAttribute('aria-label', fullName);
    dateButton.append(el('span', 'week-date-long', fullName), el('span', 'week-date-short', shortWeekDate(date)));
    card.append(dateButton);

    for (const type of MEAL_TYPES) {
      const meal = mealAt(date, type.id);
      const onClick = meal
        ? () => openDay(date, type.id)
        : () => { if (!state.offline) openForm({ date, type: type.id }); }; // 011 RF-10
      const row = button('week-meal type-' + type.id + (meal ? '' : ' empty'), undefined, onClick);
      if (!meal) row.disabled = state.offline; // abre el formulario para crear (011 D-7)
      row.append(
        el('span', 'week-meal-type', type.name),
        el('span', 'week-meal-name', meal ? dishNames(meal) : '—'),
      );
      card.append(row);
    }
    week.append(card);
  }
  return week;
}

// Abrevia los siete días si algún nombre completo, con el número de dos cifras más ancho, no
// cabe en su columna (008 RF-15, D-11). Aquí solo se mide; la cuenta la hace logic.js
function updateWeekDates() {
  const week = document.querySelector('.week');
  if (!week || week.offsetParent === null) return; // en Compra o sin sesión, no hay nada que medir
  const first = week.querySelector('.week-date');
  const probe = el('span', 'week-date-probe');
  first.append(probe);
  const measure = (text) => {
    probe.textContent = text;
    return probe.getBoundingClientRect().width;
  };
  const days = weekDays(state.refDate, getToday());
  const nameWidths = days.map(({ date }) => measure(formatDate(date, { weekday: 'long' })));
  const numberWidths = [];
  for (let day = 10; day <= 31; day++) numberWidths.push(measure(String(day)));
  const spaceWidth = measure(' ');
  probe.remove();
  const available = first.getBoundingClientRect().width;
  week.classList.toggle('short-dates', needsShortWeekDates(nameWidths, numberWidths, spaceWidth, available));
}

// Vuelve a medir cuando cambia el ancho del calendario (ventana, ☰, letra); fuera del aviso y
// solo si cambió el ancho, porque abreviar cambia el alto (como 005 D-2)
let calendarWidth = null;
const calendarObserver = new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (width === calendarWidth) return;
  calendarWidth = width;
  requestAnimationFrame(updateWeekDates);
});

// Vista diaria: un bloque por tipo de comida
function buildDayView() {
  const container = el('div', 'day');
  for (const type of MEAL_TYPES) container.append(buildBlock(state.refDate, type));
  return container;
}

function buildBlock(date, type) {
  const block = el('section', 'block type-' + type.id + (isNoCopyDay(date) ? ' no-copy' : ''));
  const meal = mealAt(date, type.id);

  if (!meal) {
    const empty = el('div', 'block-empty');
    const texts = el('div');
    texts.append(el('span', 'block-type', type.name), el('p', null, 'Nada registrado'));
    const add = button('btn', 'Añadir', () => { if (!state.offline) openForm({ date, type: type.id }); });
    add.disabled = state.offline; // 011 RF-10, D-7
    empty.append(texts, add);
    block.append(empty);
    return block;
  }

  const isOpen = state.openType === type.id;
  const header = button('block-header', undefined, () => {
    state.openType = isOpen ? null : type.id;
    render();
  });
  header.setAttribute('aria-expanded', String(isOpen));
  header.append(el('span', 'block-type', type.name), el('span', 'block-summary', dishNames(meal)));
  block.append(header);
  if (isOpen) block.append(buildDetail(meal));
  return block;
}

function buildDetail(meal) {
  const detail = el('div', 'block-detail');
  meal.platos.forEach((dish, index) => detail.append(buildDishDetail(dish, dishTitle(meal.tipo, index))));

  const buttons = el('div', 'detail-buttons');
  const remove = button('btn btn-danger', 'Borrar', () => deleteMeal(meal));
  remove.disabled = state.offline; // 011 RF-10, D-7; "Editar" sigue activo (RF-9)
  buttons.append(button('btn', 'Editar', () => openForm({ meal })), remove);
  detail.append(buttons);
  return detail;
}

function buildDishDetail(dish, title) {
  const box = el('div', 'detail-dish');
  box.append(el('p', 'detail-subtitle', title), el('h3', null, dish.nombre));

  if (dish.ingredientes?.length) {
    const list = el('ul');
    for (const ingredient of dish.ingredientes) list.append(el('li', null, formatIngredient(ingredient)));
    box.append(el('p', 'detail-subtitle', 'Ingredientes'), list);
  }
  if (dish.receta) {
    box.append(el('p', 'detail-subtitle', 'Receta'), el('p', 'detail-recipe', dish.receta));
  }
  const link = safeLink(dish.referencia);
  if (link) {
    const a = el('a', null, link);
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(el('p', 'detail-subtitle', 'Referencia'), a);
  }
  return box;
}

// ===== Confirmación =====
function askConfirm(text, acceptText = 'Aceptar') {
  const dialog = $('confirm-dialog');
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = acceptText;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
    dialog.showModal();
  });
}

// ===== Formulario: platos e ingredientes =====
function buildFormDish(container) {
  const node = $('dish-template').content.firstElementChild.cloneNode(true);
  const find = (selector) => node.querySelector(selector);
  const dish = {
    node,
    title: find('.dish-title'),
    nameLabel: find('.dish-name-label'),
    name: find('.dish-name'),
    ingredients: find('.ingredients'),
    recipe: find('.dish-recipe'),
    reference: find('.dish-reference'),
  };
  find('.dish-add-ingredient').addEventListener('click', () => addIngredient(dish));
  container.append(node);
  return dish;
}

function addIngredient(dish, data = {}) {
  const row = $('ingredient-template').content.firstElementChild.cloneNode(true);
  const name = row.querySelector('.ingredient-name');
  name.value = flattenLineBreaks(data.nombre || '');
  row.querySelector('.ingredient-quantity').value = data.cantidad ?? '';
  row.querySelector('.ingredient-unit').value = data.unidad || '';
  name.addEventListener('keydown', onNameKeydown);
  name.addEventListener('beforeinput', onNameBeforeInput);
  name.addEventListener('input', (event) => onNameInput(name, event));
  nameObserver.observe(name);
  row.querySelector('.ingredient-remove').addEventListener('click', () => {
    nameObserver.unobserve(name);
    row.remove();
  });
  dish.ingredients.append(row);
}

// ===== Nombre del ingrediente en varias líneas (RF-2, CL-1, CL-2) =====

// Intro tecleado (no pegado) en el nombre (D-3)
const TYPED_BREAKS = ['insertLineBreak', 'insertParagraph'];

// Ajusta el alto del nombre a sus líneas. Con una línea queda sin alto propio, para que
// en el pc se estire como la cantidad y la unidad (D-5, RF-3)
function fitNameHeight(textarea) {
  textarea.style.height = '';
  if (textarea.scrollHeight <= textarea.clientHeight) return;
  const border = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = `${textarea.scrollHeight + border}px`;
}

// Reajusta el alto cuando cambia el ancho del nombre: al abrir el diálogo o cambiar de
// ancho. Fuera del aviso y solo si cambió el ancho, para no entrar en bucle (D-2)
const nameWidths = new WeakMap();
const nameObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const width = entry.contentRect.width;
    if (width === nameWidths.get(entry.target)) continue;
    nameWidths.set(entry.target, width);
    requestAnimationFrame(() => fitNameHeight(entry.target));
  }
});

// Igual que el envío implícito de un campo de una línea: solo con "Guardar" activo
function submitFromName() {
  const save = $('form-save');
  if (!save.disabled) $('meal-form').requestSubmit(save);
}

function onNameKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  submitFromName();
}

// Teclados que no avisan de la tecla (keydown 229): el salto no entra y se envía (D-3)
function onNameBeforeInput(event) {
  if (!TYPED_BREAKS.includes(event.inputType)) return;
  event.preventDefault();
  submitFromName();
}

// Un salto pegado, o uno que no se pudo anular, pasa a espacio sin mover el cursor (CL-1)
function onNameInput(name, event) {
  const flat = flattenLineBreaks(name.value);
  if (flat !== name.value) {
    const { selectionStart, selectionEnd } = name;
    name.value = flat;
    name.setSelectionRange(selectionStart, selectionEnd);
  }
  fitNameHeight(name);
  if (TYPED_BREAKS.includes(event.inputType)) submitFromName();
}

function fillDish(dish, data) {
  dish.name.value = data?.nombre || '';
  dish.recipe.value = data?.receta || '';
  dish.reference.value = data?.referencia || '';
  dish.ingredients.querySelectorAll('.ingredient-name').forEach((name) => nameObserver.unobserve(name));
  dish.ingredients.replaceChildren();
  const ingredients = data?.ingredientes || [];
  if (ingredients.length) ingredients.forEach((ingredient) => addIngredient(dish, ingredient));
  else addIngredient(dish);
}

function readRows(dish) {
  return [...dish.ingredients.querySelectorAll('.ingredient')].map((row) => ({
    row,
    name: row.querySelector('.ingredient-name'),
    quantity: row.querySelector('.ingredient-quantity'),
    unit: row.querySelector('.ingredient-unit'),
  }));
}

// Valores en bruto de una fila y de un plato, para la lógica (D-6)
function readRow(row) {
  return { name: row.name.value, quantity: row.quantity.value, badInput: row.quantity.validity.badInput, unit: row.unit.value };
}

function readDish(dish) {
  return {
    name: dish.name.value,
    recipe: dish.recipe.value,
    reference: dish.reference.value,
    rows: readRows(dish).map(readRow),
  };
}

// Muestra u oculta el segundo plato según el tipo elegido
function updateDishes() {
  const layout = formDishLayout(formState.type, dishHasData(readDish(formState.dish2)));
  formState.dish1.title.textContent = layout.firstTitle;
  formState.dish2.title.textContent = layout.secondTitle;
  formState.dish2.node.hidden = layout.secondHidden;
  $('form-remove-second').hidden = !layout.showRemoveSecond;
  if (layout.error) showFormError(layout.error);
}

function chooseType(type) {
  formState.type = type;
  document.querySelectorAll('.type-button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  showFormError('');
  updateDishes();
}

function removeSecondDish() {
  fillDish(formState.dish2, null);
  showFormError('');
  updateDishes();
}

// ===== Formulario: abrir y cargar =====
function showFormError(text) {
  $('form-error').textContent = text;
  $('form-error').hidden = !text;
}

function showFormNotice(text) {
  $('form-notice').textContent = text;
  $('form-notice').hidden = !text;
}

function clearMarks() {
  document.querySelectorAll('#meal-form .invalid-field').forEach((n) => n.classList.remove('invalid-field'));
}

function fillForm({ id = null, fecha: date, tipo: type = null, platos: dishes = [] }) {
  formState.id = id;
  formState.snapshot = id ? { fecha: date, tipo: type, platos: dishes } : null; // CL-4
  formState.seen = id ? { date, type, meal: { id, platos: dishes } } : null; // D-12
  $('form-title').textContent = id ? 'Editar comida' : 'Añadir comida';
  $('form-date').value = date;
  fillDish(formState.dish1, dishes[0]);
  fillDish(formState.dish2, dishes[1]);
  clearMarks();
  showFormNotice('');
  chooseType(type);
}

// Abre el formulario para una comida concreta, o para una fecha/tipo (edita si ya existe)
function openForm({ meal = null, date = null, type = null } = {}) {
  const existing = meal || (date && type ? mealAt(date, type) : null);
  if (existing) {
    fillForm(existing);
  } else {
    const initialDate = date || initialFormDate(state.view, state.refDate, getToday());
    fillForm({ fecha: toISODate(initialDate), tipo: type });
    if (type) checkExisting();
  }
  $('meal-dialog').showModal();
  formState.open = true;
  formState.savedElsewhere = false;
  formState.savedSlot = null;
  announceForm({ hello: true });
  startRefresh();
  refreshMatch();
}

async function fetchMeal(isoDate, type) {
  const { data, error } = await client.from('comidas').select('*')
    .eq('fecha', isoDate).eq('tipo', type).maybeSingle();
  if (error) throw error;
  return data;
}

// En una entrada nueva: si la fecha y el tipo ya tienen comida, se pasa a editarla
async function checkExisting() {
  const isoDate = $('form-date').value;
  if (formState.id || !isoDate || !formState.type) return;
  const searchId = ++formState.searchId;
  let existing;
  try {
    existing = await fetchMeal(isoDate, formState.type);
  } catch {
    return; // se volverá a comprobar al guardar
  }
  if (searchId !== formState.searchId || formState.id) return;
  const seen = { date: isoDate, type: formState.type, meal: null }; // D-12: lo que había en el hueco
  if (!existing) {
    formState.seen = seen;
    return;
  }

  const hasData = dishHasData(readDish(formState.dish1)) || dishHasData(readDish(formState.dish2));
  if (hasData) {
    const load = await askConfirm(duplicateMessage(formState.type, 'confirm'), 'Editar la existente');
    if (!load) {
      // RF-40 cancelada: la comida que ya había no cuenta como guardada desde otro sitio
      if (searchId === formState.searchId && !formState.id) {
        formState.seen = { ...seen, meal: { id: existing.id, platos: existing.platos } };
      }
      return;
    }
  }
  fillForm(existing);
  showFormNotice(duplicateMessage(existing.tipo, 'editing'));
}

// ===== Formulario: validación y guardado =====
// El formulario entero en bruto, para validateMealForm (D-6)
function readForm() {
  return {
    date: $('form-date').value,
    type: formState.type,
    dishes: [readDish(formState.dish1), readDish(formState.dish2)],
  };
}

// Marca los campos que devuelve la validación: { field: 'date' } o { dish, field, row? }
function markInvalid(invalid) {
  const dishes = [formState.dish1, formState.dish2];
  for (const { dish, field, row } of invalid) {
    let node;
    if (field === 'date') node = $('form-date');
    else if (row !== undefined) node = readRows(dishes[dish])[row][field];
    else node = dishes[dish][field];
    node.classList.add('invalid-field');
  }
}

// Devuelve { data } listo para guardar o { error }, con los campos marcados
function validateForm() {
  clearMarks();
  const raw = readForm();
  const result = validateMealForm(raw);
  if (!result.error) return result;
  markInvalid(result.invalid);
  // Desayuno con dos platos: se vuelve a enseñar el botón "Eliminar segundo plato", como antes
  if (formDishLayout(raw.type, dishHasData(raw.dishes[1])).showRemoveSecond) updateDishes();
  return result;
}

async function saveMeal(event) {
  event.preventDefault();
  if (formState.savedElsewhere || state.offline) return; // RF-4: también al enviar con Enter; 011 RF-10
  showFormError('');
  const { data: meal, error } = validateForm();
  if (error) return showFormError(error);

  formState.saving = true;
  refreshMatch();
  try {
    // Una sola entrada por día y tipo
    const existing = await fetchMeal(meal.fecha, meal.tipo);
    if (!sessionActive) return; // CL-13: sesión cerrada mientras esperaba
    if (isOtherMeal(existing, formState.id)) return showFormError(duplicateMessage(meal.tipo, 'error'));

    if (formState.id) {
      // CL-4 (D-5): compara con lo que había al abrir y guarda en un solo paso
      const { snapshot } = formState;
      const { data, error: saveError } = await client.rpc('guardar_comida_si_no_cambio', {
        p_id: formState.id,
        p_fecha_antes: snapshot.fecha, p_tipo_antes: snapshot.tipo, p_platos_antes: snapshot.platos,
        p_fecha: meal.fecha, p_tipo: meal.tipo, p_platos: meal.platos,
      });
      if (!sessionActive) return;
      if (saveError) throw saveError;
      const outcome = saveOutcome(data);
      if (outcome === 'changed') return markSavedElsewhere(); // CL-4: aviso de RF-3, sin guardar
      if (outcome === 'deleted') return showFormError('Esta comida ya no existe; puede que la haya borrado la otra persona.');
      if (outcome === 'error') throw new Error('Respuesta inesperada al guardar');
    } else {
      const { error: saveError } = await client.from('comidas').insert(meal);
      if (!sessionActive) return;
      if (saveError) throw saveError;
    }
    sendForms('saved', { date: meal.fecha, type: meal.tipo }); // RF-3 (D-6): sin esperar
    $('meal-dialog').close();
    loadData();
  } catch (saveError) {
    if (!sessionActive) return; // CL-13: error de fetchMeal llegado tras el cierre
    showFormError(saveErrorMessage(saveError, meal.tipo, navigator.onLine));
  } finally {
    formState.saving = false;
    refreshMatch();
  }
}

// ===== Borrado =====
async function deleteMeal(meal) {
  if (state.offline) return; // 011 RF-10
  const text = deleteConfirmText(meal);
  if (!(await askConfirm(text, 'Borrar'))) return;

  const { error } = await client.from('comidas').delete().eq('id', meal.id);
  if (!sessionActive) return; // CL-13: respuesta llegada tras el cierre de sesión
  if (error) return showError('No se ha podido borrar la comida. ' + translateError(error, navigator.onLine));
  state.openType = null;
  loadData();
}

// ===== Eventos =====
function bindEvents() {
  $('config-retry').addEventListener('click', connect);
  $('form-login').addEventListener('submit', submitLogin);
  $('forgot-button').addEventListener('click', () => showRecovery($('login-email').value.trim()));
  $('recovery-back').addEventListener('click', () => showLoginForm('login'));
  $('form-recovery').addEventListener('submit', submitRecovery);
  $('form-new-password').addEventListener('submit', submitNewPassword);
  $('new-password-cancel').addEventListener('click', cancelNewPassword);
  $('user-button').addEventListener('click', openUserMenu);
  $('user-menu').addEventListener('pointerdown', (event) => { menuPressedOutside = isOutsideDialog($('user-menu'), event); });
  $('user-menu').addEventListener('click', onUserMenuClick);
  $('user-menu').addEventListener('close', () => $('user-button').setAttribute('aria-expanded', 'false'));
  $('user-menu-logout').addEventListener('click', logOutFromMenu);
  // Al cruzar los 768 px cambia el diseño (CSS) y el menú se cierra (CL-8)
  matchMedia('(min-width: 768px)').addEventListener('change', closeUserMenu);
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  readSidebar();
  calendarObserver.observe($('calendar')); // 008 RF-15

  document.querySelectorAll('.view-button').forEach((b) => b.addEventListener('click', () => changeView(b.dataset.view)));
  $('prev-button').addEventListener('click', () => shiftPeriod(-1));
  $('next-button').addEventListener('click', () => shiftPeriod(1));
  $('today-button').addEventListener('click', goToToday);
  $('period-button').addEventListener('click', openMonthPanel);
  $('panel-prev').addEventListener('click', () => shiftPanelYear(-1));
  $('panel-next').addEventListener('click', () => shiftPanelYear(1));
  $('month-panel').addEventListener('pointerdown', (event) => { panelPressedOutside = isOutsideDialog($('month-panel'), event); });
  $('month-panel').addEventListener('click', onMonthPanelClick);
  $('month-panel').addEventListener('close', () => $('period-button').setAttribute('aria-expanded', 'false'));
  window.addEventListener('resize', () => {
    if ($('month-panel').open) placeMonthPanel();
  });
  $('add-button').addEventListener('click', () => { if (!state.offline) openForm(); }); // 011 RF-10
  document.querySelectorAll('.screen-button').forEach((b) => b.addEventListener('click', () => {
    if (reviewState.open) return; // 009 CL-7: además de la barra inerte por el modal
    showAppScreen(b.dataset.screen);
  }));
  $('saved-toggle').addEventListener('click', toggleSaved);
  $('add-article-button').addEventListener('click', () => { if (!state.offline) openArticleForm(); }); // 011 RF-10
  $('finish-button').addEventListener('click', finishShopping);
  $('article-cancel').addEventListener('click', closeArticleForm);
  $('article-delete').addEventListener('click', deleteFromArticleForm);
  $('article-form').addEventListener('submit', saveArticle);
  $('ingredients-button').addEventListener('click', openReview);
  $('ingredients-cancel').addEventListener('click', closeReview); // RF-4
  $('ingredients-retry').addEventListener('click', () => loadReviewMeals({ showLoading: true })); // RF-21
  $('ingredients-lines').addEventListener('change', onReviewLineChange); // RF-9
  $('ingredients-form').addEventListener('submit', submitReview); // RF-13
  for (const side of ['from', 'to']) {
    $(PERIOD_FIELDS[side].date).addEventListener('change', onPeriodFieldChange); // RF-3
    $(PERIOD_FIELDS[side].type).addEventListener('change', onPeriodFieldChange);
  }
  // En el documento: mientras se añade, el foco queda fuera del diálogo (sus controles, desactivados)
  document.addEventListener('keydown', onReviewKeydown);
  $('ingredients-dialog').addEventListener('cancel', onReviewCancel);
  $('ingredients-dialog').addEventListener('close', () => {
    // D-13: respaldo; un close atrasado de un cierre anterior no cierra la revisión reabierta
    if (reviewState.open && !$('ingredients-dialog').open) closeReview();
  });
  $('quick-add').addEventListener('submit', submitQuickAdd);
  $('quick-add-input').addEventListener('input', renderSuggestions); // RF-21, RF-22
  $('error-notice-close').addEventListener('click', () => hideError());

  formState.dish1 = buildFormDish($('form-dish-1'));
  formState.dish2 = buildFormDish($('form-dish-2'));
  formState.dish1.nameLabel.textContent = 'Nombre de receta *';
  document.querySelectorAll('.type-button').forEach((b) => b.addEventListener('click', () => {
    chooseType(b.dataset.type);
    onSlotChange();
  }));
  $('form-date').addEventListener('change', onSlotChange);
  $('form-remove-second').addEventListener('click', removeSecondDish);
  $('form-cancel').addEventListener('click', () => $('meal-dialog').close());
  $('meal-form').addEventListener('submit', saveMeal);
  $('meal-dialog').addEventListener('close', onFormClosed);

  $('confirm-yes').addEventListener('click', () => $('confirm-dialog').close('yes'));
  $('confirm-no').addEventListener('click', () => $('confirm-dialog').close('no'));

  // Recargar al volver a primer plano y al recuperar la conexión
  document.addEventListener('visibilitychange', () => {
    onVisibilityChange(); // RNF-5, RNF-6 (004)
    if (document.visibilityState !== 'visible') {
      stopRetry(); // 011 RF-16: en segundo plano no se reintenta
      return;
    }
    if (sessionActive && (state.copyMode || state.offline)) {
      retryConnection(); // 011 RF-16: en el momento, y otra vez cada 30 s
      startRetry();
    } else {
      loadData();
      loadList(); // 007 RF-34
      scheduleCopySave(); // 011 RF-1
    }
    checkSessionAlive();
  });
  window.addEventListener('online', () => {
    if (sessionActive && (state.copyMode || state.offline)) {
      retryConnection(); // 011 RF-12, D-6: solo el reintento sale del modo copia
    } else if (sessionActive) {
      loadData();
      loadList(); // 007 RF-34
      scheduleCopySave(); // 011 RF-1
    } else if (!$('screen-config').hidden) connect();
    announceForm({ hello: true }); // CL-3 (si el socket aún no ha vuelto, lo hace SUBSCRIBED)
    recheckSaved(); // D-12
  });
  window.addEventListener('offline', () => {
    goOffline();
    peers = []; // CL-3: sin conexión no hay aviso de RF-1
    refreshMatch();
  });
}

bindEvents();
connect();

// Service worker (010 RF-9 a RF-13): al terminar de cargar y sin aviso si falla (D-8, RF-12)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}
