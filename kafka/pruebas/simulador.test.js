// Pruebas del simulador (npm test). No necesitan Kafka.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generarEventos, resumen, casoSalto, casoDuplicado, casoTotalMalo } from '../bridge/simulador.js';
import { validarEventoPedido } from '../shared/dto.js';

const eventos = generarEventos(5000);

test('genera exactamente la cantidad pedida', () => {
  assert.equal(eventos.length, 5000);
  assert.equal(generarEventos(7).length, 7);
});

test('todos los eventos pasan la validación del DTO', () => {
  for (const e of eventos) assert.deepEqual(validarEventoPedido(e), [], `${e.pedidoId} ${e.tipo}`);
});

test('salen ordenados por fecha y ninguno queda en el futuro', () => {
  for (let i = 1; i < eventos.length; i++) assert.ok(eventos[i - 1].fecha <= eventos[i].fecha);
  assert.ok(eventos.at(-1).fecha <= new Date().toISOString());
});

// Cada evento parte del estado en que lo dejó el anterior del mismo pedido:
// ningún pedido se salta un paso ni aparece sin haberse creado
test('cada pedido empieza con PEDIDO_CREADO y sigue paso a paso', () => {
  const estado = new Map();
  for (const e of eventos) {
    const esperado = e.tipo === 'PEDIDO_CREADO' ? null : estado.get(e.pedidoId);
    assert.equal(e.estadoAnterior, esperado, `${e.pedidoId} ${e.tipo}`);
    estado.set(e.pedidoId, e.estadoNuevo);
  }
});

test('solo PEDIDO_CREADO lleva los items', () => {
  for (const e of eventos) assert.equal(e.items.length > 0, e.tipo === 'PEDIDO_CREADO');
});

test('el resumen cuenta cada pedido una vez, en su último estado', () => {
  const { pedidos, porEstado } = resumen(eventos);
  assert.equal(pedidos, eventos.filter(e => e.tipo === 'PEDIDO_CREADO').length);
  assert.equal(Object.values(porEstado).reduce((a, b) => a + b, 0), pedidos);
});

test('el salto pasa el DTO: lo tiene que detectar la regla de transiciones', () => {
  const [creado, despachado] = casoSalto('PRUEBA');
  assert.deepEqual(validarEventoPedido(creado), []);
  assert.deepEqual(validarEventoPedido(despachado), []);
  assert.equal(despachado.estadoAnterior, 'CREADO');
});

test('el duplicado repite el mismo eventId', () => {
  const [a, b] = casoDuplicado('PRUEBA');
  assert.equal(a.eventId, b.eventId);
});

test('el total mal calculado no pasa el DTO', () => {
  assert.notDeepEqual(validarEventoPedido(casoTotalMalo('PRUEBA')), []);
});