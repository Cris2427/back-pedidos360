// Pruebas del DTO y del serializador (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEventoPedido, validarEventoPedido } from '../shared/dto.js';
import { serializar, deserializar, EventoInvalidoError } from '../shared/serializador.js';

// Un evento de referencia con todos los campos del formato v2. El total
// incluye $2.990 de despacho, por eso es mayor que la suma de los items.
const EVENTO_REFERENCIA = {
  eventId: '3f6c2a9e-8d41-4b7a-9c55-1e2f7a0b6d93',
  tipo: 'PEDIDO_CREADO',
  version: 2,
  fecha: '2026-11-12T13:05:00.000Z',
  pedidoId: 'PED-A7K2-000001',
  clienteId: 'CLI-0001',
  total: 25960,
  actor: { usuarioId: 'CLI-0001', rol: 'CLIENTE' },
  estadoAnterior: null,
  estadoNuevo: 'CREADO',
  items: [
    { productoId: 'PRD-001', nombre: 'Pizza Margarita', categoria: 'PIZZAS', cantidad: 2, precioUnitario: 9990 },
    { productoId: 'PRD-010', nombre: 'Bebida 1,5 L', categoria: 'BEBIDAS', cantidad: 1, precioUnitario: 2990 },
  ],
  canal: 'WEB',
  comuna: 'Ñuñoa',
  sucursalId: 'SUC-02',
};

// el evento de referencia como texto, con algún campo cambiado
const comoTexto = (cambio = {}) => JSON.stringify({ ...EVENTO_REFERENCIA, ...cambio });

// los datos que entrega el publicador; el DTO completa el resto
const datosValidos = () => ({
  tipo: 'PEDIDO_CREADO',
  pedidoId: 'PED-A7K2-000002',
  clienteId: 'CLI-0002',
  total: 9990,
  actor: { usuarioId: 'CLI-0002', rol: 'CLIENTE' },
  items: [{ productoId: 'PRD-001', nombre: 'Pizza Margarita', categoria: 'PIZZAS', cantidad: 1, precioUnitario: 9990 }],
  canal: 'APP',
  comuna: 'Providencia',
  sucursalId: 'SUC-01',
});

test('un evento con el formato v2 completo es válido', () => {
  assert.deepEqual(deserializar(Buffer.from(comoTexto())), EVENTO_REFERENCIA);
});

test('crearEventoPedido completa eventId, versión, fecha y estados', () => {
  const evento = crearEventoPedido(datosValidos());
  assert.match(evento.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(evento.version, 2);
  assert.ok(!Number.isNaN(Date.parse(evento.fecha)));
  assert.equal(evento.estadoAnterior, null);
  assert.equal(evento.estadoNuevo, 'CREADO');
  assert.deepEqual(validarEventoPedido(evento), []);
});

test('cada evento tiene su propio eventId, aunque sea del mismo pedido', () => {
  assert.notEqual(crearEventoPedido(datosValidos()).eventId, crearEventoPedido(datosValidos()).eventId);
});

test('serializar y deserializar devuelven el mismo evento', () => {
  const evento = crearEventoPedido(datosValidos());
  assert.deepEqual(deserializar(Buffer.from(serializar(evento))), evento);
});

test('el productor no deja publicar un evento inválido', () => {
  const evento = crearEventoPedido({ ...datosValidos(), clienteId: undefined });
  assert.throws(() => serializar(evento), EventoInvalidoError);
});

// Mensajes que nunca se van a poder procesar. Deben fallar con
// EventoInvalidoError y reintentable = false, para ir directo a la DLT.
const MALOS = {
  'JSON roto': '{ esto no es JSON',
  'el texto null (mensaje veneno)': 'null',
  'un número suelto': '42',
  'versión 1': comoTexto({ version: 1 }),
  'total menor que los items': comoTexto({ total: 1000 }),
  'PEDIDO_CREADO sin items': comoTexto({ items: [] }),
  'estadoNuevo que no corresponde al tipo': comoTexto({ estadoNuevo: 'ENTREGADO' }),
  'pedidoId con otro formato': comoTexto({ pedidoId: 'P-1001' }),
};

for (const [caso, texto] of Object.entries(MALOS)) {
  test(`rechaza ${caso}`, () => {
    assert.throws(
      () => deserializar(Buffer.from(texto)),
      e => e instanceof EventoInvalidoError && e.reintentable === false,
    );
  });
}

test('rechaza un mensaje sin contenido', () => {
  assert.throws(() => deserializar(null), EventoInvalidoError);
});