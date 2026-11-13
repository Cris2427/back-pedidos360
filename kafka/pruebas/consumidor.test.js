// Pruebas del consumidor (npm test). No necesitan Kafka: la DLT es un
// arreglo y las esperas de los reintentos no esperan de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearManejador } from '../shared/consumidor.js';
import { serializar } from '../shared/serializador.js';
import { TransicionInvalidaError } from '../shared/estados.js';
import { generarEventos } from '../bridge/simulador.js';

// el primer evento generado siempre es un PEDIDO_CREADO
const EVENTO = generarEventos(1)[0];

// Un mensaje con la forma en que lo entrega KafkaJS
function mensajeKafka(texto) {
  return {
    key: Buffer.from(EVENTO.pedidoId),
    value: Buffer.from(texto),
    offset: '42',
    headers: { correlationId: Buffer.from('corrida-1') },
  };
}

// Un manejador con dobles de prueba en vez de Kafka
function preparar(procesar) {
  const dlt = [];
  const esperas = [];
  const manejar = crearManejador({
    servicio: 'report',
    groupId: 'report',
    procesar,
    enviarADlt: async mensaje => { dlt.push(mensaje); },
    esperar: async ms => { esperas.push(ms); },
    log: () => {},
  });
  return { manejar, dlt, esperas };
}

const recibir = (manejar, message, extra = {}) =>
  manejar({ topic: 'pedidos.eventos', partition: 1, message, ...extra });

test('un mensaje válido llega a la lógica del servicio con su contexto', async () => {
  let evento, contexto;
  const { manejar, dlt } = preparar(async (e, c) => { evento = e; contexto = c; return 'aplicado'; });
  assert.equal(await recibir(manejar, mensajeKafka(serializar(EVENTO))), 'aplicado');
  assert.deepEqual(evento, EVENTO);
  assert.equal(contexto.partition, 1);
  assert.equal(contexto.correlationId, 'corrida-1');
  assert.equal(dlt.length, 0);
});

test('un JSON roto va directo a la DLT, sin reintentos', async () => {
  let llamadas = 0;
  const { manejar, dlt, esperas } = preparar(async () => { llamadas++; });
  assert.equal(await recibir(manejar, mensajeKafka('{ esto no es JSON')), 'dlt');
  assert.equal(llamadas, 0);
  assert.deepEqual(esperas, []);
  assert.equal(dlt[0].headers['dlt-motivo'], 'JSON inválido');
});

test('una transición inválida va directo a la DLT, sin reintentos', async () => {
  const { manejar, dlt, esperas } = preparar(async () => { throw new TransicionInvalidaError('CREADO', 'DESPACHADO'); });
  assert.equal(await recibir(manejar, mensajeKafka(serializar(EVENTO))), 'dlt');
  assert.deepEqual(esperas, []);
  assert.equal(dlt[0].headers['dlt-motivo'], 'transición inválida');
  assert.equal(dlt[0].headers['dlt-error'], 'transición inválida: CREADO -> DESPACHADO');
});

test('un error pasajero se reintenta y, si se arregla, sigue normal', async () => {
  let llamadas = 0;
  let latidos = 0;
  const { manejar, dlt, esperas } = preparar(async () => {
    llamadas++;
    if (llamadas < 3) throw new Error('la base de datos no responde');
    return 'aplicado';
  });
  const resultado = await recibir(manejar, mensajeKafka(serializar(EVENTO)), { heartbeat: async () => { latidos++; } });
  assert.equal(resultado, 'aplicado');
  assert.equal(llamadas, 3);
  assert.deepEqual(esperas, [1000, 2000]);
  assert.equal(latidos, 2);
  assert.equal(dlt.length, 0);
});

test('si se acaban los reintentos, va a la DLT', async () => {
  let llamadas = 0;
  const { manejar, dlt, esperas } = preparar(async () => { llamadas++; throw new Error('la base de datos no responde'); });
  assert.equal(await recibir(manejar, mensajeKafka(serializar(EVENTO))), 'dlt');
  assert.equal(llamadas, 4);
  assert.deepEqual(esperas, [1000, 2000, 4000]);
  assert.equal(dlt[0].headers['dlt-motivo'], 'se agotaron los reintentos');
  assert.equal(dlt[0].headers['dlt-intentos'], '4');
});

test('la DLT conserva el mensaje original y dice de dónde venía', async () => {
  const { manejar, dlt } = preparar(async () => {});
  const original = mensajeKafka('{ esto no es JSON');
  await recibir(manejar, original);
  const { key, value, headers } = dlt[0];
  assert.equal(key, original.key);
  assert.equal(value, original.value);
  assert.equal(headers.correlationId, original.headers.correlationId);
  assert.equal(headers['dlt-servicio'], 'report');
  assert.equal(headers['dlt-grupo'], 'report');
  assert.equal(headers['dlt-topico'], 'pedidos.eventos');
  assert.equal(headers['dlt-particion'], '1');
  assert.equal(headers['dlt-offset'], '42');
});