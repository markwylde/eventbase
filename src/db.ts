import createDoubledb from 'doubledb';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';

export async function createDb(streamName: string, dbPath?: string) {
  const path = dbPath
    ? join(dbPath, `doubledb-${streamName}`)
    : join(tmpdir(), `doubledb-${streamName}`);

  // Ensure the directory exists
  await mkdir(dbPath || tmpdir(), { recursive: true });

  // Open existing DB or create a new one
  const db = await createDoubledb(path);

  return db;
}
