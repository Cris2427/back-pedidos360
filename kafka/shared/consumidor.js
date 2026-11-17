// Consumidor genérico de Pedidos360: lo usan report y audit.
// Hace lo que en Spring Kafka hacen @KafkaListener, DefaultErrorHandler y
// DeadLetterPublishingRecoverer. Por cada mensaje:
//   1. lo deserializa y lo valida con el DTO
//   2. se lo entrega a la lógica del servicio (procesar)
//   3. si falla por algo pasajero, reintenta a los 1, 2 y 4 segundos
//   4. si el error no tiene arreglo, o se acabaron los reintentos, lo manda a
//      la DLT del servicio con headers que dicen qué pasó, y sigue con el
//      siguiente mensaje
// Así un mensaje malo nunca deja su partición bloqueada.
import { crearKafka, CONFIG_PRODUCTOR, OPCIONES_ENVIO, configConsumidor } from './kafka.js';
import { dltDe } from './topics.js';
import { deserializar as deserializarPedido } from './serializador.js';

export const REINTENTOS_MS = [1000, 2000, 4000];

const esperarMs = ms => new Promise(r => setTimeout(r, ms));
const comoTexto = valor => (valor == null ? undefined : valor.toString());

// Una línea de log: hora, servicio, qué pasó y el contexto del mensaje
// (grupo, partición, offset, key, correlationId) para poder rastrearlo.
export function crearLog(servicio) {
  return (texto, datos = {}) => {
    const extra = Object.entries(datos)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`${new Date().toISOString()} [${servicio}] ${texto}${extra ? ` ${extra}` : ''}`);
  };
}

// El mensaje que va a la DLT: la misma key y el mismo value (los bytes
// originales, aunque no sean JSON), los headers originales (como el
// correlationId) y los que explican qué pasó y de dónde venía.
export function mensajeDlt({ topic, partition, message, servicio, groupId, motivo, error, intentos }) {
  return {
    key: message.key,
    value: message.value,
    headers: {
      ...message.headers,
      'dlt-motivo': motivo,
      'dlt-error': String(error.message).slice(0, 500),
      'dlt-servicio': servicio,
      'dlt-grupo': groupId,
      'dlt-topico': topic,
      'dlt-particion': String(partition),
      'dlt-offset': String(message.offset),
      'dlt-intentos': String(intentos),
      'dlt-fecha': new Date().toISOString(),
    },
  };
}

// Lo que se hace con un mensaje, separado de Kafka para poder probarlo sin
// clúster (las pruebas le pasan una DLT falsa y esperas que no esperan).
// Devuelve qué pasó: lo que responda procesar ('aplicado', 'duplicado'...) o 'dlt'.
export function crearManejador({
  servicio,
  groupId,
  procesar,
  enviarADlt,
  deserializar = deserializarPedido,
  esperar = esperarMs,
  log = crearLog(servicio),
  reintentosMs = REINTENTOS_MS,
}) {
  return async function manejar({ topic, partition, message, heartbeat = async () => {} }) {
    const contexto = {
      topic,
      partition,
      offset: message.offset,
      key: comoTexto(message.key),
      correlationId: comoTexto(message.headers?.correlationId),
    };
    const datosLog = {
      grupo: groupId,
      particion: partition,
      offset: message.offset,
      key: contexto.key,
      correlationId: contexto.correlationId,
    };

    for (let intento = 1; ; intento++) {
      try {
        const evento = deserializar(message.value);
        const resultado = await procesar(evento, contexto);
        return resultado ?? 'procesado';
      } catch (error) {
        const sinArreglo = error.reintentable === false;
        if (sinArreglo || intento > reintentosMs.length) {
          const motivo = sinArreglo ? (error.motivo ?? error.message) : 'se agotaron los reintentos';
          // Si la DLT tampoco responde (Kafka caído), el error sube y KafkaJS
          // no confirma el offset: el mensaje se vuelve a leer, no se pierde.
          await enviarADlt(mensajeDlt({ topic, partition, message, servicio, groupId, motivo, error, intentos: intento }));
          log(`a la DLT: ${motivo}`, { ...datosLog, error: JSON.stringify(error.message) });
          return 'dlt';
        }
        const espera = reintentosMs[intento - 1];
        log(`falló el intento ${intento}, se reintenta en ${espera / 1000} s`, { ...datosLog, error: JSON.stringify(error.message) });
        await esperar(espera);
        // avisa al grupo que sigue vivo, para que no lo saquen mientras espera
        await heartbeat();
      }
    }
  };
}

// Conecta un consumidor al clúster y lo deja escuchando.
//   servicio:     'report' o 'audit'. Define el clientId y la DLT.
//   groupId:      el grupo de consumidores; por defecto, el nombre del servicio
//   topic:        de dónde lee
//   procesar:     la lógica del servicio: async (evento, contexto)
//   deserializar: por defecto, el del evento de pedido
// Al contexto se le agrega el producer, para los servicios que además
// publican (audit escribe en audit.timeline).
export async function iniciarConsumidor({ servicio, groupId = servicio, topic, procesar, deserializar }) {
  const log = crearLog(servicio);
  // el pid distingue a cada instancia en Kafka UI cuando hay varias
  const kafka = crearKafka(`${servicio}-${process.pid}`);
  const consumer = kafka.consumer(configConsumidor(groupId));
  const producer = kafka.producer(CONFIG_PRODUCTOR);
  const dlt = dltDe(servicio);

  const manejar = crearManejador({
    servicio,
    groupId,
    deserializar,
    log,
    procesar: (evento, contexto) => procesar(evento, { ...contexto, producer }),
    enviarADlt: mensaje => producer.send({ topic: dlt, messages: [mensaje], ...OPCIONES_ENVIO }),
  });

  // Rebalanceo: cada vez que el grupo se reorganiza, cada miembro dice qué particiones le tocaron
  consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    const mias = payload.memberAssignment[topic] ?? [];
    log(`en el grupo ${groupId}, particiones: ${mias.length ? mias.join(', ') : 'ninguna (hay más instancias que particiones)'}`);
  });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    log(`el consumidor falló: ${payload.error.message}`, { reinicia: payload.restart });
  });

  // Cada 5 s, si hubo movimiento, un resumen de lo procesado
  const conteo = {};
  let ultimoTotal = 0;
  const resumen = setInterval(() => {
    const total = Object.values(conteo).reduce((a, b) => a + b, 0);
    if (total === ultimoTotal) return;
    ultimoTotal = total;
    log(`${total} mensajes: ${Object.entries(conteo).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }, 5000);

  await producer.connect();
  await consumer.connect();
  // Un grupo nuevo, sin offsets guardados, parte desde el primer mensaje del
  // tópico. Así un grupo como report-v2 puede reconstruir todo desde cero.
  await consumer.subscribe({ topic, fromBeginning: true });
  // eachMessage entrega un mensaje a la vez, en orden dentro de cada
  // partición. KafkaJS confirma el offset después de cada lote procesado.
  await consumer.run({
    eachMessage: async args => {
      const resultado = await manejar(args);
      conteo[resultado] = (conteo[resultado] ?? 0) + 1;
    },
  });
  log(`escuchando ${topic} en el grupo ${groupId} (DLT: ${dlt})`);

  // Apagado ordenado (Ctrl+C): sale del grupo de inmediato, así sus
  // particiones pasan a otra instancia sin esperar los 30 s de sessionTimeout
  const apagar = async () => {
    log('apagando...');
    clearInterval(resumen);
    await consumer.disconnect();
    await producer.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', apagar);
  process.once('SIGTERM', apagar);

  return { consumer, producer, log };
}