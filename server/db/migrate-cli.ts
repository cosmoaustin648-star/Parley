// CLI entry: `npm run migrate` (the server also migrates on boot).
import { db } from './index.ts';
import { migrate } from './migrate.ts';

await migrate(db);
console.log('[migrate] up to date');
await db.end();
