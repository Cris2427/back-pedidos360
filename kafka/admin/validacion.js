// Valida lo que llega al admin por HTTP, antes de tocar el clúster. Como en
// la EP4 y en audit, un campo desconocido o mal escrito es un 400: nunca se
// ignora en silencio. Las reglas que dependen del estado del clúster (si el
// tópico existe, si un grupo tiene instancias conectadas) están en
// servicio.js, grupos.js y dlt.js.
import { ParametroInvalidoError } from '../shared/http.js';
import { REPLICAS, MIN_INSYNC } from '../shared/topics.js';

// Los nombres que Kafka acepta: letras, números, punto, guion y guion bajo
const NOMBRE = /^[A-Za-z0-9._-]{1,200}$/;

// Lo que se puede pedir de un tópico, con sus límites
const LIMITES = {
  particiones: [1, 12],
  replicas: [1, REPLICAS],
  retencionDias: [1, 365],
  retencionMbPorParticion: [1, 10240],
  minInsync: [1, REPLICAS],
};
const LIMPIEZAS = ['delete', 'compact'];
const CONFIGURABLES = ['retencionDias', 'retencionMbPorParticion', 'limpieza', 'minInsync'];

// Un tópico nuevo sin más datos queda como pedidos.eventos: 3 particiones, 3
// copias, min ISR 2, 7 días o 256 MB por partición, y delete
const POR_DEFECTO = {
  particiones: 3,
  replicas: REPLICAS,
  retencionDias: 7,
  retencionMbPorParticion: 256,
  limpieza: 'delete',
  minInsync: MIN_INSYNC,
};

// El cuerpo (o la query) trae solo los campos permitidos
function soloCampos(objeto, permitidos, que = 'campo') {
  if (objeto === null || typeof objeto !== 'object' || Array.isArray(objeto)) {
    throw new ParametroInvalidoError('el cuerpo debe ser un objeto JSON');
  }
  const desconocidos = Object.keys(objeto).filter(k => !permitidos.includes(k));
  if (desconocidos.length) {
    throw new ParametroInvalidoError(`${que} desconocido: ${desconocidos.join(', ')}. Se puede usar: ${permitidos.join(', ') || 'ninguno'}`);
  }
}

function entero(nombre, valor, [min, max] = LIMITES[nombre]) {
  // en la query llega como texto ('20'); en el cuerpo JSON, como número
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ParametroInvalidoError(`${nombre} debe ser un entero entre ${min} y ${max}`);
  }
  return n;
}

function limpieza(valor) {
  if (!LIMPIEZAS.includes(valor)) throw new ParametroInvalidoError(`limpieza debe ser ${LIMPIEZAS.join(' o ')}`);
  return valor;
}

export function validarNombreTopico(nombre) {
  if (typeof nombre !== 'string' || !NOMBRE.test(nombre) || nombre === '.' || nombre === '..') {
    throw new ParametroInvalidoError('nombre: solo letras, números, punto, guion y guion bajo (hasta 200)');
  }
  if (nombre.startsWith('__')) {
    throw new ParametroInvalidoError('los nombres que empiezan con __ son de los tópicos internos de Kafka');
  }
  return nombre;
}

// POST /topicos: devuelve el tópico completo, con el mismo formato que los de
// shared/topics.js
export function validarNuevoTopico(cuerpo) {
  soloCampos(cuerpo, ['nombre', 'particiones', 'replicas', ...CONFIGURABLES]);
  const t = { ...POR_DEFECTO, ...cuerpo };
  const topico = {
    nombre: validarNombreTopico(t.nombre),
    particiones: entero('particiones', t.particiones),
    replicas: entero('replicas', t.replicas),
    retencionDias: entero('retencionDias', t.retencionDias),
    retencionMbPorParticion: entero('retencionMbPorParticion', t.retencionMbPorParticion),
    limpieza: limpieza(t.limpieza),
    minInsync: entero('minInsync', t.minInsync),
  };
  // con min ISR mayor que las copias, ninguna escritura con acks=all se aceptaría
  if (topico.minInsync > topico.replicas) {
    throw new ParametroInvalidoError(`minInsync (${topico.minInsync}) no puede ser mayor que replicas (${topico.replicas})`);
  }
  return topico;
}

// PATCH /topicos/:nombre/configuracion: solo los campos que cambian
export function validarCambioConfig(cuerpo) {
  soloCampos(cuerpo, CONFIGURABLES);
  if (!Object.keys(cuerpo).length) {
    throw new ParametroInvalidoError(`no hay nada que cambiar. Se puede usar: ${CONFIGURABLES.join(', ')}`);
  }
  const cambios = {};
  for (const [campo, valor] of Object.entries(cuerpo)) {
    cambios[campo] = campo === 'limpieza' ? limpieza(valor) : entero(campo, valor);
  }
  return cambios;
}

// POST /topicos/:nombre/particiones: el total nuevo, no cuántas se agregan
export function validarParticiones(cuerpo) {
  soloCampos(cuerpo, ['total']);
  return entero('total', cuerpo.total, LIMITES.particiones);
}

// POST /grupos/:grupo/offsets: a dónde mover el grupo en un tópico.
// posicion: 'inicio' (vuelve a leer todo), 'fin' (salta lo pendiente) o una
// fecha ISO (vuelve a leer desde esa hora)
export function validarReinicio(cuerpo) {
  soloCampos(cuerpo, ['topico', 'posicion']);
  const { topico, posicion } = cuerpo;
  if (typeof topico !== 'string' || !topico) throw new ParametroInvalidoError('falta topico');
  if (posicion === 'inicio' || posicion === 'fin') return { topico, posicion };
  const ms = typeof posicion === 'string' ? Date.parse(posicion) : NaN;
  if (Number.isNaN(ms)) {
    throw new ParametroInvalidoError("posicion debe ser 'inicio', 'fin' o una fecha (ejemplo: 2026-11-13T15:00:00Z)");
  }
  return { topico, posicion: new Date(ms).toISOString(), ms };
}

// GET /dlt/:servicio?limite=20
export function validarLimiteDlt(query) {
  soloCampos(query, ['limite'], 'parámetro');
  if (typeof query.limite === 'object') throw new ParametroInvalidoError('limite va una sola vez');
  return query.limite === undefined ? 20 : entero('limite', query.limite, [1, 100]);
}

// Para las rutas que no reciben nada: ?algo=1 (o un cuerpo con campos) es un
// error, no se ignora
export function sinParametros(query, que = 'parámetro') {
  soloCampos(query, [], que);
}