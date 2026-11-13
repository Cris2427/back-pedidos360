// npm run db: deja lista la base de report y audit.
//   1. se conecta con los datos del .env
//   2. crea los esquemas y las tablas que falten (db/esquema.sql)
//   3. muestra cada tabla con cuántas filas tiene
// Se puede correr las veces que sea: si todo está, no cambia nada.
import { crearPool, prepararEsquema } from '../shared/db.js';

const pool = crearPool('db-setup');

async function main() {
  const { rows: [info] } = await pool.query(
    "SELECT current_setting('server_version') AS version, current_database() AS base",
  );
  console.log(`PostgreSQL ${info.version}, base ${info.base} en ${process.env.PGHOST}:${process.env.PGPORT}`);

  await prepararEsquema(pool);
  console.log('Esquemas y tablas listos:');

  const { rows: tablas } = await pool.query(`
    SELECT table_schema AS esquema, table_name AS tabla
    FROM information_schema.tables
    WHERE table_schema IN ('report', 'audit')
    ORDER BY table_schema DESC, table_name`);
  for (const t of tablas) {
    // los nombres vienen del catálogo de PostgreSQL, no de un usuario
    const { rows: [{ filas }] } = await pool.query(`SELECT count(*)::int AS filas FROM "${t.esquema}"."${t.tabla}"`);
    t.filas = filas;
  }
  console.table(tablas);
}

main()
  .catch(e => {
    console.error(`npm run db falló: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());