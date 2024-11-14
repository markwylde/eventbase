import type { Event, EventbaseConfig } from './types.js';
import type { Level } from 'level';
import { createDb } from './db.js';
import { setupNats } from './nats.js';
import { JetStreamClient } from '@nats-io/jetstream';

type Stream = {
  waitUntilReady: () => Promise<void>;
  stop: () => void;
};

type SubscriptionCallback<T extends object> = (key: string, data: T | null, event: Event) => void;

export async function createEventbase(config: EventbaseConfig) {
  const db = await createDb(config.streamName);
  const { nc, js, jsm } = await setupNats(config.streamName, config.nats);
  const subscriptions = new Map<string, SubscriptionCallback<any>[]>();

  // Replay all events from stream to rebuild state
  const stream = await replayEvents(config.streamName, js, db, subscriptions);
  await stream.waitUntilReady();

  return {
    put: async <T extends object>(id: string, data: T) => put(id, data, config.streamName, js, db),
    get: async <T extends object>(id: string): Promise<T | null> => get<T>(id, db),
    delete: async (id: string) => delete_(id, config.streamName, js, db),
    keys: async (pattern: string) => keys(pattern, db),
    subscribe: <T extends object>(filter: string, callback: SubscriptionCallback<T>) => {
      if (!subscriptions.has(filter)) {
        subscriptions.set(filter, []);
      }
      subscriptions.get(filter)!.push(callback as SubscriptionCallback<any>);
      return () => {
        const callbacks = subscriptions.get(filter)!;
        subscriptions.set(filter, callbacks.filter(cb => cb !== callback));
      };
    },
    close: async () => {
      await stream.stop();
      await db.close();
      await nc.close();
    }
  };
}

async function replayEvents(
  streamName: string,
  js: JetStreamClient,
  db: Level<string, object>,
  subscriptions: Map<string, SubscriptionCallback<any>[]>
): Promise<Stream> {
  let isReady = false;
  let isStopped = false;
  let resolve: () => void;

  const readyPromise = new Promise<void>(_resolve => {
    resolve = _resolve;
  });

  const consumer = await js.consumers.get(streamName);
  const messages = await consumer.consume();

  // Track last received message time
  let lastMessageTime = Date.now();
  const READY_THRESHOLD = 1000; // 1 second without messages means we're caught up

  const checkIfReady = setInterval(() => {
    if (!isReady && Date.now() - lastMessageTime > READY_THRESHOLD) {
      isReady = true;
      resolve();
      clearInterval(checkIfReady);
    }
  }, 100);

  // Start processing messages
  (async () => {
    for await (const msg of messages) {
      const event: Event = JSON.parse(msg.string());

      let oldData = null;
      try {
        oldData = await db.get(event.id);
      } catch (error) {}
      event.oldData = oldData;

      if (event.type === 'PUT') {
        await db.put(event.id, event.data);
        notifySubscribers(event, event.id, event.data, subscriptions);
      } else if (event.type === 'DELETE') {
        await db.del(event.id);
        notifySubscribers(event, event.id, null, subscriptions);
      }
      lastMessageTime = Date.now();
      msg.ack();
    }
  })();

  return {
    waitUntilReady: () => readyPromise,
    stop: async () => {
      isStopped = true;
      clearInterval(checkIfReady);
      await messages.close();
      await consumer.delete();
    }
  };
}

function notifySubscribers<T>(event: Event, key: string, data: T | null, subscriptions: Map<string, SubscriptionCallback<any>[]>) {
  for (const [filter, callbacks] of subscriptions.entries()) {
    if (keyMatchesFilter(key, filter)) {
      callbacks.forEach(callback => callback(key, data, event));
    }
  }
}

function keyMatchesFilter(key: string, filter: string): boolean {
  const regex = new RegExp('^' + filter.replace('*', '.*') + '$');
  return regex.test(key);
}

async function put<T extends object>(id: string, data: T, streamName: string, js: any, db: Level<string, object>) {
  const event: Event = {
    type: 'PUT',
    id,
    data,
    timestamp: Date.now()
  };
  await js.publish(
    `${streamName}.put`,
    JSON.stringify(event)
  );
  await db.put(id, data);
  return data;
}

async function get<T extends object>(id: string, db: Level<string, object>): Promise<T | null> {
  try {
    return await db.get(id) as T;
  } catch (err: any) {
    if (err.notFound) return null;
    throw err;
  }
}

async function delete_(id: string, streamName: string, js: any, db: Level<string, object>) {
  const event: Event = {
    type: 'DELETE',
    id,
    timestamp: Date.now()
  };
  await js.publish(
    `${streamName}.delete`,
    JSON.stringify(event)
  );
  await db.del(id);
}

async function keys(pattern: string, db: Level<string, object>) {
  const keys: string[] = [];
  for await (const key of db.keys()) {
    if (key.match(pattern)) {
      keys.push(key);
    }
  }
  return keys;
}

export default createEventbase;
