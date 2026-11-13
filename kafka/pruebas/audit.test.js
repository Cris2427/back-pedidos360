// Pruebas de audit (npm test). No necesitan Kafka: el producer es un doble
// que anota lo que le mandan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registroDe, validarRegistro, serializarRegistro, deserializarRegistro } from '../audit/registro.js';
import { publicarRegistro } from '../audit/auditoria.js';
import { EventoInvalidoError } from '../shared/serializador.js';
import { TIMELINE } from '../shared/topics.js';
import { generarEventos, armarPedido, eventoDe, casoSalto } from '../bridge/simulador.js';

const pedido = armarPedido('PED-PRUEBA-000001');
const aceptado = eventoDe(pedido, 'PEDIDO_ACEPTADO', 'CREADO', Date.parse('2026-11-13T15:10:00.000Z'));

test('el registro dice quién, qué, cuándo y desde dónde', () => {
  const r = registroDe(aceptado);
  assert.equal(r.eventId, aceptado.eventId);
  assert.deepEqual(r.quien, { usuarioId: pedido.sucursal.operador, rol: 'OPERADOR' });
  assert.equal(r.que, 'PEDIDO_ACEPTADO');
  assert.equal(r.cuando, '2026-11-13T15:10:00.000Z');
  assert.deepEqual(r.desdeDonde, { canal: pedido.canal, comuna: pedido.comuna, sucursalId: pedido.sucursal.sucursalId });
  assert.equal(r.estadoAnterior, 'CREADO');
  assert.equal(r.estadoNuevo, 'ACEPTADO');
  assert.equal(r.detalle, `${pedido.sucursal.operador} (operador) aceptó el pedido PED-PRUEBA-000001`);
});

test('todo evento del simulador se transforma en un registro válido', () => {
  for (const e of generarEventos(2000)) assert.deepEqual(validarRegistro(registroDe(e)), [], `${e.pedidoId} ${e.tipo}`);
});

test('el salto también se registra: audit anota lo que pasó', () => {
  const [, despachado] = casoSalto('PRUEBA');
  assert.deepEqual(validarRegistro(registroDe(despachado)), []);
});

test('serializar y deserializar devuelven el mismo registro', () => {
  const r = registroDe(aceptado);
  assert.deepEqual(deserializarRegistro(Buffer.from(serializarRegistro(r))), r);
});

test('un registro malo no se publica ni se acepta al leer', () => {
  const sinQuien = { ...registroDe(aceptado), quien: undefined };
  assert.throws(() => serializarRegistro(sinQuien), EventoInvalidoError);
  assert.throws(
    () => deserializarRegistro(Buffer.from('{ esto no es JSON')),
    e => e instanceof EventoInvalidoError && e.reintentable === false,
  );
  assert.throws(() => deserializarRegistro(Buffer.from(JSON.stringify(sinQuien))), EventoInvalidoError);
});

// consumir-transformar-producir con un producer de mentira
test('publicarRegistro manda el registro a audit.timeline con key pedidoId', async () => {
  const enviados = [];
  const producer = { send: async envio => { enviados.push(envio); } };
  const resultado = await publicarRegistro(aceptado, { producer, correlationId: 'corrida-1' });

  assert.equal(resultado, 'publicado');
  assert.equal(enviados.length, 1);
  const { topic, messages: [mensaje] } = enviados[0];
  assert.equal(topic, TIMELINE);
  assert.equal(mensaje.key, aceptado.pedidoId);
  assert.deepEqual(mensaje.headers, { correlationId: 'corrida-1' });
  assert.deepEqual(deserializarRegistro(Buffer.from(mensaje.value)), registroDe(aceptado));
});