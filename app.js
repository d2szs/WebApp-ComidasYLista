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
  noticeKind: null,     // origen del aviso visible: 'carga' | 'sync' | 'accion'
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
function el(etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function button(clase, texto, alPulsar) {
  const nodo = el('button', clase, texto);
  nodo.type = 'button';
  nodo.addEventListener('click', alPulsar);
  return nodo;
}

function showScreen(nombre) {
  for (const pantalla of ['config', 'start', 'login', 'app']) {
    $('screen-' + pantalla).hidden = pantalla !== nombre;
  }
}

// ===== Avisos y errores =====
function showError(texto, tipo = 'accion') {
  $('error-notice-text').textContent = texto;
  $('error-notice').hidden = false;
  state.noticeKind = tipo;
}

// Oculta el aviso (si se indica tipo, solo cuando el aviso es de ese tipo)
function hideError(tipo) {
  if (tipo && state.noticeKind !== tipo) return;
  $('error-notice').hidden = true;
  state.noticeKind = null;
}

// ===== Arranque y conexión =====
function showConfig(mensaje) {
  $('config-message').textContent = mensaje;
  showScreen('config');
}

// Pregunta a Supabase si responde. Devuelve el código HTTP, o null si no responde a tiempo.
async function checkServer() {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), CONNECTION_TIMEOUT);
  try {
    const respuesta = await fetch(SUPABASE_URL + '/auth/v1/health', {
      headers: { apikey: SUPABASE_CLAVE_PUBLICA },
      signal: control.signal,
    });
    return respuesta.status;
  } catch {
    return null;
  } finally {
    clearTimeout(temporizador);
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
    client.auth.onAuthStateChange((_evento, sesion) => setTimeout(() => applySession(sesion), 0));
  } else {
    const { data } = await client.auth.getSession();
    applySession(data.session);
  }
}

function applySession(sesion) {
  if (sesion && !sessionActive) {
    sessionActive = true;
    showScreen('app');
    render();
    subscribeChanges();
    loadData();
  } else if (!sesion) {
    sessionActive = false;
    unsubscribeChanges();
    state.meals.clear();
    hideError();
    showScreen('login');
  }
}

// ===== Inicio y cierre de sesión =====
function showLoginError(texto) {
  $('login-error').textContent = texto;
  $('login-error').hidden = !texto;
}

async function submitLogin(evento) {
  evento.preventDefault();
  const email = $('login-email').value.trim();
  const clave = $('login-password').value;
  const inputError = loginInputError(email, clave);
  if (inputError) return showLoginError(inputError);

  showLoginError('');
  $('login-button').disabled = true;
  $('login-button').textContent = 'Entrando…';
  const { error } = await client.auth.signInWithPassword({ email, password: clave });
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
function mealAt(fecha, tipo) {
  return state.meals.get(mealKey(toISODate(fecha), tipo)) || null;
}

// Periodo visible según la vista y el día de referencia (logic.js)
function currentRange() {
  return visibleRange(state.view, state.refDate);
}

async function loadData() {
  if (!sessionActive) return;
  const peticion = ++state.requestId;
  const { from: desde, to: hasta } = currentRange();
  $('loading-indicator').hidden = false;

  let resultado;
  try {
    resultado = await client.from('comidas').select('*')
      .gte('fecha', toISODate(desde)).lte('fecha', toISODate(hasta));
  } catch (error) {
    resultado = { error };
  }
  if (peticion !== state.requestId) return; // llegó una petición más reciente

  $('loading-indicator').hidden = true;
  if (resultado.error) {
    showError('No se han podido cargar las comidas. ' + translateError(resultado.error, navigator.onLine), 'carga');
    return;
  }
  hideError('carga');
  state.meals = new Map(resultado.data.map((c) => [mealKey(c.fecha, c.tipo), c]));
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
  channel = client.channel('comidas-cambios')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comidas' }, scheduleReload)
    .subscribe((estadoCanal) => {
      const accion = syncStatusAction(estadoCanal, state.noticeKind);
      if (accion === 'recover') {
        hideError('sync');
        scheduleReload();
      } else if (accion === 'show') {
        showError('Se ha perdido la sincronización en tiempo real. Reintentando…', 'sync');
      }
    });
}

function unsubscribeChanges() {
  if (channel) client.removeChannel(channel);
  channel = null;
}

// ===== Navegación =====
function changeView(vista) {
  state.view = vista;
  state.openType = null;
  render();
  loadData();
}

function shiftPeriod(sentido) {
  state.refDate = movePeriod(state.view, state.refDate, sentido);
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

function openDay(fecha, tipoAbierto = null) {
  state.view = 'day';
  state.refDate = fecha;
  state.openType = tipoAbierto;
  render();
  loadData();
}

// ===== Render =====
function render() {
  updateHeader();
  const calendario = $('calendar');
  if (state.view === 'month') calendario.replaceChildren(buildMonthView());
  else if (state.view === 'week') calendario.replaceChildren(buildWeekView());
  else calendario.replaceChildren(buildDayView());
}

function updateHeader() {
  document.querySelectorAll('.view-button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  $('period-title').textContent = periodTitle(state.view, state.refDate);
}

// Vista mensual: cuadrícula de días con puntos (móvil) o nombres (pantalla grande)
function buildMonthView() {
  const rejilla = el('div', 'month');
  for (const inicial of ['L', 'M', 'X', 'J', 'V', 'S', 'D']) rejilla.append(el('div', 'month-header', inicial));

  for (const { date: fecha, outside, isToday } of monthGrid(state.refDate, getToday())) {
    const celda = button('month-day', undefined, () => openDay(fecha));
    if (outside) celda.classList.add('outside');
    if (isToday) celda.classList.add('today');
    celda.setAttribute('aria-label', longDate(fecha));
    celda.append(el('div', 'month-number', String(fecha.getDate())));

    const lista = el('div', 'month-meals');
    for (const tipo of MEAL_TYPES) {
      const comida = mealAt(fecha, tipo.id);
      if (!comida) continue;
      const item = el('div', 'month-meal type-' + tipo.id);
      item.title = tipo.name + ': ' + comida.platos[0].nombre;
      item.append(el('span', 'dot'), el('span', 'month-meal-name', comida.platos[0].nombre));
      lista.append(item);
    }
    celda.append(lista);
    rejilla.append(celda);
  }
  return rejilla;
}

// Vista semanal: siete días con sus tres comidas
function buildWeekView() {
  const semana = el('div', 'week');
  for (const { date: fecha, isToday } of weekDays(state.refDate, getToday())) {
    const tarjeta = el('section', 'week-day' + (isToday ? ' today' : ''));
    tarjeta.append(button('week-date', formatDate(fecha, { weekday: 'long', day: 'numeric' }), () => openDay(fecha)));

    for (const tipo of MEAL_TYPES) {
      const comida = mealAt(fecha, tipo.id);
      const alPulsar = comida
        ? () => openDay(fecha, tipo.id)
        : () => openForm({ fecha, tipo: tipo.id });
      const fila = button('week-meal type-' + tipo.id + (comida ? '' : ' empty'), undefined, alPulsar);
      fila.append(
        el('span', 'week-meal-type', tipo.name),
        el('span', 'week-meal-name', comida ? dishNames(comida) : '—'),
      );
      tarjeta.append(fila);
    }
    semana.append(tarjeta);
  }
  return semana;
}

// Vista diaria: un bloque por tipo de comida
function buildDayView() {
  const contenedor = el('div', 'day');
  for (const tipo of MEAL_TYPES) contenedor.append(buildBlock(state.refDate, tipo));
  return contenedor;
}

function buildBlock(fecha, tipo) {
  const bloque = el('section', 'block type-' + tipo.id);
  const comida = mealAt(fecha, tipo.id);

  if (!comida) {
    const vacio = el('div', 'block-empty');
    const textos = el('div');
    textos.append(el('span', 'block-type', tipo.name), el('p', null, 'Nada registrado'));
    vacio.append(textos, button('btn', 'Añadir', () => openForm({ fecha, tipo: tipo.id })));
    bloque.append(vacio);
    return bloque;
  }

  const abierto = state.openType === tipo.id;
  const cabecera = button('block-header', undefined, () => {
    state.openType = abierto ? null : tipo.id;
    render();
  });
  cabecera.setAttribute('aria-expanded', String(abierto));
  cabecera.append(el('span', 'block-type', tipo.name), el('span', 'block-summary', dishNames(comida)));
  bloque.append(cabecera);
  if (abierto) bloque.append(buildDetail(comida));
  return bloque;
}

function buildDetail(comida) {
  const detalle = el('div', 'block-detail');
  comida.platos.forEach((plato, indice) => detalle.append(buildDishDetail(plato, dishTitle(comida.tipo, indice))));

  const botones = el('div', 'detail-buttons');
  botones.append(
    button('btn', 'Editar', () => openForm({ comida })),
    button('btn btn-danger', 'Borrar', () => deleteMeal(comida)),
  );
  detalle.append(botones);
  return detalle;
}

function buildDishDetail(plato, titulo) {
  const caja = el('div', 'detail-dish');
  caja.append(el('p', 'detail-subtitle', titulo), el('h3', null, plato.nombre));

  if (plato.ingredientes?.length) {
    const lista = el('ul');
    for (const ing of plato.ingredientes) lista.append(el('li', null, formatIngredient(ing)));
    caja.append(el('p', 'detail-subtitle', 'Ingredientes'), lista);
  }
  if (plato.receta) {
    caja.append(el('p', 'detail-subtitle', 'Receta'), el('p', 'detail-recipe', plato.receta));
  }
  const enlace = safeLink(plato.referencia);
  if (enlace) {
    const a = el('a', null, enlace);
    a.href = enlace;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    caja.append(el('p', 'detail-subtitle', 'Referencia'), a);
  }
  return caja;
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
    if (sessionActive) showError('Sin conexión a internet. Los datos se actualizarán al recuperarla.', 'carga');
  });
}

bindEvents();
connect();
