// Regla de transiciones del pedido: desde cada estado, a cuáles se puede
// pasar. Es la tabla del caso Pedidos360: no se puede despachar sin aceptar,
// y un pedido se puede cancelar solo antes de que salga a despacho.
export const TRANSICIONES = {
  CREADO: ['ACEPTADO', 'CANCELADO'],
  ACEPTADO: ['EN_PREPARACION', 'CANCELADO'],
  EN_PREPARACION: ['DESPACHADO', 'CANCELADO'],
  DESPACHADO: ['ENTREGADO'],
  ENTREGADO: [],
  CANCELADO: [],
};

// Estados finales: de ahí no se sale. Los demás son pedidos en curso.
export const FINALES = Object.keys(TRANSICIONES).filter(e => TRANSICIONES[e].length === 0);
export const ACTIVOS = Object.keys(TRANSICIONES).filter(e => !FINALES.includes(e));

// ¿Se puede pasar de `anterior` a `nuevo`? Un pedido sin estado (null) es uno
// que todavía no existe: solo puede nacer en CREADO.
export function transicionValida(anterior, nuevo) {
  if (anterior === null) return nuevo === 'CREADO';
  return TRANSICIONES[anterior]?.includes(nuevo) ?? false;
}

// Error de una transición que no cumple la regla. Igual que un evento
// inválido, reintentar no sirve: el salto seguirá siendo un salto. Por eso
// reintentable = false y el consumidor lo manda directo a la DLT.
export class TransicionInvalidaError extends Error {
  constructor(anterior, nuevo) {
    super(`transición inválida: ${anterior ?? '(sin estado)'} -> ${nuevo}`);
    this.name = 'TransicionInvalidaError';
    this.motivo = 'transición inválida'; // corto, para el header de la DLT
    this.reintentable = false;
  }
}

// La usa el consumidor antes de aplicar un evento
export function exigirTransicion(anterior, nuevo) {
  if (!transicionValida(anterior, nuevo)) throw new TransicionInvalidaError(anterior, nuevo);
}