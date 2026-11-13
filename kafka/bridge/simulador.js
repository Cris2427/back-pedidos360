// Arma los eventos de pedidos que publica el productor. No sabe nada de
// Kafka: solo devuelve eventos con el formato del DTO, así se puede probar
// sin levantar el clúster.
import crypto from 'node:crypto';
import { crearEventoPedido, ESTADOS } from '../shared/dto.js';
import { PRODUCTOS, COMUNAS, CANALES, sucursalDe, itemDe, totalDe } from './catalogo.js';

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;

// Los pedidos se reparten en las últimas 12 horas, y 1 de cada 10 se cancela
const VENTANA = 12 * HORA;
const PROB_CANCELAR = 0.1;

// El recorrido normal de un pedido, en orden
const RECORRIDO = ['PEDIDO_CREADO', 'PEDIDO_ACEPTADO', 'PEDIDO_EN_PREPARACION', 'PEDIDO_DESPACHADO', 'PEDIDO_ENTREGADO'];

// Minutos que pasan antes de cada paso: [mínimo, máximo]
const DEMORA = {
  PEDIDO_CREADO: [0, 0],
  PEDIDO_ACEPTADO: [1, 5],
  PEDIDO_EN_PREPARACION: [2, 8],
  PEDIDO_DESPACHADO: [10, 20],
  PEDIDO_ENTREGADO: [10, 30],
  PEDIDO_CANCELADO: [1, 10],
};

const azar = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const unoDe = lista => lista[azar(0, lista.length - 1)];

// Código corto de cada corrida, para que sus pedidos no choquen con los de
// otra: PED-3F6C-000001, PED-3F6C-000002...
export const nuevoCodigo = () => crypto.randomUUID().slice(0, 4).toUpperCase();

// Los datos fijos de un pedido: quién lo pide, desde dónde y qué lleva
export function armarPedido(pedidoId) {
  const comuna = unoDe(COMUNAS);
  // de 1 a 4 productos distintos (se mezcla la carta y se toman los
  // primeros), de 1 a 3 unidades cada uno
  const elegidos = [...PRODUCTOS].sort(() => Math.random() - 0.5).slice(0, azar(1, 4));
  const items = elegidos.map(p => itemDe(p.productoId, azar(1, 3)));
  return {
    pedidoId,
    clienteId: `CLI-${String(azar(1, 500)).padStart(4, '0')}`,
    comuna,
    sucursal: sucursalDe(comuna),
    canal: unoDe(CANALES),
    items,
    total: totalDe(items),
  };
}

// Quién hace cada paso. El cliente crea el pedido, salvo por teléfono, donde
// lo ingresa el operador. El operador de la sucursal lo mueve después. Si se
// cancela recién creado, lo cancela el cliente; más adelante, el operador.
function actorDe(tipo, pedido, estadoAnterior) {
  const cliente = { usuarioId: pedido.clienteId, rol: 'CLIENTE' };
  const operador = { usuarioId: pedido.sucursal.operador, rol: 'OPERADOR' };
  if (tipo === 'PEDIDO_CREADO') return pedido.canal === 'TELEFONO' ? operador : cliente;
  if (tipo === 'PEDIDO_CANCELADO' && estadoAnterior === 'CREADO') return cliente;
  return operador;
}

// Un evento del pedido con el formato del DTO. Solo PEDIDO_CREADO lleva los items.
export function eventoDe(pedido, tipo, estadoAnterior, fechaMs) {
  return crearEventoPedido({
    tipo,
    fecha: new Date(fechaMs).toISOString(),
    pedidoId: pedido.pedidoId,
    clienteId: pedido.clienteId,
    total: pedido.total,
    actor: actorDe(tipo, pedido, estadoAnterior),
    estadoAnterior,
    items: tipo === 'PEDIDO_CREADO' ? pedido.items : [],
    canal: pedido.canal,
    comuna: pedido.comuna,
    sucursalId: pedido.sucursal.sucursalId,
  });
}

// Los eventos de un pedido, en orden. Si se cancela, es desde CREADO,
// ACEPTADO o EN_PREPARACION, los estados desde donde el caso lo permite.
// Un paso que caería en el futuro todavía no pasa: el pedido queda en curso.
function recorridoDe(pedido, inicioMs, ahoraMs) {
  const pasos = Math.random() < PROB_CANCELAR
    ? [...RECORRIDO.slice(0, azar(1, 3)), 'PEDIDO_CANCELADO']
    : RECORRIDO;
  const eventos = [];
  let fecha = inicioMs;
  let estadoAnterior = null;
  for (const tipo of pasos) {
    fecha += azar(...DEMORA[tipo]) * MINUTO;
    if (fecha > ahoraMs) break;
    const evento = eventoDe(pedido, tipo, estadoAnterior, fecha);
    eventos.push(evento);
    estadoAnterior = evento.estadoNuevo;
  }
  return eventos;
}

// Exactamente `cantidad` eventos de pedidos de las últimas 12 horas,
// ordenados por fecha: el orden en que habrían pasado.
export function generarEventos(cantidad, ahoraMs = Date.now()) {
  const codigo = nuevoCodigo();
  const eventos = [];
  for (let n = 1; eventos.length < cantidad; n++) {
    const pedido = armarPedido(`PED-${codigo}-${String(n).padStart(6, '0')}`);
    const inicio = ahoraMs - Math.floor(Math.random() * VENTANA);
    eventos.push(...recorridoDe(pedido, inicio, ahoraMs));
  }
  // Sobran unos pocos: se quitan los más recientes. Como dentro de un pedido
  // las fechas siempre avanzan, ningún pedido queda con un hueco en medio.
  eventos.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return eventos.slice(0, cantidad);
}

// En qué estado quedó cada pedido según lo publicado. Report debe llegar a
// los mismos números: así se comprueba que no se perdió ni duplicó nada.
export function resumen(eventos) {
  const ultimo = new Map();
  for (const e of eventos) ultimo.set(e.pedidoId, e.estadoNuevo);
  const porEstado = Object.fromEntries(ESTADOS.map(estado => [estado, 0]));
  for (const estado of ultimo.values()) porEstado[estado]++;
  return { pedidos: ultimo.size, porEstado };
}

// ---------------------------------------------------------------- casos de error
// Para probar el manejo de errores de los consumidores.

// Un pedido que pasa de CREADO directo a DESPACHADO. Los dos eventos son
// válidos para el DTO: lo que está mal es el recorrido, y eso lo detecta la
// regla de transiciones del consumidor.
export function casoSalto(codigo) {
  const pedido = armarPedido(`PED-SALTO-${codigo}`);
  const ahora = Date.now();
  return [
    eventoDe(pedido, 'PEDIDO_CREADO', null, ahora - 2 * MINUTO),
    eventoDe(pedido, 'PEDIDO_DESPACHADO', 'CREADO', ahora),
  ];
}

// El mismo evento (mismo eventId) dos veces, como cuando el publicador se cae
// justo después de enviar y al volver lo envía de nuevo. Se debe contar una vez.
export function casoDuplicado(codigo) {
  const evento = eventoDe(armarPedido(`PED-DUPLICADO-${codigo}`), 'PEDIDO_CREADO', null, Date.now());
  return [evento, evento];
}

// Un pedido con el total menor que la suma de sus productos: el DTO lo rechaza
export function casoTotalMalo(codigo) {
  const evento = eventoDe(armarPedido(`PED-TOTAL-${codigo}`), 'PEDIDO_CREADO', null, Date.now());
  return { ...evento, total: 100 };
}