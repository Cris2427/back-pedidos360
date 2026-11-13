// La lógica de audit: por cada evento de pedido, publica su registro de
// auditoría en audit.timeline. Es el patrón consumir-transformar-producir:
// el consumidor entrega el evento (consumir), registroDe arma el registro
// (transformar) y aquí se publica (producir).
import { OPCIONES_ENVIO } from '../shared/kafka.js';
import { TIMELINE } from '../shared/topics.js';
import { registroDe, serializarRegistro } from './registro.js';

// Audit registra todo evento que pasa el DTO, aunque su transición no sea
// válida (como el --salto): una auditoría anota lo que pasó, no decide si
// estuvo bien; eso lo decide report. Lo que no pasa el DTO va a la DLT de audit.
export async function publicarRegistro(evento, { producer, correlationId }) {
  const registro = registroDe(evento);
  await producer.send({
    topic: TIMELINE,
    messages: [{
      // la misma key que el evento: el historial de un pedido queda en una
      // sola partición, en orden
      key: registro.pedidoId,
      value: serializarRegistro(registro),
      // el correlationId sigue al registro, para rastrearlo de punta a punta
      headers: correlationId ? { correlationId } : {},
    }],
    ...OPCIONES_ENVIO,
  });
  return 'publicado';
}