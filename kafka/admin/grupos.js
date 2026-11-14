// Los grupos de consumidores, para el admin: listarlos con su lag, ver qué
// particiones tiene cada instancia, mover sus offsets (para volver a leer o
// para saltar lo pendiente) y borrarlos.
// Kafka solo deja mover los offsets de un grupo, o borrarlo, cuando no tiene
// instancias conectadas: si las tiene, se responde 409.
import { AssignerProtocol } from '../shared/kafka.js';
import { NoEncontradoError, ConflictoError } from '../shared/http.js';
import * as validar from './validacion.js';

const suma = (lista, fn) => lista.reduce((s, x) => s + fn(x), 0);
export const instancias = n => `${n} ${n === 1 ? 'instancia' : 'instancias'}`;

// Qué particiones tiene asignadas cada instancia conectada a un grupo. Kafka
// lo guarda en bytes, en el formato del protocolo de consumidores.
function asignacion(miembro) {
  const { assignment = {} } = AssignerProtocol.MemberAssignment.decode(miembro.memberAssignment) ?? {};
  return Object.fromEntries(Object.entries(assignment).map(([t, ps]) => [t, [...ps].sort((a, b) => a - b)]));
}

// admin: el cliente admin de KafkaJS. exigirTopico viene de servicio.js.
export function crearGrupos({ admin, log, exigirTopico }) {
  async function describir(ids) {
    if (!ids) ids = (await admin.listGroups()).groups.map(g => g.groupId);
    if (!ids.length) return [];
    return (await admin.describeGroups(ids)).groups;
  }

  async function exigirGrupo(grupo) {
    const [g] = await describir([grupo]);
    // Kafka responde Dead cuando el grupo no existe
    if (!g || g.state === 'Dead') throw new NoEncontradoError(`no existe el grupo ${grupo}`);
    return g;
  }

  function exigirSinInstancias(g) {
    if (g.members.length) {
      throw new ConflictoError(`el grupo ${g.groupId} está leyendo con ${instancias(g.members.length)}: detenlas antes (Kafka solo cambia un grupo sin instancias)`);
    }
  }

  // Por cada partición que lee el grupo: hasta dónde confirmó (confirmado),
  // dónde termina el tópico (fin) y cuántos mensajes le faltan (lag)
  async function offsetsDe(groupId, existentes) {
    const filas = [];
    for (const { topic, partitions } of await admin.fetchOffsets({ groupId })) {
      // si el tópico se borró, sus offsets quedan huérfanos: no se muestran
      if (!existentes.includes(topic)) continue;
      const offsets = await admin.fetchTopicOffsets(topic);
      for (const { partition, offset } of partitions) {
        const o = offsets.find(x => x.partition === partition);
        if (!o) continue;
        const confirmado = Number(offset);
        // sin offset confirmado (-1), o si la retención ya borró hasta ahí,
        // el grupo parte desde el primer mensaje que queda (inicio)
        const lag = Number(o.high) - Math.max(confirmado, Number(o.low));
        filas.push({ topico: topic, particion: partition, confirmado, fin: Number(o.high), lag });
      }
    }
    return filas.sort((a, b) => a.topico.localeCompare(b.topico) || a.particion - b.particion);
  }

  async function estado(g, existentes) {
    const offsets = await offsetsDe(g.groupId, existentes);
    return {
      grupo: g.groupId,
      // Stable: leyendo. Empty: sin instancias. PreparingRebalance y
      // CompletingRebalance: reorganizándose (entró o salió una instancia)
      estado: g.state,
      instancias: g.members.map(m => ({ id: m.clientId, host: m.clientHost, particiones: asignacion(m) })),
      lag: suma(offsets, o => o.lag),
      offsets,
    };
  }

  async function todos() {
    const existentes = await admin.listTopics();
    const grupos = await Promise.all((await describir()).map(g => estado(g, existentes)));
    return grupos.sort((a, b) => a.grupo.localeCompare(b.grupo));
  }

  // Los grupos que leen un tópico: los que tienen offsets en él o alguna
  // instancia conectada con particiones de él (lo usa servicio.js)
  async function lectoresDe(topico) {
    return (await todos())
      .filter(g => g.offsets.some(o => o.topico === topico) || g.instancias.some(i => i.particiones[topico]))
      .map(g => ({
        grupo: g.grupo,
        estado: g.estado,
        instancias: g.instancias.length,
        lag: suma(g.offsets.filter(o => o.topico === topico), o => o.lag),
      }));
  }

  async function listarGrupos(query) {
    validar.sinParametros(query);
    return (await todos()).map(g => ({
      grupo: g.grupo,
      estado: g.estado,
      instancias: g.instancias.length,
      lag: g.lag,
      topicos: [...new Set(g.offsets.map(o => o.topico))],
    }));
  }

  async function detalleGrupo(grupo) {
    return estado(await exigirGrupo(grupo), await admin.listTopics());
  }

  // Mueve los offsets del grupo en un tópico. Al volver a conectarse, el
  // grupo sigue leyendo desde ahí: 'inicio' vuelve a leer todo (replay),
  // 'fin' salta lo pendiente y una fecha vuelve a leer desde esa hora.
  async function reiniciarOffsets(grupo, cuerpo) {
    const { topico, posicion, ms } = validar.validarReinicio(cuerpo);
    exigirSinInstancias(await exigirGrupo(grupo));
    await exigirTopico(topico);
    // Se guardan offsets reales y no los especiales de KafkaJS (-2 inicio,
    // -1 fin): así el lag se calcula bien y cualquier cliente los entiende
    const partitions = posicion === 'inicio' || posicion === 'fin'
      ? (await admin.fetchTopicOffsets(topico)).map(o => ({ partition: o.partition, offset: posicion === 'inicio' ? o.low : o.high }))
      // el primer offset de cada partición con fecha igual o posterior
      : await admin.fetchTopicOffsetsByTimestamp(topico, ms);
    await admin.setOffsets({ groupId: grupo, topic: topico, partitions });
    log(`offsets movidos: ${grupo} en ${topico} -> ${posicion}`);
    return detalleGrupo(grupo);
  }

  async function borrarGrupo(grupo) {
    exigirSinInstancias(await exigirGrupo(grupo));
    // borra sus offsets: si vuelve a conectarse, parte como grupo nuevo
    await admin.deleteGroups([grupo]);
    log(`grupo borrado: ${grupo}`);
    return { borrado: grupo };
  }

  return { lectoresDe, listarGrupos, detalleGrupo, reiniciarOffsets, borrarGrupo };
}