'use strict';

// ===== Claves de Supabase (solo la clave pública, nunca la secreta) =====
const SUPABASE_URL = 'https://beyarsihdhzpxzvsxeep.supabase.co';
const SUPABASE_CLAVE_PUBLICA = 'sb_publishable_BLEWWv74RigJ6Jo977E59A_2vs3nYk2';

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
};

let client = null;
let channel = null;
let sessionActive = false;
let authListening = false;
let reloadTimer = null;

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
  for (const screen of ['config', 'start', 'login', 'app']) {
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
      headers: { apikey: SUPABASE_CLAVE_PUBLICA },
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
    keysDefined: keysDefined(SUPABASE_URL, SUPABASE_CLAVE_PUBLICA),
    status: null,
  };
  // Solo se pregunta al servidor si hay librería y claves
  if (check.libraryLoaded && check.keysDefined) check.status = await checkServer();
  const problem = configMessage(check);
  if (problem) return showConfig(problem);

  if (!client) client = window.supabase.createClient(SUPABASE_URL, SUPABASE_CLAVE_PUBLICA);
  if (!authListening) {
    authListening = true;
    // Se lanza también al suscribirse (INITIAL_SESSION). setTimeout evita bloquear el cliente.
    client.auth.onAuthStateChange((_event, session) => setTimeout(() => applySession(session), 0));
  } else {
    const { data } = await client.auth.getSession();
    applySession(data.session);
  }
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
    unsubscribeChanges();
    state.meals.clear();
    hideError();
    showScreen('login');
  }
}

// ===== Inicio y cierre de sesión =====
function showLoginError(text) {
  $('login-error').textContent = text;
  $('login-error').hidden = !text;
}

async function submitLogin(event) {
  event.preventDefault();
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

async function logOut() {
  // Solo en este dispositivo: la otra sesión abierta sigue funcionando
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) showError('No se ha podido cerrar la sesión. ' + translateError(error, navigator.onLine));
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
        : () => openForm({ fecha: date, tipo: type.id });
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
    empty.append(texts, button('btn', 'Añadir', () => openForm({ fecha: date, tipo: type.id })));
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
    button('btn', 'Editar', () => openForm({ comida: meal })),
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
function askConfirm(texto, textoAceptar = 'Aceptar') {
  const dialogo = $('confirm-dialog');
  $('confirm-text').textContent = texto;
  $('confirm-yes').textContent = textoAceptar;
  dialogo.returnValue = '';
  return new Promise((resolver) => {
    dialogo.addEventListener('close', () => resolver(dialogo.returnValue === 'si'), { once: true });
    dialogo.showModal();
  });
}

// ===== Formulario: platos e ingredientes =====
function buildFormDish(contenedor) {
  const nodo = $('dish-template').content.firstElementChild.cloneNode(true);
  const buscar = (selector) => nodo.querySelector(selector);
  const plato = {
    nodo,
    titulo: buscar('.dish-title'),
    etiquetaNombre: buscar('.dish-name-label'),
    nombre: buscar('.dish-name'),
    ingredientes: buscar('.ingredients'),
    receta: buscar('.dish-recipe'),
    referencia: buscar('.dish-reference'),
  };
  buscar('.dish-add-ingredient').addEventListener('click', () => addIngredient(plato));
  contenedor.append(nodo);
  return plato;
}

function addIngredient(plato, datos = {}) {
  const fila = $('ingredient-template').content.firstElementChild.cloneNode(true);
  fila.querySelector('.ingredient-name').value = datos.nombre || '';
  fila.querySelector('.ingredient-quantity').value = datos.cantidad ?? '';
  fila.querySelector('.ingredient-unit').value = datos.unidad || '';
  fila.querySelector('.ingredient-remove').addEventListener('click', () => fila.remove());
  plato.ingredientes.append(fila);
}

function fillDish(plato, datos) {
  plato.nombre.value = datos?.nombre || '';
  plato.receta.value = datos?.receta || '';
  plato.referencia.value = datos?.referencia || '';
  plato.ingredientes.replaceChildren();
  const ingredientes = datos?.ingredientes || [];
  if (ingredientes.length) ingredientes.forEach((ing) => addIngredient(plato, ing));
  else addIngredient(plato);
}

function readRows(plato) {
  return [...plato.ingredientes.querySelectorAll('.ingredient')].map((fila) => ({
    fila,
    nombre: fila.querySelector('.ingredient-name'),
    cantidad: fila.querySelector('.ingredient-quantity'),
    unidad: fila.querySelector('.ingredient-unit'),
  }));
}

// Valores en bruto de una fila y de un plato, para la lógica (D-6)
function readRow(f) {
  return { name: f.nombre.value, quantity: f.cantidad.value, badInput: f.cantidad.validity.badInput, unit: f.unidad.value };
}

function readDish(plato) {
  return {
    name: plato.nombre.value,
    recipe: plato.receta.value,
    reference: plato.referencia.value,
    rows: readRows(plato).map(readRow),
  };
}

// Muestra u oculta el segundo plato según el tipo elegido
function updateDishes() {
  const layout = formDishLayout(formState.type, dishHasData(readDish(formState.dish2)));
  formState.dish1.titulo.textContent = layout.firstTitle;
  formState.dish2.titulo.textContent = layout.secondTitle;
  formState.dish2.nodo.hidden = layout.secondHidden;
  $('form-remove-second').hidden = !layout.showRemoveSecond;
  if (layout.error) showFormError(layout.error);
}

function chooseType(tipo) {
  formState.type = tipo;
  document.querySelectorAll('.type-button').forEach((b) => b.classList.toggle('active', b.dataset.type === tipo));
  showFormError('');
  updateDishes();
}

function removeSecondDish() {
  fillDish(formState.dish2, null);
  showFormError('');
  updateDishes();
}

// ===== Formulario: abrir y cargar =====
function showFormError(texto) {
  $('form-error').textContent = texto;
  $('form-error').hidden = !texto;
}

function showFormNotice(texto) {
  $('form-notice').textContent = texto;
  $('form-notice').hidden = !texto;
}

function clearMarks() {
  document.querySelectorAll('#meal-form .invalid-field').forEach((n) => n.classList.remove('invalid-field'));
}

function fillForm({ id = null, fecha, tipo = null, platos = [] }) {
  formState.id = id;
  $('form-title').textContent = id ? 'Editar comida' : 'Añadir comida';
  $('form-date').value = fecha;
  fillDish(formState.dish1, platos[0]);
  fillDish(formState.dish2, platos[1]);
  clearMarks();
  showFormNotice('');
  chooseType(tipo);
}

// Abre el formulario para una comida concreta, o para una fecha/tipo (edita si ya existe)
function openForm({ comida = null, fecha = null, tipo = null } = {}) {
  const existente = comida || (fecha && tipo ? mealAt(fecha, tipo) : null);
  if (existente) {
    fillForm(existente);
  } else {
    const fechaInicial = fecha || initialFormDate(state.view, state.refDate, getToday());
    fillForm({ fecha: toISODate(fechaInicial), tipo });
    if (tipo) checkExisting();
  }
  $('meal-dialog').showModal();
}

async function fetchMeal(fechaISO, tipo) {
  const { data, error } = await client.from('comidas').select('*')
    .eq('fecha', fechaISO).eq('tipo', tipo).maybeSingle();
  if (error) throw error;
  return data;
}

// En una entrada nueva: si la fecha y el tipo ya tienen comida, se pasa a editarla
async function checkExisting() {
  const fechaISO = $('form-date').value;
  if (formState.id || !fechaISO || !formState.type) return;
  const busqueda = ++formState.searchId;
  let existente;
  try {
    existente = await fetchMeal(fechaISO, formState.type);
  } catch {
    return; // se volverá a comprobar al guardar
  }
  if (!existente || busqueda !== formState.searchId || formState.id) return;

  const hayDatos = dishHasData(readDish(formState.dish1)) || dishHasData(readDish(formState.dish2));
  if (hayDatos) {
    const cargar = await askConfirm(duplicateMessage(formState.type, 'confirm'), 'Editar la existente');
    if (!cargar) return;
  }
  fillForm(existente);
  showFormNotice(duplicateMessage(existente.tipo, 'editing'));
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
  const rowField = { name: 'nombre', quantity: 'cantidad', unit: 'unidad' };
  const dishField = { name: 'nombre', reference: 'referencia' };
  for (const { dish, field, row } of invalid) {
    let node;
    if (field === 'date') node = $('form-date');
    else if (row !== undefined) node = readRows(dishes[dish])[row][rowField[field]];
    else node = dishes[dish][dishField[field]];
    node.classList.add('invalid-field');
  }
}

// Devuelve { data } listo para guardar o { error }, con los campos marcados
function validateForm() {
  clearMarks();
  const raw = readForm();
  const resultado = validateMealForm(raw);
  if (!resultado.error) return resultado;
  markInvalid(resultado.invalid);
  // Desayuno con dos platos: se vuelve a enseñar el botón "Eliminar segundo plato", como antes
  if (formDishLayout(raw.type, dishHasData(raw.dishes[1])).showRemoveSecond) updateDishes();
  return resultado;
}

async function saveMeal(evento) {
  evento.preventDefault();
  showFormError('');
  const { data: datos, error } = validateForm();
  if (error) return showFormError(error);

  $('form-save').disabled = true;
  try {
    // Una sola entrada por día y tipo
    const existente = await fetchMeal(datos.fecha, datos.tipo);
    if (isOtherMeal(existente, formState.id)) return showFormError(duplicateMessage(datos.tipo, 'error'));

    if (formState.id) {
      const { data, error: errorGuardar } = await client.from('comidas')
        .update(datos).eq('id', formState.id).select('id');
      if (errorGuardar) throw errorGuardar;
      if (wasDeleted(data)) return showFormError('Esta comida ya no existe; puede que la haya borrado la otra persona.');
    } else {
      const { error: errorGuardar } = await client.from('comidas').insert(datos);
      if (errorGuardar) throw errorGuardar;
    }
    $('meal-dialog').close();
    loadData();
  } catch (errorGuardar) {
    showFormError(saveErrorMessage(errorGuardar, datos.tipo, navigator.onLine));
  } finally {
    $('form-save').disabled = false;
  }
}

// ===== Borrado =====
async function deleteMeal(comida) {
  const texto = deleteConfirmText(comida);
  if (!(await askConfirm(texto, 'Borrar'))) return;

  const { error } = await client.from('comidas').delete().eq('id', comida.id);
  if (error) return showError('No se ha podido borrar la comida. ' + translateError(error, navigator.onLine));
  state.openType = null;
  loadData();
}

// ===== Eventos =====
function bindEvents() {
  $('config-retry').addEventListener('click', connect);
  $('form-login').addEventListener('submit', submitLogin);
  $('logout-button').addEventListener('click', logOut);

  document.querySelectorAll('.view-button').forEach((b) => b.addEventListener('click', () => changeView(b.dataset.view)));
  $('prev-button').addEventListener('click', () => shiftPeriod(-1));
  $('next-button').addEventListener('click', () => shiftPeriod(1));
  $('today-button').addEventListener('click', goToToday);
  $('add-button').addEventListener('click', () => openForm());
  $('error-notice-close').addEventListener('click', () => hideError());

  formState.dish1 = buildFormDish($('form-dish-1'));
  formState.dish2 = buildFormDish($('form-dish-2'));
  formState.dish1.etiquetaNombre.textContent = 'Nombre de receta *';
  document.querySelectorAll('.type-button').forEach((b) => b.addEventListener('click', () => {
    chooseType(b.dataset.type);
    checkExisting();
  }));
  $('form-date').addEventListener('change', checkExisting);
  $('form-remove-second').addEventListener('click', removeSecondDish);
  $('form-cancel').addEventListener('click', () => $('meal-dialog').close());
  $('meal-form').addEventListener('submit', saveMeal);

  $('confirm-yes').addEventListener('click', () => $('confirm-dialog').close('si'));
  $('confirm-no').addEventListener('click', () => $('confirm-dialog').close('no'));

  // Recargar al volver a primer plano y al recuperar la conexión
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadData();
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
