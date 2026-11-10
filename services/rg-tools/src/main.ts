import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = config.databaseUrl ? createPool(config.databaseUrl) : undefined;
const app = buildServer({ config, db });

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`rg-tools listening on ${config.port} (mode=${config.mode})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
