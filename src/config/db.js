import sql from "mssql";

const poolConfig = {
  server: process.env.MFGO_DB_SERVER,
  database: process.env.MFGO_DB_DATABASE,
  user: process.env.MFGO_DB_USER,
  password: process.env.MFGO_DB_PASSWORD,
  port: Number(process.env.MFGO_DB_PORT || 1433),
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
    requestTimeout: 15000,
    connectionTimeout: 8000,
  },
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
};

let _pool = null;

export async function getPool() {
  if (_pool) return _pool;
  _pool = await new sql.ConnectionPool(poolConfig).connect();
  _pool.on("error", (err) => console.error("[db] pool error", err.message));
  return _pool;
}

export { sql };
