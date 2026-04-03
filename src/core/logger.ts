import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { LoggingConfig } from './config.js';

export interface Logger {
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
  debug(channel: string, msg: string, context?: Record<string, unknown>): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(config: LoggingConfig): Logger {
  const stderrLevel = LEVELS[config.level as LogLevel] ?? LEVELS.info;
  const enabledChannels = new Set(config.channels ? config.channels.split(',').map(c => c.trim()) : []);

  mkdirSync(config.dir, { recursive: true });
  const serverLog = createWriteStream(join(config.dir, 'server.log'), { flags: 'a' });
  const protocolLog = createWriteStream(join(config.dir, 'protocol.log'), { flags: 'a' });

  function writeStderr(level: LogLevel, msg: string): void {
    if (LEVELS[level] >= stderrLevel) {
      process.stderr.write(`[${level.toUpperCase()}] ${msg}\n`);
    }
  }

  function writeLog(stream: WriteStream, level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, msg, ...context });
    stream.write(entry + '\n');
  }

  return {
    info(msg, context) { writeStderr('info', msg); writeLog(serverLog, 'info', msg, context); },
    warn(msg, context) { writeStderr('warn', msg); writeLog(serverLog, 'warn', msg, context); },
    error(msg, context) { writeStderr('error', msg); writeLog(serverLog, 'error', msg, context); },
    debug(channel, msg, context) {
      if (enabledChannels.has(channel) || enabledChannels.has('all')) {
        const target = channel === 'protocol' ? protocolLog : serverLog;
        writeLog(target, 'debug', `[${channel}] ${msg}`, context);
      }
    },
  };
}

export function createNullLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}
