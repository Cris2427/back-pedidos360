import { crearStore } from '../lib/store.mjs';
import { json, leerBody, idDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol, tieneRol, getUserId } from '../lib/auth.mjs';
import { resolverItems, ESTADOS_EDITABLES } from '../lib/reglas.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'orders.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Cliente', 'Operador');
  if (sinRol) return sinRol;

  const id = idDeRuta(event);
  const pedido = await store.obtenerPedido(id);
  if (!pedido) return json(404, { error: `Pedido '${id}' no encontrado.` });

  const esOperador = tieneRol(event, 'Operador');
  if (!esOperador && pedido.clienteId !== getUserId(event)) {
    // 404 y no 403: no le confirmamos que el pedido existe
    return json(404, { error: `Pedido '${id}' no encontrado.` });
  }

  if (!ESTADOS_EDITABLES.includes(pedido.estado)) {
    return json(409, {
      error: `Un pedido en ${pedido.estado} ya no se puede editar.`,
      editableEn: ESTADOS_EDITABLES,
    });
  }

  const body = leerBody(event);
  if (!body) return json(400, { error: 'El cuerpo no es JSON válido.' });

  const resuelto = await resolverItems(store, body.items);
  if (resuelto.error) return json(resuelto.status, { error: resuelto.error });

  const actualizado = {
    ...pedido,
    clienteId: esOperador && body.clienteId ? String(body.clienteId).trim() : pedido.clienteId,
    items: resuelto.detalle,
    total: resuelto.total,
    actualizadoEn: new Date().toISOString(),
    actualizadoPor: getUserId(event),
  };
  await store.guardarPedido(actualizado);
  return json(200, actualizado);
});
