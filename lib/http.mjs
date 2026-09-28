const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';

export const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

export const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

// el cors real se configura en el api gateway, esto es por si acaso
export function preflight(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  return method === 'OPTIONS' ? { statusCode: 204, headers, body: '' } : null;
}

export function leerBody(event) {
  if (!event.body) return {};
  const texto = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString()
    : event.body;
  try {
    return JSON.parse(texto);
  } catch {
    return null; // json malo, el handler responde 400
  }
}

export const idDeRuta = (event) => event.pathParameters?.id;

// para que un error no devuelva el stack trace, queda en cloudwatch
export function conManejoDeErrores(fn) {
  return async (event) => {
    const pre = preflight(event);
    if (pre) return pre;
    try {
      return await fn(event);
    } catch (error) {
      console.error('Error en Lambda:', error);
      const detalle = error?.name ? ` (${error.name})` : '';
      return json(500, { error: `Error interno del servidor${detalle}` });
    }
  };
}
