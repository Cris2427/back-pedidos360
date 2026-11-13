// Configuración del cliente Kafka, en un solo lugar.
// Todos los servicios (bridge, report, audit, admin) piden aquí su cliente,
// su productor y su consumidor: así todos usan los mismos tiempos de espera,
// los mismos reintentos y las mismas garantías de entrega.
// KafkaJS está escrito en CommonJS: se importa completo y se sacan las piezas
import kafkajs from 'kafkajs';

const { Kafka, Partitioners, CompressionTypes } = kafkajs;
// los usa el admin: tipos de recurso para leer o cambiar configuración
// (TOPIC, BROKER) y los niveles de log
export const { ConfigResourceTypes, logLevel } = kafkajs;

// Los 3 brokers, desde el .env. Con que uno responda basta: el cliente le
// pide el mapa del clúster (metadata) y desde ahí sabe qué broker es líder
// de cada partición. Se leen al crear el cliente y no al importar este
// archivo: así las pruebas pueden importar el consumidor sin tener un .env.
function leerBrokers() {
  if (!process.env.KAFKA_BROKERS) {
    throw new Error('falta KAFKA_BROKERS: copia .env.example a .env');
  }
  return process.env.KAFKA_BROKERS.split(',').map(b => b.trim());
}

// ---------------------------------------------------------------- cliente

export function crearKafka(clientId) {
  return new Kafka({
    clientId,                 // nombre del servicio; aparece en Kafka UI en los miembros de cada grupo
    brokers: leerBrokers(),
    connectionTimeout: 3000,  // ms para abrir la conexión con un broker
    requestTimeout: 30000,    // ms máximo esperando la respuesta de un broker
    // si un broker no responde, reintenta esperando cada vez el doble:
    // 300 ms, 600 ms, 1,2 s... sin pasar de 30 s entre intentos
    retry: { initialRetryTime: 300, retries: 8, maxRetryTime: 30000 },
    logLevel: logLevel.WARN,  // solo avisos y errores: la consola queda limpia para la demo
  });
}

// ---------------------------------------------------------------- productor

export const CONFIG_PRODUCTOR = {
  // Productor idempotente: cada mensaje lleva un número de secuencia, y si el
  // productor reintenta un envío que sí había llegado, el broker descarta la
  // copia. Así un corte de red no duplica eventos en el tópico.
  idempotent: true,
  // un envío en vuelo por broker: un reintento nunca adelanta a otro mensaje
  maxInFlightRequests: 1,
  // la misma key (pedidoId) siempre cae en la misma partición; es el mismo
  // cálculo (murmur2) que usa el cliente oficial de Java
  createPartitioner: Partitioners.DefaultPartitioner,
  // los tópicos los crea npm run topics, nunca un envío por error de nombre
  allowAutoTopicCreation: false,
  // Sin límite de reintentos: si se caen 2 brokers, el productor espera a que
  // vuelva uno y sigue solo, sin perder ni duplicar. Es lo mismo que hace el
  // cliente de Java (retries = máximo).
  retry: { retries: Number.MAX_SAFE_INTEGER, maxRetryTime: 30000 },
};

// Opciones de cada send(). KafkaJS las pide en cada envío y no al crear el
// productor, por eso van aparte.
export const OPCIONES_ENVIO = {
  // acks=all: el líder confirma recién cuando las réplicas al día (mínimo 2,
  // ver min.insync.replicas en topics.js) tienen el mensaje. Si el líder se
  // cae justo después de confirmar, otra réplica ya lo tiene.
  acks: -1,
  timeout: 30000,                     // ms que el broker espera esas confirmaciones
  compression: CompressionTypes.GZIP, // un lote de JSON comprimido pesa varias veces menos
};

// ---------------------------------------------------------------- consumidor

export function configConsumidor(groupId) {
  return {
    groupId,                  // consumidores con el mismo groupId se reparten las particiones
    // Si el broker pasa 30 s sin latidos de un consumidor, lo da por muerto y
    // reparte sus particiones entre los demás (rebalanceo). El latido va cada
    // 3 s: perder uno o dos no basta para sacarlo del grupo.
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    rebalanceTimeout: 60000,  // plazo para que todos se vuelvan a unir en un rebalanceo
    // Cada lectura trae hasta 1 MB por partición. Si no hay mensajes nuevos, el
    // broker responde a los 500 ms igual, para no dejar al consumidor esperando.
    maxBytesPerPartition: 1048576,
    maxWaitTimeInMs: 500,
    allowAutoTopicCreation: false,
  };
}
