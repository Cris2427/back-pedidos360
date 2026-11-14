// Las DLT, para el admin: ver lo que report o audit no pudo procesar y
// reprocesarlo.
// Reprocesar devuelve cada mensaje a su tópico de origen con la misma key, el
// mismo value y los mismos headers (sin los dlt-*). Sirve para lo pasajero,
// como la base de datos caída: el servicio lo vuelve a leer y, como es
// idempotente, un evento que ya estaba aplicado no se aplica dos veces.
// pedidos.eventos lo leen report y audit: el servicio que ya lo tenía lo
// descarta por su eventId. Lo que no tiene arreglo (JSON malo, transición
// inválida) vuelve a la DLT.
import { OPCIONES_ENVIO, configConsumidor } from '../shared/kafka.js';
import { PEDIDOS, TIMELINE, dltDe } from '../shared/topics.js';
import { NoEncontradoError } from '../shared/http.js';
import * as validar from './validacion.js';

const SERVICIOS = ['report', 'audit'];
// a dónde se puede devolver un mensaje: solo a los tópicos que leen los
// servicios, nunca a uno que diga un header
const ORIGENES = [PEDIDOS, TIMELINE];
const PLAZO_LECTURA_MS = 15000;

const texto = v => (v == null ? undefined : v.toString());
const suma = (lista, fn) => lista.reduce((s, x) => s + fn(x), 0);

// kafka, admin y producer vienen conectados desde server.js. exigirTopico
// viene de servicio.js.
export function crearDlt({ kafka, admin, producer, log, exigirTopico }) {
  async function exigirDlt(servicio) {
    if (!SERVICIOS.includes(servicio)) {
      throw new NoEncontradoError(`no hay DLT para ${servicio}. Hay para: ${SERVICIOS.join(', ')}`);
    }
    const topico = dltDe(servicio);
    await exigirTopico(topico);
    // este grupo nunca lee: sus offsets solo marcan hasta dónde se reprocesó
    return { topico, grupo: `${servicio}-dlt-reproceso` };
  }

  // Por partición de la DLT: dónde empieza, dónde termina y hasta dónde ya
  // se reprocesó
  async function posiciones(topico, grupo) {
    const [offsets, confirmados] = await Promise.all([
      admin.fetchTopicOffsets(topico),
      admin.fetchOffsets({ groupId: grupo, topics: [topico] }),
    ]);
    const partitions = confirmados.find(c => c.topic === topico)?.partitions ?? [];
    return offsets.map(o => {
      const confirmado = Number(partitions.find(p => p.partition === o.partition)?.offset ?? -1);
      return {
        particion: o.partition,
        inicio: Number(o.low),
        fin: Number(o.high),
        reprocesadoHasta: Math.max(confirmado, Number(o.low)),
      };
    });
  }

  // Lee los mensajes de un tópico entre dos offsets sin dejar rastro: un
  // consumidor de un solo uso, que no confirma offsets y cuyo grupo se borra
  // al terminar. Así mirar la DLT no cambia nada.
  async function leer(topico, tramos) {
    const pendientes = new Map(tramos.filter(t => t.desde < t.hasta).map(t => [t.particion, t]));
    if (!pendientes.size) return [];
    const groupId = `admin-lector-${process.pid}-${Date.now()}`;
    const consumer = kafka.consumer(configConsumidor(groupId));
    const mensajes = [];
    let terminar, fallar;
    const listo = new Promise((ok, mal) => { terminar = ok; fallar = mal; });
    listo.catch(() => {}); // el error se atiende más abajo, en el await
    const plazo = setTimeout(() => fallar(new Error(`no se alcanzó a leer ${topico} en ${PLAZO_LECTURA_MS / 1000} s`)), PLAZO_LECTURA_MS);
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: topico });
      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          const t = pendientes.get(partition);
          const offset = Number(message.offset);
          if (!t || offset < t.desde || offset >= t.hasta) return;
          mensajes.push({ particion: partition, message });
          if (offset >= t.hasta - 1) {
            pendientes.delete(partition);
            if (!pendientes.size) terminar();
          }
        },
      });
      // seek: cada partición parte desde su "desde", no desde donde diga el grupo
      for (const t of pendientes.values()) {
        consumer.seek({ topic: topico, partition: t.particion, offset: String(t.desde) });
      }
      await listo;
    } finally {
      clearTimeout(plazo);
      await consumer.disconnect();
      await admin.deleteGroups([groupId]).catch(() => {});
    }
    return mensajes;
  }

  // Un mensaje de la DLT, legible: los headers dlt-* dicen qué pasó y de dónde venía
  function legible({ particion, message }, reprocesadoHasta) {
    const h = Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, texto(v)]));
    let evento;
    try {
      evento = JSON.parse(texto(message.value));
    } catch {
      evento = texto(message.value); // lo que llegó, tal cual, aunque no sea JSON
    }
    return {
      particion,
      offset: Number(message.offset),
      key: texto(message.key),
      fecha: h['dlt-fecha'],
      motivo: h['dlt-motivo'],
      error: h['dlt-error'],
      origen: { topico: h['dlt-topico'], particion: Number(h['dlt-particion']), offset: Number(h['dlt-offset']), grupo: h['dlt-grupo'] },
      intentos: Number(h['dlt-intentos']),
      correlationId: h.correlationId,
      reprocesado: Number(message.offset) < reprocesadoHasta[particion],
      evento,
    };
  }

  // Los últimos mensajes de la DLT de un servicio, del más nuevo al más antiguo
  async function verDlt(servicio, query) {
    const limite = validar.validarLimiteDlt(query);
    const { topico, grupo } = await exigirDlt(servicio);
    const pos = await posiciones(topico, grupo);
    const leidos = await leer(topico, pos.map(p => ({
      particion: p.particion,
      desde: Math.max(p.inicio, p.fin - limite),
      hasta: p.fin,
    })));
    const hasta = Object.fromEntries(pos.map(p => [p.particion, p.reprocesadoHasta]));
    return {
      topico,
      total: suma(pos, p => p.fin - p.inicio),
      pendientes: suma(pos, p => p.fin - p.reprocesadoHasta),
      mensajes: leidos
        .map(m => legible(m, hasta))
        .sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || b.offset - a.offset)
        .slice(0, limite),
    };
  }

  // Devuelve a su tópico de origen lo que aún no se reprocesó
  async function reprocesarDlt(servicio, cuerpo) {
    validar.sinParametros(cuerpo, 'campo');
    const { topico, grupo } = await exigirDlt(servicio);
    const pos = await posiciones(topico, grupo);
    const leidos = await leer(topico, pos.map(p => ({ particion: p.particion, desde: p.reprocesadoHasta, hasta: p.fin })));

    const porTopico = {};
    let sinOrigen = 0;
    for (const { particion, message } of leidos) {
      const h = message.headers ?? {};
      const destino = texto(h['dlt-topico']);
      if (!ORIGENES.includes(destino)) {
        sinOrigen++;
        continue;
      }
      const headers = Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith('dlt-')));
      headers['reprocesado-desde'] = `${topico}/${particion}/${message.offset}`;
      (porTopico[destino] ??= []).push({ key: message.key, value: message.value, headers });
    }
    for (const [destino, messages] of Object.entries(porTopico)) {
      await producer.send({ topic: destino, messages, ...OPCIONES_ENVIO });
    }
    // marca hasta dónde se reprocesó: la próxima vez parte desde ahí
    if (leidos.length) {
      await admin.setOffsets({
        groupId: grupo,
        topic: topico,
        partitions: pos.map(p => ({ partition: p.particion, offset: String(p.fin) })),
      });
    }
    log(`DLT reprocesada: ${topico}`, { mensajes: leidos.length, sinOrigen });
    return {
      topico,
      reprocesados: leidos.length - sinOrigen,
      porTopico: Object.fromEntries(Object.entries(porTopico).map(([t, m]) => [t, m.length])),
      sinOrigen,
    };
  }

  return { verDlt, reprocesarDlt };
}