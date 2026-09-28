import { crearStore } from '../lib/store.mjs';
import { json, idDeRuta, conManejoDeErrores } from '../lib/http.mjs';
import { exigirScope, exigirRol } from '../lib/auth.mjs';

const store = crearStore();

export const handler = conManejoDeErrores(async (event) => {
  const sinScope = exigirScope(event, 'catalog.write');
  if (sinScope) return sinScope;
  const sinRol = exigirRol(event, 'Admin');
  if (sinRol) return sinRol;

  const id = idDeRuta(event);
  const producto = await store.obtenerProducto(id);
  if (!producto) return json(404, { error: `Producto '${id}' no encontrado.` });

  // si esta en un pedido en curso no se borra: quedaria apuntando a nada
  const pedidos = await store.listarPedidos();
  const enUso = pedidos.filter(
    (p) =>
      !['ENTREGADO', 'CANCELADO'].includes(p.estado) &&
      (p.items ?? []).some((i) => i.productoId === id),
  );
  if (enUso.length > 0) {
    return json(409, {
      error: `No se puede eliminar '${producto.nombre}': hay ${enUso.length} pedido(s) en curso que lo incluyen.`,
    });
  }

  await store.borrarProducto(id);
  return json(200, { eliminado: id });
});
