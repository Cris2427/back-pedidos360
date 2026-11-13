// DTO del registro de auditoría: el mensaje que audit publica en
// audit.timeline. Es la versión legible de un evento de pedido: quién hizo
// qué, cuándo y desde dónde. Igual que el DTO del pedido, aquí está cómo se
// arma, cómo se valida y cómo se serializa y deserializa.
import { TIPOS, ESTADOS, ROLES } from '../shared/dto.js';
import { EventoInvalidoError } from '../shared/serializador.js';

export const VERSION_REGISTRO = 1;

// Cómo se cuenta cada tipo de evento en el detalle
const VERBO = {
  PEDIDO_CREADO: 'creó',
  PEDIDO_ACEPTADO: 'aceptó',
  PEDIDO_EN_PREPARACION: 'empezó a preparar',
  PEDIDO_DESPACHADO: 'despachó',
  PEDIDO_ENTREGADO: 'entregó',
  PEDIDO_CANCELADO: 'canceló',
};

// La transformación: de un evento de pedido (ya validado por su DTO) a un
// registro de auditoría. Conserva el eventId: el lector del timeline lo usa
// para no guardar dos veces el mismo registro.
export function registroDe(evento) {
  const { actor } = evento;
  return {
    eventId: evento.eventId,
    version: VERSION_REGISTRO,
    pedidoId: evento.pedidoId,
    quien: { usuarioId: actor.usuarioId, rol: actor.rol },
    que: evento.tipo,
    cuando: evento.fecha,
    desdeDonde: { canal: evento.canal, comuna: evento.comuna, sucursalId: evento.sucursalId },
    estadoAnterior: evento.estadoAnterior,
    estadoNuevo: evento.estadoNuevo,
    detalle: `${actor.usuarioId} (${actor.rol.toLowerCase()}) ${VERBO[evento.tipo]} el pedido ${evento.pedidoId}`,
  };
}

const esTexto = s => typeof s === 'string' && s.trim() !== '';

// Devuelve la lista de problemas del registro. Lista vacía = registro válido.
export function validarRegistro(r) {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return ['el mensaje no es un objeto JSON'];
  const errores = [];
  if (r.version !== VERSION_REGISTRO) errores.push(`version ${r.version} no soportada, se espera ${VERSION_REGISTRO}`);
  for (const campo of ['eventId', 'pedidoId', 'detalle']) {
    if (!esTexto(r[campo])) errores.push(`falta ${campo}`);
  }
  if (!TIPOS.includes(r.que)) errores.push(`que desconocido: ${r.que}`);
  if (!esTexto(r.cuando) || Number.isNaN(Date.parse(r.cuando))) errores.push('cuando inválido');
  if (!esTexto(r.quien?.usuarioId)) errores.push('falta quien.usuarioId');
  if (!ROLES.includes(r.quien?.rol)) errores.push(`quien.rol inválido: ${r.quien?.rol}`);
  for (const campo of ['canal', 'comuna', 'sucursalId']) {
    if (!esTexto(r.desdeDonde?.[campo])) errores.push(`falta desdeDonde.${campo}`);
  }
  if (!ESTADOS.includes(r.estadoNuevo)) errores.push(`estadoNuevo desconocido: ${r.estadoNuevo}`);
  if (r.estadoAnterior !== null && !ESTADOS.includes(r.estadoAnterior)) {
    errores.push(`estadoAnterior desconocido: ${r.estadoAnterior}`);
  }
  return errores;
}

// Al publicar: valida y convierte a texto JSON
export function serializarRegistro(registro) {
  const errores = validarRegistro(registro);
  if (errores.length) throw new EventoInvalidoError('registro inválido, no se publica', errores);
  return JSON.stringify(registro);
}

// Al consumir audit.timeline: bytes -> texto -> objeto, y se valida
export function deserializarRegistro(value) {
  if (value == null) throw new EventoInvalidoError('mensaje sin contenido');
  let registro;
  try {
    registro = JSON.parse(value.toString('utf8'));
  } catch {
    throw new EventoInvalidoError('JSON inválido');
  }
  const errores = validarRegistro(registro);
  if (errores.length) throw new EventoInvalidoError('registro inválido', errores);
  return registro;
}