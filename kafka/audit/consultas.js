// La lógica de las consultas de audit: valida lo que pide la API y le pide
// los registros al repositorio. Como en la EP4, un filtro desconocido o mal
// escrito se rechaza con 400 en vez de ignorarse en silencio.
import { TIPOS } from '../shared/dto.js';
import { ParametroInvalidoError, NoEncontradoError } from '../shared/http.js';

const FILTROS = ['usuario', 'que', 'desde', 'hasta', 'limite'];

// El historial de un pedido, del primer paso al último
export async function historialDe(repo, pedidoId) {
  const registros = await repo.historial(pedidoId);
  if (!registros.length) throw new NoEncontradoError(`no hay registros del pedido ${pedidoId}`);
  return registros;
}

// Una fecha del filtro, normalizada al formato ISO en UTC
function fecha(nombre, valor) {
  if (valor === undefined) return undefined;
  const ms = Date.parse(valor);
  if (Number.isNaN(ms)) throw new ParametroInvalidoError(`${nombre} no es una fecha válida (ejemplo: 2026-11-13T15:00:00Z)`);
  return new Date(ms).toISOString();
}

// Los registros que cumplen los filtros, del más nuevo al más antiguo
export function buscarRegistros(repo, query) {
  const desconocidos = Object.keys(query).filter(k => !FILTROS.includes(k));
  if (desconocidos.length) {
    throw new ParametroInvalidoError(`filtro desconocido: ${desconocidos.join(', ')}. Se puede usar: ${FILTROS.join(', ')}`);
  }
  for (const [nombre, valor] of Object.entries(query)) {
    if (typeof valor !== 'string') throw new ParametroInvalidoError(`${nombre} va una sola vez`);
  }

  const { usuario, que, limite = '50' } = query;
  if (que !== undefined && !TIPOS.includes(que)) {
    throw new ParametroInvalidoError(`que debe ser uno de: ${TIPOS.join(', ')}`);
  }
  const desde = fecha('desde', query.desde);
  const hasta = fecha('hasta', query.hasta);
  if (desde && hasta && desde > hasta) throw new ParametroInvalidoError('desde debe ser anterior a hasta');
  const n = Number(limite);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new ParametroInvalidoError('limite debe ser un entero entre 1 y 200');
  }
  return repo.buscar({ usuario: usuario || undefined, que, desde, hasta, limite: n });
}