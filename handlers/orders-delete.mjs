import { crearStore } from '../lib/store.mjs';
import { json, idDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol, tieneRol, getUserId } from '../lib/auth.mjs';
import { ESTADOS_BORRABLES } from '../lib/reglas.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'orders.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Cliente', 'Operador');
  if (sinRol) return sinRol;

  const id = idDeRuta(event);
  const pedido = await store.obtenerPedido(id);
  if (!pedido) return json(404, { error: `Pedido '${id}' no encontrado.` });

  if (!tieneRol(event, 'Operador') && pedido.clienteId !== getUserId(event)) {
    return json(404, { error: `Pedido '${id}' no encontrado.` });
  }

  if (!ESTADOS_BORRABLES.includes(pedido.estado)) {
    return json(409, {
      error: `Un pedido en ${pedido.estado} no se puede eliminar porque tiene stock comprometido. Cancélalo primero.`,
      borrableEn: ESTADOS_BORRABLES,
    });
  }

  await store.borrarPedido(id);
  return json(200, { eliminado: id });
});
