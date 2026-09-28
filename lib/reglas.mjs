// de aca sale lo de "no se puede despachar sin aceptar": desde CREADO no
// hay ningun camino a DESPACHADO
export const TRANSICIONES = {
  CREADO: ['ACEPTADO', 'CANCELADO'],
  ACEPTADO: ['EN_PREPARACION', 'CANCELADO'],
  EN_PREPARACION: ['DESPACHADO'],
  DESPACHADO: ['ENTREGADO'],
  ENTREGADO: [],
  CANCELADO: [],
};

// solo mientras el pedido no tenga stock comprometido
export const ESTADOS_EDITABLES = ['CREADO'];
export const ESTADOS_BORRABLES = ['CREADO', 'CANCELADO'];

export function validarProducto({ nombre, precio, stock }) {
  if (typeof nombre !== 'string' || !nombre.trim()) return 'El campo "nombre" es obligatorio.';
  if (!Number.isFinite(precio) || precio < 0) return 'El campo "precio" debe ser un número >= 0.';
  if (!Number.isInteger(stock) || stock < 0) return 'El campo "stock" debe ser un entero >= 0.';
  return null;
}

// el total sale de los precios de la base, nunca del que manda el navegador
// el stock aca solo se revisa: se descuenta al aceptar el pedido
export async function resolverItems(store, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'El pedido debe traer al menos un ítem.', status: 400 };
  }

  let total = 0;
  const detalle = [];

  for (const item of items) {
    const producto = await store.obtenerProducto(item.productoId);
    if (!producto) {
      return { error: `Producto '${item.productoId}' no existe.`, status: 400 };
    }
    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
      return { error: 'La cantidad debe ser un entero mayor que 0.', status: 400 };
    }
    if (item.cantidad > producto.stock) {
      return {
        error: `Stock insuficiente de '${producto.nombre}': quedan ${producto.stock}.`,
        status: 409,
      };
    }
    total += producto.precio * item.cantidad;
    detalle.push({ productoId: producto.id, cantidad: item.cantidad, precio: producto.precio });
  }

  return { detalle, total };
}

export const puedeVerPedido = (pedido, userId, esOperador) =>
  esOperador || pedido.clienteId === userId;
