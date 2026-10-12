import { config } from './config.ts';
import { db } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createServer } from './app.ts';
import { closeGateway } from './realtime/gateway.ts';
import { cleanupOrphanAttachments } from './routes/messages.ts';

async function main() {
  await migrate(db);
  const server = createServer();
  await new Promise<void>((res) => server.listen(config.port, config.host, res));
  console.log(`[parley] listening on ${config.appUrl} (${config.env})`);
  if (!config.smtp.host) console.log('[parley] SMTP not configured — emails go to the dev outbox (GET /api/dev/outbox).');

  const cleanup = setInterval(() => { cleanupOrphanAttachments().catch((e) => console.error('[cleanup]', e)); }, 3600_000);
  cleanup.unref();
  // Sessions past expiry and used/expired email tokens.
  const prune = setInterval(() => {
    db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
    db.query(`DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'`).catch(() => {});
  }, 6 * 3600_000);
  prune.unref();

  const shutdown = async (sig: string) => {
    console.log(`[parley] ${sig} received, shutting down`);
    closeGateway();
    server.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[parley] failed to start', e);
  process.exit(1);
});
