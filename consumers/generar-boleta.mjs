// dominio facturacion: cuando un pedido sale despachado, emite su boleta
import { crearStore } from '../lib/store.mjs';
import { crearConsumidor, ErrorNoRecuperable } from '../lib/mensajeria.mjs';
import { desglosarIva } from '../lib/reglas.mjs';

const store = crearStore();

export async function procesar(evento) {
  if (evento.type !== 'PedidoDespachado') {
    throw new ErrorNoRecuperable(`facturación solo atiende PedidoDespachado, llegó ${evento.type}`);
  }
  const total = Number(evento.total);
  if (!Number.isFinite(total) || total <= 0) {
    throw new ErrorNoRecuperable('el total no es válido, no se puede emitir la boleta');
  }

  const boleta = desglosarIva(total);

  // una boleta por pedido, la clave es el pedidoId
  const nuevo = await store.guardarNotificacion({
    id: `boleta#${evento.pedidoId}`,
    canal: 'boleta',
    tipo: evento.type,
    pedidoId: evento.pedidoId,
    clienteId: evento.clienteId,
    titulo: `Boleta del pedido ${evento.pedidoId}`,
    boleta,
    eventId: evento.eventId,
    // la hora del hecho, no la de proceso: con colas estandar el orden de
    // llegada no esta garantizado
    ocurridoEn: evento.timestamp ?? new Date().toISOString(),
    creadoEn: new Date().toISOString(),
  });
  if (!nuevo) return `duplicado, la boleta de ${evento.pedidoId} ya estaba emitida`;

  return `boleta ${evento.pedidoId}: neto ${boleta.neto} + IVA ${boleta.iva} = ${boleta.total}`;
}

export const handler = crearConsumidor('generar-boleta', procesar);
