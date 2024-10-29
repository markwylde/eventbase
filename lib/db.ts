import { Level } from 'level';
import { join } from 'path';
import { rm } from 'fs/promises';

export async function createDb(streamName: string) {
  const dbPath = join(process.cwd(), `data/${streamName}-db`);

  // Delete existing DB
  try {
    await rm(dbPath, { recursive: true, force: true });
  } catch (err) {
    // Ignore if doesn't exist
  }

  // Create fresh DB
  const db = new Level(dbPath, { valueEncoding: 'json' });
  await db.open();

  return db;
}
