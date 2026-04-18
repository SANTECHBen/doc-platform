import { buildApp } from './app';
import { loadEnv } from './env';
import { createContext } from './context';

const env = loadEnv();
const ctx = createContext(env);
const app = await buildApp(ctx);

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
