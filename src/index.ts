import type { Event, EventbaseConfig, StatsEvent } from './types.js';
import type { Level } from 'level';
import { createDb } from './db.js';
import { EventbaseNats, setupNats } from './nats.js';
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

const sequenceWaiters = new Map<number, ((seq: number) => void)[]>();

function waitForStream(seq: number): Promise<number> {
  return new Promise((resolve) => {
    if (sequenceWaiters.size === 0 || Math.max(...sequenceWaiters.keys()) < seq) {
      sequenceWaiters.set(seq, []);
    }

    for (const [waitSeq, callbacks] of sequenceWaiters.entries()) {
      if (waitSeq <= seq) {
        callbacks.push(resolve);
        return;
      }
    }
  });
}

export async function createEventbase(config: EventbaseConfig) {
  const db: Level<string, any> = await createDb('db', config.dbPath);
  const metaDb: Level<string, any> = await createDb('meta', config.dbPath);
  const settingsDb: Level<string, any> = await createDb('settings', config.dbPath);

  await db.open();
  await metaDb.open();
  await settingsDb.open();

  const { nc, js, jsm } = await setupNats(config.streamName, config.nats);
  const subscriptions = new Map<string, SubscriptionCallback<any>[]>();

  let lastAccessed = Date.now();
  let activeSubscriptions = 0;

  // Setup stats stream if configured
  let stats: EventbaseNats;
  if (config.statsStreamName) {
    stats = await setupNats(config.statsStreamName, config.nats);
  }

  const publishStats = async (statsEvent: StatsEvent) => {
    if (stats?.js && config.statsStreamName) {
      try {
        await stats.js.publish(
          `${config.statsStreamName}.stats`,
          JSON.stringify(statsEvent)
        );
      } catch (err) {
        console.error('Error publishing stats:', err);
      }
    }
  };

  const updateLastAccessed = () => {
    lastAccessed = Date.now();
  };

  const stream = await replayEvents(
    config,
    config.streamName,
    js,
    db,
    metaDb,
    settingsDb,
    subscriptions,
    publishStats
  );
  await stream.waitUntilReady();

  const instance = {
    get: async <T extends object>(id: string): Promise<{ meta: MetaData; data: T } | null> => {
      const start = Date.now();
      updateLastAccessed();
      const result = await get<T>(id, db, metaDb);
      await publishStats({
        operation: 'GET',
        id,
        timestamp: start,
        duration: Date.now() - start
      });
      return result;
    },

    put: async <T extends object>(id: string, data: T) => {
      const start = Date.now();
      updateLastAccessed();
      const result = await put<T>(
        config,
        id,
        data,
        js,
        jsm,
        db,
        metaDb,
        publishStats
      );
      return result;
    },

    delete: async (id: string) => {
      const start = Date.now();
      updateLastAccessed();
      const result = await del(config, id, js, jsm, db, metaDb);
      await publishStats({
        operation: 'DELETE',
        id,
        timestamp: start,
        duration: Date.now() - start
      });
      return result;
    },

    keys: async (pattern: string) => {
      const start = Date.now();
      updateLastAccessed();
      const result = await keys(pattern, db);
      await publishStats({
        operation: 'KEYS',
        pattern,
        timestamp: start,
        duration: Date.now() - start
      });
      return result;
    },

    subscribe: <T extends object>(filter: string, callback: SubscriptionCallback<T>) => {
      const start = Date.now();
      if (!subscriptions.has(filter)) {
        subscriptions.set(filter, []);
      }
      subscriptions.get(filter)!.push(callback as SubscriptionCallback<any>);
      activeSubscriptions++;

      publishStats({
        operation: 'SUBSCRIBE',
        pattern: filter,
        timestamp: start,
        duration: Date.now() - start
      });

      return () => {
        const callbacks = subscriptions.get(filter)!;
        const index = callbacks.indexOf(callback as SubscriptionCallback<any>);
        if (index !== -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          subscriptions.delete(filter);
        }
        activeSubscriptions = Math.max(0, activeSubscriptions - 1);
      };
    },

    getLastAccessed: () => lastAccessed,
    getActiveSubscriptions: () => activeSubscriptions,

    close: async () => {
      await stream.stop();
      await db.close();
      await metaDb.close();
      await settingsDb.close();
      await nc.close();
      await stats?.close();
    },
  };

  return instance;
}

async function replayEvents(
  config: EventbaseConfig,
  streamName: string,
  js: JetStreamClient,
  db: Level<string, any>,
  metaDb: Level<string, MetaData>,
  settingsDb: Level<string, string>,
  subscriptions: Map<string, SubscriptionCallback<any>[]>,
  publishStats: (statsEvent: StatsEvent) => Promise<void>
): Promise<Stream> {
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
    if (err.code === 'LEVEL_NOT_FOUND') {
      lastProcessedSeq = 0;
    } else {
      throw err;
    }
  }

  // Get initial stream state
  const streamInfo = await (await js.streams.get(streamName)).info();
  const targetSeq = streamInfo.state.last_seq;

  // If there are no messages or we're already caught up, resolve immediately
  if (targetSeq === 0 || lastProcessedSeq >= targetSeq) {
    resolve();
  }

  const startSeq = lastProcessedSeq + 1;
  const consumer = await js.consumers.get(streamName, { opt_start_seq: startSeq });
  const messages = await consumer.consume();

  const processing = (async () => {
    try {
      for await (const msg of messages) {
        const seq = msg.seq;
        const event: Event = JSON.parse(msg.string());

        config.onMessage?.(event);

        const oldData = await db.get(event.id).catch(() => undefined);
        event.oldData = oldData === undefined ? null : oldData;

        if (event.type === 'PUT') {
          await db.put(event.id, event.data);
          await updateMetaData(event.id, msg.time.toISOString(), metaDb);
          notifySubscribers(
            event,
            event.id,
            await get(event.id, db, metaDb),
            subscriptions,
            publishStats
          );
        } else if (event.type === 'DELETE') {
          await db.del(event.id);
          await metaDb.del(event.id);
          notifySubscribers(event, event.id, null, subscriptions, publishStats);
        }

        // Resolve all waiters for this sequence and lower
        for (const [waitSeq, callbacks] of sequenceWaiters.entries()) {
          if (waitSeq <= seq) {
            callbacks.forEach((callback) => callback(seq));
            sequenceWaiters.delete(waitSeq);
          } else {
            break;
          }
        }

        await settingsDb.put(seqKey, seq.toString());
        msg.ack();

        // Resolve when we've caught up to the initial state
        if (seq >= targetSeq) {
          resolve();
        }
      }
    } catch (err) {
      console.error('Error in replayEvents:', err);
      if (await messages.closed()) {
      } else {
        throw err;
      }
    }
  })();

  return {
    waitUntilReady: () => readyPromise,
    stop: async () => {
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
    if (!meta) {
      meta = { dateCreated: time, dateModified: time, changes: 1 };
    } else {
      meta.dateModified = time;
      meta.changes += 1;
    }
  } catch (err: any) {
    if (err.code === 'LEVEL_NOT_FOUND') {
      meta = { dateCreated: time, dateModified: time, changes: 1 };
    } else {
      console.error('Error in updateMetaData:', err);
      throw err;
    }
  }
  await metaDb.put(id, meta);
}

function notifySubscribers<T>(
  event: Event,
  key: string,
  data: { meta: MetaData; data: T } | null,
  subscriptions: Map<string, SubscriptionCallback<any>[]>,
  publishStats: (statsEvent: StatsEvent) => Promise<void>
) {
  for (const [filter, callbacks] of subscriptions.entries()) {
    if (keyMatchesFilter(key, filter)) {
      const start = Date.now();
      callbacks.forEach((callback) => callback(key, data?.data, data?.meta || null, event));
      publishStats({
        operation: 'SUBSCRIBE_EMIT',
        id: key,
        pattern: filter,
        timestamp: start,
        duration: Date.now() - start
      });
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
      db.get(id) as Promise<T | undefined>,
      metaDb.get(id) as Promise<MetaData | undefined>,
    ]);

    if (data === undefined || meta === undefined) return null;
    return { meta, data };
  } catch (err: any) {
    if (err.code === 'LEVEL_NOT_FOUND') return null;
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
  metaDb: Level<string, MetaData>,
  publishStats: (statsEvent: StatsEvent) => Promise<void>
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

  const processedSeq = await waitForStream(msg.seq);

  const result = await get<T>(id, db, metaDb);
  if (result === null) {
    throw new Error(`Failed to retrieve data after put operation for key: ${id}`);
  }

  await publishStats({
    operation: 'PUT',
    id,
    timestamp: event.timestamp,
    duration: Date.now() - event.timestamp
  });

  await jsm.streams.purge(config.streamName, {
    filter: `${config.streamName}.${base64encode(id)}-put`,
    keep: 1,
  });

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
  const processedSeq = await waitForStream(msg.seq);
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
