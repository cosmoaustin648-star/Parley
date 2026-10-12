// Production build: dist/client (static app) + dist/server.js (+ dist/migrations).
import { buildClient, buildServer } from './build-lib.mjs';

const t = Date.now();
const { jsName, cssName } = await buildClient({ dev: false });
await buildServer();
console.log(`[build] client ${jsName}, ${cssName}; server dist/server.js — ${Date.now() - t}ms`);
