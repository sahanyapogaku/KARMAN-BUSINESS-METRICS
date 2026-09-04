import sql from "mssql";

const pools = {};

function baseConfig(database) {
  return {
    server: process.env.TC_DB_SERVER,
    database,
    user: process.env.TC_DB_USER,
    password: process.env.TC_DB_PASSWORD,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true,
      requestTimeout: 20000,
      connectionTimeout: 8000,
    },
    pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  };
}

// Shared server (10.10.4.174) hosts both the Teamcenter ("tc") database
// and the ThreeWayMatch finance database — one pool per database, cached.
export async function getKarmanSqlPool(database) {
  if (pools[database]) return pools[database];
  const pool = await new sql.ConnectionPool(baseConfig(database)).connect();
  pool.on("error", (err) => console.error(`[${database}-db] pool error`, err.message));
  pools[database] = pool;
  return pool;
}
