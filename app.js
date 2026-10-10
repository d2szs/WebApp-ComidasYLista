'use strict';

// ===== Claves de Supabase (solo la clave pública, nunca la secreta) =====
const SUPABASE_URL = 'https://beyarsihdhzpxzvsxeep.supabase.co';
const SUPABASE_CLAVE_PUBLICA = 'sb_publishable_BLEWWv74RigJ6Jo977E59A_2vs3nYk2';

// ===== Constantes =====
const MENSAJE_DUPLICADO = 'Ya hay una comida registrada ese día';
const TIEMPO_MAXIMO_CONEXION = 8000;
// Nombre de cada vista en logic.js
const VISTA_LOGICA = { dia: 'day', semana: 'week', mes: 'month' };

// ===== Estado =====
const estado = {
  vista: 'semana',      // 'mes' | 'semana' | 'dia'
  fechaRef: hoy(),      // día de referencia del periodo visible
  comidas: new Map(),   // 'aaaa-mm-dd|tipo' → fila
  abierto: null,        // tipo desplegado en la vista diaria
  peticion: 0,          // para descartar respuestas antiguas
  avisoTipo: null,      // origen del aviso visible: 'carga' | 'sync' | 'accion'
};

const formulario = {
  id: null,             // id de la entrada en edición (null = nueva)
  tipo: null,
  plato1: null,
  plato2: null,
  busqueda: 0,          // para descartar búsquedas antiguas de entradas existentes
};

let cliente = null;
let canal = null;
let sesionActiva = false;
let escuchandoSesion = false;
let temporizadorRecarga = null;

const $ = (id) => document.getElementById(id);

// ===== Hoy: único sitio que lee el reloj; se pasa a logic.js como dato (D-5) =====
function hoy() {
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

function boton(clase, texto, alPulsar) {
  const nodo = el('button', clase, texto);
  nodo.type = 'button';
  nodo.addEventListener('click', alPulsar);
  return nodo;
}

function mostrarPantalla(nombre) {
  for (const pantalla of ['config', 'inicio', 'login', 'app']) {
    $('pantalla-' + pantalla).hidden = pantalla !== nombre;
  }
}

// ===== Avisos y errores =====
function mostrarError(texto, tipo = 'accion') {
  $('aviso-error-texto').textContent = texto;
  $('aviso-error').hidden = false;
  estado.avisoTipo = tipo;
}

// Oculta el aviso (si se indica tipo, solo cuando el aviso es de ese tipo)
function ocultarError(tipo) {
  if (tipo && estado.avisoTipo !== tipo) return;
  $('aviso-error').hidden = true;
  estado.avisoTipo = null;
}

// ===== Arranque y conexión =====
function mostrarConfig(mensaje) {
  $('config-mensaje').textContent = mensaje;
  mostrarPantalla('config');
}

// Pregunta a Supabase si responde. Devuelve el código HTTP, o null si no responde a tiempo.
async function comprobarServidor() {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIEMPO_MAXIMO_CONEXION);
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

async function conectar() {
  mostrarPantalla('inicio');
  const check = {
    libraryLoaded: Boolean(window.supabase),
    keysDefined: keysDefined(SUPABASE_URL, SUPABASE_CLAVE_PUBLICA),
    status: null,
  };
  // Solo se pregunta al servidor si hay librería y claves
  if (check.libraryLoaded && check.keysDefined) check.status = await comprobarServidor();
  const problem = configMessage(check);
  if (problem) return mostrarConfig(problem);

  if (!cliente) cliente = window.supabase.createClient(SUPABASE_URL, SUPABASE_CLAVE_PUBLICA);
  if (!escuchandoSesion) {
    escuchandoSesion = true;
    // Se lanza también al suscribirse (INITIAL_SESSION). setTimeout evita bloquear el cliente.
    cliente.auth.onAuthStateChange((_evento, sesion) => setTimeout(() => aplicarSesion(sesion), 0));
  } else {
    const { data } = await cliente.auth.getSession();
    aplicarSesion(data.session);
  }
}

function aplicarSesion(sesion) {
  if (sesion && !sesionActiva) {
    sesionActiva = true;
    mostrarPantalla('app');
    render();
    suscribirCambios();
    cargarDatos();
  } else if (!sesion) {
    sesionActiva = false;
    quitarSuscripcion();
    estado.comidas.clear();
    ocultarError();
    mostrarPantalla('login');
  }
}

// ===== Inicio y cierre de sesión =====
function mostrarErrorLogin(texto) {
  $('login-error').textContent = texto;
  $('login-error').hidden = !texto;
}

async function enviarLogin(evento) {
  evento.preventDefault();
  const email = $('login-email').value.trim();
  const clave = $('login-clave').value;
  const inputError = loginInputError(email, clave);
  if (inputError) return mostrarErrorLogin(inputError);

  mostrarErrorLogin('');
  $('login-boton').disabled = true;
  $('login-boton').textContent = 'Entrando…';
  const { error } = await cliente.auth.signInWithPassword({ email, password: clave });
  $('login-boton').disabled = false;
  $('login-boton').textContent = 'Entrar';
  if (error) return mostrarErrorLogin(translateLoginError(error, navigator.onLine));
  $('login-clave').value = '';
}

async function cerrarSesion() {
  // Solo en este dispositivo: la otra sesión abierta sigue funcionando
  const { error } = await cliente.auth.signOut({ scope: 'local' });
  if (error) mostrarError('No se ha podido cerrar la sesión. ' + translateError(error, navigator.onLine));
}

// ===== Carga de datos =====
function comidaDe(fecha, tipo) {
  return estado.comidas.get(mealKey(toISODate(fecha), tipo)) || null;
}

// Periodo visible según la vista y el día de referencia (logic.js)
function rangoVisible() {
  return visibleRange(VISTA_LOGICA[estado.vista], estado.fechaRef);
}

async function cargarDatos() {
  if (!sesionActiva) return;
  const peticion = ++estado.peticion;
  const { from: desde, to: hasta } = rangoVisible();
  $('indicador-carga').hidden = false;

  let resultado;
  try {
    resultado = await cliente.from('comidas').select('*')
      .gte('fecha', toISODate(desde)).lte('fecha', toISODate(hasta));
  } catch (error) {
    resultado = { error };
  }
  if (peticion !== estado.peticion) return; // llegó una petición más reciente

  $('indicador-carga').hidden = true;
  if (resultado.error) {
    mostrarError('No se han podido cargar las comidas. ' + translateError(resultado.error, navigator.onLine), 'carga');
    return;
  }
  ocultarError('carga');
  estado.comidas = new Map(resultado.data.map((c) => [mealKey(c.fecha, c.tipo), c]));
  render();
}

// Agrupa varias recargas seguidas en una sola
function programarRecarga() {
  clearTimeout(temporizadorRecarga);
  temporizadorRecarga = setTimeout(cargarDatos, 300);
}

// ===== Sincronización en tiempo real =====
function suscribirCambios() {
  quitarSuscripcion();
  canal = cliente.channel('comidas-cambios')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comidas' }, programarRecarga)
    .subscribe((estadoCanal) => {
      const accion = syncStatusAction(estadoCanal, estado.avisoTipo);
      if (accion === 'recover') {
        ocultarError('sync');
        programarRecarga();
      } else if (accion === 'show') {
        mostrarError('Se ha perdido la sincronización en tiempo real. Reintentando…', 'sync');
      }
    });
}

function quitarSuscripcion() {
  if (canal) cliente.removeChannel(canal);
  canal = null;
}

// ===== Navegación =====
function cambiarVista(vista) {
  estado.vista = vista;
  estado.abierto = null;
  render();
  cargarDatos();
}

function moverPeriodo(sentido) {
  estado.fechaRef = movePeriod(VISTA_LOGICA[estado.vista], estado.fechaRef, sentido);
  estado.abierto = null;
  render();
  cargarDatos();
}

function irAHoy() {
  estado.fechaRef = hoy();
  estado.abierto = null;
  render();
  cargarDatos();
}

function abrirDia(fecha, tipoAbierto = null) {
  estado.vista = 'dia';
  estado.fechaRef = fecha;
  estado.abierto = tipoAbierto;
  render();
  cargarDatos();
}

// ===== Render =====
function render() {
  actualizarCabecera();
  const calendario = $('calendario');
  if (estado.vista === 'mes') calendario.replaceChildren(crearVistaMes());
  else if (estado.vista === 'semana') calendario.replaceChildren(crearVistaSemana());
  else calendario.replaceChildren(crearVistaDia());
}

function actualizarCabecera() {
  document.querySelectorAll('.boton-vista').forEach((b) => {
    b.classList.toggle('activo', b.dataset.vista === estado.vista);
  });
  $('titulo-periodo').textContent = periodTitle(VISTA_LOGICA[estado.vista], estado.fechaRef);
}

// Vista mensual: cuadrícula de días con puntos (móvil) o nombres (pantalla grande)
function crearVistaMes() {
  const rejilla = el('div', 'mes');
  for (const inicial of ['L', 'M', 'X', 'J', 'V', 'S', 'D']) rejilla.append(el('div', 'mes-cabecera', inicial));

  for (const { date: fecha, outside, isToday } of monthGrid(estado.fechaRef, hoy())) {
    const celda = boton('mes-dia', undefined, () => abrirDia(fecha));
    if (outside) celda.classList.add('fuera');
    if (isToday) celda.classList.add('hoy');
    celda.setAttribute('aria-label', longDate(fecha));
    celda.append(el('div', 'mes-numero', String(fecha.getDate())));

    const lista = el('div', 'mes-comidas');
    for (const tipo of MEAL_TYPES) {
      const comida = comidaDe(fecha, tipo.id);
      if (!comida) continue;
      const item = el('div', 'mes-comida tipo-' + tipo.id);
      item.title = tipo.name + ': ' + comida.platos[0].nombre;
      item.append(el('span', 'punto'), el('span', 'mes-comida-nombre', comida.platos[0].nombre));
      lista.append(item);
    }
    celda.append(lista);
    rejilla.append(celda);
  }
  return rejilla;
}

// Vista semanal: siete días con sus tres comidas
function crearVistaSemana() {
  const semana = el('div', 'semana');
  for (const { date: fecha, isToday } of weekDays(estado.fechaRef, hoy())) {
    const tarjeta = el('section', 'semana-dia' + (isToday ? ' hoy' : ''));
    tarjeta.append(boton('semana-fecha', formatDate(fecha, { weekday: 'long', day: 'numeric' }), () => abrirDia(fecha)));

    for (const tipo of MEAL_TYPES) {
      const comida = comidaDe(fecha, tipo.id);
      const alPulsar = comida
        ? () => abrirDia(fecha, tipo.id)
        : () => abrirFormulario({ fecha, tipo: tipo.id });
      const fila = boton('semana-comida tipo-' + tipo.id + (comida ? '' : ' vacia'), undefined, alPulsar);
      fila.append(
        el('span', 'semana-comida-tipo', tipo.name),
        el('span', 'semana-comida-nombre', comida ? dishNames(comida) : '—'),
      );
      tarjeta.append(fila);
    }
    semana.append(tarjeta);
  }
  return semana;
}

// Vista diaria: un bloque por tipo de comida
function crearVistaDia() {
  const contenedor = el('div', 'dia');
  for (const tipo of MEAL_TYPES) contenedor.append(crearBloque(estado.fechaRef, tipo));
  return contenedor;
}

function crearBloque(fecha, tipo) {
  const bloque = el('section', 'bloque tipo-' + tipo.id);
  const comida = comidaDe(fecha, tipo.id);

  if (!comida) {
    const vacio = el('div', 'bloque-vacio');
    const textos = el('div');
    textos.append(el('span', 'bloque-tipo', tipo.name), el('p', null, 'Nada registrado'));
    vacio.append(textos, boton('boton', 'Añadir', () => abrirFormulario({ fecha, tipo: tipo.id })));
    bloque.append(vacio);
    return bloque;
  }

  const abierto = estado.abierto === tipo.id;
  const cabecera = boton('bloque-cabecera', undefined, () => {
    estado.abierto = abierto ? null : tipo.id;
    render();
  });
  cabecera.setAttribute('aria-expanded', String(abierto));
  cabecera.append(el('span', 'bloque-tipo', tipo.name), el('span', 'bloque-resumen', dishNames(comida)));
  bloque.append(cabecera);
  if (abierto) bloque.append(crearDetalle(comida));
  return bloque;
}

function crearDetalle(comida) {
  const detalle = el('div', 'bloque-detalle');
  comida.platos.forEach((plato, indice) => detalle.append(crearDetallePlato(plato, dishTitle(comida.tipo, indice))));

  const botones = el('div', 'detalle-botones');
  botones.append(
    boton('boton', 'Editar', () => abrirFormulario({ comida })),
    boton('boton boton-peligro', 'Borrar', () => borrarComida(comida)),
  );
  detalle.append(botones);
  return detalle;
}

function crearDetallePlato(plato, titulo) {
  const caja = el('div', 'detalle-plato');
  caja.append(el('p', 'detalle-subtitulo', titulo), el('h3', null, plato.nombre));

  if (plato.ingredientes?.length) {
    const lista = el('ul');
    for (const ing of plato.ingredientes) lista.append(el('li', null, formatIngredient(ing)));
    caja.append(el('p', 'detalle-subtitulo', 'Ingredientes'), lista);
  }
  if (plato.receta) {
    caja.append(el('p', 'detalle-subtitulo', 'Receta'), el('p', 'detalle-receta', plato.receta));
  }
  const enlace = safeLink(plato.referencia);
  if (enlace) {
    const a = el('a', null, enlace);
    a.href = enlace;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    caja.append(el('p', 'detalle-subtitulo', 'Referencia'), a);
  }
  return caja;
}

// ===== Confirmación =====
function confirmar(texto, textoAceptar = 'Aceptar') {
  const dialogo = $('dialogo-confirmar');
  $('confirmar-texto').textContent = texto;
  $('confirmar-si').textContent = textoAceptar;
  dialogo.returnValue = '';
  return new Promise((resolver) => {
    dialogo.addEventListener('close', () => resolver(dialogo.returnValue === 'si'), { once: true });
    dialogo.showModal();
  });
}

// ===== Formulario: platos e ingredientes =====
function crearPlatoFormulario(contenedor) {
  const nodo = $('plantilla-plato').content.firstElementChild.cloneNode(true);
  const buscar = (selector) => nodo.querySelector(selector);
  const plato = {
    nodo,
    titulo: buscar('.plato-titulo'),
    etiquetaNombre: buscar('.plato-etiqueta-nombre'),
    nombre: buscar('.plato-nombre'),
    ingredientes: buscar('.ingredientes'),
    receta: buscar('.plato-receta'),
    referencia: buscar('.plato-referencia'),
  };
  buscar('.plato-anadir-ingrediente').addEventListener('click', () => anadirIngrediente(plato));
  contenedor.append(nodo);
  return plato;
}

function anadirIngrediente(plato, datos = {}) {
  const fila = $('plantilla-ingrediente').content.firstElementChild.cloneNode(true);
  fila.querySelector('.ingrediente-nombre').value = datos.nombre || '';
  fila.querySelector('.ingrediente-cantidad').value = datos.cantidad ?? '';
  fila.querySelector('.ingrediente-unidad').value = datos.unidad || '';
  fila.querySelector('.ingrediente-quitar').addEventListener('click', () => fila.remove());
  plato.ingredientes.append(fila);
}

function rellenarPlato(plato, datos) {
  plato.nombre.value = datos?.nombre || '';
  plato.receta.value = datos?.receta || '';
  plato.referencia.value = datos?.referencia || '';
  plato.ingredientes.replaceChildren();
  const ingredientes = datos?.ingredientes || [];
  if (ingredientes.length) ingredientes.forEach((ing) => anadirIngrediente(plato, ing));
  else anadirIngrediente(plato);
}

function leerFilas(plato) {
  return [...plato.ingredientes.querySelectorAll('.ingrediente')].map((fila) => ({
    fila,
    nombre: fila.querySelector('.ingrediente-nombre'),
    cantidad: fila.querySelector('.ingrediente-cantidad'),
    unidad: fila.querySelector('.ingrediente-unidad'),
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
    rows: leerFilas(plato).map(readRow),
  };
}

// Muestra u oculta el segundo plato según el tipo elegido
function actualizarPlatos() {
  const layout = formDishLayout(formulario.tipo, dishHasData(readDish(formulario.plato2)));
  formulario.plato1.titulo.textContent = layout.firstTitle;
  formulario.plato2.titulo.textContent = layout.secondTitle;
  formulario.plato2.nodo.hidden = layout.secondHidden;
  $('form-quitar-segundo').hidden = !layout.showRemoveSecond;
  if (layout.error) mostrarErrorFormulario(layout.error);
}

function elegirTipo(tipo) {
  formulario.tipo = tipo;
  document.querySelectorAll('.boton-tipo').forEach((b) => b.classList.toggle('activo', b.dataset.tipo === tipo));
  mostrarErrorFormulario('');
  actualizarPlatos();
}

function quitarSegundoPlato() {
  rellenarPlato(formulario.plato2, null);
  mostrarErrorFormulario('');
  actualizarPlatos();
}

// ===== Formulario: abrir y cargar =====
function mostrarErrorFormulario(texto) {
  $('form-error').textContent = texto;
  $('form-error').hidden = !texto;
}

function mostrarAvisoFormulario(texto) {
  $('form-aviso').textContent = texto;
  $('form-aviso').hidden = !texto;
}

function limpiarMarcas() {
  document.querySelectorAll('#form-comida .campo-invalido').forEach((n) => n.classList.remove('campo-invalido'));
}

function cargarEnFormulario({ id = null, fecha, tipo = null, platos = [] }) {
  formulario.id = id;
  $('form-titulo').textContent = id ? 'Editar comida' : 'Añadir comida';
  $('form-fecha').value = fecha;
  rellenarPlato(formulario.plato1, platos[0]);
  rellenarPlato(formulario.plato2, platos[1]);
  limpiarMarcas();
  mostrarAvisoFormulario('');
  elegirTipo(tipo);
}

// Abre el formulario para una comida concreta, o para una fecha/tipo (edita si ya existe)
function abrirFormulario({ comida = null, fecha = null, tipo = null } = {}) {
  const existente = comida || (fecha && tipo ? comidaDe(fecha, tipo) : null);
  if (existente) {
    cargarEnFormulario(existente);
  } else {
    const fechaInicial = fecha || initialFormDate(VISTA_LOGICA[estado.vista], estado.fechaRef, hoy());
    cargarEnFormulario({ fecha: toISODate(fechaInicial), tipo });
    if (tipo) buscarExistente();
  }
  $('dialogo-comida').showModal();
}

async function buscarComida(fechaISO, tipo) {
  const { data, error } = await cliente.from('comidas').select('*')
    .eq('fecha', fechaISO).eq('tipo', tipo).maybeSingle();
  if (error) throw error;
  return data;
}

// En una entrada nueva: si la fecha y el tipo ya tienen comida, se pasa a editarla
async function buscarExistente() {
  const fechaISO = $('form-fecha').value;
  if (formulario.id || !fechaISO || !formulario.tipo) return;
  const busqueda = ++formulario.busqueda;
  let existente;
  try {
    existente = await buscarComida(fechaISO, formulario.tipo);
  } catch {
    return; // se volverá a comprobar al guardar
  }
  if (!existente || busqueda !== formulario.busqueda || formulario.id) return;

  const hayDatos = dishHasData(readDish(formulario.plato1)) || dishHasData(readDish(formulario.plato2));
  if (hayDatos) {
    const cargar = await confirmar(MENSAJE_DUPLICADO + '. ¿Quieres editarla? Se perderá lo que has escrito.', 'Editar la existente');
    if (!cargar) return;
  }
  cargarEnFormulario(existente);
  mostrarAvisoFormulario(MENSAJE_DUPLICADO + ': la estás editando.');
}

// ===== Formulario: validación y guardado =====
// El formulario entero en bruto, para validateMealForm (D-6)
function readForm() {
  return {
    date: $('form-fecha').value,
    type: formulario.tipo,
    dishes: [readDish(formulario.plato1), readDish(formulario.plato2)],
  };
}

// Marca los campos que devuelve la validación: { field: 'date' } o { dish, field, row? }
function markInvalid(invalid) {
  const dishes = [formulario.plato1, formulario.plato2];
  const rowField = { name: 'nombre', quantity: 'cantidad', unit: 'unidad' };
  const dishField = { name: 'nombre', reference: 'referencia' };
  for (const { dish, field, row } of invalid) {
    let node;
    if (field === 'date') node = $('form-fecha');
    else if (row !== undefined) node = leerFilas(dishes[dish])[row][rowField[field]];
    else node = dishes[dish][dishField[field]];
    node.classList.add('campo-invalido');
  }
}

// Devuelve { data } listo para guardar o { error }, con los campos marcados
function validarFormulario() {
  limpiarMarcas();
  const raw = readForm();
  const resultado = validateMealForm(raw);
  if (!resultado.error) return resultado;
  markInvalid(resultado.invalid);
  // Desayuno con dos platos: se vuelve a enseñar el botón "Eliminar segundo plato", como antes
  if (formDishLayout(raw.type, dishHasData(raw.dishes[1])).showRemoveSecond) actualizarPlatos();
  return resultado;
}

async function guardarComida(evento) {
  evento.preventDefault();
  mostrarErrorFormulario('');
  const { data: datos, error } = validarFormulario();
  if (error) return mostrarErrorFormulario(error);

  $('form-guardar').disabled = true;
  try {
    // Una sola entrada por día y tipo
    const existente = await buscarComida(datos.fecha, datos.tipo);
    if (isOtherMeal(existente, formulario.id)) return mostrarErrorFormulario(MENSAJE_DUPLICADO);

    if (formulario.id) {
      const { data, error: errorGuardar } = await cliente.from('comidas')
        .update(datos).eq('id', formulario.id).select('id');
      if (errorGuardar) throw errorGuardar;
      if (wasDeleted(data)) return mostrarErrorFormulario('Esta comida ya no existe; puede que la haya borrado la otra persona.');
    } else {
      const { error: errorGuardar } = await cliente.from('comidas').insert(datos);
      if (errorGuardar) throw errorGuardar;
    }
    $('dialogo-comida').close();
    cargarDatos();
  } catch (errorGuardar) {
    mostrarErrorFormulario(errorGuardar?.code === '23505' ? MENSAJE_DUPLICADO : translateError(errorGuardar, navigator.onLine));
  } finally {
    $('form-guardar').disabled = false;
  }
}

// ===== Borrado =====
async function borrarComida(comida) {
  const texto = deleteConfirmText(comida);
  if (!(await confirmar(texto, 'Borrar'))) return;

  const { error } = await cliente.from('comidas').delete().eq('id', comida.id);
  if (error) return mostrarError('No se ha podido borrar la comida. ' + translateError(error, navigator.onLine));
  estado.abierto = null;
  cargarDatos();
}

// ===== Eventos =====
function conectarEventos() {
  $('config-reintentar').addEventListener('click', conectar);
  $('form-login').addEventListener('submit', enviarLogin);
  $('boton-salir').addEventListener('click', cerrarSesion);

  document.querySelectorAll('.boton-vista').forEach((b) => b.addEventListener('click', () => cambiarVista(b.dataset.vista)));
  $('boton-anterior').addEventListener('click', () => moverPeriodo(-1));
  $('boton-siguiente').addEventListener('click', () => moverPeriodo(1));
  $('boton-hoy').addEventListener('click', irAHoy);
  $('boton-anadir').addEventListener('click', () => abrirFormulario());
  $('aviso-error-cerrar').addEventListener('click', () => ocultarError());

  formulario.plato1 = crearPlatoFormulario($('form-plato-1'));
  formulario.plato2 = crearPlatoFormulario($('form-plato-2'));
  formulario.plato1.etiquetaNombre.textContent = 'Nombre de receta *';
  document.querySelectorAll('.boton-tipo').forEach((b) => b.addEventListener('click', () => {
    elegirTipo(b.dataset.tipo);
    buscarExistente();
  }));
  $('form-fecha').addEventListener('change', buscarExistente);
  $('form-quitar-segundo').addEventListener('click', quitarSegundoPlato);
  $('form-cancelar').addEventListener('click', () => $('dialogo-comida').close());
  $('form-comida').addEventListener('submit', guardarComida);

  $('confirmar-si').addEventListener('click', () => $('dialogo-confirmar').close('si'));
  $('confirmar-no').addEventListener('click', () => $('dialogo-confirmar').close('no'));

  // Recargar al volver a primer plano y al recuperar la conexión
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cargarDatos();
  });
  window.addEventListener('online', () => {
    if (sesionActiva) cargarDatos();
    else if (!$('pantalla-config').hidden) conectar();
  });
  window.addEventListener('offline', () => {
    if (sesionActiva) mostrarError('Sin conexión a internet. Los datos se actualizarán al recuperarla.', 'carga');
  });
}

conectarEventos();
conectar();
