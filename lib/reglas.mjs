// backend/pedidos360-api/lib/reglas.mjs
// Reglas de negocio del caso Pedidos360, compartidas por las Lambdas de pedidos.

/**
 * Máquina de estados del pedido. La regla del caso es "no se puede despachar
 * sin aceptar", y sale de acá: desde CREADO no existe camino a DESPACHADO.
 */
export const TRANSICIONES = {
  CREADO: ['ACEPTADO', 'CANCELADO'],
  ACEPTADO: ['EN_PREPARACION', 'CANCELADO'],
  EN_PREPARACION: ['DESPACHADO'],
  DESPACHADO: ['ENTREGADO'],
  ENTREGADO: [],
  CANCELADO: [],
};

/** Un pedido solo se puede editar o borrar mientras no comprometa stock. */
export const ESTADOS_EDITABLES = ['CREADO'];
export const ESTADOS_BORRABLES = ['CREADO', 'CANCELADO'];

/** Valida el cuerpo de un producto. Devuelve el mensaje de error, o null. */
export function validarProducto({ nombre, precio, stock }) {
  if (typeof nombre !== 'string' || !nombre.trim()) return 'El campo "nombre" es obligatorio.';
  if (!Number.isFinite(precio) || precio < 0) return 'El campo "precio" debe ser un número >= 0.';
  if (!Number.isInteger(stock) || stock < 0) return 'El campo "stock" debe ser un entero >= 0.';
  return null;
}

/**
 * Valida los ítems de un pedido contra el catálogo y calcula el total.
 *
 * El total SIEMPRE se recalcula acá: el que manda el navegador se ignora,
 * porque puede venir manipulado. El stock solo se comprueba, no se descuenta
 * (la regla del caso es que decrece al ACEPTAR el pedido).
 *
 * Devuelve { error, status } o { detalle, total }.
 */
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

/**
 * Un Cliente solo puede operar sobre sus propios pedidos; Operador y Admin
 * sobre todos. Devuelve true si este usuario puede tocar este pedido.
 */
export const puedeVerPedido = (pedido, userId, esOperador) =>
  esOperador || pedido.clienteId === userId;
