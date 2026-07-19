import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';

const TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const url = ownerUrlOrThrow();
  const deadline = Date.now() + TIMEOUT_MS;
  process.stdout.write('Waiting for Postgres');

  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      process.stdout.write(' ready\n');
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) {
        process.stdout.write(' timed out\n');
        throw new Error(
          `Postgres did not become ready within ${TIMEOUT_MS / 1000}s. Is Docker running? Try: docker compose logs db`
        );
      }
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
