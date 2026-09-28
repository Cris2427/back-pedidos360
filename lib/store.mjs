// dos versiones con los mismos metodos: dynamodb para aws y una en memoria
// para las pruebas, se elige con la variable STORE

export const CATALOG_TABLE = process.env.CATALOG_TABLE ?? 'Pedidos360-Catalog';
export const ORDERS_TABLE = process.env.ORDERS_TABLE ?? 'Pedidos360-Orders';

export const CATALOGO_INICIAL = [
  { id: 'p-001', nombre: 'Notebook 14"', precio: 499990, stock: 8 },
  { id: 'p-002', nombre: 'Mouse inalámbrico', precio: 14990, stock: 40 },
  { id: 'p-003', nombre: 'Teclado mecánico', precio: 59990, stock: 12 },
];

// lleva la numeracion de cada tabla, se filtra de los listados
export const CONTADOR = '_seq';

// nada de regex en template literal: ahi \d se convierte en d y no calza
const numeroDeId = (id, prefijo) => {
  const texto = String(id ?? '');
  const inicio = prefijo + '-';
  if (!texto.startsWith(inicio)) return 0;
  const resto = texto.slice(inicio.length);
  return /^[0-9]+$/.test(resto) ? Number(resto) : 0;
};

const formatearId = (prefijo, numero) => `${prefijo}-${String(numero).padStart(3, '0')}`;

const esCondicionFallida = (error) =>
  error?.name === 'ConditionalCheckFailedException' ||
  String(error?.__type ?? '').includes('ConditionalCheckFailedException');

// dynamodb
export function crearStoreDynamo() {
  // el sdk se importa aca y no arriba: viene en lambda pero no esta
  // instalado en el repo, y romperia las pruebas locales
  let sdk = null;
  const cargar = () => {
    sdk ??= (async () => {
      const [{ DynamoDBClient }, lib] = await Promise.all([
        import('@aws-sdk/client-dynamodb'),
        import('@aws-sdk/lib-dynamodb'),
      ]);
      const doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
      return { doc, lib };
    })();
    return sdk;
  };

  // los atributos van con #alias porque "total" e "items" son palabras
  // reservadas de dynamodb
  return {
    tipo: 'dynamodb',

    // ADD es atomico: suma y devuelve el valor nuevo de una, asi dos
    // lambdas a la vez nunca sacan el mismo numero
    async siguienteId(prefijo) {
      const { doc, lib } = await cargar();
      const tabla = prefijo === 'p' ? CATALOG_TABLE : ORDERS_TABLE;

      const { Attributes } = await doc.send(
        new lib.UpdateCommand({
          TableName: tabla,
          Key: { id: CONTADOR },
          UpdateExpression: 'ADD #n :uno',
          ExpressionAttributeNames: { '#n': 'numero' },
          ExpressionAttributeValues: { ':uno': 1 },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      let numero = Number(Attributes?.numero ?? 1);

      // la primera vez en una tabla con datos devolveria p-001 y chocaria,
      // asi que lo alineamos con el mayor que exista
      if (numero === 1) {
        const { Items = [] } = await doc.send(
          new lib.ScanCommand({
            TableName: tabla,
            ProjectionExpression: '#id',
            ExpressionAttributeNames: { '#id': 'id' },
          }),
        );
        const mayor = Items.reduce((max, it) => Math.max(max, numeroDeId(it.id, prefijo)), 0);
        if (mayor >= numero) {
          numero = mayor + 1;
          await doc.send(
            new lib.UpdateCommand({
              TableName: tabla,
              Key: { id: CONTADOR },
              UpdateExpression: 'SET #n = :v',
              ExpressionAttributeNames: { '#n': 'numero' },
              ExpressionAttributeValues: { ':v': numero },
            }),
          );
        }
      }

      return formatearId(prefijo, numero);
    },

    async listarProductos() {
      const { doc, lib } = await cargar();
      const { Items = [] } = await doc.send(new lib.ScanCommand({ TableName: CATALOG_TABLE }));
      return Items.filter((p) => p.id !== CONTADOR).sort((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      );
    },

    async obtenerProducto(id) {
      const { doc, lib } = await cargar();
      const { Item } = await doc.send(
        new lib.GetCommand({ TableName: CATALOG_TABLE, Key: { id } }),
      );
      return Item ?? null;
    },

    async guardarProducto(producto) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.PutCommand({ TableName: CATALOG_TABLE, Item: producto }));
      return producto;
    },

    async fijarStock(id, stock) {
      const { doc, lib } = await cargar();
      const { Attributes } = await doc.send(
        new lib.UpdateCommand({
          TableName: CATALOG_TABLE,
          Key: { id },
          UpdateExpression: 'SET #stock = :stock',
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#stock': 'stock', '#id': 'id' },
          ExpressionAttributeValues: { ':stock': stock },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes;
    },

    // la condicion y el descuento van en la misma operacion atomica, asi
    // dos pedidos a la vez no pueden dejar el stock negativo
    async descontarStock(id, cantidad) {
      const { doc, lib } = await cargar();
      try {
        await doc.send(
          new lib.UpdateCommand({
            TableName: CATALOG_TABLE,
            Key: { id },
            UpdateExpression: 'SET #stock = #stock - :q',
            ConditionExpression: 'attribute_exists(#id) AND #stock >= :q',
            ExpressionAttributeNames: { '#stock': 'stock', '#id': 'id' },
            ExpressionAttributeValues: { ':q': cantidad },
          }),
        );
        return true;
      } catch (error) {
        if (esCondicionFallida(error)) return false;
        throw error;
      }
    },

    async devolverStock(id, cantidad) {
      const { doc, lib } = await cargar();
      try {
        await doc.send(
          new lib.UpdateCommand({
            TableName: CATALOG_TABLE,
            Key: { id },
            UpdateExpression: 'SET #stock = #stock + :q',
            ConditionExpression: 'attribute_exists(#id)',
            ExpressionAttributeNames: { '#stock': 'stock', '#id': 'id' },
            ExpressionAttributeValues: { ':q': cantidad },
          }),
        );
        return true;
      } catch (error) {
        if (esCondicionFallida(error)) return false;
        throw error;
      }
    },

    async borrarProducto(id) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.DeleteCommand({ TableName: CATALOG_TABLE, Key: { id } }));
      return true;
    },

    async listarPedidos() {
      const { doc, lib } = await cargar();
      const { Items = [] } = await doc.send(new lib.ScanCommand({ TableName: ORDERS_TABLE }));
      return Items.filter((o) => o.id !== CONTADOR).sort((a, b) =>
        String(b.creadoEn ?? '').localeCompare(String(a.creadoEn ?? '')),
      );
    },

    async obtenerPedido(id) {
      const { doc, lib } = await cargar();
      const { Item } = await doc.send(new lib.GetCommand({ TableName: ORDERS_TABLE, Key: { id } }));
      return Item ?? null;
    },

    async guardarPedido(pedido) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.PutCommand({ TableName: ORDERS_TABLE, Item: pedido }));
      return pedido;
    },

    // bloqueo optimista: si otro operador se adelanto, este falla en vez de
    // descontar el stock dos veces
    async cambiarEstado(id, estadoEsperado, nuevoEstado, extra = {}) {
      const { doc, lib } = await cargar();
      try {
        const { Attributes } = await doc.send(
          new lib.UpdateCommand({
            TableName: ORDERS_TABLE,
            Key: { id },
            UpdateExpression:
              'SET #estado = :nuevo, #actualizadoEn = :ts, #actualizadoPor = :por, #descontado = :descontado',
            ConditionExpression: '#estado = :esperado',
            ExpressionAttributeNames: {
              '#estado': 'estado',
              '#actualizadoEn': 'actualizadoEn',
              '#actualizadoPor': 'actualizadoPor',
              '#descontado': 'stockDescontado',
            },
            ExpressionAttributeValues: {
              ':nuevo': nuevoEstado,
              ':esperado': estadoEsperado,
              ':ts': new Date().toISOString(),
              ':por': extra.actualizadoPor ?? 'desconocido',
              ':descontado': extra.stockDescontado === true,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes;
      } catch (error) {
        if (esCondicionFallida(error)) return null;
        throw error;
      }
    },

    async borrarPedido(id) {
      const { doc, lib } = await cargar();
      await doc.send(new lib.DeleteCommand({ TableName: ORDERS_TABLE, Key: { id } }));
      return true;
    },

    async sembrarSiEstaVacio() {
      const { doc, lib } = await cargar();
      const { Count } = await doc.send(
        new lib.ScanCommand({ TableName: CATALOG_TABLE, Select: 'COUNT', Limit: 1 }),
      );
      if (Count > 0) return 0;
      for (const producto of CATALOGO_INICIAL) {
        await doc.send(new lib.PutCommand({ TableName: CATALOG_TABLE, Item: producto }));
      }
      return CATALOGO_INICIAL.length;
    },
  };
}

// en memoria, solo para las pruebas
export function crearStoreMemoria() {
  const productos = CATALOGO_INICIAL.map((p) => ({ ...p }));
  const pedidos = [];
  const copia = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);

  const contadores = {
    p: productos.reduce((max, p) => Math.max(max, numeroDeId(p.id, 'p')), 0),
    o: 0,
  };

  return {
    tipo: 'memoria',

    async siguienteId(prefijo) {
      contadores[prefijo] = (contadores[prefijo] ?? 0) + 1;
      return formatearId(prefijo, contadores[prefijo]);
    },

    async listarProductos() {
      return copia(productos);
    },
    async obtenerProducto(id) {
      return copia(productos.find((p) => p.id === id) ?? null);
    },
    async guardarProducto(producto) {
      const i = productos.findIndex((p) => p.id === producto.id);
      if (i >= 0) productos[i] = { ...producto };
      else productos.push({ ...producto });
      return copia(producto);
    },
    async fijarStock(id, stock) {
      const p = productos.find((x) => x.id === id);
      if (!p) return null;
      p.stock = stock;
      return copia(p);
    },
    async descontarStock(id, cantidad) {
      const p = productos.find((x) => x.id === id);
      if (!p || p.stock < cantidad) return false;
      p.stock -= cantidad;
      return true;
    },
    async devolverStock(id, cantidad) {
      const p = productos.find((x) => x.id === id);
      if (!p) return false;
      p.stock += cantidad;
      return true;
    },

    async borrarProducto(id) {
      const i = productos.findIndex((p) => p.id === id);
      if (i >= 0) productos.splice(i, 1);
      return i >= 0;
    },

    async listarPedidos() {
      return copia(pedidos);
    },
    async obtenerPedido(id) {
      return copia(pedidos.find((o) => o.id === id) ?? null);
    },
    async guardarPedido(pedido) {
      pedidos.push({ ...pedido });
      return copia(pedido);
    },
    async cambiarEstado(id, estadoEsperado, nuevoEstado, extra = {}) {
      const pedido = pedidos.find((o) => o.id === id);
      if (!pedido || pedido.estado !== estadoEsperado) return null;
      pedido.estado = nuevoEstado;
      pedido.actualizadoEn = new Date().toISOString();
      pedido.actualizadoPor = extra.actualizadoPor ?? 'desconocido';
      pedido.stockDescontado = extra.stockDescontado === true;
      return copia(pedido);
    },
    async borrarPedido(id) {
      const i = pedidos.findIndex((o) => o.id === id);
      if (i >= 0) pedidos.splice(i, 1);
      return i >= 0;
    },
    async sembrarSiEstaVacio() {
      return 0;
    },
  };
}

// una instancia por proceso: en las pruebas los 10 handlers comparten el
// mismo store, en aws lo compartido es dynamodb
let instancia = null;

export function crearStore() {
  instancia ??= process.env.STORE === 'memory' ? crearStoreMemoria() : crearStoreDynamo();
  return instancia;
}
