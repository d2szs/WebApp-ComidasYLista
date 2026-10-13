'use strict';

// ===== Claves de Supabase (solo la clave pública, nunca la secreta) =====
const SUPABASE_URL = 'https://beyarsihdhzpxzvsxeep.supabase.co';
const SUPABASE_PUBLIC_KEY = 'sb_publishable_BLEWWv74RigJ6Jo977E59A_2vs3nYk2';

// ===== Constantes =====
const CONNECTION_TIMEOUT = 8000;

// ===== Estado =====
const state = {
  view: 'week',         // 'month' | 'week' | 'day'
  refDate: getToday(),  // día de referencia del periodo visible
  meals: new Map(),     // 'aaaa-mm-dd|tipo' → fila
  openType: null,       // tipo desplegado en la vista diaria
  requestId: 0,         // para descartar respuestas antiguas
  noticeKind: null,     // origen del aviso visible: 'load' | 'sync' | 'action'
};

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
};

let client = null;
let channel = null;
let sessionActive = false;
let reloadTimer = null;
let ready = false;          // connect() ya eligió la pantalla de arranque (D-2)
let signingOut = false;     // la app está cerrando la sesión ella misma (no es RF-15)
let onNewPassword = false;  // en la pantalla de nueva contraseña
let recoveryUserId = null;  // id de la cuenta del enlace de recuperación (D-4)

// Formularios abiertos en otras pestañas o dispositivos (004-edicion-simultanea)
let formsChannel = null;    // canal privado 'meal-forms' (D-1)
let formsReady = false;     // canal suscrito (CL-3)
let peers = [];             // otros formularios (updatePeers)
const tabKey = crypto.randomUUID(); // clave de esta pestaña en los mensajes "form" (D-3)
let announceSeq = 0;        // sube con cada mensaje "form", anuncio o salida (D-3)
let announced = false;      // el último mensaje "form" enviado fue un anuncio
let refreshTimer = null;    // reanuncio del formulario propio (RNF-4)
let peerTimer = null;       // revisión de la caducidad de los peers (RNF-4)

// Datos del enlace de recuperación, leídos al cargar y antes de crear el cliente (D-2)
let authLink = readAuthLink(location.hash, location.search);

const PENDING_KEY = 'pending-recovery';

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
  const problem = configMessage(check);
  if (problem) return showConfig(problem);

  if (!client) {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);
    // setTimeout evita bloquear el cliente; los eventos no deciden la pantalla de arranque (D-2)
    client.auth.onAuthStateChange((event, session) => setTimeout(() => onAuthEvent(event, session), 0));
  }
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
    applySession(session);
    checkSessionAlive(); // RF-15 al abrir la app
  } else {
    applySession(null);
  }
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

function applySession(session) {
  if (session && !sessionActive) {
    sessionActive = true;
    showScreen('app');
    render();
    subscribeChanges();
    loadData();
  } else if (!session) {
    sessionActive = false;
    onNewPassword = false;
    unsubscribeChanges();
    state.meals.clear();
    hideError();
    showScreen('login');
  }
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
  signingOut = true;
  const { error } = await client.auth.signOut({ scope: 'local' });
  finishSigningOut();
  if (error) showError('No se ha podido cerrar la sesión. ' + translateError(error, navigator.onLine));
  else applySession(null);
}

// ===== Carga de datos =====
function mealAt(date, type) {
  return state.meals.get(mealKey(toISODate(date), type)) || null;
}

// Periodo visible según la vista y el día de referencia (logic.js)
function currentRange() {
  return visibleRange(state.view, state.refDate);
}

async function loadData() {
  if (!sessionActive) return;
  const requestId = ++state.requestId;
  const { from, to } = currentRange();
  $('loading-indicator').hidden = false;

  let result;
  try {
    result = await client.from('comidas').select('*')
      .gte('fecha', toISODate(from)).lte('fecha', toISODate(to));
  } catch (error) {
    result = { error };
  }
  if (requestId !== state.requestId) return; // llegó una petición más reciente

  $('loading-indicator').hidden = true;
  if (result.error) {
    showError('No se han podido cargar las comidas. ' + translateError(result.error, navigator.onLine), 'load');
    return;
  }
  hideError('load');
  state.meals = new Map(result.data.map((c) => [mealKey(c.fecha, c.tipo), c]));
  render();
}

// Agrupa varias recargas seguidas en una sola
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadData, 300);
}

// ===== Sincronización en tiempo real =====
function subscribeChanges() {
  unsubscribeChanges();
  subscribeForms();
  channel = client.channel('meal-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comidas' }, scheduleReload)
    .subscribe((channelStatus) => {
      const action = syncStatusAction(channelStatus, state.noticeKind);
      if (action === 'recover') {
        hideError('sync');
        scheduleReload();
      } else if (action === 'show') {
        showError('Se ha perdido la sincronización en tiempo real. Reintentando…', 'sync');
      }
    });
}

function unsubscribeChanges() {
  if (channel) client.removeChannel(channel);
  channel = null;
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
  $('form-save').disabled = saveDisabled;
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

// ===== Render =====
function render() {
  updateHeader();
  const calendar = $('calendar');
  if (state.view === 'month') calendar.replaceChildren(buildMonthView());
  else if (state.view === 'week') calendar.replaceChildren(buildWeekView());
  else calendar.replaceChildren(buildDayView());
}

function updateHeader() {
  document.querySelectorAll('.view-button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  $('period-title').textContent = periodTitle(state.view, state.refDate);
}

// Vista mensual: cuadrícula de días con puntos (móvil) o nombres (pantalla grande)
function buildMonthView() {
  const grid = el('div', 'month');
  for (const initial of ['L', 'M', 'X', 'J', 'V', 'S', 'D']) grid.append(el('div', 'month-header', initial));

  for (const { date, outside, isToday } of monthGrid(state.refDate, getToday())) {
    const cell = button('month-day', undefined, () => openDay(date));
    if (outside) cell.classList.add('outside');
    if (isToday) cell.classList.add('today');
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
    const card = el('section', 'week-day' + (isToday ? ' today' : ''));
    card.append(button('week-date', formatDate(date, { weekday: 'long', day: 'numeric' }), () => openDay(date)));

    for (const type of MEAL_TYPES) {
      const meal = mealAt(date, type.id);
      const onClick = meal
        ? () => openDay(date, type.id)
        : () => openForm({ date, type: type.id });
      const row = button('week-meal type-' + type.id + (meal ? '' : ' empty'), undefined, onClick);
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

// Vista diaria: un bloque por tipo de comida
function buildDayView() {
  const container = el('div', 'day');
  for (const type of MEAL_TYPES) container.append(buildBlock(state.refDate, type));
  return container;
}

function buildBlock(date, type) {
  const block = el('section', 'block type-' + type.id);
  const meal = mealAt(date, type.id);

  if (!meal) {
    const empty = el('div', 'block-empty');
    const texts = el('div');
    texts.append(el('span', 'block-type', type.name), el('p', null, 'Nada registrado'));
    empty.append(texts, button('btn', 'Añadir', () => openForm({ date, type: type.id })));
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
  buttons.append(
    button('btn', 'Editar', () => openForm({ meal })),
    button('btn btn-danger', 'Borrar', () => deleteMeal(meal)),
  );
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
  row.querySelector('.ingredient-name').value = data.nombre || '';
  row.querySelector('.ingredient-quantity').value = data.cantidad ?? '';
  row.querySelector('.ingredient-unit').value = data.unidad || '';
  row.querySelector('.ingredient-remove').addEventListener('click', () => row.remove());
  dish.ingredients.append(row);
}

function fillDish(dish, data) {
  dish.name.value = data?.nombre || '';
  dish.recipe.value = data?.receta || '';
  dish.reference.value = data?.referencia || '';
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
  if (!existing || searchId !== formState.searchId || formState.id) return;

  const hasData = dishHasData(readDish(formState.dish1)) || dishHasData(readDish(formState.dish2));
  if (hasData) {
    const load = await askConfirm(duplicateMessage(formState.type, 'confirm'), 'Editar la existente');
    if (!load) return;
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
  if (formState.savedElsewhere) return; // RF-4: también al enviar con Enter
  showFormError('');
  const { data: meal, error } = validateForm();
  if (error) return showFormError(error);

  formState.saving = true;
  refreshMatch();
  try {
    // Una sola entrada por día y tipo
    const existing = await fetchMeal(meal.fecha, meal.tipo);
    if (isOtherMeal(existing, formState.id)) return showFormError(duplicateMessage(meal.tipo, 'error'));

    if (formState.id) {
      const { data, error: saveError } = await client.from('comidas')
        .update(meal).eq('id', formState.id).select('id');
      if (saveError) throw saveError;
      if (wasDeleted(data)) return showFormError('Esta comida ya no existe; puede que la haya borrado la otra persona.');
    } else {
      const { error: saveError } = await client.from('comidas').insert(meal);
      if (saveError) throw saveError;
    }
    sendForms('saved', { date: meal.fecha, type: meal.tipo }); // RF-3 (D-6): sin esperar
    $('meal-dialog').close();
    loadData();
  } catch (saveError) {
    showFormError(saveErrorMessage(saveError, meal.tipo, navigator.onLine));
  } finally {
    formState.saving = false;
    refreshMatch();
  }
}

// ===== Borrado =====
async function deleteMeal(meal) {
  const text = deleteConfirmText(meal);
  if (!(await askConfirm(text, 'Borrar'))) return;

  const { error } = await client.from('comidas').delete().eq('id', meal.id);
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
  $('logout-button').addEventListener('click', logOut);

  document.querySelectorAll('.view-button').forEach((b) => b.addEventListener('click', () => changeView(b.dataset.view)));
  $('prev-button').addEventListener('click', () => shiftPeriod(-1));
  $('next-button').addEventListener('click', () => shiftPeriod(1));
  $('today-button').addEventListener('click', goToToday);
  $('add-button').addEventListener('click', () => openForm());
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
    if (document.visibilityState !== 'visible') return;
    loadData();
    checkSessionAlive();
  });
  window.addEventListener('online', () => {
    if (sessionActive) loadData();
    else if (!$('screen-config').hidden) connect();
  });
  window.addEventListener('offline', () => {
    if (sessionActive) showError('Sin conexión a internet. Los datos se actualizarán al recuperarla.', 'load');
  });
}

bindEvents();
connect();
