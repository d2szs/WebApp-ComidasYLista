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
  noticeKind: null,     // origen del aviso visible: 'load' | 'offline' | 'listLoad' | 'recipesLoad' | 'sync' | 'copy' | 'action'
  noticeId: 0,          // 027: número del último aviso mostrado (sube con cada uno)
  visibleNoticeId: null, // 027: número del aviso a la vista (null: ninguno)
  copyMode: false,      // 011: mostrando la copia guardada (000-base D-19)
  offline: false,       // 011: sin red, con o sin copia (009 D-14)
  channelStatus: null,  // último estado del canal de tiempo real (000-base CL-15)
  moving: null,         // 025: claves de las casillas en "Moviendo…" (null: ninguna) (C-14, D-13)
};
// 011: copia para ver sin red; saveId descarta guardados adelantados por otro (D-3);
// retryTimer y probing, el reintento de cada 30 s (RF-16, D-6)
const copyState = { copy: null, saveTimer: null, saveId: 0, retryTimer: null, probing: false, rerun: false,
  mealNames: null }; // 014 D-7: nombres de comidas de la última carga buena (null: aún ninguna)

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
let currentScreen = 'meals'; // pantalla de la app: 'meals' | 'list' | 'recipes' | 'settings' (007 RF-1; 026 C-1; 028 D-7)
// Configuración (028 D-7): 'index' o 'tags', solo en memoria; entrar desde el menú abre el índice
let settingsView = 'index';

// Lista de la compra (007): artículos como llegan de la base de datos; loaded = primera carga
// hecha (RF-11). requestId sigue subiendo al cerrar sesión, para descartar respuestas viejas (CL-10)
function initialListState(requestId = 0) {
  return { items: [], loaded: false, requestId, savedOpen: false, quickPending: false, quickClosed: false, finishing: false };
}
let listState = initialListState();

// Recetas (026 D-8, D-10): todas, con sus estrellas, y los perfiles; loaded = primera carga hecha
// (C-47); noCopy = en modo copia, copia de una versión anterior sin recetas (C-33). Búsqueda,
// etiquetas y tiempo solo en memoria; el orden, también en el navegador (C-41, D-11).
// openId: receta del detalle (D-10); listScroll: posición de la lista al abrirla (C-13);
// rating: puntuación en curso (D-14); deletingId: borrado propio en curso (D-19)
function initialRecipeState(requestId = 0) {
  return {
    items: [], profiles: [], loaded: false, noCopy: false, requestId, ...initialRecipeFilters(),
    openId: null, listScroll: 0, rating: false, deletingId: null,
  };
}
function initialRecipeFilters(order = storedRecipeOrder(null)) {
  return { text: '', tags: [], tagsOpen: false, maxTime: null, order }; // 029 C-1, D-2
}
let recipeState = initialRecipeState();
let currentUserId = null; // id del usuario de la sesión, para "Tus estrellas" (026 C-12, D-22)
const WIDE_RECIPES = window.matchMedia('(min-width: 1024px)'); // pc ancho: lista y detalle (C-14)
// Vista de Recetas (030 D-7): lista, etiquetas y detalle se pintan para la pantalla Recetas o la
// ventana "Recetas" del formulario de comida. state: filtros y receta abierta (las recetas
// cargadas, siempre de recipeState); ids: sus nodos; mode: 'screen' o 'picker'
const recipeScreen = {
  mode: 'screen',
  get state() { return recipeState; }, // recipeState se sustituye al cerrar sesión
  ids: {
    root: 'recipes', loading: 'recipes-loading', empty: 'recipes-empty', list: 'recipe-list',
    filters: 'recipe-filters', tagsRow: 'recipe-tags-row', tags: 'recipe-tags',
    tagsToggle: 'recipe-tags-toggle', detail: 'recipe-detail',
  },
  render: () => renderRecipes(),
  open: (id) => openRecipe(id),
  back: () => backToRecipes(),
};
// Ventana "Recetas" (030 D-7): sus filtros, solo en memoria y vacíos al abrirla (C-12, C-13);
// openId y listScroll, como en la pantalla; dish, el plato del que se abrió; notice, el aviso
// de la ventana ({ kind: 'load', text }, D-8)
function initialPickerState(order = storedRecipeOrder(null)) {
  return { ...initialRecipeFilters(order), openId: null, listScroll: 0, dish: null, notice: null };
}
let pickerState = initialPickerState();
const recipePicker = {
  mode: 'picker',
  get state() { return pickerState; },
  ids: {
    root: 'picker-body', loading: 'picker-loading', empty: 'picker-empty', list: 'picker-list',
    filters: 'picker-filters', tagsRow: 'picker-tags-row', tags: 'picker-tags',
    tagsToggle: 'picker-tags-toggle', detail: 'picker-detail',
  },
  render: () => renderPicker(),
  open: () => {}, // el detalle, "‹ Recetas" y "Elegir" llegan con la T9 (D-15)
  back: () => {},
  choose: () => {},
};
let recipeReloadTimer = null; // agrupa recargas seguidas por tiempo real (300 ms, como la lista)
// Ventana "ya está en la lista" del campo rápido (021 C-8 a C-14): el artículo como se vio y lo
// que guarda cada botón
const existsState = { article: null, choice: null, saving: false };
// Diálogo de etiqueta (028 D-8): key, la clave del grupo (lo sigue aunque cambie su forma, C-11);
// group, el grupo como se ve ahora (count 0 si ya no lo tiene ninguna receta); saving, mientras
// guarda (C-14, C-28); pressedOutside, la pulsación empezó fuera (C-14); view, 'main' o
// 'merge' o 'confirm' (D-5); confirm, la acción que se pregunta ({ action: 'merge' o 'delete',
// targetKey y target al unir, back: la vista a la que vuelve "Cancelar" });
// opened, cuenta las aperturas para no pintar una respuesta en otro diálogo
const tagDialogState = {
  key: null, group: null, saving: false, pressedOutside: false, view: 'main', confirm: null, opened: 0,
};
// Ventana de ↺ en Guardados (022): el artículo como se vio al abrirla; saving, mientras guarda (C-10)
const recoverState = { item: null, saving: false };
// Revisión de ingredientes de comidas (009, plan § Algoritmo); requestId nunca vuelve a
// empezar mientras la app está abierta (D-12)
function initialReviewState(requestId = 0) {
  return {
    open: false, from: null, to: null, meals: [], lines: [], choices: new Map(), loading: false,
    loadError: null, noIngredients: false, saveError: null, saving: false, reloadPending: false, requestId,
    typed: new Map(), typedErrorKeys: [], // 017: lo escrito en "Comprar" y las líneas con error (D-1)
  };
}
let reviewState = initialReviewState();
// Formulario de artículo (007 T9): id null = "Añadir artículo"; opened sube al abrirlo
// typedName: se ha escrito o borrado en el nombre (las cargas recalculan su lista, 016 C-11);
// found: los artículos de las sugerencias a la vista; picked: el último elegido
const articleForm = { id: null, item: null, saving: false, opened: 0, typedName: false, found: [], picked: null };
// 012: envío de la cola de tachados en curso en esta pestaña (D-4); errorShown: el error de
// guardado del envío ya se mostró (RF-17: una sola vez); retryTimer: reintento de la cola con red (D-8)
const strikeQueueState = { sending: false, errorShown: false, retryTimer: null };

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
const SCREEN_KEY = 'screen'; // 'meals', 'list' o 'recipes', en la pestaña y en el navegador (007 D-19; 026 C-3)
const RECIPE_ORDER_KEY = 'recipe-order'; // orden elegido de la lista de recetas (026 D-11)
const SCREEN_TITLES = { meals: 'Comidas', list: 'Compra', recipes: 'Recetas', settings: 'Configuración' }; // 026 C-2; 028 C-2

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

// Cambia de pantalla sin tocar el calendario (007 RF-2, RF-3, D-7). Configuración no marca ningún
// botón de la barra ni se recuerda (028 C-2, C-5, D-7)
function showAppScreen(name) {
  if (name === 'recipes' && currentScreen !== 'recipes') resetRecipeFilters(); // 026 C-41, D-11
  currentScreen = name;
  $('screen-app').dataset.screen = name;
  $('app-title').textContent = SCREEN_TITLES[name];
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
  if (name === 'recipes') renderRecipes();
  if (name === 'settings') renderSettings();
  else rememberScreen(name); // 007 RF-46: la "pantalla abierta" (barra, carga o entrada)
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
// type (027 D-1): 'error' (rojo), 'info' (berenjena) o 'confirmation' (caballa, se va sola)
function showError(text, kind = 'action', type = 'error') {
  const notice = $('error-notice');
  $('error-notice-text').textContent = text;
  notice.classList.toggle('notice-info', type === 'info');
  notice.classList.toggle('notice-confirmation', type === 'confirmation');
  notice.hidden = false;
  state.noticeKind = kind;
  const id = ++state.noticeId;
  state.visibleNoticeId = id;
  const duration = noticeDuration(type);
  if (duration !== null) { // 027 C-1, C-3: solo quita su propio aviso
    setTimeout(() => { if (timerMayHide(id, state.visibleNoticeId)) hideError(); }, duration);
  }
}

// Aviso informativo (027 C-4): en berenjena y fijo hasta ✕ u otro aviso
function showInfo(text) {
  showError(text, 'action', 'info');
}

// Oculta el aviso (si se indica kind, solo cuando el aviso es de ese origen)
function hideError(kind) {
  if (kind && state.noticeKind !== kind) return;
  $('error-notice').hidden = true;
  state.noticeKind = null;
  state.visibleNoticeId = null;
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

// Id del usuario de la sesión guardada, o null (026 D-22); sin localStorage, null
function readStoredSessionUserId() {
  try {
    return storedSessionUserId(localStorage.getItem(authStorageKey(SUPABASE_URL)));
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
    currentUserId = session.user.id || readStoredSessionUserId(); // 026 D-22: en modo copia, la guardada
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
    loadListWithQueue(); // 007 RF-44: la lista se carga aunque se vea Comidas; 012 RF-9, RF-15, CL-5
    loadRecipes(); // 026 D-8: también aunque se vea otra pantalla
    scheduleCopySave(); // 011 RF-1
  } else if (!session) {
    sessionActive = false;
    currentUserId = null;
    if (state.copyMode) {
      // 011 CL-3: sale del modo copia; la copia guardada se queda en el dispositivo
      state.copyMode = false;
      copyState.copy = null;
      setOffline(false);
    }
    stopRetry(); // 011 RF-16: sin sesión no se reintenta
    stopQueueRetry(); // 012 RF-15 (D-8): la cola se queda en el dispositivo
    strikeQueueState.errorShown = false;
    clearTimeout(copyState.saveTimer);
    copyState.mealNames = null; // 014 D-8: se olvidan; la copia se conserva
    copyState.saveId++; // 011: descarta un guardado en curso de la sesión anterior
    onNewPassword = false;
    closeDialogs(); // CL-13: antes de quitar el canal, para anunciar el formulario cerrado
    unsubscribeChanges();
    state.meals.clear();
    state.moving = null; // 025: la respuesta de un movimiento en curso ya no se pinta
    listState = initialListState(listState.requestId + 1); // 007 RF-11: "Cargando…" al volver a entrar
    renderShopping();
    clearTimeout(recipeReloadTimer);
    recipeState = initialRecipeState(recipeState.requestId + 1); // 026 C-47: "Cargando…" al volver a entrar
    renderRecipes();
    renderTagSettings(); // 028 C-9
    hideError();
    closeMonthPanel(); // 006 CL-6
    closeUserMenu(); // 008 CL-3: abierto en una sección oculta, dejaría la página inerte
    showScreen('login');
  }
}

// CL-13: cierra la confirmación (askConfirm resuelve "no") y el formulario, sin guardar
function closeDialogs() {
  cancelDrag(); // 025 C-23
  const confirmDialog = $('confirm-dialog');
  if (confirmDialog.open) confirmDialog.close();
  closeRecipePicker(); // 030 C-39, D-16: antes que el formulario
  closeExists(); // 021 C-14
  closeRecover(); // 022 C-12
  closeArticleForm(); // 007 CL-8
  if ($('recipe-dialog').open) $('recipe-dialog').close(); // 026 C-37
  closeTagDialog(); // 028 C-37
  if (reviewState.open) closeReview(); // 009 CL-5
  searchState.query = ''; // 023 C-28, D-9: se olvida la búsqueda guardada
  closeSearch({ restoreFocus: false }); // 023 C-28: abierto en una sección oculta, dejaría la página inerte
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

// Recetas con sus estrellas embebidas, y los perfiles (nombres cortos e iniciales) (026 D-8)
function recipesQuery() {
  return client.from('recetas').select('*, estrellas(usuario, estrellas)');
}

function profilesQuery() {
  return client.from('perfiles').select('usuario, nombre_corto, inicial');
}

// Nombres de comidas para sugerir: un text[] de la base de datos (014 D-2, D-6)
function mealNamesQuery() {
  return client.rpc('nombres_ingredientes');
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
  const [meals, list, names, recipes, profiles] = await Promise.all([
    timedQuery(mealsQuery(from, to)), timedQuery(listQuery()), timedQuery(mealNamesQuery()),
    timedQuery(recipesQuery()), timedQuery(profilesQuery())]);
  if (id !== copyState.saveId || !sessionActive) return;
  const mealNames = names.error ? null : cleanMealNames(names.data);
  if (mealNames) {
    copyState.mealNames = mealNames; // 014 D-7: aunque fallen comidas o lista
    refreshOpenIngredientSuggestions(); // 014 C-17
  }
  if (meals.error || list.error) return; // CL-1: se queda la anterior, sin aviso
  // 014 C-21: sin nombres nuevos, los de memoria o los de la copia anterior, nunca []
  const keptNames = copyState.mealNames ?? cleanMealNames(readSavedCopy()?.mealNames) ?? undefined;
  // 026 D-9: sin recetas o perfiles nuevos, los de la copia anterior (si los tiene)
  const keptRecipes = recipes.error || profiles.error
    ? copyRecipes(readSavedCopy()) : { recipes: recipes.data, profiles: profiles.data };
  writeCopy(buildCopy({ savedAt, from, to, meals: meals.data, articles: list.data, mealNames: keptNames,
    recipes: keptRecipes?.recipes, profiles: keptRecipes?.profiles }));
}

// Nombres de comidas para sugerir (014 D-8): en modo copia, los de la copia en pantalla; fuera,
// los de la última carga buena o, si aún no hay, los de la copia guardada; sin nada, []
function suggestionMealNames() {
  if (state.copyMode) return copyMealNames(copyState.copy);
  return copyState.mealNames ?? copyMealNames(readSavedCopy());
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
  showError(withUnsentCount(copyNoticeText(copyState.copy.savedAt, getToday()), readStrikeQueue().length), 'copy'); // 012 RF-4
  scheduleSearchRecalc(); // 023 C-25
  loadMealsFromCopy();
  loadListFromCopy();
  loadRecipesFromCopy(); // 026 C-33
  setOffline(true);
  startRetry(); // RF-16
}

// Contador de la cola en el aviso del modo copia (012 RF-4, D-6); cerrado con ✕ o sustituido por
// otro aviso, no vuelve (RF-5). Sin copia el aviso es el 'offline' de 000-base RF-50 (CL-8)
function refreshCopyNotice() {
  if (!state.copyMode || state.noticeKind !== 'copy') return;
  $('error-notice-text').textContent =
    withUnsentCount(copyNoticeText(copyState.copy.savedAt, getToday()), readStrikeQueue().length);
}

// Lo enviado desde la otra pestaña, que lo pasó a la copia guardada (keepSentInCopy) (012 RF-7,
// RF-8). Misma copia (mismo savedAt): sus artículos. Más nueva: solo los cambios que estaban en
// la cola (previous) y que ella ya tiene ('done'); un conflicto no se toca hasta la carga (RF-14)
function refreshCopyArticles(previous) {
  const saved = readSavedCopy();
  if (!saved || !copyState.copy || saved.savedAt < copyState.copy.savedAt) return;
  let articles = saved.articles;
  if (saved.savedAt !== copyState.copy.savedAt) {
    const rows = new Map(saved.articles.map((item) => [item.id, item]));
    const sent = previous.filter((change) => queuedStrikeOutcome(change, rows.get(change.id) ?? null) === 'done');
    articles = applyStrikeQueue(copyState.copy.articles, sent).items;
  }
  copyState.copy = { ...copyState.copy, articles };
  listState.items = articles;
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

// Recetas y perfiles de la copia, con loaded en true: sin "Cargando…"; de una versión anterior,
// ninguna y el texto de C-33
function loadRecipesFromCopy() {
  const saved = copyRecipes(copyState.copy);
  recipeState.items = saved ? saved.recipes : [];
  recipeState.profiles = saved ? saved.profiles : [];
  recipeState.noCopy = !saved;
  recipeState.loaded = true;
  recipeState.tags = keptTags(recipeState.tags, recipeState.items); // C-51
  pickerState.tags = keptTags(pickerState.tags, recipeState.items); // 030: igual en la ventana
  renderRecipes();
  refreshDishLinks(); // 030 D-19
  refreshOpenRecipeSuggestions(); // 030 C-5
  renderTagSettings(); // 028 C-35, C-42, D-8
}

// Sin red, con o sin copia (009 D-14)
function setOffline(value) {
  if (state.offline === value) return;
  state.offline = value;
  if (value) cancelDrag(); // 025 C-23
  scheduleSearchRecalc(); // 023 C-25, D-11
  applyWriteControls(); // RF-10, CL-6
  renderShopping();
  renderTagSettings(); // 028 C-35: sin red, las etiquetas no abren el diálogo
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
    const sent = await sendStrikeQueue(); // 012 RF-9: antes de las cargas
    if (sent === 'noResponse') return; // 012 CL-6: sigue sin red; el reintento de la 011 sigue
    if (sent === 'sessionGone') { // 012 RF-16: inicio de sesión, la cola espera
      checkSessionAlive();
      return;
    }
    if (!sessionActive) return; // 'error' (RF-17) y 'busy' no cortan: Supabase responde
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
  scheduleSearchRecalc(); // 023 C-25
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
  loadRecipes(); // 026 D-8: las recetas de la copia se sustituyen con la carga
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
  loadRecipes(); // 026 D-8
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
  // 021 C-13: en el campo rápido se sigue escribiendo; solo [+] se desactiva
  for (const id of ['add-button', 'add-article-button', 'add-recipe-button', 'quick-add-button', 'article-delete']) {
    $(id).disabled = state.offline;
  }
  refreshExistsButtons(); // 021 C-13
  refreshRecoverButtons(); // 022 C-11
  $('article-save').disabled = state.offline || articleForm.saving;
  refreshRecipeSave(); // 026 C-22, C-34
  refreshTagButtons(); // 028 C-35
  $('finish-button').disabled = state.offline || listState.finishing || readStrikeQueue().length > 0; // 012 RF-20
  refreshMatch(); // "Guardar" del formulario de comida
  if (sessionActive) render(); // "Borrar" del detalle, "Añadir" del día, filas vacías de la semana
  if (sessionActive) renderRecipeDetail(recipeScreen); // 026 C-34: estrellas y "Borrar" de la receta
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

// ===== Recetas (026) =====

// Carga todas las recetas y los perfiles; solo vale la última respuesta (D-8). No cambia el estado
// de red de la app: un fallo solo muestra su aviso y lo ya cargado sigue (C-48); en modo copia,
// las de la copia
async function loadRecipes() {
  if (!sessionActive) return;
  const requestId = ++recipeState.requestId;
  if (state.copyMode) return loadRecipesFromCopy();
  const [recipes, profiles] = await Promise.all([timedQuery(recipesQuery()), timedQuery(profilesQuery())]);
  if (requestId !== recipeState.requestId || !sessionActive || state.copyMode) return;
  const failed = recipes.error ? recipes : profiles.error ? profiles : null;
  if (failed) {
    const text = recipeErrorMessage('load', failed.error, reachable(failed));
    showError(text, 'recipesLoad');
    showPickerNotice('load', text); // 030 C-45, D-8: dentro de la ventana, si está abierta
    return;
  }
  hideError('recipesLoad');
  hidePickerNotice('load'); // C-45: se quita con la siguiente carga buena
  recipeState.items = recipes.data;
  recipeState.profiles = profiles.data;
  recipeState.noCopy = false;
  recipeState.loaded = true;
  recipeState.tags = keptTags(recipeState.tags, recipeState.items); // C-51
  pickerState.tags = keptTags(pickerState.tags, recipeState.items); // 030: igual en la ventana
  // C-30, D-19: la abierta ya no está (y no es un borrado propio): a la lista, con aviso
  const gone = recipeState.openId && recipeState.openId !== recipeState.deletingId
    && !recipeState.items.some((r) => r.id === recipeState.openId);
  if (gone) {
    closeRecipe();
    showInfo(RECIPE_GONE_MESSAGE); // 027 C-4
  }
  renderRecipes();
  refreshDishLinks(); // 030 D-19
  refreshOpenRecipeSuggestions(); // 030 C-5
  if (gone && !WIDE_RECIPES.matches) window.scrollTo(0, recipeState.listScroll); // C-13
  refreshRecipeTagSuggestions(); // C-20: con las etiquetas usadas ahora
  renderTagSettings(); // 028 C-11, D-8
}

// Orden guardado en el navegador; sin poder leerlo, el de por defecto (C-41, D-11)
function readRecipeOrder() {
  try {
    return storedRecipeOrder(localStorage.getItem(RECIPE_ORDER_KEY));
  } catch {
    return storedRecipeOrder(null);
  }
}

// Búsqueda vacía, sin etiquetas, "Cualquiera" y el orden guardado (C-41); los campos, igual
function resetRecipeFilters() {
  Object.assign(recipeState, initialRecipeFilters(readRecipeOrder()));
  recipeState.openId = null; // al entrar desde otra pantalla, la lista (como al recargar, C-3)
  $('recipe-search').value = '';
  $('recipe-time').value = '';
  $('recipe-order').value = recipeState.order;
}

// Lo escrito y elegido en los filtros; cada cambio repinta la lista al momento (C-7 a C-11)
function onRecipeSearch() {
  recipeState.text = $('recipe-search').value;
  renderRecipes();
}

function onRecipeTime() {
  const value = $('recipe-time').value;
  recipeState.maxTime = value === '' ? null : Number(value);
  renderRecipes();
}

// El orden elegido se recuerda en el navegador; sin poder guardarlo, vale para esta visita (D-11)
function onRecipeOrder() {
  recipeState.order = storedRecipeOrder($('recipe-order').value);
  try {
    localStorage.setItem(RECIPE_ORDER_KEY, recipeState.order);
  } catch {
    // Sin localStorage, el orden no se recuerda
  }
  renderRecipes();
}

// Un nodo de la vista (030 D-7)
function viewNode(view, name) {
  return $(view.ids[name]);
}

// Marca o desmarca una etiqueta (C-8)
function toggleRecipeTag(view, tag) {
  const filters = view.state;
  const key = articleKey(tag);
  const marked = filters.tags.some((t) => articleKey(t) === key);
  filters.tags = marked ? filters.tags.filter((t) => articleKey(t) !== key) : [...filters.tags, tag];
  view.render();
}

// Pliega o despliega el filtro de etiquetas; se queda así hasta salir de Recetas (029 C-2, D-2)
function toggleRecipeTagsOpen(view) {
  view.state.tagsOpen = !view.state.tagsOpen;
  view.render();
}

// Pastillas de las etiquetas usadas, en orden alfabético (C-8): desplegado, todas; plegado,
// solo las marcadas (029 C-2 a C-6). El foco se queda en la pulsada o, si sale, en el botón
function renderRecipeTags(view) {
  const filters = view.state;
  const tags = usedTags(recipeState.items);
  const box = viewNode(view, 'tags');
  const focusedKey = box.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  box.replaceChildren();
  viewNode(view, 'tagsRow').hidden = tags.length === 0;
  const marked = new Set(filters.tags.map(articleKey));
  const open = filters.tagsOpen;
  const shown = open ? tags : tags.filter((tag) => marked.has(articleKey(tag)));
  const count = tags.filter((tag) => marked.has(articleKey(tag))).length;
  const toggle = viewNode(view, 'tagsToggle');
  toggle.textContent = `Etiquetas${count ? ` (${count})` : ''} ${open ? '▴' : '▾'}`;
  toggle.setAttribute('aria-expanded', String(open));
  box.hidden = shown.length === 0;
  if (focusedKey && !shown.some((tag) => articleKey(tag) === focusedKey)) toggle.focus();
  for (const tag of shown) {
    const key = articleKey(tag);
    const chip = button('recipe-tag', tag, () => toggleRecipeTag(view, tag));
    chip.dataset.key = key;
    chip.setAttribute('aria-pressed', String(marked.has(key)));
    box.append(chip);
    if (key === focusedKey) chip.focus();
  }
}

// Pinta la lista de recetas de una vista (C-4 a C-11, C-33, C-47); todo con textContent (I-9).
// No toca lo escrito ni lo elegido en los filtros (C-29)
function renderRecipeList(view) {
  const filters = view.state;
  viewNode(view, 'loading').hidden = recipeState.loaded;
  const list = viewNode(view, 'list');
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  list.replaceChildren();
  const any = recipeState.loaded && recipeState.items.length > 0;
  viewNode(view, 'filters').hidden = !any;
  const shown = any ? sortRecipes(filterRecipes(recipeState.items, filters), filters.order) : [];
  const empty = viewNode(view, 'empty');
  empty.hidden = !recipeState.loaded || shown.length > 0;
  if (any) empty.textContent = 'Ninguna receta coincide.'; // C-6
  else empty.textContent = recipeState.noCopy ? NO_COPY_RECIPES_TEXT : 'Todavía no hay recetas.';
  if (any) renderRecipeTags(view);
  for (const recipe of shown) {
    const line = recipeLine(recipe);
    const card = button('recipe-card', undefined, () => view.open(recipe.id));
    card.dataset.id = recipe.id;
    if (recipe.id === filters.openId) card.setAttribute('aria-current', 'true'); // C-14, C-50
    card.append(el('span', 'recipe-card-name', line.name), el('span', 'recipe-card-info', line.info));
    if (line.tags) card.append(el('span', 'recipe-card-tags', line.tags));
    const item = el('li');
    item.append(card);
    list.append(item);
    if (recipe.id === focusedId) card.focus({ preventScroll: true });
  }
}

// Pinta la pantalla Recetas: lista y detalle; y el buscador, si está abierto
function renderRecipes() {
  renderRecipeList(recipeScreen);
  renderRecipeDetail(recipeScreen);
  if ($('search-dialog').open) renderSearchRecipes(); // C-27, C-47: cargas y cambios del otro
  if ($('recipe-picker').open) renderPicker(); // 030 D-18: cada carga la repinta
}

// ----- Ventana "Recetas" del formulario de comida (030 C-11 a C-17, C-39, C-45; D-7, D-8) -----

// Pinta la lista, las etiquetas y el detalle de la ventana, y su aviso
function renderPicker() {
  renderRecipeList(recipePicker);
  renderRecipeDetail(recipePicker);
  const notice = $('picker-notice');
  notice.hidden = !pickerState.notice;
  notice.textContent = pickerState.notice?.text || '';
}

// Abre la ventana para un plato: búsqueda, etiquetas y tiempo vacíos, etiquetas plegadas y el
// último orden elegido en Recetas (C-12)
function openRecipePicker(dish) {
  const dialog = $('recipe-picker');
  if (dialog.open || !$('meal-dialog').open) return;
  pickerState = { ...initialPickerState(readRecipeOrder()), dish };
  $('picker-search').value = '';
  $('picker-time').value = '';
  $('picker-order').value = pickerState.order;
  renderPicker();
  dialog.showModal();
  dialog.scrollTop = 0;
}

// Cierra la ventana sin tocar el plato (C-16); sin abrir, nada
function closeRecipePicker() {
  if ($('recipe-picker').open) $('recipe-picker').close();
}

// Al cerrarse (✕, Esc o desde fuera): se olvidan el aviso y el plato, y el foco vuelve al botón
// "Recetas" del plato si el formulario sigue abierto (D-8, D-11)
function onRecipePickerClosed() {
  const dish = pickerState.dish;
  pickerState.dish = null;
  pickerState.notice = null;
  if (dish && sessionActive && $('meal-dialog').open) dish.recipesButton?.focus();
}

// Aviso dentro de la ventana, solo si está abierta (D-8)
function showPickerNotice(kind, text) {
  if (!$('recipe-picker').open) return;
  pickerState.notice = { kind, text };
  renderPicker();
}

// Quita el aviso de ese tipo, si es el que se ve
function hidePickerNotice(kind) {
  if (pickerState.notice?.kind !== kind) return;
  pickerState.notice = null;
  if ($('recipe-picker').open) renderPicker();
}

// Filtros de la ventana: como los de la pantalla Recetas, pero el orden no se guarda (C-13)
function onPickerSearch() {
  pickerState.text = $('picker-search').value;
  renderPicker();
}

function onPickerTime() {
  const value = $('picker-time').value;
  pickerState.maxTime = value === '' ? null : Number(value);
  renderPicker();
}

function onPickerOrder() {
  pickerState.order = storedRecipeOrder($('picker-order').value);
  renderPicker();
}

function setupRecipePicker() {
  $('picker-close').addEventListener('click', closeRecipePicker); // C-16
  $('recipe-picker').addEventListener('close', onRecipePickerClosed);
  $('picker-search').addEventListener('input', onPickerSearch);
  $('picker-tags-toggle').addEventListener('click', () => toggleRecipeTagsOpen(recipePicker));
  $('picker-time').addEventListener('change', onPickerTime);
  $('picker-order').addEventListener('change', onPickerOrder);
}

// La receta abierta en la vista, si sigue en las cargadas (o en la copia)
function openedRecipe(view) {
  return recipeState.items.find((r) => r.id === view.state.openId) || null;
}

// Abre el detalle (C-12). Por debajo de 1024 px sustituye a la lista: se guarda su posición y
// se sube arriba (C-13); en pc ancho, la lista se queda como está (C-14)
function openRecipe(id) {
  const wasList = !recipeState.openId;
  if (wasList && !WIDE_RECIPES.matches) recipeState.listScroll = window.scrollY;
  recipeState.openId = id;
  renderRecipes();
  if (!WIDE_RECIPES.matches) {
    window.scrollTo(0, 0);
    $('recipe-detail').querySelector('.recipe-back')?.focus();
  }
}

// Cierra el detalle sin repintar
function closeRecipe() {
  recipeState.openId = null;
}

// "‹ Recetas": vuelve a la lista con la misma búsqueda, filtros, orden y posición (C-13)
function backToRecipes() {
  const id = recipeState.openId;
  closeRecipe();
  renderRecipes();
  window.scrollTo(0, recipeState.listScroll);
  $('recipe-list').querySelector(`.recipe-card[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

// Pinta el detalle de la receta abierta en la vista (C-12); partes vacías ocultas; todo con
// textContent (I-9). En la pantalla, estrellas y "Borrar", desactivados sin red y mientras se
// puntúa (C-34, D-14); en la ventana (030 C-14, D-7), sin "Tus estrellas", "Editar" ni
// "Borrar", y con "Elegir"
function renderRecipeDetail(view) {
  const screen = view.mode === 'screen';
  const box = viewNode(view, 'detail');
  const focusedStar = box.contains(document.activeElement) ? document.activeElement.dataset.stars : null;
  box.replaceChildren();
  const recipe = openedRecipe(view);
  viewNode(view, 'root').classList.toggle('recipe-open', Boolean(recipe));
  if (!recipe) {
    if (screen && recipeState.loaded) box.append(el('p', 'recipe-detail-empty', 'Elige una receta para ver su detalle.'));
    return;
  }
  box.append(button('recipe-back', '‹ Recetas', view.back), el('h2', null, recipe.nombre));
  const facts = recipeFacts(recipe);
  if (facts) box.append(el('p', 'recipe-detail-facts', facts));
  if (recipe.etiquetas?.length) box.append(el('p', 'recipe-detail-tags', recipe.etiquetas.join(' · ')));
  const ratings = ratingsText(recipe, recipeState.profiles);
  if (ratings) box.append(el('p', 'recipe-detail-ratings', ratings));
  if (screen) box.append(buildMyStars(recipe));
  if (focusedStar) box.querySelector(`.recipe-star[data-stars="${focusedStar}"]`)?.focus();

  if (recipe.ingredientes?.length) {
    const list = el('ul');
    for (const ingredient of recipe.ingredientes) list.append(el('li', null, formatIngredient(ingredient)));
    box.append(el('p', 'detail-subtitle', 'Ingredientes'), list);
  }
  if (recipe.preparacion) box.append(el('p', 'detail-subtitle', 'Preparación'), el('p', 'detail-recipe', recipe.preparacion));
  if (recipe.notas) box.append(el('p', 'detail-subtitle', 'Notas o variaciones'), el('p', 'detail-recipe', recipe.notas));
  const link = safeLink(recipe.referencia);
  if (link) {
    const a = el('a', null, link);
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(el('p', 'detail-subtitle', 'Referencia'), a);
  }
  box.append(el('p', 'recipe-detail-author', 'Añadida por ' + recipe.autor_nombre)); // C-25
  const buttons = el('div', 'detail-buttons');
  if (screen) {
    const edit = button('btn', 'Editar', () => openRecipeForm(recipe));
    const remove = button('btn btn-danger', 'Borrar', () => deleteRecipe(recipe));
    edit.disabled = state.offline; // C-34
    remove.disabled = state.offline;
    buttons.append(edit, remove);
  } else {
    buttons.append(button('btn btn-primary', 'Elegir', () => view.choose(recipe))); // 030 C-14
  }
  box.append(buttons);
}

// "Tus estrellas": cinco botones; tocar la que ya tengo las quita (C-15); solo las mías (C-16)
function buildMyStars(recipe) {
  const mine = myStars(recipe, currentUserId);
  const row = el('div', 'recipe-my-stars');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Tus estrellas');
  row.append(el('span', 'recipe-my-stars-label', 'Tus estrellas:'));
  for (let n = 1; n <= 5; n++) {
    const star = button('recipe-star', n <= (mine || 0) ? '★' : '☆', () => rateRecipe(recipe, n));
    star.dataset.stars = String(n);
    star.setAttribute('aria-label', n === 1 ? '1 estrella' : `${n} estrellas`);
    star.setAttribute('aria-pressed', String(n === mine));
    star.disabled = state.offline || recipeState.rating; // C-34, D-14
    row.append(star);
  }
  return row;
}

// Guarda mis estrellas (o las quita) con puntuar_receta (C-15, D-6); sin respuesta en 8 s, el
// error de siempre (C-35, D-14). Si ya no existe, la carga lo dice (C-30)
async function rateRecipe(recipe, tapped) {
  if (state.offline || recipeState.rating) return;
  recipeState.rating = true;
  renderRecipeDetail(recipeScreen);
  const result = await timedQuery(client.rpc('puntuar_receta', {
    p_receta: recipe.id,
    p_estrellas: nextStars(myStars(recipe, currentUserId), tapped),
    p_inicial: userInitial($('user-menu-email').textContent),
  }));
  if (!sessionActive) return; // I-13
  if (result.error || recipeSaveOutcome(result.data) === 'error') {
    showError(recipeErrorMessage('rate', result.error, reachable(result)));
  } else {
    await loadRecipes();
  }
  recipeState.rating = false;
  renderRecipeDetail(recipeScreen);
}

// Borra la receta tras confirmar (C-24): sus estrellas, en cascada; si ya no estaba, sin error.
// Un borrado propio vuelve a la lista sin aviso (D-19)
async function deleteRecipe(recipe) {
  if (state.offline) return; // C-34
  if (!(await askConfirm(recipeDeleteText(recipe), 'Borrar'))) return;
  if (!sessionActive || state.offline) return;
  recipeState.deletingId = recipe.id;
  const result = await timedQuery(client.from('recetas').delete().eq('id', recipe.id));
  if (!sessionActive) return; // I-13
  if (result.error) {
    recipeState.deletingId = null;
    showError(recipeErrorMessage('delete', result.error, reachable(result)));
    return;
  }
  if (recipeState.openId === recipe.id) {
    closeRecipe();
    renderRecipes();
    window.scrollTo(0, recipeState.listScroll);
  }
  await loadRecipes();
  recipeState.deletingId = null;
}

// ----- Formulario de receta (026 C-17 a C-23, C-31, C-32, C-43; D-18) -----
// id y version: la receta que se edita (null al añadir); tags: sus etiquetas (pastillas);
// tagTyped: se ha escrito en "Etiquetas" desde que tiene el cursor; stars y starsTouched: "Tus
// estrellas", que solo se mandan si se tocaron (C-21, D-5); opened: sube con cada apertura;
// fromMeal: abierto con "Guardar como receta", termina en Comidas (C-44, C-49)
const recipeForm = {
  dish: null, id: null, version: null, tags: [], tagTyped: false,
  stars: null, starsTouched: false, saving: false, opened: 0, fromMeal: false,
};

// El plato de dish-template, sin leyenda, con "Tiempo (min)" tras "Personas" y "Notas o
// variaciones" tras "Preparación" (spec § Cómo se verá; D-18)
function buildRecipeDish() {
  const dish = buildFormDish($('recipe-form-dish'), { noLink: true }); // 030 D-10: sin marca
  dish.node.classList.add('recipe-dish');
  dish.nameLabel.textContent = 'Nombre de receta *';
  dish.recipe.previousElementSibling.textContent = 'Preparación';
  dish.persons.closest('.field').after($('recipe-form-time-field'));
  dish.recipe.closest('.field').after($('recipe-form-notes-field'));
  dish.time = $('recipe-form-time'); // markRecipeInvalid lo busca como 'time'
  return dish;
}

// "Guardar", desactivado sin red y mientras se guarda (C-22, C-34)
function refreshRecipeSave() {
  $('recipe-save').disabled = state.offline || recipeForm.saving;
}

function showRecipeFormError(text) {
  $('recipe-form-error').textContent = text;
  $('recipe-form-error').hidden = !text;
}

function clearRecipeMarks() {
  document.querySelectorAll('#recipe-form .invalid-field').forEach((n) => n.classList.remove('invalid-field'));
}

// Marca los campos que devuelve validateRecipeForm: { field } o { field, row } del único plato
function markRecipeInvalid(invalid) {
  const { dish } = recipeForm;
  for (const { field, row } of invalid) {
    const node = row !== undefined ? readRows(dish)[row][field] : dish[field];
    node.classList.add('invalid-field');
  }
}

// Rellena el formulario: vacío para añadir o con la receta guardada (C-17)
function fillRecipeForm(recipe = null) {
  recipeForm.id = recipe?.id ?? null;
  recipeForm.version = recipe?.version ?? null;
  recipeForm.tags = [...(recipe?.etiquetas ?? [])];
  recipeForm.stars = recipe ? myStars(recipe, currentUserId) : null;
  recipeForm.starsTouched = false;
  $('recipe-form-tag').value = '';
  recipeForm.tagTyped = false;
  closeRecipeTagSuggestions();
  showRecipeTagError('');
  renderRecipeFormTags();
  renderRecipeFormStars();
  $('recipe-form-title').textContent = recipe ? 'Editar receta' : 'Añadir receta';
  fillDish(recipeForm.dish, recipe && {
    nombre: recipe.nombre, personas: recipe.personas, ingredientes: recipe.ingredientes,
    receta: recipe.preparacion, referencia: recipe.referencia,
  });
  $('recipe-form-time').value = recipe?.tiempo ?? '';
  $('recipe-form-notes').value = recipe?.notas || '';
  clearRecipeMarks();
  showRecipeFormError('');
}

// "+ Añadir receta" (vacío), "Editar" (con lo guardado) (C-17) o "Guardar como receta" de un
// plato (dish: una copia de sus datos; la comida no cambia, C-26); sin red, nada (C-34, D-13)
function openRecipeForm(recipe = null, dish = null) {
  if (state.offline) return;
  fillRecipeForm(recipe);
  if (dish) {
    const data = recipeFromDish(dish);
    fillDish(recipeForm.dish, { ...data, receta: data.preparacion });
  }
  recipeForm.fromMeal = dish !== null;
  recipeForm.opened++;
  $('recipe-dialog').showModal();
}

// El formulario en bruto, para validateRecipeForm
function readRecipeForm() {
  return {
    ...readDish(recipeForm.dish),
    time: $('recipe-form-time').value,
    notes: $('recipe-form-notes').value,
    tags: recipeForm.tags,
  };
}

// Guarda con guardar_receta (D-5): válido y sin otra receta de nombre equivalente (C-23), se
// guarda, se espera a la carga y se abre su detalle (C-22, D-19). Los errores, dentro del
// formulario sin perder lo escrito (C-31, C-32, C-35, C-43)
async function saveRecipe(event) {
  event.preventDefault();
  if (state.offline || recipeForm.saving) return; // C-34
  showRecipeFormError('');
  clearRecipeMarks();
  const { data, error, invalid } = validateRecipeForm(readRecipeForm());
  if (error) {
    markRecipeInvalid(invalid);
    return showRecipeFormError(error);
  }
  // C-52: lo escrito en "Etiquetas" sin añadir entra como una más; la undécima no guarda
  if (!addRecipeTag($('recipe-form-tag').value)) {
    $('recipe-form-tag').classList.add('invalid-field');
    return $('recipe-form-tag').focus();
  }
  data.etiquetas = recipeForm.tags;
  const same = sameNameRecipe(recipeState.items, data.nombre, recipeForm.id);
  if (same) return askEditExisting(same);

  const opened = recipeForm.opened;
  recipeForm.saving = true;
  refreshRecipeSave();
  try {
    await sendRecipe(data, opened);
  } finally {
    // T11: también si se cerró la sesión durante la espera, para que "Guardar" vuelva a servir
    recipeForm.saving = false;
    refreshRecipeSave();
  }
}

// Envía el guardado y reparte el resultado (C-22, C-31, C-44, C-49)
async function sendRecipe(data, opened) {
  const result = await timedQuery(client.rpc('guardar_receta', {
    p_id: recipeForm.id,
    p_version: recipeForm.version,
    p_receta: data,
    p_estrellas_tocadas: recipeForm.starsTouched, // C-21, D-5: si no, no pisa las del detalle
    p_estrellas: recipeForm.stars,
    p_inicial: userInitial($('user-menu-email').textContent),
  }));
  if (!sessionActive) return; // I-13
  const outcome = result.error ? null : recipeSaveOutcome(result.data);
  if (outcome === 'saved' && recipeForm.fromMeal) {
    // C-44, C-49: se cierra y se sigue en Comidas como estaba, con el aviso
    if (opened === recipeForm.opened && $('recipe-dialog').open) {
      $('recipe-dialog').close();
      showError(recipeSavedText(data.nombre), 'action', 'confirmation'); // 027 C-1
    }
    loadRecipes();
  } else if (outcome === 'saved') {
    await loadRecipes(); // D-19: el detalle se abre con la receta ya cargada
    if (!sessionActive) return;
    if (opened === recipeForm.opened && $('recipe-dialog').open) {
      $('recipe-dialog').close();
      openRecipe(result.data.id);
    }
  } else if (opened === recipeForm.opened) {
    // Cambiada o borrada: se recarga, para que al volver a abrirla se vea como está (C-31)
    if (outcome === 'changed' || outcome === 'deleted') loadRecipes();
    if (outcome === 'changed') showRecipeFormError(RECIPE_CHANGED_MESSAGE);
    else if (outcome === 'deleted') showRecipeFormError(RECIPE_GONE_MESSAGE);
    else showRecipeFormError(result.error
      ? recipeErrorMessage('save', result.error, reachable(result), data.nombre)
      : recipeErrorMessage('save', new Error('Respuesta inesperada al guardar'), true));
  }
}

// ----- Etiquetas del formulario de receta (C-20, C-42, C-52) -----
// Cada etiqueta, una pastilla que se quita con un toque; como texto (I-9)
function renderRecipeFormTags() {
  const list = $('recipe-form-tags');
  list.replaceChildren(...recipeForm.tags.map((tag) => {
    const pill = button('recipe-tag recipe-form-tag', undefined, () => removeRecipeTag(tag));
    pill.append(el('span', null, tag), el('span', 'recipe-form-tag-x', '✕'));
    pill.setAttribute('aria-label', `Quitar la etiqueta ${tag}`);
    const item = el('li');
    item.append(pill);
    return item;
  }));
  list.hidden = recipeForm.tags.length === 0;
}

function showRecipeTagError(text) {
  $('recipe-tag-error').textContent = text;
  $('recipe-tag-error').hidden = !text;
}

// Añade lo escrito con la forma de una ya usada equivalente; vacía o repetida, no añade nada
// pero vacía el campo. false solo si sería la undécima: el aviso, y lo escrito se queda (C-42)
function addRecipeTag(text) {
  const { tags, error } = addTag(recipeForm.tags, text, usedTags(recipeState.items));
  showRecipeTagError(error || '');
  if (error) return false;
  if (!cleanTag(text)) return true;
  recipeForm.tags = tags;
  $('recipe-form-tag').value = '';
  recipeForm.tagTyped = false;
  closeRecipeTagSuggestions();
  renderRecipeFormTags();
  return true;
}

function removeRecipeTag(tag) {
  recipeForm.tags = recipeForm.tags.filter((t) => t !== tag);
  showRecipeTagError('');
  renderRecipeFormTags();
  $('recipe-form-tag').focus();
}

// Hasta 5 usadas que coinciden con lo escrito, sin las que ya tiene (C-20)
function renderRecipeTagSuggestions() {
  const list = $('recipe-tag-suggestions');
  const found = tagSuggestions(usedTags(recipeState.items), $('recipe-form-tag').value, recipeForm.tags);
  list.replaceChildren(...found.map((tag, index) => {
    const option = el('li', 'suggestion', tag);
    option.id = `recipe-tag-suggestion-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    return option;
  }));
  list.hidden = found.length === 0;
  $('recipe-form-tag').setAttribute('aria-expanded', String(!list.hidden));
  $('recipe-form-tag').removeAttribute('aria-activedescendant');
}

function recipeTagOptions() {
  return [...$('recipe-tag-suggestions').querySelectorAll('[role="option"]')];
}

function setRecipeTagMark(index) {
  const options = recipeTagOptions();
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  if (index < 0) return $('recipe-form-tag').removeAttribute('aria-activedescendant');
  $('recipe-form-tag').setAttribute('aria-activedescendant', options[index].id);
  options[index].scrollIntoView({ block: 'nearest' });
}

// Tras una carga, la lista abierta se recalcula con lo escrito; la marcada sigue si sigue
function refreshRecipeTagSuggestions() {
  if (!$('recipe-dialog').open || !recipeForm.tagTyped) return;
  const before = recipeTagOptions();
  const oldNames = before.map((option) => option.textContent);
  const oldIndex = markedIndex(before);
  renderRecipeTagSuggestions();
  setRecipeTagMark(keptMark(oldNames, oldIndex, recipeTagOptions().map((option) => option.textContent)));
}

function closeRecipeTagSuggestions() {
  $('recipe-tag-suggestions').hidden = true;
  $('recipe-tag-suggestions').replaceChildren();
  $('recipe-form-tag').setAttribute('aria-expanded', 'false');
  $('recipe-form-tag').removeAttribute('aria-activedescendant');
}

// La coma añade lo escrito antes de ella (también pegada o desde teclados que no avisan de la
// tecla); si no, sugerencias para lo escrito (C-20)
function onRecipeTagInput() {
  const input = $('recipe-form-tag');
  showRecipeTagError('');
  input.classList.remove('invalid-field');
  if (input.value.includes(',')) {
    const parts = input.value.split(',');
    const rest = parts.pop();
    const full = parts.find((part) => !addRecipeTag(part));
    if (full !== undefined) { // la undécima: se queda escrita, con el aviso (C-42)
      input.value = full.trim();
      return;
    }
    input.value = rest.trimStart();
  }
  recipeForm.tagTyped = true;
  renderRecipeTagSuggestions();
}

// ↑/↓ marcan, Esc solo cierra la lista; Intro elige la marcada o añade lo escrito. Con el
// campo vacío, Intro guarda, como en los demás campos. Componiendo, nada (C-20)
function onRecipeTagKeydown(event) {
  if (event.isComposing) return;
  const open = !$('recipe-tag-suggestions').hidden;
  if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    const options = recipeTagOptions();
    setRecipeTagMark(moveMark(markedIndex(options), options.length, event.key === 'ArrowDown' ? 'down' : 'up'));
  } else if (open && event.key === 'Escape') {
    event.preventDefault(); // anula el cierre del diálogo: la siguiente Esc sí lo cierra
    recipeForm.tagTyped = false;
    closeRecipeTagSuggestions();
  } else if (event.key === 'Enter') {
    const marked = $('recipe-tag-suggestions').querySelector('[aria-selected="true"]');
    const text = marked ? marked.textContent : $('recipe-form-tag').value;
    if (!cleanTag(text)) return;
    event.preventDefault();
    addRecipeTag(text);
  }
}

function setupRecipeTags() {
  const input = $('recipe-form-tag');
  const list = $('recipe-tag-suggestions');
  input.addEventListener('input', onRecipeTagInput);
  input.addEventListener('keydown', onRecipeTagKeydown);
  input.addEventListener('blur', () => {
    recipeForm.tagTyped = false;
    closeRecipeTagSuggestions();
  });
  list.addEventListener('mousedown', (event) => event.preventDefault()); // el foco no sale del campo
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) addRecipeTag(option.textContent);
  });
}

// ----- "Tus estrellas" del formulario (C-21): como en el detalle, pero solo se guardan con
// "Guardar"; tocar la que ya tengo las quita -----
function setupRecipeFormStars() {
  const row = $('recipe-form-stars');
  for (let n = 1; n <= 5; n++) {
    const star = button('recipe-star', '☆', () => {
      recipeForm.stars = nextStars(recipeForm.stars, n);
      recipeForm.starsTouched = true;
      renderRecipeFormStars();
    });
    star.dataset.stars = String(n);
    star.setAttribute('aria-label', n === 1 ? '1 estrella' : `${n} estrellas`);
    row.append(star);
  }
}

// Solo cambia textos y estado: el foco se queda en la estrella tocada
function renderRecipeFormStars() {
  $('recipe-form-stars').querySelectorAll('.recipe-star').forEach((star) => {
    const n = Number(star.dataset.stars);
    star.textContent = n <= (recipeForm.stars || 0) ? '★' : '☆';
    star.setAttribute('aria-pressed', String(n === recipeForm.stars));
  });
}

// C-23: "Cancelar" conserva lo escrito; "Editar la existente" la carga tal como está ahora
async function askEditExisting(same) {
  const opened = recipeForm.opened;
  const load = await askConfirm(recipeExistsText(same.nombre), 'Editar la existente');
  if (!load || !sessionActive || opened !== recipeForm.opened || !$('recipe-dialog').open) return;
  const current = recipeState.items.find((r) => r.id === same.id);
  if (current) fillRecipeForm(current);
  else showRecipeFormError(RECIPE_GONE_MESSAGE);
}

// Pinta la pantalla Compra con lo que hay en listState (RF-6 a RF-12); todo con textContent (RNF-6)
function renderShopping() {
  const loading = !listState.loaded;
  $('list-loading').hidden = !loading; // RF-11, D-13
  $('list-content').hidden = loading;
  renderSuggestions(); // cada recarga recalcula las sugerencias de lo escrito (RF-22, CL-16, CL-18)
  refreshOpenIngredientSuggestions(); // 014 C-17, C-19, C-22: también las del formulario
  refreshArticleSuggestions(); // 016 C-11
  if ($('search-dialog').open) renderSearchShopping(); // 023 C-20, C-34, D-12: también con "Cargando…"
  // 009 RF-33: hasta la primera carga correcta; v4.1: sin red, también en modo copia (D-14)
  $('ingredients-button').disabled = loading || state.offline;
  if (loading) return;

  // 012 RF-3, RF-7 (D-2): la cola se aplica solo al pintar; listState.items sigue siendo lo cargado
  const queue = readStrikeQueue();
  const { items, unsent } = applyStrikeQueue(listState.items, queue);
  const { pending, saved, pendingCount, savedCount, struckCount } = shoppingLists(items);

  $('pending-title').textContent = `Por comprar (${pendingCount})`;
  $('pending-list').replaceChildren(...pending.map((item) => buildPendingRow(item, unsent.has(item.id))));
  $('pending-empty').hidden = pending.length > 0; // RF-10
  $('finish-button').hidden = struckCount === 0; // RF-41
  $('finish-button').disabled = listState.finishing || state.offline || queue.length > 0; // 011 RF-10, 012 RF-20

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
  recover.addEventListener('click', () => openRecover(item)); // 022 C-1
  const remove = el('button', 'article-action', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Borrar «${item.nombre}»`);
  remove.disabled = state.offline; // 011 RF-10
  remove.addEventListener('click', () => deleteArticle(item, false)); // RF-31
  row.append(...articleNameParts(item), recover, remove);
  return row;
}

// Sugerencias de Guardados para lo escrito en el campo rápido (RF-21, RF-22); como texto (RNF-6).
// keepMark: tras una recarga, la marcada sigue si sigue en la lista; al escribir, ninguna (015 C-8, C-9).
// Cerrada con Esc, sigue cerrada hasta escribir o borrar (015 C-7, D-2)
function renderSuggestions(keepMark = true) {
  const before = quickOptions();
  const oldNames = before.map((pick) => pick.textContent);
  const oldIndex = keepMark ? quickMarkedIndex(before) : -1;
  const found = listState.quickClosed ? [] : suggestions(listState.items, $('quick-add-input').value);
  $('quick-suggestions').replaceChildren(...found.map((item) => {
    const li = el('li');
    const pick = button('suggestion', item.nombre, () => pickSuggestion(item)); // sin red también (021 C-13)
    li.append(pick);
    return li;
  }));
  $('quick-suggestions').hidden = found.length === 0;
  setQuickMark(keptMark(oldNames, oldIndex, found.map((item) => item.nombre))); // 015 D-3
}

function quickOptions() {
  return [...$('quick-suggestions').querySelectorAll('.suggestion')];
}

function quickMarkedIndex(options = quickOptions()) {
  return options.findIndex((pick) => pick.classList.contains('marked'));
}

// Marca la sugerencia index (-1: ninguna) y la deja a la vista (015 C-1, C-2)
function setQuickMark(index) {
  const options = quickOptions();
  options.forEach((pick, i) => pick.classList.toggle('marked', i === index));
  if (index >= 0) options[index].scrollIntoView({ block: 'nearest' });
}

// Escribir o borrar vuelve a abrir la lista, sin marcada (015 C-7, C-9)
function onQuickInput() {
  listState.quickClosed = false;
  renderSuggestions(false);
}

// ↑/↓ con sugerencias visibles marcan sin mover el cursor del campo y Esc cierra la lista sin
// tocar el texto; con un teclado de composición, nada nuestro. Intro lo resuelve el envío del
// formulario (015 C-1, C-2, C-6, C-11, C-12)
function onQuickKeydown(event) {
  if (event.isComposing || $('quick-suggestions').hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    listState.quickClosed = true;
    return renderSuggestions();
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const options = quickOptions();
  setQuickMark(moveMark(quickMarkedIndex(options), options.length, event.key === 'ArrowDown' ? 'down' : 'up'));
}

// Elegir una sugerencia no guarda nada: nombre guardado, cantidad y unidad guardadas solo si las
// dos estaban vacías, lista cerrada hasta escribir o borrar en el nombre y cursor en Cantidad.
// También sin red: solo rellena (021 C-6, C-13; como "Añadir artículo", 016 C-3, C-4)
function pickSuggestion(item) {
  const [input, quantity, unit] = quickFields();
  const fields = pickedAmountFields(item, quantity.value, unit.value);
  input.value = item.nombre;
  quantity.value = fields.quantity;
  unit.value = fields.unit;
  showQuickError('');
  listState.quickClosed = true;
  renderSuggestions();
  quantity.focus();
}

// Alta con anadir_articulo (RF-13, RF-19, RF-20, RF-39, CL-4); true si quedó añadido o recuperado.
// fromForm: los mensajes van dentro del formulario de artículo (llega en T9).
// askIfListed: si ya está en Por comprar, sin aviso y devuelve 'listed' (021 C-8)
async function addArticle({ nombre, cantidad, unidad }, fromForm = false, askIfListed = false) {
  const report = (text, type) => (fromForm ? showArticleFormError(text) : showError(text, 'action', type));
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
  if (outcome.kind === 'exists' && askIfListed && outcome.list === 'por_comprar') return 'listed';
  if (outcome.kind === 'exists') { // RF-19, CL-4, RF-45
    report(articleExistsMessage(outcome.name, outcome.list), 'info'); // 027 C-4
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

// Los tres campos del campo rápido: nombre, cantidad y unidad (021 C-4)
function quickFields() {
  return [$('quick-add-input'), $('quick-add-quantity'), $('quick-add-unit')];
}

function showQuickError(text) {
  $('quick-add-error').textContent = text;
  $('quick-add-error').hidden = !text;
}

// Intro o [+] en el campo rápido, con cantidad y unidad (RF-13, RF-16, CL-16, CL-17; 021 C-2 a C-5)
async function submitQuickAdd(event) {
  event.preventDefault();
  const marked = quickOptions()[quickMarkedIndex()];
  if (marked) return marked.click(); // 015 C-12, 021 C-6: con una marcada, la elige como al tocarla
  if (state.offline) return; // 011 RF-10, 021 C-13
  if (listState.quickPending) return; // CL-17: otro Intro o [+] mientras espera no hace nada
  const fields = quickFields();
  const [input, quantity, unit] = fields;
  if (!cleanIngredientName(input.value)) return; // RF-16, 021 C-5: sin mensaje
  const checked = validateArticleForm({ name: input.value, quantity: quantity.value, original: null, unit: unit.value });
  if (checked.error) return showQuickError(checked.error); // 021 C-5
  showQuickError('');
  const sent = fields.map((field) => field.value); // CL-16, 021 C-4: lo cambiado mientras espera no se borra
  listState.quickPending = true; // los campos siguen editables (CL-17)
  try {
    // 021 C-7: sin cantidad, el aviso de hoy; con ella, la ventana (C-8)
    const ok = await addArticle(checked.data, false, checked.data.cantidad !== null);
    if (!sessionActive) return;
    if (ok === 'listed') return await askExisting(checked.data);
    if (ok && fields.every((field, i) => field.value === sent[i])) clearQuickFields();
    renderSuggestions();
    input.focus();
  } finally {
    listState.quickPending = false;
  }
}

// Vacía los tres campos y deja el cursor en el nombre (021 C-4, C-9, C-10)
function clearQuickFields() {
  quickFields().forEach((field) => { field.value = ''; });
  showQuickError('');
  renderSuggestions();
  $('quick-add-input').focus();
}

// Ya en Por comprar con cantidad escrita: la ventana, con el artículo de la lista recargada (D-2)
async function askExisting(written) {
  const listError = await loadList();
  if (!sessionActive || listError) return; // el error de carga ya se ve; los campos se quedan
  const article = findEquivalent(listState.items, written.nombre);
  if (!article || article.lista !== 'por_comprar') return showInfo(ARTICLE_CHANGED_MESSAGE); // C-11, 027 C-4
  const choice = existingArticleChoice(article, written);
  Object.assign(existsState, { article, choice, saving: false });
  $('exists-text').textContent = choice.text;
  for (const [id, option] of [['exists-sum', choice.sum], ['exists-change', choice.change]]) {
    $(id).hidden = !option;
    $(id).textContent = option ? option.label : '';
  }
  refreshExistsButtons();
  $('exists-dialog').showModal(); // I-12: encima de todo
}

// Sin red o mientras guarda, "Sumar" y "Cambiar a" desactivados; "Dejar", solo mientras guarda (C-13)
function refreshExistsButtons() {
  $('exists-sum').disabled = state.offline || existsState.saving;
  $('exists-change').disabled = state.offline || existsState.saving;
  $('exists-keep').disabled = existsState.saving;
}

function closeExists() {
  existsState.article = null;
  existsState.choice = null;
  existsState.saving = false;
  if ($('exists-dialog').open) $('exists-dialog').close();
}

// "Dejar" o Esc: nada cambia, se vacían los campos (C-10); mientras guarda, Esc no cierra
function keepExisting() {
  if (existsState.saving) return;
  closeExists();
  clearQuickFields();
}

// "Sumar" o "Cambiar a": un solo cambio con su "antes"; si el otro lo ha cambiado, no se guarda (D-1, C-9, C-11, C-12)
async function applyExisting(option) {
  if (state.offline || existsState.saving || !option) return;
  const { article } = existsState;
  existsState.saving = true;
  refreshExistsButtons();
  const change = {
    accion: 'cambiar',
    id: article.id,
    antes: { lista: article.lista, cantidad: article.cantidad, unidad: article.unidad },
    cantidad: option.cantidad,
    unidad: option.unidad,
  };
  let result;
  try {
    result = await client.rpc('anadir_ingredientes', { p_cambios: [change] });
  } catch (error) {
    result = { error };
  }
  if (!sessionActive || !existsState.saving) return; // I-13: ya se cerró sin guardar
  closeExists();
  const outcome = result.data?.resultado;
  if (result.error) showError(articleErrorMessage('save', result.error, navigator.onLine)); // C-12
  else if (outcome === 'cambiado') showInfo(ARTICLE_CHANGED_MESSAGE); // C-11, 027 C-4
  else if (outcome !== 'hecho') showError(ARTICLE_UNEXPECTED_MESSAGE);
  else clearQuickFields(); // C-9
  loadList();
}

// Sustituye un artículo por el que devuelve el servidor y repinta (RF-37, D-9)
function replaceItem(row) {
  listState.items = listState.items.map((item) => (item.id === row.id ? row : item));
  renderShopping();
}

// ===== Ventana de ↺ en Guardados (022) =====
const RECOVER_FIELDS = { quantity: 'recover-quantity', unit: 'recover-unit' };

function showRecoverError(text) {
  $('recover-error').textContent = text;
  $('recover-error').hidden = !text;
  if (!text) document.querySelectorAll('#recover-form .invalid-field').forEach((n) => n.classList.remove('invalid-field'));
}

// Sin red o mientras guarda, "Añadir" desactivado; mientras guarda, también "Cancelar" (C-10, C-11)
function refreshRecoverButtons() {
  $('recover-add').disabled = state.offline || recoverState.saving;
  $('recover-cancel').disabled = recoverState.saving;
}

// Rellena con la cantidad y la unidad guardadas, sin guardar nada; foco en "Añadir" (C-1, C-2)
function openRecover(item) {
  if (state.offline) return; // 011 RF-10
  Object.assign(recoverState, { item, saving: false });
  $('recover-title').textContent = `Pasar «${item.nombre}» a Por comprar`; // I-9: como texto
  $('recover-quantity').value = item.cantidad !== null ? amountFieldText(item.cantidad) : ''; // 013 C-5
  $('recover-unit').value = item.unidad || '';
  showRecoverError('');
  refreshRecoverButtons();
  $('recover-dialog').showModal(); // I-12: encima de todo
  $('recover-add').focus(); // C-2: sin cursor en ningún campo
}

function closeRecover() {
  recoverState.item = null;
  recoverState.saving = false;
  if ($('recover-dialog').open) $('recover-dialog').close();
}

// "Cancelar" o Esc: sigue en Guardados (C-6); mientras guarda, no cierra (C-10)
function cancelRecover() {
  if (!recoverState.saving) closeRecover();
}

// "Añadir" o Intro: pasa a Por comprar con lo que se ve; solo si sigue en Guardados (C-3 a C-9, D-2, D-3)
async function submitRecover(event) {
  event.preventDefault();
  const { item } = recoverState;
  if (state.offline || recoverState.saving || !item) return; // C-10, C-11: también con Intro
  showRecoverError('');
  const checked = validateArticleForm({
    name: item.nombre, quantity: $('recover-quantity').value, original: item.cantidad, unit: $('recover-unit').value,
  });
  if (checked.error) { // C-5
    checked.invalid.forEach((field) => $(RECOVER_FIELDS[field])?.classList.add('invalid-field'));
    return showRecoverError(checked.error);
  }
  recoverState.saving = true;
  refreshRecoverButtons();
  const result = await timedQuery(client.from('articulos')
    .update({ lista: 'por_comprar', tachado: false, cantidad: checked.data.cantidad, unidad: checked.data.unidad })
    .eq('id', item.id).eq('lista', 'guardados')
    .select('id, nombre, cantidad, unidad, lista, tachado'));
  if (!sessionActive || recoverState.item !== item) return; // I-13: ya se cerró sin guardar
  recoverState.saving = false;
  refreshRecoverButtons();
  if (result.error) { // C-9: la ventana sigue abierta con lo escrito
    return showRecoverError(articleErrorMessage('save', result.error, reachable(result)));
  }
  closeRecover();
  if (result.data.length === 0) return missingOrMoved(item.id, ARTICLE_CHANGED_MESSAGE); // C-7, C-8
  replaceItem(result.data[0]);
}

// Intro en Unidad envía, como en Cantidad (C-3)
function onRecoverUnitKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  $('recover-form').requestSubmit();
}

function setupRecover() {
  $('recover-form').addEventListener('submit', submitRecover);
  $('recover-cancel').addEventListener('click', cancelRecover);
  $('recover-dialog').addEventListener('cancel', (event) => { event.preventDefault(); cancelRecover(); });
  $('recover-quantity').addEventListener('input', () => showRecoverError('')); // C-5, C-9
  $('recover-unit').addEventListener('change', () => showRecoverError(''));
  $('recover-unit').addEventListener('keydown', onRecoverUnitKeydown);
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
  refreshCopyNotice(); // RF-4
  return true;
}

// Quita el cambio de ese artículo, sin repintar; si no se puede guardar, el envío lo da por hecho (D-1)
function dropQueuedStrike(id) {
  try {
    writeStrikeQueue(removeQueuedStrike(readStrikeQueue(), id));
  } catch {
    // RF-10: el siguiente envío lo verá con el valor querido
  }
  refreshCopyNotice();
}

// Tachar falló sin red con la app fuera del modo copia: como el evento offline (012 RF-18)
function strikeWentOffline() {
  goOffline();
}

// ===== Envío de la cola (012 RF-9 a RF-14, RNF-1; D-3, D-4, D-5, D-7, D-9) =====
// getUser() con plazo de 8 s, con la forma de timedQuery (D-5)
async function userWithTimeout() {
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CONNECTION_TIMEOUT); });
  const result = await Promise.race([client.auth.getUser().catch((error) => ({ data: null, error })), clock]);
  clearTimeout(timer);
  if (result === null) return { data: null, error: { name: 'TimeoutError', message: 'Network timeout' }, timedOut: true };
  return { ...result, timedOut: false };
}

// → 'empty' | 'busy' | 'ok' | 'noResponse' | 'sessionGone' | 'error'. Una sola pestaña envía (RF-14)
async function sendStrikeQueue() {
  if (!sessionActive || readStrikeQueue().length === 0) return 'empty';
  if (strikeQueueState.sending) return 'busy';
  strikeQueueState.sending = true;
  let sent;
  try {
    if (navigator.locks) {
      sent = await navigator.locks.request('strike-queue', { ifAvailable: true },
        (lock) => (lock ? flushStrikeQueue() : 'busy'));
    } else {
      sent = await flushStrikeQueue(); // sin Web Locks: solo por http://IP (D-4, supuesto)
    }
  } finally {
    strikeQueueState.sending = false;
  }
  const pending = readStrikeQueue().length;
  if (needsQueueRetry(sent, pending)) startQueueRetry(); // D-8: queda cola → cada 30 s
  else if (pending === 0) stopQueueRetry();
  return sent;
}

// La carga de la lista de siempre, fuera del modo copia, con la cola enviada antes (RF-9, D-7)
async function loadListWithQueue() {
  if (!state.copyMode && !state.offline) {
    const sent = await sendStrikeQueue();
    if (sent === 'sessionGone') { // RF-16: inicio de sesión, la cola espera
      checkSessionAlive();
      return undefined;
    }
    // 'noResponse': la carga sigue y decide como hoy (modo copia o aviso) (D-7)
  }
  return loadList(); // si loadData ya entró en modo copia, pinta la copia (011 D-24)
}

// Reintento de la cola con red (RF-17, D-8): cada 30 s, solo en primer plano; no se reinicia
function startQueueRetry() {
  if (strikeQueueState.retryTimer || document.visibilityState !== 'visible') return;
  strikeQueueState.retryTimer = setInterval(queueRetryTick, 30000);
}

function stopQueueRetry() {
  clearInterval(strikeQueueState.retryTimer);
  strikeQueueState.retryTimer = null;
}

// Sin red reintenta la 011 (retryConnection)
function queueRetryTick() {
  if (readStrikeQueue().length === 0) { // D-8: la cola se vació sin envío (RF-19, otra pestaña)
    stopQueueRetry();
    return;
  }
  if (!sessionActive || state.offline || document.hidden) return;
  loadListWithQueue();
}

// Lee los artículos de la cola, decide cada cambio y envía los que siguen como se vieron, en orden
async function flushStrikeQueue() {
  const queue = readStrikeQueue(); // releída dentro del cerrojo: otra pestaña pudo vaciarla
  if (queue.length === 0) return 'empty';
  const startedAt = Date.now(); // presupuesto del envío: 8 s (D-7)
  const user = await userWithTimeout();
  let failure = strikeSendFailure(user, reachable(user));
  if (failure === 'noResponse' || failure === 'sessionGone') return failure; // RF-16: nada se envía
  if (failure) return finishSend([], failure, user.error);
  const read = await timedQuery(client.from('articulos').select('id, lista, tachado')
    .in('id', queue.map((change) => change.id)));
  failure = strikeSendFailure(read, reachable(read));
  if (failure) return finishSend([], failure, read.error);
  const rows = new Map(read.data.map((row) => [row.id, row]));
  const settled = [];
  let error = null;
  for (const change of queue) {
    const outcome = queuedStrikeOutcome(change, rows.get(change.id) ?? null);
    if (outcome !== 'apply') { // RF-10, RF-11
      settled.push({ change, result: outcome });
      continue;
    }
    if (!isStillQueued(readStrikeQueue(), change)) continue; // tocado durante el envío (D-9)
    // D-7: al menos un guardado por envío; lo demás, en el siguiente
    if (settled.some((s) => s.result === 'applied') && Date.now() - startedAt >= CONNECTION_TIMEOUT) break;
    const res = await timedQuery(client.from('articulos').update({ tachado: change.value })
      .eq('id', change.id).eq('lista', 'por_comprar').eq('tachado', change.from).select('id')); // RNF-1, D-3
    failure = strikeSendFailure(res, reachable(res));
    if (failure) { // CL-6, RF-17: lo demás sigue en cola
      error = res.error;
      break;
    }
    if (res.data.length === 0) continue; // cambió entre la lectura y el guardado: decide la siguiente vuelta
    settled.push({ change, result: 'applied' });
    if (!sessionActive) break;
  }
  return finishSend(settled, failure, error);
}

// Resuelve la cola releída con lo enviado (D-9), repinta y avisa de los conflictos (RF-12, RNF-5)
// y, una sola vez, del error de Supabase (RF-17)
function finishSend(settled, failure, error) {
  keepSentInCopy(settled); // antes que la cola: la otra pestaña lee la copia al recibir 'storage'
  try {
    writeStrikeQueue(settleStrikeQueue(readStrikeQueue(), settled));
  } catch {
    // RF-10: el siguiente envío lo dará por hecho
  }
  renderShopping(); // quita las marcas de lo enviado (RF-9)
  refreshCopyNotice();
  const names = settled.filter((s) => s.result === 'conflict').map((s) => s.change.name);
  if (names.length) showInfo(conflictNoticeText(names)); // otro aviso lo sustituye (CL-9); 027 C-4
  if (failure === 'error' && !strikeQueueState.errorShown) {
    showError(articleErrorMessage('save', error, true)); // RF-17: una vez, no en cada reintento
    strikeQueueState.errorShown = true;
  } else if (failure === null) {
    strikeQueueState.errorShown = false;
  }
  if (readStrikeQueue().length === 0) strikeQueueState.errorShown = false;
  if (settled.length && !state.copyMode) scheduleListReload(); // fuera del modo copia, la lista al día
  return failure ?? 'ok';
}

// Lo que ya tiene Supabase ('applied' o 'done') pasa a la copia guardada (con su savedAt) y, en
// modo copia, a la de memoria, para que al salir de la cola no vuelva a pintarse con el valor
// viejo, aquí ni en la otra pestaña en modo copia; los conflictos no (los pone al día la carga
// al salir del modo copia) (012 RF-7, RF-8, CL-6)
function keepSentInCopy(settled) {
  const sent = settled.filter((s) => s.result === 'applied' || s.result === 'done').map((s) => s.change);
  if (sent.length === 0) return;
  if (state.copyMode && copyState.copy) {
    copyState.copy = { ...copyState.copy, articles: applyStrikeQueue(copyState.copy.articles, sent).items };
    listState.items = applyStrikeQueue(listState.items, sent).items;
  }
  const saved = readSavedCopy();
  if (saved) writeCopy({ ...saved, articles: applyStrikeQueue(saved.articles, sent).items });
}

// "Terminar compra": pasa a Guardados los tachados de la base de datos, no los de la pantalla,
// en una sola sentencia (RF-25, RF-42, CL-5, CL-11)
async function finishShopping() {
  if (state.offline || listState.finishing || readStrikeQueue().length > 0) return; // 011 RF-10, 012 RF-20
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
  $('finish-button').disabled = state.offline || readStrikeQueue().length > 0; // 011 D-7, 012 RF-20
  if (error) {
    // RF-36, RF-37: la lista se queda como estaba; recargar sin red taparía este aviso con el de carga
    showError(articleErrorMessage('finish', error, navigator.onLine));
    return;
  }
  if (rows.length === 0) showInfo(NO_STRUCK_MESSAGE); // CL-11, 027 C-4
  loadList();
}

// El artículo no estaba como se esperaba: ¿lo han borrado (CL-2) o movido (CL-12, CL-14)?
// onAnswered: solo setStruck lo pasa, para quitar de la cola cuando la lectura respondió (007 D-25)
async function missingOrMoved(id, movedMessage, onAnswered) {
  const { data, error } = await client.from('articulos').select('id').eq('id', id);
  if (!sessionActive) return;
  if (error) {
    showError(articleErrorMessage('save', error, navigator.onLine)); // RF-36, RF-37: sin red no es CL-2
    return;
  }
  onAnswered?.();
  if (data.length === 0) return articleGone();
  if (movedMessage) showInfo(movedMessage); // CL-14, 027 C-4
  loadList();
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
  showInfo(ARTICLE_GONE_MESSAGE); // 027 C-4
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
  $('article-quantity').value = item && item.cantidad !== null ? amountFieldText(item.cantidad) : ''; // 013 C-5
  $('article-unit').value = (item && item.unidad) || '';
  articleForm.typedName = false;
  articleForm.picked = null;
  closeArticleSuggestions(); // 016 C-2: "Editar artículo" nunca tiene
  clearArticleMarks();
  showArticleFormError('');
  $('article-dialog').showModal();
}

// ===== Sugerencias en el nombre de "Añadir artículo" (016) =====
// Como las de ingrediente (D-3): el foco no sale del nombre; mousedown no lo quita y la
// elección va en click. Solo en "Añadir artículo" (C-2)
function onArticleNameInput() {
  if (articleForm.id) return;
  articleForm.typedName = true;
  renderArticleSuggestions(); // C-1, C-10: sin marcada
}

// Las de Guardados para lo escrito, como en el campo rápido (C-1); como texto (I-9)
function renderArticleSuggestions() {
  const list = $('article-suggestions');
  articleForm.found = suggestions(listState.items, $('article-name').value);
  list.replaceChildren(...articleForm.found.map((item, index) => {
    const option = el('li', 'suggestion', item.nombre);
    option.id = `article-suggestion-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    return option;
  }));
  list.hidden = articleForm.found.length === 0;
  $('article-name').setAttribute('aria-expanded', String(!list.hidden));
  $('article-name').removeAttribute('aria-activedescendant');
}

function articleOptions() {
  return [...$('article-suggestions').querySelectorAll('[role="option"]')];
}

// Marca la opción index (-1: ninguna) y la deja a la vista (C-6)
function setArticleMark(index) {
  const options = articleOptions();
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  if (index < 0) return $('article-name').removeAttribute('aria-activedescendant');
  $('article-name').setAttribute('aria-activedescendant', options[index].id);
  options[index].scrollIntoView({ block: 'nearest' });
}

// Cada carga recalcula la lista abierta sin tocar lo escrito; la marcada sigue si sigue (C-11).
// Cerrada (Esc o al salir del nombre), sigue cerrada hasta escribir o borrar
function refreshArticleSuggestions() {
  if (!$('article-dialog').open || articleForm.id || !articleForm.typedName) return;
  const before = articleOptions();
  const oldNames = before.map((option) => option.textContent);
  const oldIndex = markedIndex(before);
  renderArticleSuggestions();
  setArticleMark(keptMark(oldNames, oldIndex, articleForm.found.map((item) => item.nombre)));
}

function closeArticleSuggestions() {
  $('article-suggestions').hidden = true;
  $('article-suggestions').replaceChildren();
  articleForm.found = [];
  $('article-name').setAttribute('aria-expanded', 'false');
  $('article-name').removeAttribute('aria-activedescendant');
}

// Elegir: nombre guardado, cantidad y unidad guardadas solo si las dos estaban vacías, lista
// cerrada y cursor en Cantidad; no guarda nada: recupera Guardar (C-3, C-4, D-2)
function pickArticleSuggestion(item) {
  $('article-name').value = item.nombre;
  const fields = pickedAmountFields(item, $('article-quantity').value, $('article-unit').value);
  $('article-quantity').value = fields.quantity;
  $('article-unit').value = fields.unit;
  articleForm.picked = item;
  articleForm.typedName = false;
  closeArticleSuggestions();
  $('article-quantity').focus();
}

// Con la lista visible, ↑/↓ marcan y Esc solo la cierra (la siguiente Esc cierra el
// formulario); Intro lo resuelve el envío, también sin aviso de la tecla. Componiendo, nada (C-6, C-8, C-13)
function onArticleNameKeydown(event) {
  if (event.isComposing || $('article-suggestions').hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault(); // anula el cierre del diálogo
    articleForm.typedName = false; // cerrada a propósito: una carga no la reabre (C-11)
    return closeArticleSuggestions();
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const options = articleOptions();
  setArticleMark(moveMark(markedIndex(options), options.length, event.key === 'ArrowDown' ? 'down' : 'up'));
}

function setupArticleSuggestions() {
  const list = $('article-suggestions');
  $('article-name').addEventListener('input', onArticleNameInput);
  $('article-name').addEventListener('keydown', onArticleNameKeydown);
  $('article-name').addEventListener('blur', () => { // C-9, D-1
    articleForm.typedName = false;
    closeArticleSuggestions();
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) pickArticleSuggestion(articleForm.found[articleOptions().indexOf(option)]);
  });
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
  reviewState.typed = new Map(); // 017 C-9, C-12: otro periodo, campos vacíos y sin errores
  reviewState.typedErrorKeys = [];
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
  renderReviewButtons(view);
}

// "Añadir (n)", periodo y "Cancelar" según lo que se ve (RF-12, RF-17)
function renderReviewButtons(view) {
  $('ingredients-add').textContent = addButtonText(view.count);
  $('ingredients-add').disabled = view.addDisabled;
  for (const side of ['from', 'to']) { // RF-17: mientras se añade
    $(PERIOD_FIELDS[side].date).disabled = view.controlsDisabled;
    $(PERIOD_FIELDS[side].type).disabled = view.controlsDisabled;
  }
  $('ingredients-cancel').disabled = view.controlsDisabled;
}

// Vuelve a pintar las líneas conservando el desplazamiento y el foco de la casilla, la opción
// o el campo "Comprar", con el cursor donde estaba (017 C-10)
function renderReviewLines(view) {
  const list = $('ingredients-lines');
  const active = list.contains(document.activeElement) ? document.activeElement : null;
  const focus = active && {
    key: active.dataset.key, value: active.value, field: active.dataset.field,
    start: active.selectionStart, end: active.selectionEnd,
  };
  const scroll = list.scrollTop;
  list.replaceChildren(...view.lines.map((line, index) => reviewLineElement(line, index, view.controlsDisabled)));
  list.hidden = view.lines.length === 0;
  list.scrollTop = scroll;
  if (!focus) return;
  const again = [...list.querySelectorAll('input, select')].find((input) => input.dataset.key === focus.key
    && (focus.field ? input.dataset.field === focus.field : input.value === focus.value));
  if (!again || again.disabled) return;
  again.focus({ preventScroll: true });
  if (focus.field === 'text' && focus.start !== null) again.setSelectionRange(focus.start, focus.end);
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
  row.append(...reviewAmountElements(line, disabled)); // 017 C-1, C-7; 024 C-1: en todas las líneas
  if (line.status === 'saved') row.append(reviewText('review-meta', SAVED_LINE_TEXT));
  if (line.status !== 'listed') return row;
  row.append(reviewText('review-meta', lineOptions(line).listed));
  const group = reviewOptionsElement(line, index, disabled);
  if (group) row.append(group);
  return row;
}

// Opciones de una línea ya en la lista, con lo escrito en "Comprar" si es válido (017 C-4, C-5, D-3)
function reviewOptionsElement(line, index, disabled) {
  const choice = reviewState.choices.get(line.key);
  const options = lineOptions(typedLines([line], reviewState.typed)[0]);
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
  return group;
}

// "Comprar:" con su cantidad y unidad (como en "Añadir artículo"), lo escrito o, sin nada escrito,
// la calculada; si tiene error, el mensaje y, si las comidas piden otra cosa, el aviso
// (017 C-1, C-7, D-2; 024 C-1, C-8)
function reviewAmountElements(line, disabled) {
  const typed = reviewState.typed.get(line.key);
  const entry = typed ?? amountFill(line);
  const hasError = reviewState.typedErrorKeys.includes(line.key);
  const invalid = hasError ? typedAmount(entry).invalid : [];
  const box = document.createElement('div');
  box.className = 'review-amount';
  const quantity = document.createElement('input');
  quantity.type = 'text';
  quantity.maxLength = 10;
  quantity.autocomplete = 'off';
  quantity.setAttribute('autocapitalize', 'off');
  quantity.setAttribute('autocorrect', 'off');
  quantity.spellcheck = false;
  quantity.value = entry.text;
  quantity.setAttribute('aria-label', `Cantidad a comprar de ${line.nombre}`);
  const unit = $('article-unit').cloneNode(true); // mismas unidades que "Añadir artículo"
  unit.removeAttribute('id');
  unit.value = entry.unit;
  unit.setAttribute('aria-label', `Unidad a comprar de ${line.nombre}`);
  for (const [input, field] of [[quantity, 'text'], [unit, 'unit']]) {
    input.dataset.key = line.key;
    input.dataset.field = field;
    input.disabled = disabled; // C-13: solo mientras se añade
    input.classList.toggle('invalid-field', invalid.includes(field === 'text' ? 'quantity' : 'unit'));
  }
  box.append(reviewText('review-amount-label', 'Comprar:'), quantity, unit);
  const elements = [box];
  if (hasError) {
    const error = reviewText('review-error error-message', ARTICLE_QUANTITY_ERROR);
    error.setAttribute('role', 'alert');
    elements.push(error);
  }
  const notice = amountNotice(line, typed);
  if (notice) elements.push(reviewText('review-meta review-notice', notice)); // 024 C-8
  return elements;
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
  if (!input.dataset.key || input.dataset.field) return; // "Comprar" va por onReviewAmountInput

  if (input.type === 'checkbox') reviewState.choices.set(input.dataset.key, input.checked ? 'on' : 'off');
  else if (input.checked) reviewState.choices.set(input.dataset.key, input.value);
  renderReview();
}

// Escribir en "Comprar": guarda lo escrito (con lo que piden ahora las comidas), marca la casilla
// o deja "Dejar" y quita el error y el aviso de la línea; pinta solo esa línea sin sustituir el
// campo, para no perder el foco ni el teclado (017 C-5, C-6, C-9, D-1; 024 C-6, C-9, D-2)
function onReviewAmountInput(event) {
  const input = event.target;
  const key = input.dataset.key;
  if (!key || !input.dataset.field) return;
  const row = input.closest('.review-line');
  const line = reviewState.lines.find((l) => l.key === key);
  if (!line || !row) return;
  const entry = typedEntry(line,
    row.querySelector('[data-field="text"]').value, row.querySelector('[data-field="unit"]').value);
  reviewState.typed.set(key, entry);
  reviewState.choices.set(key, choiceAfterTyping(line, reviewState.choices.get(key), entry));
  reviewState.typedErrorKeys = reviewState.typedErrorKeys.filter((k) => k !== key);
  const view = reviewView({ ...reviewState, offline: state.offline });
  const box = row.querySelector('input[type="checkbox"]');
  if (box) box.checked = reviewState.choices.get(key) === 'on';
  row.querySelector('.review-error')?.remove();
  row.querySelector('.review-notice')?.remove(); // 024 C-9
  row.querySelectorAll('.review-amount .invalid-field').forEach((el) => el.classList.remove('invalid-field'));
  const oldGroup = row.querySelector('.review-options');
  if (line.status === 'listed') {
    const index = reviewState.lines.indexOf(line);
    const group = reviewOptionsElement(line, index, view.controlsDisabled);
    if (oldGroup) oldGroup.replaceWith(group);
    else row.append(group);
  }
  renderReviewButtons(view);
}

// Errores de "Comprar" al pulsar "Añadir (n)": los marca y lleva el cursor al primer campo que
// falla de la primera línea con error; true si hay alguno (017 C-7, C-9)
function showTypedErrors() {
  reviewState.typedErrorKeys = typedErrors(reviewState.lines, reviewState.choices, reviewState.typed);
  if (reviewState.typedErrorKeys.length === 0) return false;
  renderReview();
  const field = $('ingredients-lines').querySelector('.review-amount .invalid-field');
  if (field) field.focus();
  return true;
}

// "Añadir (n)": aplica lo elegido al pulsar entero o nada; si la otra persona ha cambiado la
// lista, la recarga y vuelve a decidir, hasta ADD_RETRIES veces (RF-13 a RF-17, RF-22, RF-26, D-2, RNF-3)
async function submitReview(event) {
  event.preventDefault();
  // RF-17: un solo envío; v4.1: sin red no hace nada (CL-8)
  if (reviewState.saving || reviewView({ ...reviewState, offline: state.offline }).addDisabled) return;
  reviewState.saveError = null; // RF-22: el mensaje se quita al pulsar
  if (showTypedErrors()) return; // 017 C-7: no se añade nada
  reviewState.saving = true;
  renderReview();
  const { choices } = reviewState; // lo elegido al pulsar
  const lines = typedLines(reviewState.lines, reviewState.typed); // 017 C-3, C-4: con lo escrito
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

// Valores en bruto del formulario, para validateArticleForm; original: la cantidad guardada del
// artículo que se edita (013-unidades-fracciones C-5, D-4)
function readArticleForm() {
  const source = articleForm.item || articleForm.picked; // 016: la guardada del elegido, exacta
  const original = source ? source.cantidad : null;
  return { name: $('article-name').value, quantity: $('article-quantity').value, original, unit: $('article-unit').value };
}

async function saveArticle(event) {
  event.preventDefault();
  const marked = articleOptions().findIndex((option) => option.getAttribute('aria-selected') === 'true');
  if (marked >= 0) return pickArticleSuggestion(articleForm.found[marked]); // 016 C-3, C-13: elige, no guarda
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

// Un cambio de recetas o estrellas las recarga y renueva la copia (026 C-29, D-8)
function onRecipesChange() {
  scheduleRecipeReload();
  scheduleCopySave();
}

function scheduleRecipeReload() {
  clearTimeout(recipeReloadTimer);
  recipeReloadTimer = setTimeout(loadRecipes, 300);
}

// ===== Sincronización en tiempo real =====
function subscribeChanges() {
  unsubscribeChanges();
  subscribeForms();
  channel = client.channel('meal-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comidas' }, onMealsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'articulos' }, onArticlesChange) // 007 RF-33 (D-4)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'recetas' }, onRecipesChange) // 026 C-29
    .on('postgres_changes', { event: '*', schema: 'public', table: 'estrellas' }, onRecipesChange)
    .subscribe((channelStatus) => {
      state.channelStatus = channelStatus; // 000-base CL-15
      const action = syncStatusAction(channelStatus, state.noticeKind, state.copyMode); // 011 RF-21
      if (action === 'recover') {
        hideError('sync');
        scheduleReload();
        scheduleListReload(); // 007 RF-35
        scheduleRecipeReload(); // 026 D-8
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

// ===== Configuración (028) =====

// Índice o Etiquetas, según settingsView (C-2, C-3)
function renderSettings() {
  $('settings-index').hidden = settingsView !== 'index';
  $('settings-tags').hidden = settingsView !== 'tags';
  renderTagSettings();
}

// Cambia entre el índice y Etiquetas, arriba de la página (C-3)
function showSettingsView(view) {
  settingsView = view;
  renderSettings();
  window.scrollTo(0, 0);
}

// Lista de etiquetas en uso desde las recetas cargadas (o las de la copia), sin consulta propia
// (C-7 a C-10, C-42, D-8); como texto (I-9). Sin red, las filas no se pueden pulsar (C-35)
function renderTagSettings() {
  const list = $('tag-list');
  const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const groups = recipeState.loaded ? tagGroups(recipeState.items) : [];
  $('tags-loading').hidden = recipeState.loaded; // C-9
  const empty = $('tags-empty');
  empty.hidden = !recipeState.loaded || groups.length > 0;
  empty.textContent = recipeState.noCopy ? NO_COPY_RECIPES_TEXT : TAGS_EMPTY_TEXT; // C-42, C-8
  list.replaceChildren(...groups.map((group) => {
    const row = button('settings-row', tagRowText(group), () => openTagDialog(group.key)); // C-13
    row.dataset.key = group.key;
    row.disabled = state.offline;
    const item = el('li');
    item.append(row);
    return item;
  }));
  if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  refreshTagDialog(); // C-11: el diálogo abierto, con el número al día
}

// Abre el diálogo de una etiqueta con su nombre en el campo (C-13); sin red, no (C-35)
function openTagDialog(key) {
  if (state.offline || tagDialogState.key) return;
  const group = tagGroups(recipeState.items).find((g) => g.key === key);
  if (!group) return;
  Object.assign(tagDialogState, {
    key, group, saving: false, pressedOutside: false, view: 'main', confirm: null, opened: tagDialogState.opened + 1,
  });
  $('tag-name').value = group.tag;
  showTagError('');
  showTagView('main');
  refreshTagDialog();
  $('tag-dialog').showModal(); // I-12: encima de todo
  $('tag-name').focus();
}

// Vista principal o confirmación (D-5); los errores de la otra vista se quitan
function showTagView(view) {
  tagDialogState.view = view;
  $('tag-main').hidden = view !== 'main';
  $('tag-merge').hidden = view !== 'merge';
  $('tag-confirm').hidden = view !== 'confirm';
  showTagError('');
}

// Título "etiqueta · n recetas" con las recetas cargadas ahora; si ya no la tiene ninguna, la
// última forma vista con "0 recetas" y el diálogo sigue abierto (C-11). Como texto (I-9)
function refreshTagDialog() {
  if (!tagDialogState.key) return;
  const groups = tagGroups(recipeState.items);
  const group = groups.find((g) => g.key === tagDialogState.key);
  tagDialogState.group = group || { ...tagDialogState.group, count: 0 };
  $('tag-title').textContent = tagRowText(tagDialogState.group);
  if (tagDialogState.view === 'merge') renderTagMerge(groups); // C-11, D-8
  const confirm = tagDialogState.confirm;
  if (confirm?.action === 'merge') {
    // C-11: la otra, con su forma al día; si ya no está, la última vista (C-32 avisa al pulsar)
    confirm.target = groups.find((g) => g.key === confirm.targetKey) || confirm.target;
    $('tag-confirm-text').textContent = tagMergeText(tagDialogState.group.tag, confirm.target.tag);
  } else if (confirm?.action === 'delete') {
    $('tag-confirm-text').textContent = tagDeleteText(tagDialogState.group); // C-11: el número al día
  }
  $('tag-merge-button').dataset.empty = String(mergeTargets(groups, tagDialogState.key).length === 0);
  refreshTagButtons();
}

// "Unir «etiqueta» con…" y las demás etiquetas en uso con su número (C-22); como texto (I-9).
// Sin red, las filas no se pueden pulsar (C-35)
function renderTagMerge(groups) {
  const list = $('tag-merge-list');
  const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  $('tag-merge-title').textContent = `Unir «${tagDialogState.group.tag}» con…`;
  list.replaceChildren(...mergeTargets(groups, tagDialogState.key).map((group) => {
    const row = button('settings-row', tagRowText(group), () => askTagMerge(group, 'merge')); // C-24
    row.dataset.key = group.key;
    row.disabled = state.offline || tagDialogState.saving;
    const item = el('li');
    item.append(row);
    return item;
  }));
  if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
}

// "Unir con…": pasa a la lista de las demás (C-22)
function showTagMerge() {
  if (tagDialogState.saving || state.offline) return;
  showTagView('merge');
  refreshTagDialog();
  ($('tag-merge-list').querySelector('button:not(:disabled)') || $('tag-merge-back')).focus();
}

// "‹ Volver": al diálogo con lo escrito (C-22)
function closeTagMerge() {
  if (tagDialogState.saving) return;
  showTagView('main');
  $('tag-merge-button').focus();
}

// Botones del diálogo: desactivados mientras guarda (C-28); las acciones, también sin red (C-35)
function refreshTagButtons() {
  const { saving } = tagDialogState;
  $('tag-cancel').disabled = saving;
  $('tag-confirm-cancel').disabled = saving;
  $('tag-rename').disabled = saving || state.offline;
  $('tag-merge-button').disabled = saving || state.offline || $('tag-merge-button').dataset.empty === 'true'; // C-23
  $('tag-delete').disabled = saving || state.offline;
  $('tag-merge-back').disabled = saving;
  for (const row of $('tag-merge-list').querySelectorAll('button')) row.disabled = saving || state.offline;
  $('tag-confirm-ok').disabled = saving || state.offline;
}

// Error dentro de la vista donde se pulsó (C-19, C-36)
function showTagError(text) {
  const id = tagDialogState.view === 'confirm' ? 'tag-confirm-error' : 'tag-error';
  for (const box of ['tag-error', 'tag-confirm-error']) {
    $(box).textContent = box === id ? text : '';
    $(box).hidden = box !== id || !text;
  }
}

// Cierra sin guardar; también al cerrarse la sesión (C-37)
function closeTagDialog() {
  Object.assign(tagDialogState, { key: null, group: null, saving: false, pressedOutside: false, confirm: null });
  if ($('tag-dialog').open) $('tag-dialog').close();
}

// "Cancelar", Esc o pulsar fuera: cierra sin cambiar nada; mientras guarda, nada (C-14, D-6)
function cancelTagDialog() {
  if (!tagDialogState.saving) closeTagDialog();
}

// Esc: en "Unir con…" o la confirmación, como su "‹ Volver" o "Cancelar"; en la vista
// principal, cierra (D-6)
function onTagDialogEscape(event) {
  event.preventDefault();
  if (tagDialogState.view === 'confirm') cancelTagConfirm();
  else if (tagDialogState.view === 'merge') closeTagMerge();
  else cancelTagDialog();
}

// "Cancelar" de la confirmación: vuelve a la vista de donde se vino, con lo escrito (C-21)
function cancelTagConfirm() {
  if (tagDialogState.saving) return;
  const back = tagDialogState.confirm?.back || 'main';
  tagDialogState.confirm = null;
  showTagView(back);
  refreshTagDialog();
  if (back === 'main') $('tag-name').focus();
  else ($('tag-merge-list').querySelector('button:not(:disabled)') || $('tag-merge-back')).focus();
}

// Pregunta si se une con target (el grupo de la otra) antes de hacerlo; "Cancelar" vuelve a
// back (C-21, C-24, D-5)
function askTagMerge(target, back) {
  if (tagDialogState.saving || state.offline) return;
  askTagConfirm({ action: 'merge', targetKey: target.key, target, back }, 'Unir');
}

// "Borrar": pregunta antes de quitarla de sus recetas (C-26)
function askTagDelete() {
  if (tagDialogState.saving || state.offline) return;
  askTagConfirm({ action: 'delete', back: 'main' }, 'Quitar');
}

function askTagConfirm(confirm, okText) {
  tagDialogState.confirm = confirm;
  $('tag-confirm-ok').textContent = okText;
  showTagView('confirm');
  refreshTagDialog();
  $('tag-confirm-cancel').focus();
}

// "Renombrar": según lo escrito, error, cerrar sin cambios, preguntar si se une o renombrar
// (C-16 a C-21, tagRenameAction)
function renameTag() {
  if (tagDialogState.saving || state.offline) return;
  const result = tagRenameAction(tagDialogState.group, $('tag-name').value, tagGroups(recipeState.items));
  if (result.action === 'error') {
    showTagError(result.error);
    return $('tag-name').focus();
  }
  if (result.action === 'none') return closeTagDialog();
  if (result.action === 'gone') { // C-31: sin llamar a la base de datos
    closeTagDialog();
    return showInfo(result.message);
  }
  if (result.action === 'merge') return askTagMerge(result.target, 'main');
  changeTag(result.name, false);
}

// "Unir" o "Quitar" de la confirmación (C-24, C-26)
function confirmTagChange() {
  const confirm = tagDialogState.confirm;
  if (confirm?.action === 'merge') changeTag(confirm.target.tag, true);
  else if (confirm?.action === 'delete') changeTag(null, false);
}

// Llama a cambiar_etiqueta con la forma que se ve (D-3): todo o nada, con los botones
// desactivados mientras guarda (C-28). Bien → se cierra, aviso y recetas al día (C-29, C-41,
// D-9); ya no existe → se cierra con el aviso (C-31, C-32); error o sin respuesta en 8 s →
// el error en la vista y se puede reintentar (C-36, D-10)
async function changeTag(newName, merge) {
  if (tagDialogState.saving || state.offline) return;
  const opened = tagDialogState.opened;
  const from = tagDialogState.group.tag;
  tagDialogState.saving = true;
  showTagError('');
  refreshTagButtons();
  const result = await timedQuery(client.rpc('cambiar_etiqueta', { p_etiqueta: from, p_nueva: newName, p_unir: merge }));
  if (!sessionActive || opened !== tagDialogState.opened || !tagDialogState.key) return; // I-13, D-6
  tagDialogState.saving = false;
  const outcome = result.error ? 'error' : tagChangeOutcome(result.data);
  if (outcome === 'error') {
    showTagError(result.error
      ? translateError(result.error, reachable(result))
      : translateError(new Error('Respuesta inesperada al cambiar la etiqueta'), true));
    return refreshTagButtons();
  }
  closeTagDialog();
  if (outcome === 'gone') showInfo(TAG_GONE_MESSAGE);
  else showError(tagDoneText(from, result.data), 'action', 'confirmation');
  await loadRecipes();
  if (sessionActive) scheduleCopySave();
}

// Pulsación que empieza y acaba fuera del diálogo (C-14)
function onTagDialogClick(event) {
  if (tagDialogState.pressedOutside && isOutsideDialog($('tag-dialog'), event)) cancelTagDialog();
  tagDialogState.pressedOutside = false;
}

function setupTagDialog() {
  $('tag-cancel').addEventListener('click', cancelTagDialog);
  $('tag-rename').addEventListener('click', renameTag);
  // Intro en "Nombre" hace lo de "Renombrar"
  $('tag-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (!$('tag-rename').disabled) renameTag();
    }
  });
  $('tag-merge-button').addEventListener('click', showTagMerge);
  $('tag-delete').addEventListener('click', askTagDelete);
  $('tag-merge-back').addEventListener('click', closeTagMerge);
  $('tag-confirm-cancel').addEventListener('click', cancelTagConfirm);
  $('tag-confirm-ok').addEventListener('click', confirmTagChange);
  $('tag-dialog').addEventListener('cancel', onTagDialogEscape);
  $('tag-dialog').addEventListener('pointerdown', (event) => {
    tagDialogState.pressedOutside = isOutsideDialog($('tag-dialog'), event);
  });
  $('tag-dialog').addEventListener('click', onTagDialogClick);
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

// "Configuración" del menú: cierra el menú y abre el índice (028 C-2, D-7)
function openSettingsFromMenu() {
  closeUserMenu();
  settingsView = 'index';
  showAppScreen('settings');
}

// "Cerrar sesión" del menú: sin confirmación, como el botón de antes (RF-8)
function logOutFromMenu() {
  closeUserMenu();
  logOut();
}

// ===== Buscador (023) =====
// Búsqueda guardada, solo en memoria: se pierde al recargar y se borra al cerrar sesión
// (C-4, C-5, D-9)
// focusId: artículo cuyo "Editar artículo" o ↺ se abrió desde un resultado (D-16)
const searchState = { query: '', restoreFocus: true, focusId: null };

// Modal: lo de debajo queda inerte y no cambia (C-2, C-3, D-7). El campo trae la búsqueda
// guardada, seleccionada (C-4), y la franja de aviso pasa dentro, bajo el campo (C-31, D-8)
function openSearch() {
  const input = $('search-input');
  input.value = searchState.query;
  $('search-dialog').insertBefore($('error-notice'), $('search-results'));
  $('search-dialog').showModal();
  $('search-button').setAttribute('aria-expanded', 'true');
  input.focus();
  input.select();
  renderSearch();
}

// restoreFocus: false al ir a una comida, que deja el foco en la página (D-10)
function closeSearch({ restoreFocus = true } = {}) {
  if (!$('search-dialog').open) return;
  searchState.restoreFocus = restoreFocus;
  $('search-dialog').close();
}

// Evento close: llega con ✕, Esc, una comida o closeDialogs. La franja vuelve a su sitio con
// el mismo texto y el foco, a 🔍 (C-3, C-31, D-8)
function onSearchClosed() {
  $('loading-indicator').before($('error-notice'));
  $('search-button').setAttribute('aria-expanded', 'false');
  cancelMealSearch(); // D-6
  if (searchState.restoreFocus) $('search-button').focus({ preventScroll: true });
  else if (document.activeElement === $('search-button')) $('search-button').blur(); // D-10: el navegador lo devuelve solo
  searchState.restoreFocus = true;
}

function onSearchInput() {
  searchState.query = $('search-input').value;
  renderSearch({ wait: true });
}

// Grupos de resultados; nada mientras el campo está vacío o solo con espacios (C-7). Compra al
// momento; Comidas, al abrir sin esperar y al escribir 300 ms tras la última tecla (D-6)
function renderSearch({ wait = false } = {}) {
  renderSearchShopping();
  searchMeals(wait);
  renderSearchRecipes();
}

// Grupo Compra con los artículos tal como se pintan en la lista, cola de tachados incluida;
// "Buscando…" hasta la primera carga (C-10, C-11, C-34, D-12). Lo llama también
// renderShopping, así llegan los cambios del otro, los guardados y la red (C-17, C-18, C-20, C-24)
function renderSearchShopping() {
  const group = $('search-shopping');
  const list = $('search-shopping-list');
  group.hidden = searchKey(searchState.query) === '';
  if (group.hidden) {
    list.replaceChildren();
    return;
  }
  const kept = focusedResult(list);
  let found = [];
  let text = SEARCH_LOADING_TEXT;
  if (listState.loaded) {
    const { items } = applyStrikeQueue(listState.items, readStrikeQueue());
    found = shoppingResults(items, searchState.query);
    text = found.length > 0 ? '' : SEARCH_NO_ARTICLES_TEXT;
  }
  list.replaceChildren(...found.map(buildSearchArticle));
  $('search-shopping-state').textContent = text;
  $('search-shopping-state').hidden = !text;
  if (kept) focusSearchArticle(kept.id, kept.className);
}

// Resultado: [nombre cantidad] [lista] [↺ solo en Guardados]; como texto (C-10, C-30)
function buildSearchArticle(item) {
  const saved = item.lista === 'guardados';
  const row = el('li', 'search-article');
  row.dataset.id = String(item.id);
  row.classList.toggle('struck', !saved && item.tachado);
  if (saved) row.classList.add('saved-row');
  const open = button('search-article-open', undefined, () => openFromSearch(item, openArticleForm)); // C-17
  open.append(el('span', 'search-article-name', item.nombre));
  const quantity = formatQuantity(item.cantidad, item.unidad);
  if (quantity) open.append(' ', el('span', 'search-article-quantity', quantity));
  row.append(open, el('span', 'search-article-list', saved ? 'Guardados' : 'Por comprar'));
  if (saved) {
    const recover = button('article-action search-article-recover', '↺', () => openFromSearch(item, openRecover)); // C-18
    recover.setAttribute('aria-label', `Pasar «${item.nombre}» a Por comprar`);
    recover.disabled = state.offline; // C-24, I-6
    row.append(recover);
  }
  return row;
}

// "Editar artículo" o la ventana de ↺, encima del buscador, sin cambiar nada de ellas (C-17, C-18)
function openFromSearch(item, open) {
  searchState.focusId = String(item.id);
  open(item);
}

// Artículo y botón con el foco dentro de los resultados, para no perderlo al repintar (D-16)
function focusedResult(list) {
  const active = document.activeElement;
  const row = list.contains(active) ? active.closest('.search-article') : null;
  return row ? { id: row.dataset.id, className: active.className } : null;
}

// Foco en ese botón del artículo, o en su nombre (↺ ya no está), o en el campo si ya no sale (D-16)
function focusSearchArticle(id, className = '') {
  const row = [...$('search-shopping-list').children].find((node) => node.dataset.id === id);
  const target = row && ([...row.querySelectorAll('button')].find((node) => node.className === className && !node.disabled)
    || row.querySelector('.search-article-open'));
  (target || $('search-input')).focus();
}

// ===== Grupo Comidas del buscador (023 C-12 a C-16, C-26; D-4 a D-6) =====
// requestId: número de la última petición; la que llega con otro se descarta (C-16, D-6).
// typed y today: los de la primera página, que "Ver más" repite (D-5). received: filas
// recibidas, de las que sale p_desde (D-4)
// local: sin red con copia, se busca en sus 7 semanas hasta "limit" resultados (C-23, D-11)
const mealSearch = {
  requestId: 0, timer: null, typed: '', today: '', results: [], received: 0, more: false,
  loading: false, loadingMore: false, error: '', moreError: '', local: false, limit: 0,
  recalcPending: false,
};
const MEAL_SEARCH_DELAY = 300; // ms tras la última tecla (D-6)

// Anula la petición en curso y la que espera: al escribir, vaciar, cerrar y cerrar sesión (D-6)
function cancelMealSearch() {
  mealSearch.requestId++;
  clearTimeout(mealSearch.timer);
  mealSearch.timer = null;
}

// Nueva búsqueda desde la primera página; "Buscando…" al momento (C-14)
function searchMeals(wait) {
  cancelMealSearch();
  Object.assign(mealSearch, {
    typed: searchState.query, today: toISODate(getToday()), results: [], received: 0, more: false,
    loading: searchKey(searchState.query) !== '', loadingMore: false, error: '', moreError: '',
    local: state.copyMode && copyState.copy !== null, limit: SEARCH_PAGE_SIZE,
  });
  if (mealSearch.local) return searchCopyMeals(); // C-23: sin esperar ni "Buscando…"
  renderSearchMeals();
  if (!mealSearch.loading) return;
  const id = mealSearch.requestId;
  if (wait) mealSearch.timer = setTimeout(() => requestMeals(id), MEAL_SEARCH_DELAY);
  else requestMeals(id);
}

// "Ver más": la página siguiente con el mismo texto y el mismo "hoy" (C-13, D-5)
function loadMoreMeals() {
  if (mealSearch.loading || mealSearch.loadingMore || !mealSearch.more) return;
  if (mealSearch.local) { // C-23: 20 más de la copia
    const focusFrom = $('search-meals-list').children.length;
    mealSearch.limit += SEARCH_PAGE_SIZE;
    return searchCopyMeals(focusFrom);
  }
  cancelMealSearch();
  Object.assign(mealSearch, { loadingMore: true, moreError: '' });
  renderSearchMeals();
  requestMeals(mealSearch.requestId);
}

// Pide 21 filas para saber si hay más (D-1); las que llegan se vuelven a pasar por mealResult
// y una que la app no ve coincidir no se pinta (D-4). Error o 8 s sin respuesta: C-26
async function requestMeals(id) {
  const from = mealSearch.received;
  const result = await timedQuery(client.rpc('buscar_comidas', {
    p_texto: mealSearch.typed, p_hoy: mealSearch.today, p_desde: from, p_cuantas: SEARCH_PAGE_SIZE + 1,
  }));
  if (id !== mealSearch.requestId || !sessionActive) return; // C-16
  const more = mealSearch.loadingMore;
  Object.assign(mealSearch, { loading: false, loadingMore: false });
  if (result.error) {
    if (isNetworkError(result.error, reachable(result))) { // C-35: como al fallar una carga
      goOffline();
      if (state.copyMode) return; // el recálculo de C-25 pinta la copia
      mealSearch.recalcPending = false; // sin copia: el error, sin volver a pedir
    }
    const text = searchErrorMessage(result.error, reachable(result));
    if (more) mealSearch.moreError = text;
    else mealSearch.error = text;
    return renderSearchMeals();
  }
  const rows = result.data || [];
  const page = rows.slice(0, SEARCH_PAGE_SIZE);
  mealSearch.received = from + page.length;
  mealSearch.more = rows.length > SEARCH_PAGE_SIZE;
  const seen = new Set(mealSearch.results.map((found) => found.id));
  for (const meal of page) {
    if (seen.has(meal.id)) continue; // D-5: no se repite
    const found = mealResult(meal, mealSearch.typed);
    if (found) mealSearch.results.push(found);
    else console.warn('buscar_comidas devuelve una comida que la app no ve coincidir:', meal.id); // D-4
  }
  renderSearchMeals({ focusFrom: more ? $('search-meals-list').children.length : -1 });
}

// Comidas de la copia hasta mealSearch.limit (C-23, D-11)
function searchCopyMeals(focusFrom = -1) {
  const { results, more } = localMealResults(copyState.copy.meals, mealSearch.typed, mealSearch.today, mealSearch.limit);
  Object.assign(mealSearch, { results, more, loading: false });
  renderSearchMeals({ focusFrom });
}

// Al perder o recuperar la red, o entrar o salir del modo copia, con el buscador abierto: Comidas
// otra vez desde los 20 primeros (C-25, D-11). Una sola vez aunque cambien varias cosas seguidas
// (goOffline: setOffline y enterCopyMode), para no pedir a Supabase lo que la copia ya tiene
function scheduleSearchRecalc() {
  if (mealSearch.recalcPending) return;
  mealSearch.recalcPending = true;
  queueMicrotask(() => {
    if (!mealSearch.recalcPending) return;
    mealSearch.recalcPending = false;
    if ($('search-dialog').open) searchMeals(false);
  });
}

// Pinta el grupo Comidas con mealSearch; como texto (C-12, C-30). focusFrom: tras "Ver más",
// si el botón tenía el foco y ya no está, pasa al primer resultado nuevo
function renderSearchMeals({ focusFrom = -1 } = {}) {
  const { results, loading, loadingMore, error, moreError, more } = mealSearch;
  $('search-meals').hidden = searchKey(mealSearch.typed) === ''; // C-7, C-9
  $('search-meals-offline').textContent = mealSearch.local ? SEARCH_OFFLINE_TEXT : ''; // C-23, C-33
  $('search-meals-offline').hidden = !mealSearch.local;
  const list = $('search-meals-list');
  list.replaceChildren(...(loading || error ? [] : results.map(buildSearchMeal)));
  let text = '';
  if (loading) text = SEARCH_LOADING_TEXT; // C-14
  else if (error) text = error; // C-26
  else if (results.length === 0 && !more) text = SEARCH_NO_MEALS_TEXT; // C-15
  $('search-meals-state').textContent = text;
  $('search-meals-state').hidden = !text;
  $('search-meals-state').classList.toggle('search-error', !!error);
  const moreButton = $('search-more');
  const hadFocus = document.activeElement === moreButton;
  moreButton.hidden = loading || !!error || !more; // C-13
  moreButton.disabled = loadingMore;
  $('search-more-error').textContent = moreError; // C-26: bajo los ya vistos, que se quedan
  $('search-more-error').hidden = !moreError;
  if (hadFocus && moreButton.hidden) (list.children[focusFrom]?.querySelector('button') || $('search-input')).focus();
}

// Resultado: platos que coinciden, fecha y tipo, y el motivo si lo hay (C-12)
function buildSearchMeal(found) {
  const row = el('li', 'search-meal');
  const open = button('search-meal-open', undefined, () => openMealFromSearch(found)); // C-19
  open.append(el('span', 'search-meal-names', found.names), el('span', 'search-meal-date', found.dateLine));
  if (found.reason) open.append(el('span', 'search-meal-reason', found.reason));
  row.append(open);
  return row;
}

// Cierra el buscador, pasa a Comidas si hacía falta y abre la vista Día con la comida
// desplegada, que vuelve a cargar el día (C-19, C-22, D-10)
function openMealFromSearch(found) {
  closeSearch({ restoreFocus: false });
  if (currentScreen !== 'meals') showAppScreen('meals');
  openDay(fromISODate(found.fecha), found.tipo);
}

// ===== Grupo Recetas del buscador (026 C-27, C-28, C-45, C-47) =====
// Con las recetas cargadas (o las de la copia, C-45); "Buscando…" hasta la primera carga
// (C-47). Lo llama también renderRecipes, así llegan las cargas y los cambios del otro
function renderSearchRecipes() {
  const group = $('search-recipes');
  const list = $('search-recipes-list');
  group.hidden = searchKey(searchState.query) === '';
  if (group.hidden) {
    list.replaceChildren();
    return;
  }
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const found = recipeState.loaded ? recipeSearchResults(recipeState.items, searchState.query) : [];
  let text = '';
  if (!recipeState.loaded) text = SEARCH_LOADING_TEXT;
  else if (found.length === 0) text = SEARCH_NO_RECIPES_TEXT;
  list.replaceChildren(...found.map(buildSearchRecipe));
  $('search-recipes-state').textContent = text;
  $('search-recipes-state').hidden = !text;
  if (focusedId) {
    const again = list.querySelector(`.search-meal-open[data-id="${CSS.escape(focusedId)}"]`);
    (again || $('search-input')).focus();
  }
}

// Resultado: nombre y, si no coincide por él, "Ingrediente: …" o "Etiqueta: …"; como texto (C-27)
function buildSearchRecipe(found) {
  const row = el('li', 'search-meal search-recipe');
  const open = button('search-meal-open', undefined, () => openRecipeFromSearch(found.id)); // C-28
  open.dataset.id = found.id;
  open.append(el('span', 'search-meal-names', found.name));
  if (found.reason) open.append(el('span', 'search-meal-reason', found.reason));
  row.append(open);
  return row;
}

// Cierra el buscador, va a Recetas y abre su detalle (C-28). Desde otra pantalla, la lista
// empieza sin búsqueda ni filtros (C-41); ya en Recetas, se quedan como estaban (C-50)
function openRecipeFromSearch(id) {
  closeSearch({ restoreFocus: false });
  if (currentScreen !== 'recipes') showAppScreen('recipes');
  openRecipe(id);
}

// Al cerrarse "Editar artículo" o ↺ abiertos desde un resultado, el foco vuelve a él (D-16)
function onSearchChildClosed() {
  const id = searchState.focusId;
  searchState.focusId = null;
  if (id !== null && $('search-dialog').open) focusSearchArticle(id);
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
  if (isRenderHeld()) { // 025 C-22, D-9: se pinta al soltar, cancelar o tras el clic del toque
    renderPending = true;
    return;
  }
  renderPending = false;
  paintedMeals = state.meals; // 025: "como se veía" al levantar
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
      const moving = state.moving?.has(mealKey(toISODate(date), type.id)); // 025 C-14, C-17
      const onClick = meal
        ? () => openDay(date, type.id)
        : () => { if (!state.offline) openForm({ date, type: type.id }); }; // 011 RF-10
      const row = button('week-meal type-' + type.id + (meal ? '' : ' empty'), undefined, onClick);
      if (!meal) row.disabled = state.offline; // abre el formulario para crear (011 D-7)
      if (moving) {
        row.disabled = true;
        row.classList.add('moving');
      }
      row.dataset.date = toISODate(date); // 025: qué casilla es al arrastrar
      row.dataset.type = type.id;
      row.append(
        el('span', 'week-meal-type', type.name),
        el('span', 'week-meal-name', moving ? 'Moviendo…' : meal ? dishNames(meal) : '—'),
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
  const persons = personsText(dish.personas); // 018 C-8, C-9, C-11
  if (persons) box.append(el('p', 'detail-subtitle detail-persons', persons));

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
  // 026 C-26, D-13: uno por plato, bajo sus datos; desactivado sin red (C-34, I-6)
  const save = button('btn dish-save-recipe', 'Guardar como receta', () => openRecipeForm(null, dish));
  save.disabled = state.offline;
  box.append(save);
  return box;
}

// ===== Confirmación =====
function askConfirm(text, acceptText = 'Aceptar') {
  const dialog = $('confirm-dialog');
  if (dialog.open) return Promise.resolve(false); // 030 D-17: una sola a la vez
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = acceptText;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
    dialog.showModal();
  });
}

// ===== Formulario: platos e ingredientes =====
// noLink: el plato del formulario de receta, sin marca ni sugerencias de receta (030 D-10)
function buildFormDish(container, { noLink = false } = {}) {
  const node = $('dish-template').content.firstElementChild.cloneNode(true);
  const find = (selector) => node.querySelector(selector);
  const dish = {
    node,
    title: find('.dish-title'),
    nameLabel: find('.dish-name-label'),
    name: find('.dish-name'),
    linkLine: find('.dish-recipe-link'),
    link: null, // la marca del plato, { id, name } (030 D-2)
    noLink,
    recipeList: find('.recipe-suggestions'),
    recipesButton: find('.dish-recipes-button'), // abre la ventana "Recetas" (030 C-11)
    found: [], // las recetas sugeridas, en el orden de la lista (030 D-9)
    typedName: false, // se ha escrito o borrado en el nombre: las cargas recalculan (C-5)
    persons: find('.dish-persons'), // 018 D-11: markInvalid lo busca como 'persons'
    ingredients: find('.ingredients'),
    recipe: find('.dish-recipe'),
    reference: find('.dish-reference'),
  };
  find('.dish-add-ingredient').addEventListener('click', () => addIngredient(dish));
  const label = find('.dish-name-label');
  label.id = `dish-name-label-${++dishCount}`;
  dish.name.setAttribute('aria-labelledby', label.id); // D-10: el título, sin lo de la fila
  if (noLink) {
    dish.recipeList.remove();
    dish.recipesButton.remove();
  } else {
    setupRecipeSuggestions(dish);
    dish.recipesButton.addEventListener('click', () => openRecipePicker(dish));
  }
  container.append(node);
  return dish;
}

// ===== Sugerencias de receta en el nombre del plato (030 C-1 a C-5, D-9) =====
// Como las de ingrediente: el foco no sale del nombre; mousedown no lo quita y la elección
// va en click
let dishCount = 0;

function setupRecipeSuggestions(dish) {
  const { name, recipeList: list } = dish;
  list.id = `recipe-suggestions-${dishCount}`;
  name.setAttribute('role', 'combobox');
  name.setAttribute('aria-autocomplete', 'list');
  name.setAttribute('aria-expanded', 'false');
  name.setAttribute('aria-controls', list.id);
  name.addEventListener('input', () => {
    refreshDishLink(dish); // C-44
    dish.typedName = true; // desde aquí, las cargas recalculan su lista (C-5)
    renderRecipeSuggestions(dish); // C-1
  });
  name.addEventListener('keydown', (event) => onDishNameKeydown(dish, event));
  name.addEventListener('blur', () => { // C-4: al salir se cierra y se olvida lo escrito
    dish.typedName = false;
    closeRecipeSuggestions(dish);
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) pickRecipeSuggestion(dish, dish.found[recipeOptions(dish).indexOf(option)]);
  });
}

// Pinta la lista del plato; sin sugerencias, oculta y sin hueco (C-1 a C-3). Como texto (I-9)
function renderRecipeSuggestions(dish) {
  const { name, recipeList: list } = dish;
  const linkedId = keptRecipeLink(name.value, dish.link); // C-3 (D-13)
  dish.found = recipeSuggestions(recipeState.items, name.value, linkedId);
  const grew = dish.found.length > 0 && (list.hidden || dish.found.length !== list.children.length);
  list.replaceChildren(...dish.found.map((recipe, index) => {
    const option = el('li', 'suggestion recipe-suggestion');
    option.id = `${list.id}-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const { name: recipeName, info } = recipeLine(recipe);
    option.append(el('span', 'recipe-suggestion-name', recipeName),
      el('span', 'recipe-suggestion-stars', info.split(' · ')[0])); // solo las estrellas (D-9)
    return option;
  }));
  list.hidden = dish.found.length === 0;
  name.setAttribute('aria-expanded', String(dish.found.length > 0));
  name.removeAttribute('aria-activedescendant'); // lista nueva: ninguna marcada
  if (grew) list.scrollIntoView({ block: 'nearest' }); // C-4: lo justo; si se ve, nada
}

function recipeOptions(dish) {
  return [...dish.recipeList.querySelectorAll('[role="option"]')];
}

// Marca la opción index (-1: ninguna) y la deja a la vista (C-4)
function setRecipeMark(dish, index) {
  const options = recipeOptions(dish);
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  if (index < 0) return dish.name.removeAttribute('aria-activedescendant');
  dish.name.setAttribute('aria-activedescendant', options[index].id);
  options[index].scrollIntoView({ block: 'nearest' });
}

// Con la lista visible, ↑/↓ marcan, Intro con marcada elige y Esc solo cierra la lista; Intro
// sin marcada sigue al envío del formulario. Con un teclado de composición, nada nuestro (C-4)
function onDishNameKeydown(dish, event) {
  if (event.isComposing || dish.recipeList.hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const options = recipeOptions(dish);
    setRecipeMark(dish, moveMark(markedIndex(options), options.length, event.key === 'ArrowDown' ? 'down' : 'up'));
  } else if (event.key === 'Escape') {
    event.preventDefault(); // anula el cierre del diálogo: la siguiente Esc sí lo cierra
    dish.typedName = false; // cerrada a propósito: una carga no la vuelve a abrir
    closeRecipeSuggestions(dish);
  } else if (event.key === 'Enter' && pickMarkedRecipe(dish)) {
    event.preventDefault();
  }
}

// Elige la sugerencia marcada, si la hay; también desde saveMeal, para los teclados que no
// avisan de la tecla y envían el formulario (D-9, manual 1)
function pickMarkedRecipe(dish) {
  const marked = markedIndex(recipeOptions(dish));
  if (marked < 0) return false;
  pickRecipeSuggestion(dish, dish.found[marked]);
  return true;
}

// El plato del formulario de comida con el cursor en su nombre, o null
function focusedDish() {
  return [formState.dish1, formState.dish2].find((dish) => dish && dish.name === document.activeElement) || null;
}

// Tras una carga de recetas (con red o de la copia), la lista del plato con el cursor se
// recalcula si en él se ha escrito o borrado; la marcada sigue si sigue en la lista (C-5)
function refreshOpenRecipeSuggestions() {
  const dish = $('meal-dialog').open ? focusedDish() : null;
  if (!dish || !dish.typedName) return;
  const oldIds = dish.found.map((recipe) => recipe.id);
  const oldIndex = markedIndex(recipeOptions(dish));
  renderRecipeSuggestions(dish);
  const kept = keptMark(oldIds, oldIndex, dish.found.map((recipe) => recipe.id));
  if (kept >= 0) setRecipeMark(dish, kept);
}

function closeRecipeSuggestions(dish) {
  if (!dish.recipeList) return;
  dish.recipeList.hidden = true;
  dish.recipeList.replaceChildren();
  dish.found = [];
  dish.name.setAttribute('aria-expanded', 'false');
  dish.name.removeAttribute('aria-activedescendant');
}

// Elegir una sugerencia: copia la receta al plato (030 C-6 a C-10); "Cancelar" vuelve al nombre
async function pickRecipeSuggestion(dish, recipe) {
  dish.typedName = false;
  closeRecipeSuggestions(dish);
  if (!(await chooseRecipe(dish, recipe))) dish.name.focus();
}

// Copia la receta al plato con su marca (la nueva sustituye a la que hubiera, C-9, C-10) y el
// cursor va a "Personas". Con algo más que el nombre, antes pregunta (C-7, D-11). Copia la
// receta cargada en ese momento (C-8); si ya no está, la que se tocó. No guarda nada.
// Devuelve si se copió; false al cancelar o si el formulario o la sesión ya no siguen
async function chooseRecipe(dish, recipe) {
  if (dishHasMoreThanName(readDish(dish))) {
    const replace = await askConfirm(replaceDishText(recipe.nombre), 'Sustituir');
    if (!sessionActive || !$('meal-dialog').open) return false; // I-13 (D-11): nada
    if (!replace) return false;
  }
  const current = recipeState.items.find((item) => item.id === recipe.id) || recipe;
  fillDish(dish, { ...dishFromRecipe(current), receta_id: current.id }); // D-2: link con su nombre
  dish.persons.focus(); // C-6 (D-12)
  return true;
}

function addIngredient(dish, data = {}) {
  const row = $('ingredient-template').content.firstElementChild.cloneNode(true);
  const name = row.querySelector('.ingredient-name');
  name.value = flattenLineBreaks(data.nombre || '');
  const hasAmount = data.cantidad !== null && data.cantidad !== undefined;
  row.querySelector('.ingredient-quantity').value = hasAmount ? amountFieldText(data.cantidad) : ''; // 013 C-5
  row.originalQuantity = hasAmount ? data.cantidad : null; // 013 D-4
  row.querySelector('.ingredient-unit').value = data.unidad || '';
  name.addEventListener('keydown', onNameKeydown);
  name.addEventListener('beforeinput', onNameBeforeInput);
  name.addEventListener('input', (event) => onNameInput(name, event));
  setupIngredientSuggestions(row, name);
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

// Igual que el envío implícito de un campo de una línea: solo con "Guardar" activo. Envía el
// formulario de la fila: el de comida o el de receta (026 D-18)
function submitFromName(row) {
  const form = row.closest('form');
  const save = form.querySelector('button[type="submit"]');
  if (!save.disabled) form.requestSubmit(save);
}

// Con la lista visible, ↑/↓ marcan, Intro con marcada elige y Esc solo cierra la lista; si
// no, Intro guarda como hoy. Con un teclado de composición, nada nuestro (014 C-11 a C-13, D-16)
function onNameKeydown(event) {
  if (event.isComposing) return;
  const row = event.target.closest('.ingredient');
  const open = !row.querySelector('.ingredient-suggestions').hidden;
  if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    moveIngredientMark(row, event.key === 'ArrowDown' ? 'down' : 'up');
  } else if (open && event.key === 'Escape') {
    event.preventDefault(); // anula el cierre del diálogo: la siguiente Esc sí lo cierra
    row.typedName = false; // cerrada a propósito: una carga no la vuelve a abrir
    closeIngredientSuggestions(row);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    enterFromName(row);
  }
}

// Teclados que no avisan de la tecla (keydown 229): el salto no entra y se envía (D-3),
// o elige la marcada (014 D-17)
function onNameBeforeInput(event) {
  if (!TYPED_BREAKS.includes(event.inputType)) return;
  event.preventDefault();
  enterFromName(event.target.closest('.ingredient'));
}

// Intro: con una sugerencia marcada, la elige sin guardar; sin ninguna, guarda (014 C-12)
function enterFromName(row) {
  const marked = row.querySelector('.ingredient-suggestions [aria-selected="true"]');
  if (marked) pickIngredientSuggestion(row, marked.textContent);
  else submitFromName(row);
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
  const row = name.closest('.ingredient');
  if (TYPED_BREAKS.includes(event.inputType)) return submitFromName(row);
  row.typedName = true; // desde aquí, las cargas recalculan su lista (014 C-8, C-22)
  renderIngredientSuggestions(row); // 014 C-1, C-2
}

// ===== Sugerencias de nombre en la fila de ingrediente (014) =====
// Una lista por fila (D-14): el foco no sale del nombre; mousedown no lo quita (también al
// tocar) y la elección va en click
let ingredientListCount = 0;

function setupIngredientSuggestions(row, name) {
  const list = row.querySelector('.ingredient-suggestions');
  list.id = `ingredient-suggestions-${++ingredientListCount}`;
  name.setAttribute('aria-controls', list.id);
  name.addEventListener('blur', () => { // C-8: al salir se cierra y se olvida lo escrito
    row.typedName = false;
    closeIngredientSuggestions(row);
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) pickIngredientSuggestion(row, option.textContent);
  });
}

// Sugerencias para lo escrito en la fila, sin repetir las otras filas del mismo plato (C-5)
function rowSuggestions(row) {
  const others = [...row.parentElement.querySelectorAll('.ingredient')]
    .filter((other) => other !== row)
    .map((other) => other.querySelector('.ingredient-name').value);
  return ingredientSuggestions({
    items: listState.items, // D-10
    mealNames: suggestionMealNames(), // D-8
    typed: row.querySelector('.ingredient-name').value,
    otherNames: others,
  });
}

// Pinta la lista de la fila; sin sugerencias, oculta y sin hueco (C-1, C-2). Como texto (I-9)
function renderIngredientSuggestions(row) {
  const found = rowSuggestions(row);
  const list = row.querySelector('.ingredient-suggestions');
  const grew = found.length > 0 && (list.hidden || found.length !== list.children.length);
  list.replaceChildren(...found.map((text, index) => {
    const option = el('li', 'suggestion', text);
    option.id = `${list.id}-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    return option;
  }));
  list.hidden = found.length === 0;
  const name = row.querySelector('.ingredient-name');
  name.setAttribute('aria-expanded', String(found.length > 0));
  name.removeAttribute('aria-activedescendant'); // lista nueva: ninguna marcada
  if (grew) list.scrollIntoView({ block: 'nearest' }); // C-26 (D-21): lo justo; si se ve, nada
}

function rowOptions(row) {
  return [...row.querySelectorAll('.ingredient-suggestions [role="option"]')];
}

function markedIndex(options) {
  return options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
}

// Marca la opción index (-1: ninguna) y la deja a la vista (014 C-11, D-14)
function setIngredientMark(row, index) {
  const options = rowOptions(row);
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  const name = row.querySelector('.ingredient-name');
  if (index < 0) return name.removeAttribute('aria-activedescendant');
  name.setAttribute('aria-activedescendant', options[index].id);
  options[index].scrollIntoView({ block: 'nearest' });
}

// ↑/↓: marca la siguiente o la anterior, sin dar la vuelta (D-12)
function moveIngredientMark(row, key) {
  const options = rowOptions(row);
  setIngredientMark(row, moveMark(markedIndex(options), options.length, key));
}

// Tras una carga o al entrar o salir del modo copia, la lista de la fila con el cursor se
// recalcula con lo escrito (sale aunque antes no hubiera ninguna), sin cerrar el formulario;
// la marcada sigue si sigue en la lista. Solo si en ella se ha escrito o borrado desde que
// tiene el cursor: si no, ninguna lista (014 C-8, C-9, C-17, C-19, C-22, D-13)
function refreshOpenIngredientSuggestions() {
  const name = document.activeElement;
  if (!name?.matches('#meal-dialog[open] .ingredient-name, #recipe-dialog[open] .ingredient-name')) return;
  const row = name.closest('.ingredient');
  if (!row.typedName) return;
  const before = rowOptions(row);
  const oldNames = before.map((option) => option.textContent);
  renderIngredientSuggestions(row);
  const newNames = rowOptions(row).map((option) => option.textContent);
  const kept = keptMark(oldNames, markedIndex(before), newNames);
  if (kept >= 0) setIngredientMark(row, kept);
}

function closeIngredientSuggestions(row) {
  const list = row.querySelector('.ingredient-suggestions');
  list.hidden = true;
  list.replaceChildren();
  const name = row.querySelector('.ingredient-name');
  name.setAttribute('aria-expanded', 'false');
  name.removeAttribute('aria-activedescendant');
}

// Elegir: el nombre pasa a ser la sugerencia, la lista se cierra y el cursor va a "Cant."
// sin tocar cantidad ni unidad; no guarda nada (C-10, C-15)
function pickIngredientSuggestion(row, text) {
  const name = row.querySelector('.ingredient-name');
  name.value = text;
  fitNameHeight(name);
  closeIngredientSuggestions(row);
  row.querySelector('.ingredient-quantity').focus();
}

function fillDish(dish, data) {
  dish.name.value = data?.nombre || '';
  dish.typedName = false; // 030 C-4: al abrir o rellenar, ninguna sugerencia de receta
  closeRecipeSuggestions(dish);
  // La marca guardada, con el nombre guardado como nombre de la marca (030 C-21, D-2); sin
  // marca o en el formulario de receta, ninguna (C-20)
  dish.link = !dish.noLink && data?.receta_id ? { id: data.receta_id, name: data.nombre || '' } : null;
  refreshDishLink(dish);
  dish.persons.value = String(savedPersons(data?.personas) ?? ''); // 018 C-6, C-11
  dish.recipe.value = data?.receta || '';
  dish.reference.value = data?.referencia || '';
  dish.ingredients.querySelectorAll('.ingredient-name').forEach((name) => nameObserver.unobserve(name));
  dish.ingredients.replaceChildren();
  const ingredients = data?.ingredientes || [];
  if (ingredients.length) ingredients.forEach((ingredient) => addIngredient(dish, ingredient));
  else addIngredient(dish);
}

// Línea de la marca bajo el nombre: la receta, o que se quitará al guardar (030 C-44, D-19)
function refreshDishLink(dish) {
  const text = recipeLinkText(dish.name.value, dish.link, recipeState.items);
  dish.linkLine.textContent = text || '';
  dish.linkLine.hidden = !text;
}

// Con cada carga de recetas, el nombre actual de la receta en los platos del formulario (D-19)
function refreshDishLinks() {
  if (formState.dish1) refreshDishLink(formState.dish1);
  if (formState.dish2) refreshDishLink(formState.dish2);
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
// original: la cantidad guardada con que se rellenó la fila, si la hay (013-unidades-fracciones D-4)
function readRow(row) {
  const original = row.row.originalQuantity ?? null;
  return { name: row.name.value, quantity: row.quantity.value, original, unit: row.unit.value };
}

function readDish(dish) {
  return {
    name: dish.name.value,
    link: dish.link, // 030 D-2
    persons: dish.persons.value,
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

  // 030 D-17: con una confirmación (o la ventana "Recetas") abierta, espera a que se cierre
  await modalsClosed();
  if (!sessionActive || searchId !== formState.searchId || formState.id) return;
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

// Espera a que no quede abierta ninguna confirmación ni la ventana "Recetas" (030 D-17)
async function modalsClosed() {
  let open;
  while ((open = [$('confirm-dialog'), $('recipe-picker')].find((dialog) => dialog?.open))) {
    await new Promise((resolve) => open.addEventListener('close', resolve, { once: true }));
  }
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
  const dish = focusedDish(); // 030 D-9: Intro de un teclado sin tecla, con una marcada, elige
  if (dish && pickMarkedRecipe(dish)) return;
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
// ===== Arrastrar comidas (025-arrastrar-comidas) =====
// drag: la pulsación o el arrastre en curso, sobre una casilla de la semana (null: ninguno).
// Mientras hay uno, y tras un toque corto hasta que llega su clic, render() queda pendiente:
// la casilla pulsada sigue en la página y lo que llega se pinta después (C-22, D-9)
let drag = null;
let tapHoldTimer = null;      // espera del clic de un toque corto (D-9)
let renderPending = false;
let swallowClick = false;     // el clic que sigue a un levantamiento no abre nada (C-16, D-8)
let cancelledPointerId = null; // puntero de un arrastre cancelado aún sin soltar (C-16, C-30)
let paintedMeals = new Map(); // comidas de la semana pintada ("como se veía")
const TAP_CLICK_WAIT_MS = 500; // tras un toque corto, hasta aquí se espera su clic

function isRenderHeld() {
  return drag !== null || tapHoldTimer !== null;
}

function flushRender() {
  if (renderPending && !isRenderHeld()) render();
}

function releaseTapHold() {
  clearTimeout(tapHoldTimer);
  tapHoldTimer = null;
  flushRender();
}

// Pulsación sobre una casilla de la semana (C-1, C-2, C-5, C-7)
function onCalendarPointerDown(event) {
  if (drag) { // C-30: otro dedo u otro puntero
    if (event.pointerId !== drag.pointerId) cancelDrag();
    return;
  }
  const row = event.target.closest('.week-meal');
  if (!row || row.disabled || state.offline || state.view !== 'week') return; // C-7
  if (state.moving) return; // C-17: el toque abre el día o el formulario como siempre
  const mouse = event.pointerType === 'mouse';
  if (mouse && event.button !== 0) return; // D-11: el clic derecho, como hoy
  const slot = { date: row.dataset.date, type: row.dataset.type };
  const meal = paintedMeals.get(mealKey(slot.date, slot.type)) || null;
  if (!meal && mouse) return; // vacía con ratón: solo el clic de siempre
  const point = { x: event.clientX, y: event.clientY };
  drag = {
    pointerId: event.pointerId, mouse, row, slot, meal, start: point, point,
    downAt: event.timeStamp, width: window.innerWidth, lifted: false,
    timer: null, ghost: null, offset: null, frame: null, frameAt: null, target: null,
  };
  if (!mouse && meal) drag.timer = setTimeout(liftMeal, LONG_PRESS_MS); // C-1
  document.addEventListener('pointermove', onDragPointerMove);
  document.addEventListener('pointerup', onDragPointerUp);
  document.addEventListener('pointercancel', onDragPointerCancel);
}

function onDragPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.point = { x: event.clientX, y: event.clientY };
  if (drag.lifted) return; // la copia la mueve dragFrame
  if (!movesBeyond(drag.start, drag.point, drag.mouse ? MOUSE_DRAG_PX : TOUCH_SLOP_PX)) return;
  if (drag.mouse) liftMeal(); // C-2
  else endDrag(); // C-4: el navegador desplaza la página y nada se levanta
}

// Levanta la comida: copia que sigue al puntero y hueco en su casilla (C-1, C-2, C-8)
function liftMeal() {
  clearTimeout(drag.timer);
  drag.lifted = true;
  const { row } = drag;
  const rect = row.getBoundingClientRect();
  drag.offset = { x: drag.start.x - rect.left, y: drag.start.y - rect.top };
  const ghost = row.cloneNode(true); // pintada con textContent (principio 7)
  ghost.classList.add('drag-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.tabIndex = -1;
  ghost.style.width = rect.width + 'px'; // C-27: ni más ancha que su casilla
  ghost.style.transformOrigin = drag.offset.x + 'px ' + drag.offset.y + 'px';
  document.body.append(ghost);
  drag.ghost = ghost;
  row.classList.add('drag-origin');
  document.body.classList.add('dragging');
  markDropSlots();
  if (drag.mouse) {
    try { row.setPointerCapture(drag.pointerId); } catch { /* el puntero ya no está */ } // D-8
  } else if (navigator.vibrate) navigator.vibrate(DRAG_VIBRATE_MS); // C-1
  placeGhost();
  markDropTarget();
  drag.frame = requestAnimationFrame(dragFrame);
}

function placeGhost() {
  const x = drag.point.x - drag.offset.x;
  const y = drag.point.y - drag.offset.y;
  drag.ghost.style.transform = `translate(${x}px, ${y}px) scale(1.04)`;
}

// Casillas de la semana pintada: válidas con contorno, las demás atenuadas (C-9, C-10)
function weekSlotRows() {
  return $('calendar').querySelectorAll('.week-meal');
}

function slotOf(row) {
  return { date: row.dataset.date, type: row.dataset.type };
}

function markDropSlots() {
  for (const row of weekSlotRows()) {
    if (row === drag.row) continue;
    row.classList.add(canDropMeal(drag.slot, slotOf(row)) ? 'drag-valid' : 'drag-dimmed');
  }
}

function clearDropSlots() {
  for (const row of weekSlotRows()) row.classList.remove('drag-valid', 'drag-dimmed', 'drag-over');
}

// La casilla válida que está bajo el puntero, o null (la copia no recibe el puntero) (C-11)
function dropTargetAt(point) {
  const row = document.elementFromPoint(point.x, point.y)?.closest('.week-meal');
  if (!row || !$('calendar').contains(row)) return null;
  return canDropMeal(drag.slot, slotOf(row)) ? row : null;
}

function markDropTarget() {
  const target = dropTargetAt(drag.point);
  if (target === drag.target) return;
  drag.target?.classList.remove('drag-over');
  target?.classList.add('drag-over');
  drag.target = target;
}

// Zona visible del calendario: bajo la cabecera fija y, en el móvil, sobre la barra de
// pantallas de abajo (C-12, D-7)
function calendarViewport() {
  const top = document.querySelector('.header').getBoundingClientRect().bottom;
  const bar = $('screen-bar').getBoundingClientRect();
  const atBottom = bar.width > window.innerWidth / 2 && bar.bottom >= window.innerHeight - 1;
  return { top, bottom: atBottom ? bar.top : window.innerHeight };
}

// Cerca de un borde, la página se desplaza sola; window.scrollBy no pasa del final (C-12)
function edgeScroll(frameMs) {
  const { top, bottom } = calendarViewport();
  const step = edgeScrollStep(drag.point.y, top, bottom, frameMs);
  if (step) window.scrollBy(0, step);
}

// Un fotograma del arrastre: la copia sigue al dedo o al ratón, la página se desplaza cerca
// de los bordes y se marca la casilla de debajo, que cambia también al desplazarse (C-8, C-11, C-12)
function dragFrame(time) {
  if (!drag?.lifted) return;
  const frameMs = drag.frameAt === null ? 0 : time - drag.frameAt;
  drag.frameAt = time;
  placeGhost();
  edgeScroll(frameMs);
  markDropTarget();
  drag.frame = requestAnimationFrame(dragFrame);
}

function onDragPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.lifted) {
    drag.point = { x: event.clientX, y: event.clientY };
    dropMeal();
    return;
  }
  // C-5: un dedo que mantiene una casilla vacía y suelta hace lo mismo que un toque; tras una
  // pulsación larga el navegador no manda el clic, así que se pulsa aquí
  const longEmpty = !drag.mouse && !drag.meal && event.timeStamp - drag.downAt >= LONG_PRESS_MS;
  const { row } = drag;
  endDrag({ tap: !longEmpty });
  if (longEmpty) {
    row.click();
    ignoreNextClick(); // por si el navegador también lo manda
  }
}

function onDragPointerCancel(event) {
  if (drag && event.pointerId === drag.pointerId) cancelDrag(); // C-4, C-30
}

// Soltar: sobre una casilla válida, "Moviendo…" en las dos y se guarda; en otro sitio, nada
// (C-14, C-15, C-16)
function dropMeal() {
  // Antes de cancelDrag, que pinta lo pendiente: el destino, tal como se veía (C-20)
  const target = dropTargetAt(drag.point);
  const to = target && slotOf(target);
  const targetMeal = target ? paintedMeals.get(mealKey(to.date, to.type)) || null : null;
  const { meal, slot } = drag;
  cancelDrag();
  if (!target || !sessionActive || state.offline) return;
  state.moving = new Set([mealKey(slot.date, slot.type), mealKey(to.date, to.type)]);
  render();
  saveMove(meal, to, targetMeal);
}

// Una sola llamada mueve o intercambia, solo si todo sigue como se veía (D-1, D-6, D-13)
async function saveMove(meal, to, targetMeal) {
  const result = await timedQuery(client.rpc('mover_comidas', moveParams(meal, to, targetMeal)));
  if (!sessionActive || !state.moving) return; // respuesta llegada tras el cierre de sesión
  const outcome = result.error ? 'error' : moveOutcome(result.data);
  if (outcome === 'moved' || outcome === 'swapped') {
    await loadData(); // sin parpadeo: "Moviendo…" hasta que llega la semana nueva
    endMoving();
    return;
  }
  endMoving();
  if (outcome === 'changed') {
    showInfo(MOVE_CHANGED_MESSAGE); // C-20, 027 C-4
    loadData();
    return;
  }
  // C-31, D-6: sin respuesta, la base de datos puede haberla movido: pasa a sin red, que
  // recarga la semana al volver; con el dispositivo conectado, el reintento se lanza ya (con
  // copia, loadData solo leería la copia)
  const unconfirmed = moveUnconfirmed(result.error, reachable(result), result.timedOut);
  if (unconfirmed) goOffline();
  showError(moveErrorMessage(result.error, navigator.onLine, result.timedOut)); // C-21, C-31
  if (unconfirmed && navigator.onLine) retryConnection();
}

function endMoving() {
  state.moving = null;
  render();
}

// La comida vuelve a su sitio, sin guardar ni abrir nada (C-16, C-23, C-30)
function cancelDrag() {
  if (!drag) return;
  const { lifted, pointerId } = drag;
  endDrag();
  if (!lifted) return;
  ignoreNextClick();
  cancelledPointerId = pointerId; // si el botón o el dedo siguen abajo, su clic llega al soltar
}

// Soltar tras cancelar: el clic que sigue tampoco abre nada (C-16, C-30)
function onCancelledPointerUp(event) {
  if (event.pointerId !== cancelledPointerId) return;
  cancelledPointerId = null;
  ignoreNextClick();
}

// Termina la pulsación o el arrastre y pinta lo pendiente; tap: espera antes el clic del toque
function endDrag({ tap = false } = {}) {
  clearTimeout(drag.timer);
  cancelAnimationFrame(drag.frame);
  drag.ghost?.remove();
  drag.row.classList.remove('drag-origin');
  if (drag.lifted) clearDropSlots();
  document.body.classList.remove('dragging');
  document.removeEventListener('pointermove', onDragPointerMove);
  document.removeEventListener('pointerup', onDragPointerUp);
  document.removeEventListener('pointercancel', onDragPointerCancel);
  drag = null;
  if (tap) {
    clearTimeout(tapHoldTimer);
    tapHoldTimer = setTimeout(releaseTapHold, TAP_CLICK_WAIT_MS);
  } else flushRender();
}

// D-8: se ignora solo el clic que sigue; si no llega, la guarda se quita en la siguiente vuelta
function ignoreNextClick() {
  swallowClick = true;
  setTimeout(() => { swallowClick = false; });
}

// Clic en el calendario, antes que el de la casilla: el que sigue a un levantamiento no abre
// nada (C-16); el de un toque corto pinta antes lo pendiente (el clic ya tiene su casilla)
function onCalendarClickCapture(event) {
  if (swallowClick) {
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
    return;
  }
  if (tapHoldTimer !== null) releaseTapHold();
}

function setupMealDrag() {
  const calendar = $('calendar');
  calendar.addEventListener('pointerdown', onCalendarPointerDown);
  calendar.addEventListener('click', onCalendarClickCapture, true);
  document.addEventListener('pointerup', onCancelledPointerUp, true);
  // Una pulsación nueva olvida el puntero cancelado (pudo soltarse fuera de la ventana)
  document.addEventListener('pointerdown', () => { cancelledPointerId = null; }, true);
  // C-6, D-11: sin menú del navegador al mantener una comida con el dedo
  calendar.addEventListener('contextmenu', (event) => {
    if (drag && !drag.mouse && drag.meal) event.preventDefault();
  });
  // C-13, D-7: siempre puesto y no pasivo; solo frena el desplazamiento con una comida levantada
  calendar.addEventListener('touchmove', (event) => {
    if (drag?.lifted) event.preventDefault();
  }, { passive: false });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag?.lifted) cancelDrag(); // C-16
  });
  window.addEventListener('resize', () => { // C-30: girar o cambiar el ancho, no el alto
    if (drag && window.innerWidth !== drag.width) cancelDrag();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') cancelDrag(); // C-30
  });
  window.addEventListener('blur', cancelDrag); // C-30
}

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
  $('user-menu-settings').addEventListener('click', openSettingsFromMenu); // 028 C-1, C-2
  $('settings-tags-button').addEventListener('click', () => showSettingsView('tags')); // 028 C-3
  $('settings-back').addEventListener('click', () => showSettingsView('index'));
  $('search-button').addEventListener('click', openSearch); // 023 C-2
  $('search-close').addEventListener('click', () => closeSearch()); // 023 C-3
  $('search-dialog').addEventListener('close', onSearchClosed); // 023 C-3, C-31, D-8
  $('search-input').addEventListener('input', onSearchInput); // 023 C-8
  $('search-more').addEventListener('click', loadMoreMeals); // 023 C-13
  $('article-dialog').addEventListener('close', onSearchChildClosed); // 023 D-16
  $('recover-dialog').addEventListener('close', onSearchChildClosed); // 023 D-16
  // Al cruzar los 768 px cambia el diseño (CSS) y el menú se cierra (CL-8)
  matchMedia('(min-width: 768px)').addEventListener('change', closeUserMenu);
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  readSidebar();
  calendarObserver.observe($('calendar')); // 008 RF-15
  setupMealDrag(); // 025

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
  $('recipe-search').addEventListener('input', onRecipeSearch); // 026 C-7
  $('recipe-tags-toggle').addEventListener('click', () => toggleRecipeTagsOpen(recipeScreen)); // 029 C-2
  $('recipe-time').addEventListener('change', onRecipeTime); // C-9
  $('recipe-order').addEventListener('change', onRecipeOrder); // C-11, C-41
  $('add-recipe-button').addEventListener('click', () => openRecipeForm()); // C-17
  setupRecipePicker(); // 030 C-11
  recipeForm.dish = buildRecipeDish();
  setupRecipeTags(); // C-20
  setupRecipeFormStars(); // C-21
  $('recipe-cancel').addEventListener('click', () => $('recipe-dialog').close()); // C-22
  $('recipe-form').addEventListener('submit', saveRecipe);
  $('add-article-button').addEventListener('click', () => { if (!state.offline) openArticleForm(); }); // 011 RF-10
  $('finish-button').addEventListener('click', finishShopping);
  $('article-cancel').addEventListener('click', closeArticleForm);
  $('article-delete').addEventListener('click', deleteFromArticleForm);
  $('article-form').addEventListener('submit', saveArticle);
  setupArticleSuggestions(); // 016
  $('ingredients-button').addEventListener('click', openReview);
  $('ingredients-cancel').addEventListener('click', closeReview); // RF-4
  $('ingredients-retry').addEventListener('click', () => loadReviewMeals({ showLoading: true })); // RF-21
  $('ingredients-lines').addEventListener('change', onReviewLineChange); // RF-9
  $('ingredients-lines').addEventListener('input', onReviewAmountInput); // 017 C-6
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
  $('quick-add-input').addEventListener('input', onQuickInput); // RF-21, RF-22; 015 C-7, C-9
  $('quick-add-input').addEventListener('keydown', onQuickKeydown); // 015 C-1, C-2
  $('quick-add-input').addEventListener('blur', () => setQuickMark(-1)); // 015 C-10: sigue visible, sin marcada
  // 021 C-5: el mensaje de cantidad se quita al cambiar Cantidad o Unidad
  $('quick-add-quantity').addEventListener('input', () => showQuickError(''));
  $('quick-add-unit').addEventListener('change', () => showQuickError(''));
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
  $('exists-keep').addEventListener('click', keepExisting); // 021 C-10
  $('exists-sum').addEventListener('click', () => applyExisting(existsState.choice?.sum)); // C-9
  $('exists-change').addEventListener('click', () => applyExisting(existsState.choice?.change));
  $('exists-dialog').addEventListener('cancel', (event) => { event.preventDefault(); keepExisting(); });
  setupRecover(); // 022
  setupTagDialog(); // 028

  // Recargar al volver a primer plano y al recuperar la conexión
  document.addEventListener('visibilitychange', () => {
    onVisibilityChange(); // RNF-5, RNF-6 (004)
    if (document.visibilityState !== 'visible') {
      stopRetry(); // 011 RF-16: en segundo plano no se reintenta
      stopQueueRetry(); // 012 D-8: ni la cola
      return;
    }
    if (sessionActive && (state.copyMode || state.offline)) {
      retryConnection(); // 011 RF-16: en el momento, y otra vez cada 30 s
      startRetry();
    } else {
      loadData();
      loadListWithQueue(); // 007 RF-34; 012 RF-9, RF-17
      loadRecipes(); // 026 D-8
      scheduleCopySave(); // 011 RF-1
    }
    checkSessionAlive();
  });
  window.addEventListener('online', () => {
    if (sessionActive && (state.copyMode || state.offline)) {
      retryConnection(); // 011 RF-12, D-6: solo el reintento sale del modo copia
    } else if (sessionActive) {
      loadData();
      loadListWithQueue(); // 007 RF-34; 012 RF-9, RF-17
      loadRecipes(); // 026 D-8
      scheduleCopySave(); // 011 RF-1
    } else if (!$('screen-config').hidden) connect();
    announceForm({ hello: true }); // CL-3 (si el socket aún no ha vuelto, lo hace SUBSCRIBED)
    recheckSaved(); // D-12
  });
  // 012 RF-8, RF-14 (D-2, D-4): la cola la comparten las pestañas; la otra repinta al cambiar
  window.addEventListener('storage', (event) => {
    if (event.key !== STRIKE_QUEUE_KEY && event.key !== null) return;
    if (state.copyMode) refreshCopyArticles(parseStrikeQueue(event.oldValue)); // RF-8: lo enviado desde la otra pestaña ya está en la copia
    renderShopping();
    refreshCopyNotice();
    if (sessionActive && !state.copyMode && !state.offline) scheduleListReload();
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
