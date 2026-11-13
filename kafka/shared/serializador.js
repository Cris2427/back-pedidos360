// Serializador del evento de pedido: convierte el DTO en el texto que viaja
// por Kafka (al publicar) y el texto de vuelta en DTO (al consumir).
// Es lo mismo que JsonSerializer y JsonDeserializer en Spring Kafka, con la
// validación del DTO en los dos sentidos.
import { validarEventoPedido } from './dto.js';

// Error de un mensaje que nunca se va a poder procesar: JSON roto o datos
// inválidos. Reintentar no sirve, porque el mensaje seguirá igual de malo.
// Por eso reintentable = false: el consumidor lo manda directo a la DLT.
export class EventoInvalidoError extends Error {
  constructor(motivo, errores = []) {
    super(errores.length ? `${motivo}: ${errores.join('; ')}` : motivo);
    this.name = 'EventoInvalidoError';
    this.motivo = motivo;     // corto, para el header de la DLT
    this.errores = errores;   // el detalle, campo por campo
    this.reintentable = false;
  }
}

// Al publicar: valida y convierte a texto JSON.
// Un evento inválido nunca entra al tópico: el error salta en el productor.
export function serializar(evento) {
  const errores = validarEventoPedido(evento);
  if (errores.length) throw new EventoInvalidoError('evento inválido, no se publica', errores);
  return JSON.stringify(evento);
}

// Al consumir: Kafka entrega el value como Buffer (bytes). Se pasa a texto,
// el texto a objeto, y se valida antes de entregárselo al negocio.
export function deserializar(value) {
  if (value == null) throw new EventoInvalidoError('mensaje sin contenido');
  let evento;
  try {
    evento = JSON.parse(value.toString('utf8'));
  } catch {
    throw new EventoInvalidoError('JSON inválido');
  }
  const errores = validarEventoPedido(evento);
  if (errores.length) throw new EventoInvalidoError('evento inválido', errores);
  return evento;
}