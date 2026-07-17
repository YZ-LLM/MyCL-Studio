// Backend tier entry point (AC13: `npm run dev:backend` starts this alone, and
// `npm run dev` starts it concurrently with the Next.js frontend). A minimal,
// dependency-free node:http server that delegates to the backend app, whose
// error middleware records to the MyCL error catalog and logs structured lines.
import { createServer } from 'node:http';
import { initErrorsDb } from '../error_folder/init-errors-db.js';
import { createApp } from './app.js';
import { logger } from '../lib/logger.js';

const PORT = Number(process.env.BACKEND_PORT || 4000);

// The node:http request handler — extracted so it can be exercised with
// in-memory req/res objects in tests without binding a socket.
export function createRequestHandler(app = createApp()) {
  return (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const { status, body } = app.dispatch({ method: req.method, path });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

export function startServer(port = PORT) {
  initErrorsDb();
  const server = createServer(createRequestHandler());
  server.listen(port, () => logger.info('backend listening', { port }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
