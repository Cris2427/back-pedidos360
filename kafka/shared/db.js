// Conexión a PostgreSQL, compartida por report y audit.
// Las propiedades de conexión salen del .env con los nombres estándar de
// PostgreSQL (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD): la librería
// pg las lee sola, por eso no aparecen aquí.
// En producción sería Amazon RDS: solo cambian esos valores.
import fs from 'node:fs/promises';
import pg from 'pg';

const ESQUEMA = new URL('../db/esquema.sql', import.meta.url);

// Un pool: un grupo de conexiones abiertas que se reutilizan, en vez de
// abrir una nueva por cada consulta
export function crearPool(servicio) {
  if (!process.env.PGHOST || !process.env.PGPASSWORD) {
    throw new Error('faltan los datos de PostgreSQL (PGHOST, PGPASSWORD...): copia .env.example a .env');
  }
  const pool = new pg.Pool({
    application_name: servicio,     // en PostgreSQL se ve qué servicio tiene cada conexión
    max: 10,                        // conexiones abiertas como máximo
    idleTimeoutMillis: 30000,       // cierra las que pasan 30 s sin usarse
    connectionTimeoutMillis: 5000,  // si la base no responde en 5 s, error (el consumidor reintenta)
  });
  // Si la base se reinicia, las conexiones que estaban en reposo se cortan.
  // Sin esto, ese error botaría el proceso completo.
  pool.on('error', error => console.error(`[${servicio}] PostgreSQL cortó una conexión: ${error.message}`));
  return pool;
}

// Crea los esquemas y las tablas que falten (db/esquema.sql)
export async function prepararEsquema(pool) {
  await pool.query(await fs.readFile(ESQUEMA, 'utf8'));
}

// Ejecuta fn dentro de una transacción: o se guarda todo o no se guarda nada.
// fn recibe la conexión de la transacción y hace sus consultas con ella.
export async function enTransaccion(pool, fn) {
  const conexion = await pool.connect();
  try {
    await conexion.query('BEGIN');
    const resultado = await fn(conexion);
    await conexion.query('COMMIT');
    return resultado;
  } catch (error) {
    // si la conexión se cortó, el ROLLBACK también falla: se ignora para que
    // suba el error original, que es el que explica qué pasó
    await conexion.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    conexion.release();
  }
}
