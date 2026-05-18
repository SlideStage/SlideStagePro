import { buildServer } from './server.js';
import { loadConfig } from './config.js';
import { disconnectPrisma } from './db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      port: config.port,
      storageRoot: config.storageRoot,
      databaseUrl: config.databaseUrl,
    },
    'slidestage-server ready',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
