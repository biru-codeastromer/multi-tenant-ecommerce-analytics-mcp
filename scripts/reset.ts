/**
 * Drops and rebuilds the schema from scratch.
 *
 * For local development only: it exists because migrations are forward-only
 * and checksum-verified, so an unreleased migration that needs correcting is
 * fixed in place and replayed rather than patched with a follow-up file.
 * Once a migration has shipped, add a new one instead.
 */
import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run db:reset with NODE_ENV=production.');
  }

  const url = ownerUrlOrThrow();
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      'Refusing to run db:reset against a non-local database. This drops every table.'
    );
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    console.log('Dropping schema public…');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    // Roles are cluster-level and survive a schema drop; migration 0007 is
    // idempotent over them, so nothing else is needed here.
    console.log('✓ Schema reset. Run: npm run db:migrate && npm run db:seed && npm run refresh');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Reset failed:\n', err instanceof Error ? err.message : err);
  process.exit(1);
});
