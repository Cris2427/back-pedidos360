// Pruebas de los datos del simulador (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTOS, SUCURSALES, COMUNAS, CANALES, COSTO_DESPACHO, sucursalDe, itemDe, totalDe } from '../bridge/catalogo.js';
import { crearEventoPedido, validarEventoPedido } from '../shared/dto.js';

test('no hay dos productos con el mismo id', () => {
  const ids = PRODUCTOS.map(p => p.productoId);
  assert.equal(new Set(ids).size, ids.length);
});

test('ninguna comuna la atienden dos sucursales', () => {
  assert.equal(new Set(COMUNAS).size, COMUNAS.length);
});

test('el total suma los productos y el despacho', () => {
  const items = [itemDe('PRD-001', 2), itemDe('PRD-010', 1)];
  assert.equal(totalDe(items), 2 * 9990 + 2990 + COSTO_DESPACHO);
});

test('sucursalDe encuentra la sucursal de cada comuna', () => {
  assert.equal(sucursalDe('Providencia').sucursalId, 'SUC-01');
  assert.equal(sucursalDe('Ñuñoa').sucursalId, 'SUC-02');
  assert.throws(() => sucursalDe('Valparaíso'));
});

test('itemDe rechaza un producto que no está en la carta', () => {
  assert.throws(() => itemDe('PRD-999', 1));
});

// La prueba más importante: con cualquier producto, sucursal y canal se arma
// un evento que el DTO acepta. Si alguien agrega un producto con el id mal
// escrito, falla aquí y no cuando el publicador ya está enviando a Kafka.
test('toda combinación de la carta forma un evento válido', () => {
  for (const producto of PRODUCTOS) {
    for (const sucursal of SUCURSALES) {
      for (const canal of CANALES) {
        const items = [itemDe(producto.productoId, 1)];
        const evento = crearEventoPedido({
          tipo: 'PEDIDO_CREADO',
          pedidoId: 'PED-PRUEBA-000001',
          clienteId: 'CLI-0001',
          total: totalDe(items),
          actor: { usuarioId: 'CLI-0001', rol: 'CLIENTE' },
          items,
          canal,
          comuna: sucursal.comunas[0],
          sucursalId: sucursal.sucursalId,
        });
        assert.deepEqual(validarEventoPedido(evento), [], `${producto.productoId}, ${sucursal.sucursalId}, ${canal}`);
      }
    }
  }
});