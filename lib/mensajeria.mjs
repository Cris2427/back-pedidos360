import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';

// un dato invalido no se arregla reintentando: va directo a la dlq
export class ErrorNoRecuperable extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorNoRecuperable';
  }
}

// en las pruebas locales la dlq es esta lista y no sqs
export const dlqEnMemoria = [];

// mismo truco que el store: el sdk viene en lambda pero no en el repo
let sqs = null;
async function enviarADlqSqs(record, motivo, consumidor) {
  sqs ??= import('@aws-sdk/client-sqs').then((lib) => ({ cliente: new lib.SQSClient({}), lib }));
  const { cliente, lib } = await sqs;
  await cliente.send(
    new lib.SendMessageCommand({
      QueueUrl: config.mensajeria.dlqUrl,
      MessageBody: record.body,
      // para saber despues por que llego aca sin tener que buscar en los logs
      MessageAttributes: {
        motivo: { DataType: 'String', StringValue: motivo.slice(0, 256) },
        consumidor: { DataType: 'String', StringValue: consumidor },
        mensajeOriginal: { DataType: 'String', StringValue: record.messageId },
      },
    }),
  );
}

async function enviarADlqMemoria(record, motivo, consumidor) {
  dlqEnMemoria.push({ body: record.body, motivo, consumidor, mensajeOriginal: record.messageId });
}

const enviarADlqPorDefecto = (...args) =>
  process.env.STORE === 'memory' ? enviarADlqMemoria(...args) : enviarADlqSqs(...args);

// el cuerpo llega tal cual se publico porque la suscripcion tiene la entrega
// sin procesar activada
function leerEvento(body) {
  let evento;
  try {
    evento = JSON.parse(body);
  } catch {
    throw new ErrorNoRecuperable('el cuerpo no es JSON válido');
  }
  if (!evento || typeof evento !== 'object') throw new ErrorNoRecuperable('el cuerpo no es un objeto');
  if (!evento.type) throw new ErrorNoRecuperable('falta el tipo de evento');
  if (!evento.eventId) throw new ErrorNoRecuperable('falta eventId, no se puede evitar procesarlo dos veces');
  if (!evento.pedidoId) throw new ErrorNoRecuperable('falta pedidoId');
  return evento;
}

// cada mensaje termina en una de tres decisiones:
//   ack        salio bien: no se devuelve y sqs lo borra
//   reintento  error recuperable: se devuelve en batchItemFailures y vuelve a
//              aparecer cuando vence la visibilidad
//   dlq        error no recuperable: se manda a la dlq y se confirma, asi no
//              se gastan reintentos en algo que va a fallar igual
// ojo: necesita "informar de errores de elementos del lote" en el trigger,
// sin eso lambda ignora batchItemFailures y borra el lote completo
export function crearConsumidor(nombre, procesar, { enviarADlq = enviarADlqPorDefecto } = {}) {
  return async (event) => {
    const batchItemFailures = [];

    for (const record of event.Records ?? []) {
      const n = Number(record.attributes?.ApproximateReceiveCount ?? 1);
      const max = config.mensajeria.maxReceiveCount;
      const intento = `intento ${n} de ${max}`;

      try {
        const evento = leerEvento(record.body);
        if (config.mensajeria.simularCaida) {
          throw new Error('servicio externo no disponible (caída simulada)');
        }
        const resultado = await procesar(evento);
        console.log(`[${nombre}] ACK · ${record.messageId} · ${resultado}`);
      } catch (error) {
        if (error instanceof ErrorNoRecuperable) {
          try {
            await enviarADlq(record, error.message, nombre);
            console.error(`[${nombre}] DLQ · ${record.messageId} · no recuperable: ${error.message}`);
          } catch (errorDlq) {
            // si ni la dlq responde, mejor reintentar que perder el mensaje
            console.error(`[${nombre}] REINTENTO · ${record.messageId} · no se pudo enviar a la DLQ: ${errorDlq.message}`);
            batchItemFailures.push({ itemIdentifier: record.messageId });
          }
        } else {
          const despues = n >= max ? 'era el último, SQS lo moverá a la DLQ' : 'se reintenta';
          console.warn(`[${nombre}] REINTENTO · ${record.messageId} · ${intento} · recuperable: ${error.message} · ${despues}`);
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    }

    return { batchItemFailures };
  };
}

// ======================= productor =======================

// en las pruebas locales los eventos publicados quedan en esta lista
export const eventosEnMemoria = [];

let sns = null;
async function enviarASns(evento) {
  sns ??= import('@aws-sdk/client-sns').then((lib) => ({ cliente: new lib.SNSClient({}), lib }));
  const { cliente, lib } = await sns;
  await cliente.send(
    new lib.PublishCommand({
      TopicArn: config.mensajeria.topicArn,
      Message: JSON.stringify(evento),
      // los filtros de las suscripciones miran este atributo, no el cuerpo
      MessageAttributes: {
        [config.mensajeria.atributoFiltro]: { DataType: 'String', StringValue: evento.type },
      },
    }),
  );
}

// las pruebas lo reemplazan para simular que sns no responde
export const publicador = {
  enviar: async (evento) => {
    if (process.env.STORE === 'memory') eventosEnMemoria.push(evento);
    else await enviarASns(evento);
  },
};

// se llama despues de guardar el pedido. si sns falla, el pedido igual queda
// guardado y el error en el log: el nucleo del negocio no depende de las
// notificaciones, que es justo lo que se busca al desacoplar
export async function publicarEvento(tipo, pedido) {
  const evento = {
    type: tipo,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    pedidoId: pedido.id,
    clienteId: pedido.clienteId,
    estado: pedido.estado,
    total: pedido.total,
    items: pedido.items,
  };
  try {
    await publicador.enviar(evento);
    console.log(`evento ${tipo} publicado · ${evento.eventId} · ${pedido.id}`);
    return evento;
  } catch (error) {
    console.error(`no se pudo publicar ${tipo} de ${pedido.id}: ${error.message}`);
    return null;
  }
}
