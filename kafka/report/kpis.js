// La lógica de report: cómo cada evento cambia el estado de un pedido y qué
// KPIs se entregan. No sabe de Kafka ni de SQL: trabaja con un repositorio
// (repositorio.js), sea el de PostgreSQL o el de memoria.
import { exigirTransicion } from '../shared/estados.js';
import { ParametroInvalidoError } from '../shared/http.js';

// Aplica un evento al pedido, en este orden:
//   1. si su eventId ya se aplicó, es un duplicado: no se cuenta de nuevo
//   2. compara con el estado GUARDADO del pedido, no con el que dice el
//      evento: si no cumple la regla, TransicionInvalidaError y a la DLT
//   3. recién entonces escribe: marca el eventId y crea o actualiza el pedido
// Todo va en una transacción, y como se revisa antes de escribir, un error
// nunca deja un evento aplicado a medias.
export async function aplicarEvento(repo, evento) {
  return repo.enTransaccion(async tx => {
    if (await tx.yaAplicado(evento.eventId)) return 'duplicado';
    const anterior = await tx.estadoDe(evento.pedidoId);
    exigirTransicion(anterior, evento.estadoNuevo);
    await tx.registrarEvento(evento);
    if (evento.tipo === 'PEDIDO_CREADO') await tx.crearPedido(evento);
    else await tx.cambiarEstado(evento);
    return 'aplicado';
  });
}

// ---------------------------------------------------------------- KPIs
// Ventas: el total de los pedidos que no se cancelaron (entregados y en curso)

export const ventasPorHora = repo => repo.ventasPorHora();

export function topProductos(repo, limite = 5) {
  const n = Number(limite);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new ParametroInvalidoError('limite debe ser un entero entre 1 y 20');
  }
  return repo.topProductos(n);
}

export const pedidosActivos = repo => repo.pedidosActivos();
export const leadTime = repo => repo.leadTime();
export const resumen = repo => repo.resumen();