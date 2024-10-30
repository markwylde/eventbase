import type { Event, EventbaseConfig } from './types.js';
import type { Level } from 'level';
import { createDb } from './db.js';
import { setupNats } from './nats.js';
import { JetStreamClient } from '@nats-io/jetstream';

type Stream = {
  waitUntilReady: () => Promise<void>;
  stop: () => void;
};

export async function createEventbase(config: EventbaseConfig) {
  const db = await createDb(config.streamName);
  const { nc, js, jsm } = await setupNats(config.streamName, config.servers);

  // Replay all events from stream to rebuild state
  const stream = await replayEvents(config.streamName, js, db);
  await stream.waitUntilReady();

  return {
    put: (id: string, data: any) => put(id, data, config.streamName, js, db),
    get: (id: string) => get(id, db),
    delete: (id: string) => delete_(id, config.streamName, js, db),
    keys: (pattern: string) => keys(pattern, db),
    close: async () => {
      await stream.stop();
      await db.close();
      await nc.close();
    }
  };
}

async function replayEvents(streamName: string, js: JetStreamClient, db: Level): Promise<Stream> {
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
      if (event.type === 'PUT') {
        await db.put(event.id, event.data);
      } else if (event.type === 'DELETE') {
        await db.del(event.id);
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

async function put(id: string, data: any, streamName: string, js: any, db: Level) {
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

async function get(id: string, db: Level) {
  try {
    return await db.get(id);
  } catch (err: any) {
    if (err.notFound) return null;
    throw err;
  }
}

async function delete_(id: string, streamName: string, js: any, db: Level) {
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

async function keys(pattern: string, db: Level) {
  const keys: string[] = [];
  for await (const key of db.keys()) {
    if (key.match(pattern)) {
      keys.push(key);
    }
  }
  return keys;
}

export default createEventbase;
