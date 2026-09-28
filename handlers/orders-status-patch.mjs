import { crearStore } from '../lib/store.mjs';
import { json, leerBody, idDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol, getUserId } from '../lib/auth.mjs';
import { TRANSICIONES } from '../lib/reglas.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'orders.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Operador');
  if (sinRol) return sinRol;

  const id = idDeRuta(event);
  const pedido = await store.obtenerPedido(id);
  if (!pedido) return json(404, { error: `Pedido '${id}' no encontrado.` });

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });

  const nuevo = body.estado;
  const permitidas = TRANSICIONES[pedido.estado] ?? [];
  if (!permitidas.includes(nuevo)) {
    return json(409, {
      error: `Transición inválida: ${pedido.estado} → ${nuevo}.`,
      permitidas,
    });
  }

  let stockDescontado = pedido.stockDescontado === true;

  if (nuevo === 'ACEPTADO') {
    // el stock baja al aceptar, no al crear el pedido
    const descontados = [];
    for (const item of pedido.items) {
      if (await store.descontarStock(item.productoId, item.cantidad)) {
        descontados.push(item);
        continue;
      }
      // no alcanzo: devolvemos lo ya descontado y rechazamos
      for (const hecho of descontados) {
        await store.devolverStock(hecho.productoId, hecho.cantidad);
      }
      const producto = await store.obtenerProducto(item.productoId);
      return json(409, {
        error: `No se puede aceptar: stock insuficiente de '${
          producto?.nombre ?? item.productoId
        }' (quedan ${producto?.stock ?? 0}).`,
      });
    }
    stockDescontado = true;
  }

  // solo se devuelve si alcanzo a descontarse
  if (nuevo === 'CANCELADO' && stockDescontado) {
    for (const item of pedido.items) {
      await store.devolverStock(item.productoId, item.cantidad);
    }
    stockDescontado = false;
  }

  // solo cambia si el pedido sigue como lo leimos
  const actualizado = await store.cambiarEstado(id, pedido.estado, nuevo, {
    actualizadoPor: getUserId(event),
    stockDescontado,
  });

  if (!actualizado) {
    if (nuevo === 'ACEPTADO') {
      for (const item of pedido.items) {
        await store.devolverStock(item.productoId, item.cantidad);
      }
    }
    return json(409, {
      error: 'El pedido cambió de estado mientras se procesaba. Recarga y reintenta.',
    });
  }

  return json(200, actualizado);
});
