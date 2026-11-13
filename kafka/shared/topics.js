// Los tópicos de Pedidos360 y sus parámetros. Es la única fuente de verdad:
// npm run topics los crea (o los corrige) con estos valores, y el admin los
// consulta. Cada número tiene una razón, anotada al lado.

export const PEDIDOS = 'pedidos.eventos';
export const TIMELINE = 'audit.timeline';

// Una DLT por servicio: al ver un mensaje ahí se sabe qué servicio falló.
// dltDe('report') -> 'pedidos.eventos.report.dlt'
export const dltDe = servicio => `${PEDIDOS}.${servicio}.dlt`;

// Igual para todos: 3 copias de cada partición (una por broker), y una
// escritura con acks=all se acepta si al menos 2 están al día. Así el
// clúster sigue recibiendo pedidos con 1 broker caído sin perder nada.
export const REPLICAS = 3;
export const MIN_INSYNC = 2;

export const TOPICOS = [
  {
    // Todos los eventos de los pedidos. 3 particiones: una líder en cada
    // broker (la carga se reparte pareja) y hasta 3 consumidores trabajando
    // en paralelo por grupo. Los eventos de un pedido van con key pedidoId:
    // caen en la misma partición y se leen en el orden en que pasaron.
    nombre: PEDIDOS,
    particiones: 3,
    // 7 días: alcanza para reprocesar una semana completa (por ejemplo, un
    // grupo nuevo que lee desde el principio) o para que un consumidor caído
    // el fin de semana se ponga al día el lunes
    retencionDias: 7,
    // y como tope de disco, 256 MB por partición: lo que se cumpla primero
    retencionMbPorParticion: 256,
    // delete: cada evento importa (CREADO, ACEPTADO...). compact dejaría solo
    // el último evento de cada pedido y se perdería la historia
    limpieza: 'delete',
  },
  {
    // Lo que report no pudo procesar. 1 partición: llegan pocos mensajes y así
    // quedan todos en una sola fila, en orden, para revisarlos y reprocesarlos.
    // 14 días: el doble que el tópico principal, para alcanzar a investigar.
    nombre: dltDe('report'),
    particiones: 1,
    retencionDias: 14,
    retencionMbPorParticion: 64,
    limpieza: 'delete',
  },
  {
    // Lo mismo para audit
    nombre: dltDe('audit'),
    particiones: 1,
    retencionDias: 14,
    retencionMbPorParticion: 64,
    limpieza: 'delete',
  },
  {
    // Historial legible de cada pedido (quién, qué, cuándo, desde dónde), que
    // publica audit. 3 particiones y key pedidoId, igual que el tópico de
    // origen: el historial de un pedido queda en orden.
    nombre: TIMELINE,
    particiones: 3,
    // 30 días: una auditoría se guarda más tiempo que los eventos de trabajo
    retencionDias: 30,
    retencionMbPorParticion: 256,
    // delete y no compact: compact dejaría solo el último registro de cada
    // pedido y el historial perdería sus pasos
    limpieza: 'delete',
  },
].map(t => ({ ...t, replicas: REPLICAS, minInsync: MIN_INSYNC }));
