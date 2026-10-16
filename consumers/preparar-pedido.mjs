// dominio bodega: cuando un pedido se acepta, genera la orden de preparacion
// para que bodega junte los productos y arme el paquete antes del despacho
import { crearStore } from '../lib/store.mjs';
import { crearConsumidor, ErrorNoRecuperable } from '../lib/mensajeria.mjs';

const store = crearStore();

export async function procesar(evento) {
  if (evento.type !== 'PedidoAceptado') {
    throw new ErrorNoRecuperable(`bodega solo atiende PedidoAceptado, llegó ${evento.type}`);
  }
  const items = Array.isArray(evento.items) ? evento.items : [];
  if (items.length === 0) throw new ErrorNoRecuperable('el pedido no trae ítems, no hay nada que preparar');

  const lineas = items.map((i) => `${i.cantidad} x ${i.nombre ?? i.productoId}`);

  // una orden por pedido, la clave es el pedidoId: aunque llegaran dos
  // eventos de aceptacion, bodega no lo arma dos veces
  const nuevo = await store.guardarNotificacion({
    id: `bodega#${evento.pedidoId}`,
    canal: 'bodega',
    tipo: evento.type,
    pedidoId: evento.pedidoId,
    clienteId: evento.clienteId,
    titulo: `Orden de preparación ${evento.pedidoId}`,
    detalle: lineas,
    eventId: evento.eventId,
    creadoEn: new Date().toISOString(),
  });
  if (!nuevo) return `duplicado, la orden de ${evento.pedidoId} ya estaba generada`;

  return `orden de preparación ${evento.pedidoId}: ${lineas.join(', ')}`;
}

export const handler = crearConsumidor('preparar-pedido', procesar);
