// Traduce la configuración de un tópico entre como la escribimos nosotros
// (shared/topics.js y la API del admin) y como la pide Kafka.
// Kafka recibe la retención en milisegundos y en bytes, y todos los valores
// de configuración como texto.

const DIA_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

// Las configuraciones del tópico que controlamos nosotros (las demás quedan
// con el valor por defecto del broker): nuestro nombre, el nombre en Kafka y
// cómo se pasa de uno al otro
const CLAVES = {
  limpieza: { kafka: 'cleanup.policy', aKafka: v => v, desdeKafka: v => v },
  retencionDias: {
    kafka: 'retention.ms',
    aKafka: v => String(v * DIA_MS),
    // -1 en Kafka es "sin límite"
    desdeKafka: v => (Number(v) < 0 ? null : Number(v) / DIA_MS),
  },
  retencionMbPorParticion: {
    // retention.bytes es por partición, no por tópico
    kafka: 'retention.bytes',
    aKafka: v => String(v * MB),
    desdeKafka: v => (Number(v) < 0 ? null : Number(v) / MB),
  },
  minInsync: { kafka: 'min.insync.replicas', aKafka: v => String(v), desdeKafka: v => Number(v) },
};

// Nuestros campos -> configuración de Kafka. Traduce solo los que vienen:
// con un tópico completo de shared/topics.js salen las 4, y con un cambio
// parcial del admin (por ejemplo, solo retencionDias) sale solo esa.
export function configuracion(t) {
  return Object.fromEntries(Object.entries(CLAVES)
    .filter(([campo]) => t[campo] !== undefined)
    .map(([campo, c]) => [c.kafka, c.aKafka(t[campo])]));
}

// Configuración de Kafka -> nuestros campos (para mostrarla en la API)
export function legible(config) {
  return Object.fromEntries(Object.entries(CLAVES)
    .map(([campo, c]) => [campo, config[c.kafka] === undefined ? null : c.desdeKafka(config[c.kafka])]));
}

// Para admin.createTopics()
export function definicionTopico(t) {
  return {
    topic: t.nombre,
    numPartitions: t.particiones,
    replicationFactor: t.replicas,
    configEntries: Object.entries(configuracion(t)).map(([name, value]) => ({ name, value })),
  };
}