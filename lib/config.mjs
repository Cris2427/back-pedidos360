// lo unico que lee variables de entorno: el resto del codigo nunca escribe
// un nombre de tabla, de cola o de topic. los valores los pone el script de
// despliegue a partir de infra/mensajeria.json
const env = process.env;

export const config = {
  origenPermitido: env.ALLOWED_ORIGIN ?? 'http://localhost:5173',

  tablas: {
    catalogo: env.CATALOG_TABLE ?? 'Pedidos360-Catalog',
    pedidos: env.ORDERS_TABLE ?? 'Pedidos360-Orders',
    notificaciones: env.NOTIFICACIONES_TABLE ?? 'Pedidos360-Notificaciones',
  },

  mensajeria: {
    topicArn: env.TOPIC_ARN ?? '',
    atributoFiltro: env.ATRIBUTO_FILTRO ?? 'tipo_evento',
    // la dlq de la cola que consume esta lambda, cada consumidor tiene la suya
    dlqUrl: env.DLQ_URL ?? '',
    maxReceiveCount: Number(env.MAX_RECEIVE_COUNT ?? 3),
    // lo que usa el administrador al crear una cola si no le dicen otra cosa
    visibilidadSegundos: Number(env.VISIBILIDAD_SEGUNDOS ?? 30),
    retencionDlqDias: Number(env.RETENCION_DLQ_DIAS ?? 14),
    // solo para la demo: el consumidor falla como si el servicio externo
    // estuviera caido, asi se ven los reintentos y despues el redrive
    simularCaida: env.SIMULAR_CAIDA === 'true',
  },
};
