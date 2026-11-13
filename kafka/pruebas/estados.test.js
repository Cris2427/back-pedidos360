// Pruebas de la regla de transiciones (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSICIONES, FINALES, ACTIVOS, transicionValida, exigirTransicion, TransicionInvalidaError } from '../shared/estados.js';
import { ESTADOS } from '../shared/dto.js';
import { generarEventos, casoSalto } from '../bridge/simulador.js';

test('la tabla tiene exactamente los estados del DTO', () => {
  assert.deepEqual(Object.keys(TRANSICIONES).sort(), [...ESTADOS].sort());
});

test('finales y activos', () => {
  assert.deepEqual(FINALES, ['ENTREGADO', 'CANCELADO']);
  assert.deepEqual(ACTIVOS, ['CREADO', 'ACEPTADO', 'EN_PREPARACION', 'DESPACHADO']);
});

test('el recorrido completo es válido', () => {
  const recorrido = [null, 'CREADO', 'ACEPTADO', 'EN_PREPARACION', 'DESPACHADO', 'ENTREGADO'];
  for (let i = 1; i < recorrido.length; i++) {
    assert.ok(transicionValida(recorrido[i - 1], recorrido[i]), `${recorrido[i - 1]} -> ${recorrido[i]}`);
  }
});

test('un pedido solo nace en CREADO', () => {
  assert.equal(transicionValida(null, 'CREADO'), true);
  assert.equal(transicionValida(null, 'ACEPTADO'), false);
});

test('no se puede despachar sin aceptar', () => {
  assert.equal(transicionValida('CREADO', 'DESPACHADO'), false);
});

test('se cancela solo antes del despacho', () => {
  for (const e of ['CREADO', 'ACEPTADO', 'EN_PREPARACION']) assert.equal(transicionValida(e, 'CANCELADO'), true, e);
  for (const e of ['DESPACHADO', 'ENTREGADO', 'CANCELADO']) assert.equal(transicionValida(e, 'CANCELADO'), false, e);
});

test('de un estado final no se sale', () => {
  for (const final of FINALES) {
    for (const e of ESTADOS) assert.equal(transicionValida(final, e), false, `${final} -> ${e}`);
  }
});

test('exigirTransicion lanza un error que no se reintenta', () => {
  assert.throws(
    () => exigirTransicion('CREADO', 'DESPACHADO'),
    e => e instanceof TransicionInvalidaError
      && e.reintentable === false
      && e.message === 'transición inválida: CREADO -> DESPACHADO',
  );
});

test('todo lo que genera el simulador cumple la regla', () => {
  for (const e of generarEventos(5000)) {
    assert.ok(transicionValida(e.estadoAnterior, e.estadoNuevo), `${e.pedidoId}: ${e.estadoAnterior} -> ${e.estadoNuevo}`);
  }
});

test('el salto del simulador no la cumple', () => {
  const [, despachado] = casoSalto('PRUEBA');
  assert.equal(transicionValida(despachado.estadoAnterior, despachado.estadoNuevo), false);
});