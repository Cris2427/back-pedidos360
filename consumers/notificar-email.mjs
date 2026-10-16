// dominio notificaciones: avisa al cliente cada cambio de estado de su pedido
import { crearStore } from '../lib/store.mjs';
import { crearConsumidor, ErrorNoRecuperable } from '../lib/mensajeria.mjs';

const store = crearStore();

const ASUNTOS = {
  PedidoCreado: 'Recibimos tu pedido',
  PedidoAceptado: 'Tu pedido fue aceptado',
  PedidoEnPreparacion: 'Tu pedido se está preparando',
  PedidoDespachado: 'Tu pedido va en camino',
  PedidoEntregado: 'Tu pedido fue entregado',
  PedidoCancelado: 'Tu pedido fue cancelado',
};

export async function procesar(evento) {
  const asunto = ASUNTOS[evento.type];
  if (!asunto) throw new ErrorNoRecuperable(`tipo de evento desconocido: ${evento.type}`);
  if (!evento.clienteId) throw new ErrorNoRecuperable('falta clienteId, no hay a quién avisar');

  // un correo por evento, la clave es el eventId
  const nuevo = await store.guardarNotificacion({
    id: `email#${evento.eventId}`,
    canal: 'email',
    tipo: evento.type,
    pedidoId: evento.pedidoId,
    clienteId: evento.clienteId,
    titulo: `${asunto}: ${evento.pedidoId}`,
    eventId: evento.eventId,
    creadoEn: new Date().toISOString(),
  });
  if (!nuevo) return `duplicado, el correo del evento ${evento.eventId} ya se había enviado`;

  // aca iria el envio real (ses, sendgrid); en el curso queda registrado
  return `correo a ${evento.clienteId}: ${asunto} (${evento.pedidoId})`;
}

export const handler = crearConsumidor('notificar-email', procesar);
