/**
 * Cron entrypoint for the projection job.
 *
 * The logic lives in src/projection/project.ts so the test suite can import it
 * without executing this runner, mirroring scripts/discover.ts. This file only
 * connects as owner, loops the orgs, and prints a line per org.
 */
import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';
import { runProjectionForOrg, type ProjectionOrg } from '../src/projection/project.js';

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();

  try {
    const { rows: orgs } = await client.query<ProjectionOrg>(
      'SELECT id, slug, default_currency FROM organizations ORDER BY slug'
    );
    if (orgs.length === 0) {
      console.log('No organizations found. Run `npm run db:seed` first.');
      return;
    }

    console.log('Projecting derived entities...\n');

    for (const org of orgs) {
      const { counts, mode } = await runProjectionForOrg(client, org);
      console.log(
        `  ${org.slug.padEnd(24)} ${mode.padEnd(22)} ` +
          `orders=${String(counts.orders).padStart(5)} ` +
          `items=${String(counts.order_items).padStart(5)} ` +
          `products=${String(counts.products).padStart(4)} ` +
          `users=${String(counts.user_profiles).padStart(5)} ` +
          `links=${String(counts.identity_links).padStart(5)}`
      );
    }

    console.log('\n✓ Projection complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Projection failed:\n', err);
  process.exit(1);
});
