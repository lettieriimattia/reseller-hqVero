// src/utils/logger.ts
// Logger centralizzato. In produzione i log vanno in file rotanti + console.

import winston from 'winston';
import path from 'path';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'reseller-hq' },
  transports: [
    // Console (sempre)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

// In produzione aggiungiamo file rotanti
if (isProduction) {
  logger.add(new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'error.log'),
    level: 'error',
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  }));
  logger.add(new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'combined.log'),
    maxsize: 10 * 1024 * 1024,
    maxFiles: 10,
  }));
}

// Helper per audit logging (lo userà audit.service.ts via Prisma)
export function logAudit(action: string, userId: string | null, meta: any) {
  logger.info(`AUDIT: ${action}`, { userId, ...meta });
}
