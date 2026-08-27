const winston = require('winston');
const env = require('../config/env');

const logger = winston.createLogger({
  level: env.nodeEnv === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () =>
        new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }), // "2026-08-24 20:16:09"
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;
