// Pruebas del microservicio admin (npm test): la validación, las reglas (qué
// se rechaza con 404 y 409) y la API. Sin clúster: el servicio recibe un
// admin falso en memoria, igual que report y audit reciben un repositorio en
// memoria. La lectura y el reproceso de las DLT necesitan un consumidor real:
// esos se prueban contra el clúster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssignerProtocol, ConfigSource } from '../shared/kafka.js';
import { TOPICOS, PEDIDOS } from '../shared/topics.js';
import { ParametroInvalidoError, NoEncontradoError, ConflictoError } from '../shared/http.js';
import { configuracion, legible, definicionTopico } from '../admin/topicos.js';
import { validarNuevoTopico, validarCambioConfig, validarParticiones, validarReinicio } from '../admin/validacion.js';
import { crearServicio } from '../admin/servicio.js';
import { crearApi } from '../admin/api.js';

// Un clúster de 3 brokers en memoria con lo justo del admin de KafkaJS que usa
// servicio.js. Parte con __consumer_offsets y los tópicos de shared/topics.js,
// y cada partición tiene 100 mensajes (offsets 0 a 99).
function adminFalso() {
  const topicos = new Map(); // nombre -> { particiones, config }
  const grupos = new Map();  // id -> { instancias: [{ clientId, asignacion }], offsets: { topico: { particion: offset } } }
  const crear = ({ topic, numPartitions, configEntries }) => topicos.set(topic, {
    particiones: numPartitions,
    config: Object.fromEntries(configEntries.map(c => [c.name, c.value])),
  });
  crear({ topic: '__consumer_offsets', numPartitions: 50, configEntries: [] });
  TOPICOS.forEach(t => crear(definicionTopico(t)));
  const brokers = [1, 2, 3];

  return {
    topicos,
    grupos,
    listTopics: async () => [...topicos.keys()],
    describeCluster: async () => ({ brokers: brokers.map(nodeId => ({ nodeId, host: 'localhost', port: 9091 + nodeId })), controller: 1, clusterId: 'falso' }),
    fetchTopicMetadata: async ({ topics }) => ({
      topics: topics.map(name => ({
        name,
        partitions: Array.from({ length: topicos.get(name).particiones }, (_, i) => ({ partitionId: i, leader: brokers[i % 3], replicas: brokers, isr: brokers })),
      })),
    }),
    describeConfigs: async ({ resources }) => ({
      resources: resources.map(({ name }) => ({
        resourceName: name,
        configEntries: Object.entries(topicos.get(name).config)
          .map(([configName, configValue]) => ({ configName, configValue, configSource: ConfigSource.TOPIC_CONFIG })),
      })),
    }),
    fetchTopicOffsets: async name => Array.from({ length: topicos.get(name).particiones }, (_, partition) => ({ partition, low: '0', high: '100' })),
    createTopics: async ({ topics }) => topics.forEach(crear),
    // como en Kafka: reemplaza toda la configuración propia del tópico
    alterConfigs: async ({ resources: [{ name, configEntries }] }) => {
      topicos.get(name).config = Object.fromEntries(configEntries.map(c => [c.name, c.value]));
    },
    createPartitions: async ({ topicPartitions: [{ topic, count }] }) => { topicos.get(topic).particiones = count; },
    deleteTopics: async ({ topics }) => topics.forEach(t => topicos.delete(t)),
    listGroups: async () => ({ groups: [...grupos.keys()].map(groupId => ({ groupId, protocolType: 'consumer' })) }),
    describeGroups: async ids => ({
      groups: ids.map(groupId => {
        const g = grupos.get(groupId);
        if (!g) return { groupId, state: 'Dead', members: [] };
        return {
          groupId,
          state: g.instancias.length ? 'Stable' : 'Empty',
          members: g.instancias.map(i => ({
            clientId: i.clientId,
            clientHost: '/127.0.0.1',
            memberAssignment: AssignerProtocol.MemberAssignment.encode({ version: 0, assignment: i.asignacion }),
          })),
        };
      }),
    }),
    fetchOffsets: async ({ groupId }) => Object.entries(grupos.get(groupId)?.offsets ?? {})
      .map(([topic, ps]) => ({ topic, partitions: Object.entries(ps).map(([p, offset]) => ({ partition: Number(p), offset: String(offset) })) })),
    setOffsets: async ({ groupId, topic, partitions }) => {
      grupos.get(groupId).offsets[topic] = Object.fromEntries(partitions.map(p => [p.partition, Number(p.offset)]));
    },
    deleteGroups: async ids => ids.forEach(id => grupos.delete(id)),
  };
}

function servicioFalso() {
  const admin = adminFalso();
  return { admin, servicio: crearServicio({ admin }) };
}

test('la configuración se traduce igual que antes, completa o por partes', () => {
  // pedidos.eventos, tal como lo crea npm run topics
  assert.deepEqual(configuracion(TOPICOS[0]), {
    'cleanup.policy': 'delete',
    'retention.ms': '604800000',
    'retention.bytes': '268435456',
    'min.insync.replicas': '2',
  });
  // un cambio parcial traduce solo lo que viene
  assert.deepEqual(configuracion({ retencionDias: 1 }), { 'retention.ms': '86400000' });
  // y de vuelta, para mostrarla: -1 en Kafka es "sin límite"
  assert.deepEqual(legible({ ...configuracion(TOPICOS[0]), 'retention.bytes': '-1' }), {
    limpieza: 'delete', retencionDias: 7, retencionMbPorParticion: null, minInsync: 2,
  });
});

test('un tópico nuevo sin más datos queda como pedidos.eventos', () => {
  assert.deepEqual(validarNuevoTopico({ nombre: 'demo' }), {
    nombre: 'demo', particiones: 3, replicas: 3, retencionDias: 7, retencionMbPorParticion: 256, limpieza: 'delete', minInsync: 2,
  });
});

test('lo mal pedido se rechaza con 400', () => {
  const casos = [
    [validarNuevoTopico, {}],
    [validarNuevoTopico, { nombre: 'con espacio' }],
    [validarNuevoTopico, { nombre: '__interno' }],
    [validarNuevoTopico, { nombre: 'demo', color: 'rojo' }],
    [validarNuevoTopico, { nombre: 'demo', particiones: 0 }],
    [validarNuevoTopico, { nombre: 'demo', particiones: 2.5 }],
    [validarNuevoTopico, { nombre: 'demo', replicas: 4 }],
    [validarNuevoTopico, { nombre: 'demo', limpieza: 'borrar' }],
    [validarNuevoTopico, { nombre: 'demo', replicas: 1, minInsync: 2 }],
    [validarNuevoTopico, [1, 2]],
    [validarCambioConfig, {}],
    [validarCambioConfig, { particiones: 6 }],
    [validarCambioConfig, { retencionDias: '7 días' }],
    [validarParticiones, { total: 13 }],
    [validarReinicio, { posicion: 'inicio' }],
    [validarReinicio, { topico: PEDIDOS, posicion: 'ayer' }],
  ];
  for (const [validar, cuerpo] of casos) {
    assert.throws(() => validar(cuerpo), ParametroInvalidoError, `${validar.name} ${JSON.stringify(cuerpo)}`);
  }
});

test('crear, cambiar la configuración, agregar particiones y borrar un tópico', async () => {
  const { admin, servicio } = servicioFalso();

  const creado = await servicio.crearTopico({ nombre: 'demo', particiones: 2 });
  assert.equal(creado.particiones, 2);
  assert.equal(creado.configuracion['retention.ms'], '604800000');
  await assert.rejects(servicio.crearTopico({ nombre: 'demo' }), ConflictoError);

  // cambia solo la retención: lo demás que tenía el tópico se conserva
  const cambiado = await servicio.modificarConfiguracion('demo', { retencionDias: 2 });
  assert.deepEqual(cambiado.cambios, ['retention.ms: 604800000 -> 172800000']);
  assert.deepEqual(admin.topicos.get('demo').config, {
    'cleanup.policy': 'delete', 'retention.ms': '172800000', 'retention.bytes': '268435456', 'min.insync.replicas': '2',
  });

  assert.equal((await servicio.agregarParticiones('demo', { total: 4 })).particiones, 4);
  await assert.rejects(servicio.agregarParticiones('demo', { total: 3 }), ConflictoError);

  assert.deepEqual(await servicio.borrarTopico('demo'), { borrado: 'demo' });
  await assert.rejects(servicio.detalleTopico('demo'), NoEncontradoError);
});

test('los tópicos de Pedidos360 y los internos no se borran ni cambian de particiones', async () => {
  const { servicio } = servicioFalso();
  await assert.rejects(servicio.borrarTopico(PEDIDOS), ConflictoError);
  await assert.rejects(servicio.agregarParticiones(PEDIDOS, { total: 6 }), ConflictoError);
  await assert.rejects(servicio.borrarTopico('__consumer_offsets'), ConflictoError);
  await assert.rejects(servicio.modificarConfiguracion('__consumer_offsets', { retencionDias: 1 }), ConflictoError);
  // su configuración sí se puede cambiar, con un aviso
  const cambiado = await servicio.modificarConfiguracion(PEDIDOS, { retencionDias: 3 });
  assert.match(cambiado.aviso, /npm run topics/);
});

test('no se borra un tópico que alguien está leyendo', async () => {
  const { admin, servicio } = servicioFalso();
  await servicio.crearTopico({ nombre: 'demo' });
  admin.grupos.set('lector', { instancias: [{ clientId: 'lector-1', asignacion: { demo: [2, 0, 1] } }], offsets: { demo: { 0: 100 } } });
  await assert.rejects(servicio.borrarTopico('demo'), /lector \(1 instancia\)/);
});

test('grupos: lag, instancias y mover offsets solo sin instancias', async () => {
  const { admin, servicio } = servicioFalso();
  admin.grupos.set('report', {
    instancias: [{ clientId: 'report-1', asignacion: { [PEDIDOS]: [2, 0, 1] } }],
    offsets: { [PEDIDOS]: { 0: 90, 1: 100, 2: 100 } },
  });

  const [report] = await servicio.listarGrupos({});
  assert.deepEqual(report, { grupo: 'report', estado: 'Stable', instancias: 1, lag: 10, topicos: [PEDIDOS] });
  const detalle = await servicio.detalleGrupo('report');
  assert.deepEqual(detalle.instancias[0].particiones, { [PEDIDOS]: [0, 1, 2] });

  // con instancias conectadas, Kafka no deja mover offsets ni borrar el grupo
  const inicio = { topico: PEDIDOS, posicion: 'inicio' };
  await assert.rejects(servicio.reiniciarOffsets('report', inicio), ConflictoError);
  await assert.rejects(servicio.borrarGrupo('report'), ConflictoError);

  admin.grupos.get('report').instancias = [];
  const desdeCero = await servicio.reiniciarOffsets('report', inicio);
  assert.equal(desdeCero.lag, 300);
  assert.deepEqual(desdeCero.offsets.map(o => o.confirmado), [0, 0, 0]);
  assert.equal((await servicio.reiniciarOffsets('report', { topico: PEDIDOS, posicion: 'fin' })).lag, 0);

  await assert.rejects(servicio.detalleGrupo('no-existe'), NoEncontradoError);
  await assert.rejects(servicio.reiniciarOffsets('report', { topico: 'no.existe', posicion: 'fin' }), NoEncontradoError);
  assert.deepEqual(await servicio.borrarGrupo('report'), { borrado: 'report' });
});

test('la API responde 201, 400, 404 y 409', async t => {
  const { servicio } = servicioFalso();
  const servidor = crearApi(servicio).listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin`;
  const enviar = (metodo, ruta, cuerpo) => fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });

  assert.equal((await enviar('POST', '/topicos', { nombre: 'demo' })).status, 201);
  assert.equal((await enviar('POST', '/topicos', { nombre: 'demo' })).status, 409);
  const malo = await enviar('POST', '/topicos', '{malo');
  assert.equal(malo.status, 400);
  assert.match((await malo.json()).error, /JSON válido/);
  assert.equal((await fetch(`${base}/topicos?x=1`)).status, 400);
  assert.equal((await fetch(`${base}/topicos/no.existe`)).status, 404);
  assert.equal((await fetch(`${base}/topicos`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/topicos/${PEDIDOS}`, { method: 'DELETE' })).status, 409);
  assert.equal((await fetch(`${base}/dlt/otro`)).status, 404);

  // la lista no muestra los internos (__consumer_offsets)
  const lista = await (await fetch(`${base}/topicos`)).json();
  assert.deepEqual(lista.map(t => t.nombre), [...TOPICOS.map(t => t.nombre), 'demo'].sort());
});