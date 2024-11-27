import { Level } from 'level';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';

export async function createDb(streamName: string, dbPath?: string) {
  const path = dbPath
    ? join(dbPath, `level-${streamName}`)
    : join(tmpdir(), `level-${streamName}`);

  // Ensure the directory exists
  await mkdir(dbPath || tmpdir(), { recursive: true });

  // Open existing DB or create a new one
  const db = new Level<string, object>(path, { valueEncoding: 'json' });
  await db.open();

  return db;
}
