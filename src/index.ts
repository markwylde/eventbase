import type { Event, EventbaseConfig } from './types.js';
import type { Level } from 'level';
import { createDb } from './db.js';
import { setupNats } from './nats.js';
import { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';

const base64encode = (str: string) => Buffer.from(str).toString('base64');

type Stream = {
  waitUntilReady: () => Promise<void>;
  stop: () => Promise<void>;
};

export interface MetaData {
  dateCreated: string;
  dateModified: string;
  changes: number;
}

type SubscriptionCallback<T extends object> = (
  key: string,
  data: T | null,
  meta: MetaData | null,
  event: Event
) => void;

const sequenceWaiters = new Map<number, (() => void)[]>();

function waitForStream(seq: number): Promise<void> {
  return new Promise((resolve) => {
    if (!sequenceWaiters.has(seq)) {
      sequenceWaiters.set(seq, []);
    }
    sequenceWaiters.get(seq)!.push(resolve);
  });
}

export async function createEventbase(config: EventbaseConfig) {
  const db: Level<string, any> = await createDb('db', config.dbPath);
  const metaDb: Level<string, any> = await createDb('meta', config.dbPath);
  const settingsDb: Level<string, any> = await createDb('settings', config.dbPath);

  const { nc, js, jsm } = await setupNats(config.streamName, config.nats);
  const subscriptions = new Map<string, SubscriptionCallback<any>[]>();

  const stream = await replayEvents(config, config.streamName, js, db, metaDb, settingsDb, subscriptions);
  await stream.waitUntilReady();

  return {
    get: async <T extends object>(id: string): Promise<{ meta: MetaData; data: T } | null> => {
      return get<T>(id, db, metaDb);
    },
    put: async <T extends object>(id: string, data: T) =>
      put<T>(config, id, data, js, jsm, db, metaDb),
    delete: async (id: string) => del(config, id, js, jsm, db, metaDb),
    keys: async (pattern: string) => keys(pattern, db),
    subscribe: <T extends object>(filter: string, callback: SubscriptionCallback<T>) => {
      if (!subscriptions.has(filter)) {
        subscriptions.set(filter, []);
      }
      subscriptions.get(filter)!.push(callback as SubscriptionCallback<any>);
      return () => {
        const callbacks = subscriptions.get(filter)!;
        subscriptions.set(
          filter,
          callbacks.filter((cb) => cb !== callback)
        );
      };
    },
    close: async () => {
      await stream.stop();
      await db.close();
      await metaDb.close();
      await settingsDb.close();
      await nc.close();
    },
  };
}

async function replayEvents(
  config: EventbaseConfig,
  streamName: string,
  js: JetStreamClient,
  db: Level<string, any>,
  metaDb: Level<string, MetaData>,
  settingsDb: Level<string, string>,
  subscriptions: Map<string, SubscriptionCallback<any>[]>
): Promise<Stream> {
  let isReady = false;
  let resolve!: () => void;
  const readyPromise = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });

  const seqKey = `${streamName}_last_processed_seq`;
  let lastProcessedSeq: number;
  try {
    const seqStr = await settingsDb.get(seqKey);
    lastProcessedSeq = parseInt(seqStr, 10);
    if (isNaN(lastProcessedSeq)) {
      lastProcessedSeq = 0;
    }
  } catch (err: any) {
    if (err.notFound) {
      lastProcessedSeq = 0;
    } else {
      throw err;
    }
  }

  const startSeq = lastProcessedSeq + 1;
  const consumer = await js.consumers.get(streamName, { opt_start_seq: startSeq });
  const messages = await consumer.consume();

  let lastMessageTime = Date.now();
  const READY_THRESHOLD = 1000;
  const checkIfReady = setInterval(() => {
    if (!isReady && Date.now() - lastMessageTime > READY_THRESHOLD) {
      isReady = true;
      resolve();
      clearInterval(checkIfReady);
    }
  }, 100);

  const processing = (async () => {
    try {
      for await (const msg of messages) {
        const seq = msg.seq;

        const event: Event = JSON.parse(msg.string());

        config.onMessage?.(event);

        event.oldData = await db.get(event.id).catch(() => null);

        if (event.type === 'PUT') {
          await db.put(event.id, event.data);
          await updateMetaData(event.id, msg.time.toISOString(), metaDb);
          notifySubscribers(event, event.id, await get(event.id, db, metaDb), subscriptions);
        } else if (event.type === 'DELETE') {
          await db.del(event.id);
          await metaDb.del(event.id);
          notifySubscribers(event, event.id, null, subscriptions);
        }

        lastMessageTime = Date.now();
        if (sequenceWaiters.has(seq)) {
          sequenceWaiters.get(seq)!.forEach((resolve) => resolve());
          sequenceWaiters.delete(seq);
        }

        await settingsDb.put(seqKey, seq.toString());
        const seqStr = await settingsDb.get(seqKey);
        msg.ack();
      }
    } catch (err) {
      if (await messages.closed()) {
        // The iterator was closed, exit the loop
      } else {
        // An actual error occurred, re-throw it
        throw err;
      }
    }
  })();

  return {
    waitUntilReady: () => readyPromise,
    stop: async () => {
      clearInterval(checkIfReady);
      await messages.close();
      await processing;
      await consumer.delete();
    },
  };
}

async function updateMetaData(
  id: string,
  time: string,
  metaDb: Level<string, MetaData>
): Promise<void> {
  let meta: MetaData;
  try {
    meta = await metaDb.get(id);
    meta.dateModified = time;
    meta.changes += 1;
  } catch (err: any) {
    if (err.notFound) {
      meta = { dateCreated: time, dateModified: time, changes: 1 };
    } else {
      throw err;
    }
  }
  await metaDb.put(id, meta);
}

function notifySubscribers<T>(
  event: Event,
  key: string,
  data: { meta: MetaData; data: T } | null,
  subscriptions: Map<string, SubscriptionCallback<any>[]>
) {
  for (const [filter, callbacks] of subscriptions.entries()) {
    if (keyMatchesFilter(key, filter)) {
      callbacks.forEach((callback) => callback(key, data?.data, data?.meta || null, event));
    }
  }
}

function keyMatchesFilter(key: string, filter: string): boolean {
  const regex = new RegExp('^' + filter.replace('*', '.*') + '$');
  return regex.test(key);
}

async function get<T extends object>(
  id: string,
  db: Level<string, any>,
  metaDb: Level<string, MetaData>
): Promise<{ meta: MetaData; data: T } | null> {
  try {
    const [data, meta] = await Promise.all([
      db.get(id) as Promise<T>,
      metaDb.get(id),
    ]);
    return { meta, data };
  } catch (err: any) {
    if (err.notFound) return null;
    throw err;
  }
}

async function put<T extends object>(
  config: EventbaseConfig,
  id: string,
  data: T,
  js: JetStreamClient,
  jsm: JetStreamManager,
  db: Level<string, any>,
  metaDb: Level<string, MetaData>
): Promise<{ meta: MetaData; data: T }> {
  const event: Event = {
    type: 'PUT',
    id,
    data,
    timestamp: Date.now(),
  };
  const msg = await js.publish(
    `${config.streamName}.${base64encode(id)}-put`,
    JSON.stringify(event)
  );
  await waitForStream(msg.seq);
  await jsm.streams.purge(config.streamName, {
    filter: `${config.streamName}.${base64encode(id)}-put`,
    keep: 1,
  });
  const result = await get<T>(id, db, metaDb);
  if (result === null) {
    throw new Error(`Failed to retrieve data after put operation for key: ${id}`);
  }
  return result;
}

async function del(
  config: EventbaseConfig,
  id: string,
  js: JetStreamClient,
  jsm: JetStreamManager,
  db: Level<string, any>,
  metaDb: Level<string, MetaData>
) {
  const event: Event = {
    type: 'DELETE',
    id,
    timestamp: Date.now(),
  };
  const msg = await js.publish(
    `${config.streamName}.${base64encode(id)}-delete`,
    JSON.stringify(event)
  );
  await waitForStream(msg.seq);
  const result = await jsm.streams.purge(config.streamName, {
    filter: `${config.streamName}.${base64encode(id)}-put`,
  });
  return { purged: result.purged };
}

async function keys(pattern: string, db: Level<string, any>) {
  const keys: string[] = [];
  for await (const key of db.keys()) {
    if (key.match(pattern)) {
      keys.push(key);
    }
  }
  return keys;
}

export { createEventbaseManager } from './manager.js';
export default createEventbase;
