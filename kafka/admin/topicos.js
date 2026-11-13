// Traduce un tópico de shared/topics.js al formato que pide Kafka.
// Kafka recibe la retención en milisegundos y en bytes, y todos los valores
// de configuración como texto.

const DIA_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

// Las configuraciones del tópico que controlamos nosotros (las demás quedan
// con el valor por defecto del broker)
export function configuracion(t) {
  return {
    'cleanup.policy': t.limpieza,
    'retention.ms': String(t.retencionDias * DIA_MS),
    // retention.bytes es por partición, no por tópico
    'retention.bytes': String(t.retencionMbPorParticion * MB),
    'min.insync.replicas': String(t.minInsync),
  };
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
