// Datos del negocio que usa el publicador para armar pedidos realistas:
// la carta de la pizzería, las sucursales con las comunas que atiende cada
// una y los canales por donde entran los pedidos.
// Los ids siguen el formato que exige el DTO (shared/dto.js).

// Lo que se cobra por llevar el pedido. Por eso el total de un pedido es
// mayor que la suma de sus productos.
export const COSTO_DESPACHO = 2990;

// La carta. Precios en pesos chilenos, con IVA incluido.
export const PRODUCTOS = [
  { productoId: 'PRD-001', nombre: 'Pizza Margarita', categoria: 'PIZZAS', precio: 9990 },
  { productoId: 'PRD-002', nombre: 'Pizza Pepperoni', categoria: 'PIZZAS', precio: 11490 },
  { productoId: 'PRD-003', nombre: 'Pizza Hawaiana', categoria: 'PIZZAS', precio: 11990 },
  { productoId: 'PRD-004', nombre: 'Pizza Vegetariana', categoria: 'PIZZAS', precio: 10990 },
  { productoId: 'PRD-005', nombre: 'Pizza Cuatro Quesos', categoria: 'PIZZAS', precio: 12490 },
  { productoId: 'PRD-006', nombre: 'Pizza Napolitana', categoria: 'PIZZAS', precio: 10490 },
  { productoId: 'PRD-007', nombre: 'Palitos de ajo', categoria: 'ACOMPAÑAMIENTOS', precio: 3990 },
  { productoId: 'PRD-008', nombre: 'Papas fritas', categoria: 'ACOMPAÑAMIENTOS', precio: 3490 },
  { productoId: 'PRD-009', nombre: 'Brownie', categoria: 'POSTRES', precio: 2990 },
  { productoId: 'PRD-010', nombre: 'Bebida 1,5 L', categoria: 'BEBIDAS', precio: 2990 },
  { productoId: 'PRD-011', nombre: 'Agua mineral 500 ml', categoria: 'BEBIDAS', precio: 1290 },
];

// Cada sucursal atiende un grupo de comunas y tiene un operador que acepta,
// prepara y despacha sus pedidos. Así cada evento dice desde dónde salió el
// pedido y quién lo movió.
export const SUCURSALES = [
  { sucursalId: 'SUC-01', nombre: 'Providencia', operador: 'OPE-01', comunas: ['Providencia', 'Las Condes', 'Vitacura', 'Santiago'] },
  { sucursalId: 'SUC-02', nombre: 'Ñuñoa', operador: 'OPE-02', comunas: ['Ñuñoa', 'La Reina', 'Macul', 'Peñalolén'] },
  { sucursalId: 'SUC-03', nombre: 'La Florida', operador: 'OPE-03', comunas: ['La Florida', 'Puente Alto', 'San Joaquín', 'La Granja'] },
];

// Todas las comunas donde se reparte
export const COMUNAS = SUCURSALES.flatMap(s => s.comunas);

// Por dónde entra el pedido: la app, la web o por teléfono a la sucursal
export const CANALES = ['APP', 'WEB', 'TELEFONO'];

// La sucursal que atiende una comuna
export function sucursalDe(comuna) {
  const sucursal = SUCURSALES.find(s => s.comunas.includes(comuna));
  if (!sucursal) throw new Error(`ninguna sucursal atiende ${comuna}`);
  return sucursal;
}

// Un producto de la carta convertido en ítem del evento, con los campos que
// pide el DTO. El precio pasa a llamarse precioUnitario.
export function itemDe(productoId, cantidad) {
  const producto = PRODUCTOS.find(p => p.productoId === productoId);
  if (!producto) throw new Error(`producto desconocido: ${productoId}`);
  return {
    productoId: producto.productoId,
    nombre: producto.nombre,
    categoria: producto.categoria,
    cantidad,
    precioUnitario: producto.precio,
  };
}

// Total del pedido: los productos más el despacho
export function totalDe(items) {
  const suma = items.reduce((s, it) => s + it.cantidad * it.precioUnitario, 0);
  return suma + COSTO_DESPACHO;
}