// Pruebas de report (npm test): la lógica con el repositorio en memoria y la
// API levantada en un puerto libre. No necesitan Kafka ni PostgreSQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositorioMemoria } from '../report/repositorio.js';
import { crearApi } from '../report/api.js';
import { aplicarEvento, ventasPorHora, topProductos, pedidosActivos, leadTime, resumen } from '../report/kpis.js';
import { ParametroInvalidoError } from '../shared/http.js';
import { TransicionInvalidaError } from '../shared/estados.js';
import { generarEventos, resumen as resumenPublicado, armarPedido, eventoDe, casoSalto, casoDuplicado } from '../bridge/simulador.js';

const MINUTO = 60 * 1000;

// Un repositorio en memoria con todos los eventos ya aplicados
async function repoCon(eventos) {
  const repo = repositorioMemoria();
  for (const e of eventos) await aplicarEvento(repo, e);
  return repo;
}

test('con 5.000 eventos, report llega a los mismos números que el publicador', async () => {
  const eventos = generarEventos(5000);
  const repo = await repoCon(eventos);
  const esperado = resumenPublicado(eventos);
  const obtenido = await resumen(repo);
  assert.equal(obtenido.pedidos, esperado.pedidos);
  assert.deepEqual(obtenido.porEstado, esperado.porEstado);
  assert.equal(obtenido.eventosAplicados, 5000);
});

test('un evento repetido se cuenta una sola vez', async () => {
  const [evento, mismo] = casoDuplicado('PRUEBA');
  const repo = repositorioMemoria();
  assert.equal(await aplicarEvento(repo, evento), 'aplicado');
  assert.equal(await aplicarEvento(repo, mismo), 'duplicado');
  assert.equal((await resumen(repo)).eventosAplicados, 1);
});

test('un salto se rechaza y no deja nada escrito', async () => {
  const [creado, despachado] = casoSalto('PRUEBA');
  const repo = await repoCon([creado]);
  await assert.rejects(aplicarEvento(repo, despachado), TransicionInvalidaError);
  const r = await resumen(repo);
  assert.equal(r.porEstado.CREADO, 1);
  assert.equal(r.eventosAplicados, 1);
});

test('un evento de un pedido que report no conoce se rechaza', async () => {
  const pedido = armarPedido('PED-PRUEBA-000001');
  const aceptado = eventoDe(pedido, 'PEDIDO_ACEPTADO', 'CREADO', Date.now());
  await assert.rejects(aplicarEvento(repositorioMemoria(), aceptado), TransicionInvalidaError);
});

// Dos pedidos armados a mano para saber exactamente qué debe salir
test('KPIs de un caso conocido: ventas, top, activos y lead time', async () => {
  const inicio = Date.parse('2026-11-13T15:10:00.000Z');
  const entregado = armarPedido('PED-PRUEBA-000001');
  const cancelado = armarPedido('PED-PRUEBA-000002');
  const repo = await repoCon([
    eventoDe(entregado, 'PEDIDO_CREADO', null, inicio),
    eventoDe(entregado, 'PEDIDO_ACEPTADO', 'CREADO', inicio + 5 * MINUTO),
    eventoDe(entregado, 'PEDIDO_EN_PREPARACION', 'ACEPTADO', inicio + 10 * MINUTO),
    eventoDe(entregado, 'PEDIDO_DESPACHADO', 'EN_PREPARACION', inicio + 25 * MINUTO),
    eventoDe(entregado, 'PEDIDO_ENTREGADO', 'DESPACHADO', inicio + 40 * MINUTO),
    eventoDe(cancelado, 'PEDIDO_CREADO', null, inicio),
    eventoDe(cancelado, 'PEDIDO_CANCELADO', 'CREADO', inicio + 2 * MINUTO),
  ]);

  // el cancelado no cuenta en ventas ni en el top
  assert.deepEqual(await ventasPorHora(repo), [{ hora: '2026-11-13T15:00:00.000Z', pedidos: 1, ventas: entregado.total }]);
  const unidades = (await topProductos(repo, 20)).reduce((s, p) => s + p.unidades, 0);
  assert.equal(unidades, entregado.items.reduce((s, it) => s + it.cantidad, 0));

  // ninguno está en curso: uno se entregó y el otro se canceló
  assert.ok((await pedidosActivos(repo)).every(f => f.pedidos === 0));

  const lead = await leadTime(repo);
  assert.equal(lead.pedidos, 1);
  assert.equal(lead.promedioMin, 40);
  assert.deepEqual(lead.porSucursal, [{ sucursalId: entregado.sucursal.sucursalId, pedidos: 1, promedioMin: 40 }]);
});

test('el top viene ordenado de más a menos vendido y respeta el límite', async () => {
  const repo = await repoCon(generarEventos(2000));
  const top = await topProductos(repo, 3);
  assert.equal(top.length, 3);
  assert.ok(top[0].unidades >= top[1].unidades && top[1].unidades >= top[2].unidades);
});

test('la suma de las ventas por hora es igual a las ventas del resumen', async () => {
  const repo = await repoCon(generarEventos(2000));
  const porHora = await ventasPorHora(repo);
  assert.equal(porHora.reduce((s, h) => s + h.ventas, 0), (await resumen(repo)).ventas);
  for (let i = 1; i < porHora.length; i++) assert.ok(porHora[i - 1].hora < porHora[i].hora);
});

test('el límite del top debe ser un entero entre 1 y 20', () => {
  const repo = repositorioMemoria();
  for (const malo of [0, 21, 'abc', 2.5]) {
    assert.throws(() => topProductos(repo, malo), ParametroInvalidoError);
  }
});

test('la API responde los KPIs y valida sus parámetros', async t => {
  const repo = await repoCon(generarEventos(500));
  const servidor = crearApi(repo).listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}/api/report`;

  for (const ruta of ['ventas-por-hora', 'top-productos', 'pedidos-activos', 'lead-time', 'resumen']) {
    const r = await fetch(`${base}/${ruta}`);
    assert.equal(r.status, 200, ruta);
  }
  const malo = await fetch(`${base}/top-productos?limite=0`);
  assert.equal(malo.status, 400);
  assert.match((await malo.json()).error, /limite/);
  assert.equal((await fetch(`${base}/no-existe`)).status, 404);
});