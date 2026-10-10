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

function esErrorDeRed(error) {
  return !navigator.onLine
    || error?.name === 'AuthRetryableFetchError'
    || /fetch|network|load failed/i.test(error?.message || '');
}

function traducirError(error) {
  if (esErrorDeRed(error)) return 'No hay conexión con el servidor. Revisa tu conexión a internet.';
  if (error?.code === '23505') return MENSAJE_DUPLICADO + '.';
  if (error?.code === '23514') return 'Los datos no son válidos para guardarlos.';
  if (error?.code === 'PGRST301' || error?.code === '42501' || error?.status === 401) {
    return 'Tu sesión ha caducado o no tienes permiso. Cierra sesión y vuelve a entrar.';
  }
  return 'Ha ocurrido un error inesperado. Inténtalo de nuevo.';
}

// ===== Arranque y conexión =====
function clavesDefinidas() {
  return Boolean(SUPABASE_URL && SUPABASE_CLAVE_PUBLICA)
    && !SUPABASE_URL.includes('TU_URL')
    && !SUPABASE_CLAVE_PUBLICA.includes('TU_CLAVE_PUBLICA');
}

function mostrarConfig(mensaje) {
  $('config-mensaje').textContent = mensaje;
  mostrarPantalla('config');
}

// Comprueba que Supabase responde. Devuelve null si va bien o el texto del problema.
async function comprobarServidor() {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIEMPO_MAXIMO_CONEXION);
  try {
    const respuesta = await fetch(SUPABASE_URL + '/auth/v1/health', {
      headers: { apikey: SUPABASE_CLAVE_PUBLICA },
      signal: control.signal,
    });
    if (respuesta.status === 401 || respuesta.status === 403) {
      return 'Supabase rechaza la clave pública. Revisa SUPABASE_CLAVE_PUBLICA en app.js.';
    }
    return respuesta.ok ? null : 'Supabase responde con un error. Prueba de nuevo en unos minutos.';
  } catch {
    return 'Supabase no responde. Comprueba tu conexión a internet y que SUPABASE_URL en app.js es correcta.';
  } finally {
    clearTimeout(temporizador);
  }
}

async function conectar() {
  mostrarPantalla('inicio');
  if (!window.supabase) {
    return mostrarConfig('No se ha podido cargar la librería de Supabase. Comprueba que el archivo supabase.js está junto a index.html.');
  }
  if (!clavesDefinidas()) {
    return mostrarConfig('Faltan las claves de Supabase. Abre app.js y rellena SUPABASE_URL y SUPABASE_CLAVE_PUBLICA con los datos de tu proyecto.');
  }
  const problema = await comprobarServidor();
  if (problema) return mostrarConfig(problema);

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
function traducirErrorLogin(error) {
  const mensaje = (error.message || '').toLowerCase();
  if (error.code === 'invalid_credentials' || mensaje.includes('invalid login')) return 'Email o contraseña incorrectos.';
  if (error.code === 'email_not_confirmed') return 'Esta cuenta todavía no tiene el email confirmado.';
  if (error.code === 'validation_failed') return 'El email no tiene un formato válido.';
  if (error.status === 429 || error.code === 'over_request_rate_limit') return 'Demasiados intentos. Espera un momento y vuelve a probar.';
  if (esErrorDeRed(error)) return 'No hay conexión con el servidor. Revisa tu conexión a internet.';
  return 'No se ha podido iniciar sesión. Inténtalo de nuevo.';
}

function mostrarErrorLogin(texto) {
  $('login-error').textContent = texto;
  $('login-error').hidden = !texto;
}

async function enviarLogin(evento) {
  evento.preventDefault();
  const email = $('login-email').value.trim();
  const clave = $('login-clave').value;
  if (!email || !clave) return mostrarErrorLogin('Escribe tu email y tu contraseña.');

  mostrarErrorLogin('');
  $('login-boton').disabled = true;
  $('login-boton').textContent = 'Entrando…';
  const { error } = await cliente.auth.signInWithPassword({ email, password: clave });
  $('login-boton').disabled = false;
  $('login-boton').textContent = 'Entrar';
  if (error) return mostrarErrorLogin(traducirErrorLogin(error));
  $('login-clave').value = '';
}

async function cerrarSesion() {
  // Solo en este dispositivo: la otra sesión abierta sigue funcionando
  const { error } = await cliente.auth.signOut({ scope: 'local' });
  if (error) mostrarError('No se ha podido cerrar la sesión. ' + traducirError(error));
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
    mostrarError('No se han podido cargar las comidas. ' + traducirError(resultado.error), 'carga');
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
      if (estadoCanal === 'SUBSCRIBED') {
        if (estado.avisoTipo === 'sync') {
          ocultarError('sync');
          programarRecarga();
        }
      } else if (estadoCanal === 'CHANNEL_ERROR' || estadoCanal === 'TIMED_OUT') {
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
function marcar(nodo) {
  nodo.classList.add('campo-invalido');
}

// Valida un plato y devuelve { plato } o { error }
function validarPlato(plato, textoNombre) {
  let error = null;
  const nombre = plato.nombre.value.trim();
  if (!nombre) {
    marcar(plato.nombre);
    error = textoNombre;
  }

  const ingredientes = [];
  for (const f of leerFilas(plato)) {
    if (isIngredientRowEmpty(readRow(f))) continue;
    const nombreIng = f.nombre.value.trim();
    const cantidad = Number(f.cantidad.value);
    const cantidadValida = f.cantidad.value !== '' && Number.isFinite(cantidad) && cantidad > 0;
    if (!nombreIng) marcar(f.nombre);
    if (!cantidadValida) marcar(f.cantidad);
    if (!UNITS[f.unidad.value]) marcar(f.unidad);
    if (!nombreIng || !cantidadValida || !UNITS[f.unidad.value]) {
      error = error || 'Completa cada ingrediente: nombre, cantidad mayor que 0 y unidad.';
      continue;
    }
    ingredientes.push({ nombre: nombreIng, cantidad, unidad: f.unidad.value });
  }

  const referencia = plato.referencia.value.trim();
  if (referencia && !safeLink(referencia)) {
    marcar(plato.referencia);
    error = error || 'La referencia debe ser un enlace que empiece por http:// o https://';
  }

  if (error) return { error };
  return { plato: { nombre, ingredientes, receta: plato.receta.value.trim(), referencia } };
}

// Devuelve { datos } listos para guardar o { error }
function validarFormulario() {
  limpiarMarcas();
  const fecha = $('form-fecha').value;
  const tipo = formulario.tipo;
  if (!fecha) {
    marcar($('form-fecha'));
    return { error: 'Elige una fecha.' };
  }
  if (!tipo) return { error: 'Elige el tipo: desayuno, comida o cena.' };

  const segundoConDatos = dishHasData(readDish(formulario.plato2));
  if (tipo === 'desayuno' && segundoConDatos) {
    actualizarPlatos();
    return { error: 'El desayuno solo tiene un plato. Elimina el segundo plato para poder guardar.' };
  }

  const textoNombre1 = tipo === 'desayuno' ? 'Escribe el nombre del plato.' : 'Escribe el nombre del primer plato.';
  const primero = validarPlato(formulario.plato1, textoNombre1);
  const segundo = segundoConDatos ? validarPlato(formulario.plato2, 'El segundo plato necesita un nombre de receta.') : null;
  if (primero.error) return { error: primero.error };
  if (segundo?.error) return { error: segundo.error };

  const platos = segundo ? [primero.plato, segundo.plato] : [primero.plato];
  return { datos: { fecha, tipo, platos } };
}

async function guardarComida(evento) {
  evento.preventDefault();
  mostrarErrorFormulario('');
  const { datos, error } = validarFormulario();
  if (error) return mostrarErrorFormulario(error);

  $('form-guardar').disabled = true;
  try {
    // Una sola entrada por día y tipo
    const existente = await buscarComida(datos.fecha, datos.tipo);
    if (existente && existente.id !== formulario.id) return mostrarErrorFormulario(MENSAJE_DUPLICADO);

    if (formulario.id) {
      const { data, error: errorGuardar } = await cliente.from('comidas')
        .update(datos).eq('id', formulario.id).select('id');
      if (errorGuardar) throw errorGuardar;
      if (!data.length) return mostrarErrorFormulario('Esta comida ya no existe; puede que la haya borrado la otra persona.');
    } else {
      const { error: errorGuardar } = await cliente.from('comidas').insert(datos);
      if (errorGuardar) throw errorGuardar;
    }
    $('dialogo-comida').close();
    cargarDatos();
  } catch (errorGuardar) {
    mostrarErrorFormulario(errorGuardar?.code === '23505' ? MENSAJE_DUPLICADO : traducirError(errorGuardar));
  } finally {
    $('form-guardar').disabled = false;
  }
}

// ===== Borrado =====
async function borrarComida(comida) {
  const texto = deleteConfirmText(comida);
  if (!(await confirmar(texto, 'Borrar'))) return;

  const { error } = await cliente.from('comidas').delete().eq('id', comida.id);
  if (error) return mostrarError('No se ha podido borrar la comida. ' + traducirError(error));
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
