// npm run topics: deja los tópicos del clúster tal como dice shared/topics.js
//   1. revisa que estén los 3 brokers
//   2. crea los tópicos que faltan
//   3. en los que ya existen, corrige particiones y configuración si alguien
//      las cambió a mano (por ejemplo, desde Kafka UI)
//   4. prepara el tópico interno donde Kafka guarda los offsets de los grupos
//   5. muestra cómo quedó cada tópico: configuración, líderes y réplicas
// Se puede correr las veces que sea: si todo está bien, no cambia nada.
import { crearKafka, ConfigResourceTypes, logLevel } from '../shared/kafka.js';
import { TOPICOS, PEDIDOS } from '../shared/topics.js';
import { configuracion, definicionTopico } from './topicos.js';

const admin = crearKafka('admin-setup').admin();
const nombres = TOPICOS.map(t => t.nombre);

async function revisarBrokers() {
  const { brokers, controller } = await admin.describeCluster();
  console.log(`Clúster: ${brokers.length} brokers, controlador: broker ${controller}`);
  const necesarios = Math.max(...TOPICOS.map(t => t.replicas));
  if (brokers.length < necesarios) {
    throw new Error(`los tópicos piden ${necesarios} réplicas y hay ${brokers.length} brokers arriba (revisa docker compose ps)`);
  }
}

async function crearFaltantes(existentes) {
  const faltantes = TOPICOS.filter(t => !existentes.includes(t.nombre));
  if (!faltantes.length) return;
  // waitForLeaders: espera a que cada partición tenga líder antes de seguir
  await admin.createTopics({ topics: faltantes.map(definicionTopico), waitForLeaders: true });
  for (const t of faltantes) console.log(`  creado       ${t.nombre}`);
}

// Kafka guarda los offsets de los grupos en un tópico interno, __consumer_offsets
// (50 particiones con 3 copias). No existe hasta que alguien pregunta por un
// grupo por primera vez, y crearlo toma unos segundos. Lo provocamos aquí para
// que el primer consumidor no tenga que esperar ni muestre el error
// "group coordinator is not available".
async function prepararOffsets(existentes) {
  if (existentes.includes('__consumer_offsets')) return;
  console.log('  preparando   __consumer_offsets (solo la primera vez, tarda unos segundos)');
  // Mientras Kafka lo crea, cada intento responde "group coordinator is not
  // available" y KafkaJS lo muestra como ERROR aunque al final funcione. Se
  // silencia solo durante este paso: si de verdad falla, el error igual sale.
  admin.logger().setLogLevel(logLevel.NOTHING);
  try {
    await admin.fetchOffsets({ groupId: 'admin-setup', topics: [PEDIDOS] });
  } finally {
    admin.logger().setLogLevel(logLevel.WARN);
  }
}

async function corregirParticiones(existentes) {
  const revisar = TOPICOS.filter(t => existentes.includes(t.nombre));
  if (!revisar.length) return;
  const { topics } = await admin.fetchTopicMetadata({ topics: revisar.map(t => t.nombre) });
  for (const t of revisar) {
    const { partitions } = topics.find(m => m.name === t.nombre);
    if (partitions.length < t.particiones) {
      // ojo: desde ahora algunas keys caen en otra partición que antes
      await admin.createPartitions({ topicPartitions: [{ topic: t.nombre, count: t.particiones }] });
      console.log(`  particiones  ${t.nombre}: ${partitions.length} -> ${t.particiones}`);
    } else if (partitions.length > t.particiones) {
      console.warn(`  AVISO ${t.nombre} tiene ${partitions.length} particiones y el código pide ${t.particiones}: Kafka no permite quitar particiones, hay que borrar el tópico y crearlo de nuevo`);
    }
    if (partitions[0].replicas.length !== t.replicas) {
      console.warn(`  AVISO ${t.nombre} tiene ${partitions[0].replicas.length} réplicas y el código pide ${t.replicas}: cambiarlas requiere reasignar las particiones`);
    }
  }
}

// Lee la configuración real de cada tópico desde los brokers
async function leerConfiguracion() {
  const { resources } = await admin.describeConfigs({
    includeSynonyms: false,
    resources: nombres.map(name => ({ type: ConfigResourceTypes.TOPIC, name })),
  });
  return Object.fromEntries(resources.map(r => [
    r.resourceName,
    Object.fromEntries(r.configEntries.map(c => [c.configName, c.configValue])),
  ]));
}

async function corregirConfiguracion(existentes) {
  const actual = await leerConfiguracion();
  for (const t of TOPICOS.filter(t => existentes.includes(t.nombre))) {
    const deseada = configuracion(t);
    const distintas = Object.keys(deseada).filter(k => actual[t.nombre][k] !== deseada[k]);
    if (!distintas.length) {
      console.log(`  sin cambios  ${t.nombre}`);
      continue;
    }
    // alterConfigs reemplaza toda la configuración propia del tópico por esta
    // lista: cualquier otro cambio hecho a mano vuelve al valor por defecto
    await admin.alterConfigs({
      resources: [{
        type: ConfigResourceTypes.TOPIC,
        name: t.nombre,
        configEntries: Object.entries(deseada).map(([name, value]) => ({ name, value })),
      }],
    });
    console.log(`  corregido    ${t.nombre}: ${distintas.map(k => `${k} ${actual[t.nombre][k]} -> ${deseada[k]}`).join(', ')}`);
  }
}

async function mostrarEstado() {
  const config = await leerConfiguracion();
  const { topics } = await admin.fetchTopicMetadata({ topics: nombres });

  console.log('\nConfiguración (leída desde los brokers):');
  console.table(topics.map(t => ({
    tópico: t.name,
    particiones: t.partitions.length,
    réplicas: t.partitions[0].replicas.length,
    'min ISR': Number(config[t.name]['min.insync.replicas']),
    'retención días': Number(config[t.name]['retention.ms']) / 86400000,
    'MB por partición': Number(config[t.name]['retention.bytes']) / 1048576,
    limpieza: config[t.name]['cleanup.policy'],
  })));

  // ISR = réplicas al día con el líder. Si las 3 aparecen, ningún broker está atrasado.
  console.log('Particiones: qué broker es líder y cuáles tienen copia:');
  console.table(topics.flatMap(t => [...t.partitions]
    .sort((a, b) => a.partitionId - b.partitionId)
    .map(p => ({
      tópico: t.name,
      partición: p.partitionId,
      líder: p.leader,
      réplicas: p.replicas.join(','),
      'al día (ISR)': p.isr.join(','),
    }))));
}

async function main() {
  await admin.connect();
  try {
    await revisarBrokers();
    const existentes = await admin.listTopics();
    console.log('Tópicos:');
    await crearFaltantes(existentes);
    await corregirParticiones(existentes);
    await corregirConfiguracion(existentes);
    await prepararOffsets(existentes);
    await mostrarEstado();
  } finally {
    await admin.disconnect();
  }
}

main().catch(e => {
  console.error(`npm run topics falló: ${e.message}`);
  process.exitCode = 1;
});
