import { Level } from 'level';
import { join } from 'path';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';

export async function createDb(streamName: string) {
  const dbPath = join(tmpdir(), `level-${streamName}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`);

  // Delete existing DB (just in case)
  try {
    await rm(dbPath, { recursive: true, force: true });
  } catch (err) {
    // Ignore if doesn't exist
  }

  // Create fresh DB
  const db = new Level<string, object>(dbPath, { valueEncoding: 'json' });
  await db.open();

  return db;
}
