import type { Event, EventbaseConfig, StatsEvent } from './types.js';
import createDoubledb, { DoubleDb } from 'doubledb';
import { EventbaseNats, setupNats } from './nats.js';
import { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { v4 as uuidv4 } from 'uuid';
import { rm } from 'fs/promises';

const base64encode = (str: string) => Buffer.from(str).toString('base64');

type QueryOptions = {
  limit?: number;
  offset?: number;
  sort?: {
    [key: string]: 1 | -1
  };
  project?: {
    [key: string]: 1
  }
}

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
  data: T,
  meta: MetaData,
  event: Event
) => void;

type SubscriptionQuery = {
  [key: string]: any;
};

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
  const db = await createDoubledb(config.dbPath || './data');
  const metaDb = await createDoubledb(config.dbPath ? `${config.dbPath}/meta` : './meta');
  const settingsDb = await createDoubledb(config.dbPath ? `${config.dbPath}/settings` : './settings');

  const { nc, js, jsm } = await setupNats(config.streamName, config.nats);
  const subscriptions = new Map<SubscriptionQuery, SubscriptionCallback<any>[]>();

  let lastAccessed = Date.now();
  let activeSubscriptions = 0;

  // Setup stats stream if configured
  let stats: EventbaseNats;
  if (config.statsStreamName) {
    stats = await setupNats(config.statsStreamName, config.nats);
  }

  const publishStats = async (statsEvent: StatsEvent) => {
    if (stats?.js && config.statsStreamName) {
      await stats.js.publish(
        `${config.statsStreamName}.stats`,
        JSON.stringify(statsEvent)
      );
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
    closed: false,

    get: async <T extends object>(id: string): Promise<{ meta: MetaData; data: T } | null> => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

      const start = Date.now();
      updateLastAccessed();
      const result = await db.read(id);
      await publishStats({
        operation: 'GET',
        id,
        timestamp: start,
        duration: Date.now() - start
      });
      return result ? { meta: await metaDb.read(id) as MetaData, data: result as T } : null;
    },

    put: async <T extends object>(id: string, data: T) => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

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

    insert: async <T extends object>(data: T): Promise<{ id: string; meta: MetaData; data: T }> => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

      const id = uuidv4();

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
      return { id, ...result };
    },

    delete: async (id: string) => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

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

    keys: async (pattern?: string) => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

      const start = Date.now();
      updateLastAccessed();
      const result = await db.filter('id', (v: string) => pattern ? v.match(pattern) : true);
      await publishStats({
        operation: 'KEYS',
        pattern,
        timestamp: start,
        duration: Date.now() - start
      });
      return result.map(record => record.id as string);
    },

    subscribe: <T extends object>(query: SubscriptionQuery, callback: SubscriptionCallback<T>) => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

      const start = Date.now();
      const queryKey = JSON.stringify(query);
      if (!subscriptions.has(queryKey as unknown as SubscriptionQuery)) {
        subscriptions.set(queryKey as unknown as SubscriptionQuery, []);
      }
      subscriptions.get(queryKey as unknown as SubscriptionQuery)!.push(callback as SubscriptionCallback<any>);
      activeSubscriptions++;

      publishStats({
        operation: 'SUBSCRIBE',
        pattern: queryKey as unknown as string,
        timestamp: start,
        duration: Date.now() - start
      });

      return () => {
        const callbacks = subscriptions.get(queryKey as unknown as SubscriptionQuery)!;
        if (!callbacks) {
          return;
        }
        const index = callbacks.indexOf(callback as SubscriptionCallback<any>);
        if (index !== -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          subscriptions.delete(queryKey as unknown as SubscriptionQuery);
        }
        activeSubscriptions = Math.max(0, activeSubscriptions - 1);
      };
    },

    query: async <T extends object>(queryObject: object, options?: QueryOptions): Promise<T[]> => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

      const start = Date.now();
      updateLastAccessed();
      const result = await db.query(queryObject as any, options as any);
      await publishStats({
        operation: 'QUERY',
        query: queryObject,
        queryResultCount: result.length,
        timestamp: start,
        duration: Date.now() - start
      });
      return result as T[];
    },

    count: async (queryObject: object): Promise<number> => {
      if (instance.closed) {
        throw new Error('instance is closed');
      }

      const start = Date.now();
      updateLastAccessed();
      const result = await db.count(queryObject as any);
      await publishStats({
        operation: 'QUERY',
        query: queryObject,
        timestamp: start,
        duration: Date.now() - start
      });
      return result;
    },

    getLastAccessed: () => lastAccessed,
    getActiveSubscriptions: () => activeSubscriptions,

    deleteStream: async () => {
      await jsm.streams.purge(config.streamName);
      await jsm.streams.delete(config.streamName);
      await instance.close();

      await Promise.all([
        db.close(),
        metaDb.close(),
        settingsDb.close()
      ]);

      await rm(config.dbPath || './data', { recursive: true });
    },

    close: async () => {
      instance.closed = true;
      await stream.stop();
      await db.close();
      await metaDb.close();
      await settingsDb.close();
      await nc.close();
      await stats?.close();
      subscriptions.clear();
    },
  };

  return instance;
}

async function replayEvents(
  config: EventbaseConfig,
  streamName: string,
  js: JetStreamClient,
  db: DoubleDb,
  metaDb: DoubleDb,
  settingsDb: DoubleDb,
  subscriptions: Map<SubscriptionQuery, SubscriptionCallback<any>[]>,
  publishStats: (statsEvent: StatsEvent) => Promise<void>
): Promise<Stream> {
  let resolve!: () => void;
  const readyPromise = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });

  const seqKey = `${streamName}_last_processed_seq`;
  let lastProcessedSeq: number;

  const seqStr = await settingsDb.read(seqKey);

  lastProcessedSeq = parseInt(seqStr?.value, 10);
  if (isNaN(lastProcessedSeq)) {
    lastProcessedSeq = 0;
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

        const oldData = await db.read(event.id).catch(() => undefined);
        event.oldData = oldData === undefined ? null : oldData;

        if (event.type === 'PUT') {
          await db.upsert(event.id, { id: event.id, ...event.data });
          await updateMetaData(event.id, msg.time.toISOString(), metaDb);
          notifySubscribers(
            event,
            event.id,
            await get(event.id, db, metaDb),
            subscriptions,
            publishStats
          );
        } else if (event.type === 'DELETE') {
          await db.remove(event.id).catch(() => {});
          await metaDb.remove(event.id).catch(() => {});
          notifySubscribers(event, event.id, event.oldData, subscriptions, publishStats);
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

        await settingsDb.upsert(seqKey, { id: seqKey, value: seq.toString() });
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
      try {
        await messages.close();
        await processing;
        await consumer.delete();
      } catch (error) {}
    },
  };
}

async function updateMetaData(
  id: string,
  time: string,
  metaDb: DoubleDb,
): Promise<void> {
  let meta: MetaData;
  try {
    meta = await metaDb.read(id) as MetaData;
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

  await metaDb.upsert(id, { id, ...meta });
}

function notifySubscribers<T>(
  event: Event,
  key: string,
  data: { meta: MetaData; data: T } | null,
  subscriptions: Map<SubscriptionQuery, SubscriptionCallback<any>[]>,
  publishStats: (statsEvent: StatsEvent) => Promise<void>
) {
  if (!data) {
    return;
  }
  for (const [queryKey, callbacks] of subscriptions.entries()) {
    const query = JSON.parse(queryKey as unknown as string);
    if (event.type === 'DELETE' || queryMatchesData(query, data?.data)) {
      const start = Date.now();
      const eventData = event.type === 'DELETE' ? event.oldData : data.data;
      callbacks.forEach((callback) => callback(key, eventData, data.meta, event));
      publishStats({
        operation: 'SUBSCRIBE_EMIT',
        id: key,
        pattern: queryKey as unknown as string,
        timestamp: start,
        duration: Date.now() - start
      });
    }
  }
}

function queryMatchesData(query: SubscriptionQuery, data: any): boolean {
  if (!data) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (!evaluateCondition(data[key], condition)) {
      return false;
    }
  }
  return true;
}

function evaluateCondition(value: any, condition: any): boolean {
  if (typeof condition === 'object' && condition !== null) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case '$lt':
          if (!(value < (operand as number))) return false;
          break;
        case '$lte':
          if (!(value <= (operand as number))) return false;
          break;
        case '$gt':
          if (!(value > (operand as number))) return false;
          break;
        case '$gte':
          if (!(value >= (operand as number))) return false;
          break;
        case '$eq':
          if (!(value === operand)) return false;
          break;
        case '$ne':
          if (!(value !== operand)) return false;
          break;
        case '$in':
          if (!Array.isArray(operand) || !operand.includes(value)) return false;
          break;
        case '$nin':
          if (!Array.isArray(operand) || operand.includes(value)) return false;
          break;
        case '$regex':
          if (!(new RegExp(operand as string).test(value))) return false;
          break;
        case '$sw':
          if (!(value.startsWith(operand as string))) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  } else {
    return value === condition;
  }
}

async function get<T extends object>(
  id: string,
  db: DoubleDb,
  metaDb: DoubleDb
): Promise<{ meta: MetaData; data: T } | null> {
  const data = await db.read(id);
  const meta = await metaDb.read(id) as MetaData;
  if (data === undefined || meta === undefined) return null;
  return { meta: meta as MetaData, data: data as T };
}

async function put<T extends object>(
  config: EventbaseConfig,
  id: string,
  data: T,
  js: JetStreamClient,
  jsm: JetStreamManager,
  db: DoubleDb,
  metaDb: DoubleDb,
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

  await waitForStream(msg.seq);

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
  db: DoubleDb,
  metaDb: DoubleDb
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

export { createEventbaseManager } from './manager.js';
export default createEventbase;
