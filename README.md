# back-pedidos360

Backend de los dominios **Pedidos** y **Catálogo** del sistema Pedidos360,
detrás de un AWS API Gateway (HTTP API) protegido con un **JWT Authorizer de
Microsoft Entra ID**.

**Una Lambda por método y ruta**: 10 funciones independientes, cada una con su
propio handler, sus propios logs y su propia configuración.

Frontend: [Cris2427/front-pedidos360](https://github.com/Cris2427/front-pedidos360)

> **DSY1107 · Desarrollo Cloud Native I** — Evaluación Parcial N°1.
> Cristian Tapia · Camila Malhue

## Estructura

```
handlers/            una función Lambda por archivo
  catalog-get.mjs          GET    /api/catalog
  catalog-post.mjs         POST   /api/catalog
  catalog-put.mjs          PUT    /api/catalog/{id}
  catalog-stock-put.mjs    PUT    /api/catalog/{id}/stock
  catalog-delete.mjs       DELETE /api/catalog/{id}
  orders-get.mjs           GET    /api/orders
  orders-post.mjs          POST   /api/orders
  orders-put.mjs           PUT    /api/orders/{id}
  orders-status-patch.mjs  PATCH  /api/orders/{id}/status
  orders-delete.mjs        DELETE /api/orders/{id}
lib/                 código compartido, sin duplicar
  auth.mjs             claims, scopes y App Roles del token
  http.mjs             respuestas, CORS y manejo de errores
  reglas.mjs           máquina de estados y validaciones del caso
  store.mjs            acceso a DynamoDB (y doble en memoria para pruebas)
infra/
  deploy-aws.ps1              despliega todo en AWS
  openapi-pedidos360.yaml     especificación de la API
test-local.mjs       52 pruebas de las 10 funciones, sin AWS
```

Las 10 funciones comparten un mismo zip y se diferencian por su `handler`
(`handlers/catalog-get.handler`, etc.). Así cada ruta es una Lambda distinta en
AWS, pero el código común vive en un solo lugar.

## Doble control de acceso

| Capa | Qué valida | Dónde |
|---|---|---|
| JWT Authorizer del API Gateway | firma, `iss`, `aud`, `exp` | configuración del HTTP API |
| Cada Lambda | claims `scp` (scopes) y `roles` (App Roles) | [`lib/auth.mjs`](lib/auth.mjs) |

Si el token no sirve, el authorizer responde **401** y la Lambda ni se ejecuta.
Si el token es válido pero le falta el permiso, la Lambda responde **403**
diciendo exactamente qué scope o rol falta.

> **Ojo con el claim `roles`**: el API Gateway entrega todos los claims como
> string, así que un claim de tipo array llega envuelto en corchetes
> (`"[Cliente]"`). Sin quitarlos, ninguna comprobación de rol coincide y todo
> responde 403 aunque el token sea correcto.

## Permisos por endpoint

| Método y ruta | Scope | App Role |
|---|---|---|
| `GET /api/catalog` | `catalog.read` | cualquiera |
| `POST /api/catalog` | `catalog.write` | `Admin` |
| `PUT /api/catalog/{id}` | `catalog.write` | `Admin` |
| `PUT /api/catalog/{id}/stock` | `catalog.write` | `Admin` |
| `DELETE /api/catalog/{id}` | `catalog.write` | `Admin` |
| `GET /api/orders` | `orders.read` | `Cliente` (los suyos) · `Operador` (todos) |
| `POST /api/orders` | `orders.write` | `Cliente` · `Operador` |
| `PUT /api/orders/{id}` | `orders.write` | `Cliente` (los suyos) · `Operador` |
| `DELETE /api/orders/{id}` | `orders.write` | `Cliente` (los suyos) · `Operador` |
| `PATCH /api/orders/{id}/status` | `orders.write` | `Operador` |

**El Admin no participa del CRUD de pedidos**: administra el catálogo y el
stock. El Cliente y el Operador tienen el CRUD; solo el Operador avanza los
estados.

## Reglas de negocio que aplica el servidor

- **No se puede despachar sin aceptar**: `CREADO → ACEPTADO → EN_PREPARACION →
  DESPACHADO → ENTREGADO`, con `CANCELADO` disponible solo desde `CREADO` y
  `ACEPTADO`. Cualquier otro salto responde **409**.
- **El stock decrece al ACEPTAR el pedido**, no al crearlo. Cancelar devuelve
  el stock solo si alcanzó a descontarse.
- Un pedido solo se **edita** en `CREADO` y solo se **elimina** en `CREADO` o
  `CANCELADO`: con stock comprometido hay que cancelarlo primero.
- El **total se recalcula** en el servidor: se ignora el que mande el cliente.
- A un `Cliente` se le fuerza el `clienteId` con la identidad de su token, y un
  pedido ajeno le responde **404** en vez de 403: así no se le revela que existe.

## Probar sin desplegar nada

```bash
node test-local.mjs
```

52 comprobaciones sobre las 10 funciones: permisos por scope y por rol,
validaciones, ciclo de estados, reglas de stock, aislamiento entre clientes,
numeración correlativa de ids y las formas en que puede llegar el claim
`roles`. Usa el store en memoria, así que **no necesita credenciales de AWS ni
red**.

## Desplegar

```bash
powershell -File infra\deploy-aws.ps1 -WhatIf   # muestra qué haría, sin tocar nada
powershell -File infra\deploy-aws.ps1
```

Crea o actualiza en un solo paso: las dos tablas de DynamoDB, las 10 funciones,
el JWT authorizer, las integraciones, las 10 rutas, el CORS y los permisos de
invocación. Es idempotente: se puede correr las veces que haga falta.

Revisa antes los parámetros del `param(...)`: región, id del API, tenant,
audiencia y el rol de ejecución (`LabRole` en AWS Academy).

> En AWS Academy las credenciales caducan cada pocas horas. Si ves
> `ExpiredToken`, recárgalas desde **AWS Details → AWS CLI** del Learner Lab.

## Variables de entorno de las Lambdas

| Variable | Default | Para qué |
|---|---|---|
| `ALLOWED_ORIGIN` | `http://localhost:5173` | origen que se devuelve en los headers CORS |
| `CATALOG_TABLE` | `Pedidos360-Catalog` | tabla de productos |
| `ORDERS_TABLE` | `Pedidos360-Orders` | tabla de pedidos |
| `STORE` | *(vacío)* | `memory` fuerza el store en memoria (solo pruebas) |

## Persistencia

Dos tablas de DynamoDB con clave de partición `id` (string) y facturación por
uso:

| Tabla | Contenido |
|---|---|
| `Pedidos360-Catalog` | `id`, `nombre`, `precio`, `stock` |
| `Pedidos360-Orders` | `id`, `clienteId`, `items`, `total`, `estado`, `creadoEn`, `stockDescontado` |

El acceso está aislado en [`lib/store.mjs`](lib/store.mjs), con dos
implementaciones de la misma interfaz: DynamoDB para las Lambdas desplegadas y
en memoria para las pruebas.

**Por qué no basta con guardar en memoria:** cada contenedor de Lambda tiene su
propia copia. Un pedido creado en uno responde `404` en otro, y todo se borra
cuando la función se enfría. Con varias Lambdas y varios navegadores, el error
aparece de inmediato.

Tres garantías que aporta la base de datos:

- El descuento de stock es **condicional** (`stock >= cantidad`) dentro de la
  misma operación atómica, así que dos pedidos simultáneos no pueden dejarlo
  negativo.
- El cambio de estado usa **bloqueo optimista**: solo se aplica si el pedido
  sigue en el estado que se leyó, así que dos operadores apretando "Aceptar" a
  la vez no descuentan el stock dos veces.
- Los **ids son correlativos** (`p-005`, `o-001`). DynamoDB no tiene
  auto-incremento, así que un documento `_seq` por tabla lleva la cuenta y se
  incrementa con `ADD`, que es atómico. Ese documento se filtra de los listados.
