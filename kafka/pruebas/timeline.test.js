// Pruebas del lector del timeline (npm test): repositorio en memoria,
// validación de filtros y la API en un puerto libre. Sin Kafka ni PostgreSQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositorioMemoria } from '../audit/repositorio.js';
import { historialDe, buscarRegistros } from '../audit/consultas.js';
import { crearApi } from '../audit/api.js';
import { verificar, conToken } from './tokens.js';
import { registroDe } from '../audit/registro.js';
import { ParametroInvalidoError, NoEncontradoError } from '../shared/http.js';
import { generarEventos, armarPedido, eventoDe } from '../bridge/simulador.js';

const MINUTO = 60 * 1000;
const INICIO = Date.parse('2026-11-13T15:00:00.000Z');

// Un pedido completo, del CREADO al ENTREGADO. Por la app: así lo crea el
// cliente (por teléfono lo crearía el operador)
const pedido = { ...armarPedido('PED-PRUEBA-000001'), canal: 'APP' };
const PASOS = [
  ['PEDIDO_CREADO', null],
  ['PEDIDO_ACEPTADO', 'CREADO'],
  ['PEDIDO_EN_PREPARACION', 'ACEPTADO'],
  ['PEDIDO_DESPACHADO', 'EN_PREPARACION'],
  ['PEDIDO_ENTREGADO', 'DESPACHADO'],
];
const registros = PASOS.map(([tipo, anterior], i) => registroDe(eventoDe(pedido, tipo, anterior, INICIO + i * 10 * MINUTO)));

// Lo mismo que hacen audit + el lector: evento -> registro -> repositorio
async function repoCon(lista) {
  const repo = repositorioMemoria();
  for (const r of lista) await repo.guardar(r);
  return repo;
}

test('un registro repetido se guarda una sola vez', async () => {
  const repo = repositorioMemoria();
  assert.equal(await repo.guardar(registros[0]), 'guardado');
  assert.equal(await repo.guardar(registros[0]), 'duplicado');
});

test('el historial de un pedido trae sus 5 pasos en orden', async () => {
  // se guardan desordenados, como podrían llegar de dos corridas distintas
  const repo = await repoCon([...registros].reverse());
  const historial = await historialDe(repo, 'PED-PRUEBA-000001');
  assert.deepEqual(historial.map(r => r.que), PASOS.map(([tipo]) => tipo));
  assert.equal(historial[0].quien.rol, 'CLIENTE');
  assert.equal(historial[1].quien.usuarioId, pedido.sucursal.operador);
});

test('un pedido sin registros responde 404', async () => {
  await assert.rejects(historialDe(repositorioMemoria(), 'PED-NO-EXISTE'), NoEncontradoError);
});

test('buscar por usuario, tipo y fechas, del más nuevo al más antiguo', async () => {
  const repo = await repoCon(registros);

  const delOperador = await buscarRegistros(repo, { usuario: pedido.sucursal.operador });
  assert.deepEqual(delOperador.map(r => r.que), ['PEDIDO_ENTREGADO', 'PEDIDO_DESPACHADO', 'PEDIDO_EN_PREPARACION', 'PEDIDO_ACEPTADO']);

  const entregas = await buscarRegistros(repo, { que: 'PEDIDO_ENTREGADO' });
  assert.equal(entregas.length, 1);

  // de 15:05 a 15:25 caen el ACEPTADO (15:10) y el EN_PREPARACION (15:20)
  const tramo = await buscarRegistros(repo, { desde: '2026-11-13T15:05:00Z', hasta: '2026-11-13T15:25:00Z' });
  assert.deepEqual(tramo.map(r => r.que), ['PEDIDO_EN_PREPARACION', 'PEDIDO_ACEPTADO']);

  assert.equal((await buscarRegistros(repo, { limite: '2' })).length, 2);
});

test('los filtros mal escritos se rechazan con 400', () => {
  const repo = repositorioMemoria();
  const malos = [
    { otro: 'x' },
    { que: 'PEDIDO_PERDIDO' },
    { desde: 'ayer' },
    { desde: '2026-11-13T16:00:00Z', hasta: '2026-11-13T15:00:00Z' },
    { limite: '0' },
    { limite: '201' },
    { usuario: ['OPE-01', 'OPE-02'] },
  ];
  for (const query of malos) {
    assert.throws(() => buscarRegistros(repo, query), ParametroInvalidoError, JSON.stringify(query));
  }
});

test('con muchos pedidos, cada historial queda completo y en orden', async () => {
  const eventos = generarEventos(2000);
  const repo = await repoCon(eventos.map(registroDe));
  const unPedido = eventos.at(-1).pedidoId;
  const esperados = eventos.filter(e => e.pedidoId === unPedido).map(e => e.tipo);
  assert.deepEqual((await historialDe(repo, unPedido)).map(r => r.que), esperados);
});

test('la API responde el historial, la búsqueda y los errores', async t => {
  const repo = await repoCon(registros);
  const servidor = crearApi(repo, { verificar }).listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}/api/audit`;
  // un Admin: el único que ve la auditoría
  const headers = await conToken({ roles: ['Admin'], scp: 'orders.read' });

  const historial = await fetch(`${base}/pedidos/PED-PRUEBA-000001`, { headers });
  assert.equal(historial.status, 200);
  assert.equal((await historial.json()).length, 5);

  const busqueda = await fetch(`${base}/registros?que=PEDIDO_CREADO`, { headers });
  assert.equal(busqueda.status, 200);
  assert.equal((await busqueda.json())[0].que, 'PEDIDO_CREADO');

  assert.equal((await fetch(`${base}/pedidos/PED-NO-EXISTE`, { headers })).status, 404);
  const malo = await fetch(`${base}/registros?otro=1`, { headers });
  assert.equal(malo.status, 400);
  assert.match((await malo.json()).error, /filtro desconocido/);
  assert.equal((await fetch(`${base}/registros`)).status, 401);
});