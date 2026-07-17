// Zero-dependency structured logger (observability). Emits one machine-readable
// JSON line per event with level, msg, ts and any extra fields. The sink is
// injectable so it can be asserted in tests without capturing global stdout, and
// so the backend tier can route logs wherever it needs (defaults to stdout,
// 12-factor — no hardcoded log-file path).
export function createLogger(sink = (line) => process.stdout.write(line + '\n')) {
  function emit(level, msg, fields = {}) {
    const record = { ts: Date.now(), level, msg, ...fields };
    sink(JSON.stringify(record), record);
    return record;
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const logger = createLogger();
