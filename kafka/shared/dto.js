// DTO del evento de pedido: la forma exacta del mensaje que viaja por
// pedidos.eventos (formato versión 2).
// Aquí se define qué campos lleva, cómo se arma uno nuevo y qué lo hace válido.
import crypto from 'node:crypto';

export const VERSION = 2;

// Cada tipo de evento deja al pedido en un estado. Son los mismos estados
// del backend de Pedidos360 (lib/reglas.mjs).
export const ESTADO_POR_TIPO = {
  PEDIDO_CREADO: 'CREADO',
  PEDIDO_ACEPTADO: 'ACEPTADO',
  PEDIDO_EN_PREPARACION: 'EN_PREPARACION',
  PEDIDO_DESPACHADO: 'DESPACHADO',
  PEDIDO_ENTREGADO: 'ENTREGADO',
  PEDIDO_CANCELADO: 'CANCELADO',
};
export const TIPOS = Object.keys(ESTADO_POR_TIPO);
export const ESTADOS = Object.values(ESTADO_POR_TIPO);
export const ROLES = ['CLIENTE', 'OPERADOR', 'ADMIN'];

// Formato de los ids. Ejemplos:
// PED-A7K2-000001, CLI-0001, PRD-001, SUC-02
const FORMATO = {
  pedidoId: /^PED-[A-Z0-9-]+$/,
  clienteId: /^CLI-\d+$/,
  productoId: /^PRD-\d+$/,
  sucursalId: /^SUC-\d+$/,
};

// Arma un evento nuevo. Quien publica entrega los datos del pedido y el DTO
// completa lo que no se debe inventar en cada lugar: el id único, la versión,
// la fecha y el estado nuevo que corresponde al tipo.
export function crearEventoPedido(datos) {
  return {
    eventId: crypto.randomUUID(),
    tipo: datos.tipo,
    version: VERSION,
    fecha: datos.fecha ?? new Date().toISOString(),
    pedidoId: datos.pedidoId,
    clienteId: datos.clienteId,
    total: datos.total,
    actor: datos.actor,
    estadoAnterior: datos.estadoAnterior ?? null,
    estadoNuevo: ESTADO_POR_TIPO[datos.tipo],
    items: datos.items ?? [],
    canal: datos.canal,
    comuna: datos.comuna,
    sucursalId: datos.sucursalId,
  };
}

const esEnteroPositivo = n => Number.isInteger(n) && n > 0;
const esTexto = s => typeof s === 'string' && s.trim() !== '';

// Devuelve la lista de problemas del evento. Lista vacía = evento válido.
export function validarEventoPedido(e) {
  // Primero, que sea un objeto: el texto null o un número también son JSON
  // válido, y sin esta revisión las líneas de abajo se caerían
  if (typeof e !== 'object' || e === null || Array.isArray(e)) {
    return ['el mensaje no es un objeto JSON'];
  }

  const errores = [];
  if (e.version !== VERSION) errores.push(`version ${e.version} no soportada, se espera ${VERSION}`);
  if (!esTexto(e.eventId)) errores.push('falta eventId');
  if (!TIPOS.includes(e.tipo)) errores.push(`tipo desconocido: ${e.tipo}`);
  else if (e.estadoNuevo !== ESTADO_POR_TIPO[e.tipo]) errores.push(`estadoNuevo ${e.estadoNuevo} no corresponde a ${e.tipo}`);
  if (e.estadoAnterior !== null && !ESTADOS.includes(e.estadoAnterior)) errores.push(`estadoAnterior desconocido: ${e.estadoAnterior}`);
  if (!esTexto(e.fecha) || Number.isNaN(Date.parse(e.fecha))) errores.push('fecha inválida');
  if (!FORMATO.pedidoId.test(e.pedidoId)) errores.push(`pedidoId inválido: ${e.pedidoId}`);
  if (!FORMATO.clienteId.test(e.clienteId)) errores.push(`clienteId inválido: ${e.clienteId}`);
  if (!esEnteroPositivo(e.total)) errores.push('total debe ser un entero mayor que 0 (pesos chilenos)');
  if (!esTexto(e.actor?.usuarioId)) errores.push('falta actor.usuarioId');
  if (!ROLES.includes(e.actor?.rol)) errores.push(`actor.rol inválido: ${e.actor?.rol}`);
  if (!esTexto(e.canal)) errores.push('falta canal');
  if (!esTexto(e.comuna)) errores.push('falta comuna');
  if (!FORMATO.sucursalId.test(e.sucursalId)) errores.push(`sucursalId inválido: ${e.sucursalId}`);
  if (e.tipo === 'PEDIDO_CREADO') errores.push(...validarItems(e.items, e.total));
  return errores;
}

// Un pedido nuevo debe traer productos, cada uno con cantidad y precio.
// El total puede ser mayor que la suma (por el despacho, por ejemplo), pero
// nunca menor.
function validarItems(items, total) {
  if (!Array.isArray(items) || items.length === 0) return ['PEDIDO_CREADO debe traer items'];
  const errores = [];
  items.forEach((it, i) => {
    if (!FORMATO.productoId.test(it?.productoId)) errores.push(`items[${i}].productoId inválido`);
    if (!esEnteroPositivo(it?.cantidad)) errores.push(`items[${i}].cantidad debe ser un entero mayor que 0`);
    if (!esEnteroPositivo(it?.precioUnitario)) errores.push(`items[${i}].precioUnitario debe ser un entero mayor que 0`);
  });
  const suma = items.reduce((s, it) => s + (it?.cantidad ?? 0) * (it?.precioUnitario ?? 0), 0);
  if (Number.isInteger(total) && total < suma) errores.push(`total ${total} es menor que la suma de los items (${suma})`);
  return errores;
}