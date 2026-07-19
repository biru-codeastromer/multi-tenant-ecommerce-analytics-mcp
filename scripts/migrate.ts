/**
 * Migration runner.
 *
 * Deliberately minimal — no migration framework. Migrations here are ordered,
 * idempotent, forward-only SQL files applied inside a transaction each, with a
 * ledger table recording which have run and a checksum so an edited-after-apply
 * file is caught rather than silently ignored.
 *
 * Runs as the OWNER role. This is the only script besides seed/discover that
 * uses the owner connection; the server never does.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Substitutes ${VAR} placeholders from the environment.
 *
 * Only used for role passwords in 0007. Values are validated to a conservative
 * character set first, because they land inside a single-quoted SQL literal in
 * ALTER ROLE ... PASSWORD, which cannot take a bind parameter.
 */
function substituteEnv(sql: string, file: string): string {
  return sql.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${file} references \${${name}} but it is not set in the environment.`);
    }
    if (!/^[A-Za-z0-9_\-!@#%^*=+.:,~]{12,128}$/.test(value)) {
      throw new Error(
        `${name} must be 12-128 chars and contain no quotes, backslashes or whitespace ` +
          `(it is interpolated into a SQL literal). Regenerate with: openssl rand -base64 32 | tr -d '/+='`
      );
    }
    return value;
  });
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows: applied } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations'
    );
    const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

    let ran = 0;
    for (const file of files) {
      const raw = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Checksum the file as written, before substitution, so rotating a
      // password does not look like an edited migration.
      const checksum = createHash('sha256').update(raw).digest('hex');
      const previous = appliedMap.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied.\n` +
              `Migrations are forward-only — add a new file instead of editing this one.\n` +
              `(To rebuild from scratch locally: npm run db:reset)`
          );
        }
        continue;
      }

      const sql = substituteEnv(raw, file);
      process.stdout.write(`  applying ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        process.stdout.write('ok\n');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        process.stdout.write('FAILED\n');
        throw err;
      }
    }

    console.log(
      ran === 0
        ? '✓ Database already up to date.'
        : `✓ Applied ${ran} migration${ran === 1 ? '' : 's'}.`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Migration failed:\n', err instanceof Error ? err.message : err);
  process.exit(1);
});
