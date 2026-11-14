// El microservicio administrador de Kafka: lo que hace cada operación de la
// API contra el clúster, con el cliente admin de KafkaJS.
//   - tópicos (en este archivo): listar, ver el detalle, crear, cambiar la
//     configuración, agregar particiones y borrar
//   - grupos de consumidores (grupos.js): lag, instancias, offsets
//   - DLT (dlt.js): ver y reprocesar
// Lo que no se puede deshacer (borrar, agregar particiones) se rechaza con 409
// en los tópicos de Pedidos360: esos se cambian en shared/topics.js y se
// aplican con npm run topics (configuración como código).
import { ConfigResourceTypes, ConfigSource } from '../shared/kafka.js';
import { TOPICOS } from '../shared/topics.js';
import { NoEncontradoError, ConflictoError } from '../shared/http.js';
import { configuracion, legible, definicionTopico } from './topicos.js';
import * as validar from './validacion.js';
import { crearGrupos, instancias } from './grupos.js';
import { crearDlt } from './dlt.js';

const GESTIONADOS = new Set(TOPICOS.map(t => t.nombre));
const esInterno = nombre => nombre.startsWith('__');

// kafka, admin y producer vienen conectados desde server.js (en las pruebas,
// un admin falso en memoria)
export function crearServicio({ kafka, admin, producer, log = () => {} }) {
  async function exigirTopico(nombre) {
    if (!(await admin.listTopics()).includes(nombre)) throw new NoEncontradoError(`no existe el tópico ${nombre}`);
  }

  function exigirNoInterno(nombre) {
    if (esInterno(nombre)) throw new ConflictoError(`${nombre} es un tópico interno de Kafka: no se modifica`);
  }

  const grupos = crearGrupos({ admin, log, exigirTopico });
  const dlt = crearDlt({ kafka, admin, producer, log, exigirTopico });

  // La configuración de cada tópico, leída desde los brokers: la vigente
  // (todos los valores, incluidos los que vienen del broker) y la propia (solo
  // la que se fijó para ese tópico)
  async function leerConfig(nombres) {
    const { resources } = await admin.describeConfigs({
      includeSynonyms: false,
      resources: nombres.map(name => ({ type: ConfigResourceTypes.TOPIC, name })),
    });
    return Object.fromEntries(resources.map(r => [r.resourceName, {
      vigente: Object.fromEntries(r.configEntries.map(c => [c.configName, c.configValue])),
      propia: Object.fromEntries(r.configEntries
        .filter(c => c.configSource === ConfigSource.TOPIC_CONFIG)
        .map(c => [c.configName, c.configValue])),
    }]));
  }

  // Un tópico con los mismos campos que se usan para crearlo
  function resumen(meta, config, offsets) {
    return {
      nombre: meta.name,
      gestionado: GESTIONADOS.has(meta.name),
      particiones: meta.partitions.length,
      replicas: meta.partitions[0]?.replicas.length ?? 0,
      ...legible(config.vigente),
      mensajes: offsets.reduce((s, o) => s + Number(o.high) - Number(o.low), 0),
      // particiones con alguna copia atrasada (por ejemplo, con un broker caído)
      particionesConCopiaAtrasada: meta.partitions.filter(p => p.isr.length < p.replicas.length).length,
    };
  }

  async function cluster(query) {
    validar.sinParametros(query);
    const { brokers, controller, clusterId } = await admin.describeCluster();
    return {
      clusterId,
      controlador: controller,
      brokers: brokers.map(b => ({ id: b.nodeId, host: `${b.host}:${b.port}` })).sort((a, b) => a.id - b.id),
    };
  }

  async function listarTopicos(query) {
    validar.sinParametros(query);
    const nombres = (await admin.listTopics()).filter(n => !esInterno(n)).sort();
    if (!nombres.length) return [];
    const [{ topics }, config] = await Promise.all([admin.fetchTopicMetadata({ topics: nombres }), leerConfig(nombres)]);
    return Promise.all(nombres.map(async n => resumen(
      topics.find(t => t.name === n), config[n], await admin.fetchTopicOffsets(n),
    )));
  }

  async function detalleTopico(nombre) {
    await exigirTopico(nombre);
    const [{ topics: [meta] }, config, offsets, lectores] = await Promise.all([
      admin.fetchTopicMetadata({ topics: [nombre] }),
      leerConfig([nombre]),
      admin.fetchTopicOffsets(nombre),
      grupos.lectoresDe(nombre),
    ]);
    return {
      ...resumen(meta, config[nombre], offsets),
      // lo que se fijó para este tópico, con los nombres de Kafka
      configuracion: config[nombre].propia,
      // ISR (alDia) = las copias al día con el líder
      porParticion: [...meta.partitions]
        .sort((a, b) => a.partitionId - b.partitionId)
        .map(p => {
          const o = offsets.find(x => x.partition === p.partitionId);
          return { particion: p.partitionId, lider: p.leader, replicas: p.replicas, alDia: p.isr, inicio: Number(o.low), fin: Number(o.high) };
        }),
      grupos: lectores,
    };
  }

  async function crearTopico(cuerpo) {
    const t = validar.validarNuevoTopico(cuerpo);
    if ((await admin.listTopics()).includes(t.nombre)) throw new ConflictoError(`el tópico ${t.nombre} ya existe`);
    const { brokers } = await admin.describeCluster();
    if (t.replicas > brokers.length) {
      throw new ConflictoError(`pide ${t.replicas} copias y hay ${brokers.length} brokers arriba: cada copia va en un broker distinto`);
    }
    // waitForLeaders: responde cuando cada partición ya tiene líder
    await admin.createTopics({ topics: [definicionTopico(t)], waitForLeaders: true });
    log(`tópico creado: ${t.nombre}`, { particiones: t.particiones, replicas: t.replicas });
    return detalleTopico(t.nombre);
  }

  async function modificarConfiguracion(nombre, cuerpo) {
    const cambios = validar.validarCambioConfig(cuerpo);
    await exigirTopico(nombre);
    exigirNoInterno(nombre);
    const [{ topics: [meta] }, config] = await Promise.all([
      admin.fetchTopicMetadata({ topics: [nombre] }),
      leerConfig([nombre]),
    ]);
    const replicas = meta.partitions[0].replicas.length;
    if (cambios.minInsync > replicas) {
      throw new ConflictoError(`${nombre} tiene ${replicas} copias: minInsync puede ser hasta ${replicas}`);
    }
    const nuevos = configuracion(cambios);
    const { vigente, propia } = config[nombre];
    // alterConfigs reemplaza TODA la configuración propia del tópico: se manda
    // la que ya tenía con los cambios encima, para no perder nada
    await admin.alterConfigs({
      resources: [{
        type: ConfigResourceTypes.TOPIC,
        name: nombre,
        configEntries: Object.entries({ ...propia, ...nuevos }).map(([name, value]) => ({ name, value })),
      }],
    });
    const detalle = Object.entries(nuevos).map(([k, v]) => `${k}: ${vigente[k]} -> ${v}`);
    log(`configuración cambiada: ${nombre}`, { cambios: JSON.stringify(detalle.join(', ')) });
    return {
      ...(await detalleTopico(nombre)),
      cambios: detalle,
      ...(GESTIONADOS.has(nombre) && {
        aviso: 'es un tópico de Pedidos360: npm run topics lo vuelve a dejar como dice shared/topics.js',
      }),
    };
  }

  async function agregarParticiones(nombre, cuerpo) {
    const total = validar.validarParticiones(cuerpo);
    await exigirTopico(nombre);
    exigirNoInterno(nombre);
    if (GESTIONADOS.has(nombre)) {
      // cambiar las particiones mueve algunas keys a otra partición: en los
      // tópicos de Pedidos360 se decide en el código, no desde la API
      throw new ConflictoError(`${nombre} es de Pedidos360: sus particiones se cambian en shared/topics.js y se aplican con npm run topics`);
    }
    const { topics: [meta] } = await admin.fetchTopicMetadata({ topics: [nombre] });
    const actual = meta.partitions.length;
    if (total <= actual) {
      throw new ConflictoError(`${nombre} ya tiene ${actual} particiones: Kafka solo permite agregar, nunca quitar`);
    }
    await admin.createPartitions({ topicPartitions: [{ topic: nombre, count: total }] });
    log(`particiones agregadas: ${nombre} ${actual} -> ${total}`);
    return detalleTopico(nombre);
  }

  async function borrarTopico(nombre) {
    await exigirTopico(nombre);
    exigirNoInterno(nombre);
    if (GESTIONADOS.has(nombre)) {
      throw new ConflictoError(`${nombre} es de Pedidos360 y lo usan los servicios: se administra en shared/topics.js`);
    }
    const leyendo = (await grupos.lectoresDe(nombre)).filter(g => g.instancias > 0);
    if (leyendo.length) {
      throw new ConflictoError(`lo están leyendo: ${leyendo.map(g => `${g.grupo} (${instancias(g.instancias)})`).join(', ')}. Detenlos antes de borrarlo`);
    }
    // borra también sus mensajes: no se puede deshacer
    await admin.deleteTopics({ topics: [nombre] });
    log(`tópico borrado: ${nombre}`);
    return { borrado: nombre };
  }

  return {
    cluster,
    listarTopicos,
    detalleTopico,
    crearTopico,
    modificarConfiguracion,
    agregarParticiones,
    borrarTopico,
    listarGrupos: grupos.listarGrupos,
    detalleGrupo: grupos.detalleGrupo,
    reiniciarOffsets: grupos.reiniciarOffsets,
    borrarGrupo: grupos.borrarGrupo,
    verDlt: dlt.verDlt,
    reprocesarDlt: dlt.reprocesarDlt,
  };
}