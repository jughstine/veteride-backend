const mysql = require("mysql2/promise");
const env = require("./env");

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: "+08:00",
  dateStrings: true,
});

pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+08:00'");
});

module.exports = pool;
