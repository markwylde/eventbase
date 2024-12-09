// manager.ts
import { createEventbase } from './index.js';
import type { EventbaseConfig } from './types.js';

type EventbaseInstance = Awaited<ReturnType<typeof createEventbase>>;

type EventbaseInstances = {
  [streamName: string]: EventbaseInstance | Promise<EventbaseInstance>;
};

export type EventbaseManagerConfig = {
  dbPath?: string;
  getStatsStreamName?: (streamName: string) => string;
  nats: EventbaseConfig['nats'];
  keepAliveSeconds?: number;
  onMessage?: EventbaseConfig['onMessage'];
  cleanupIntervalMs?: number;
};

export function createEventbaseManager(config: EventbaseManagerConfig) {
  const instances: EventbaseInstances = {};
  const {
    dbPath,
    nats,
    keepAliveSeconds = 3600, // Default to 1 hour
    onMessage,
    cleanupIntervalMs = 60000, // Default to 60 seconds
  } = config;

  let cleanupInterval: NodeJS.Timeout | null = null;

  const startCleanupInterval = () => {
    if (cleanupInterval) return;

    cleanupInterval = setInterval(async () => {
      const now = Date.now();

      for (const [streamName, instanceOrPromise] of Object.entries(instances)) {
        const instance = await instanceOrPromise;
        const lastAccessed = instance.getLastAccessed();
        const idleTime = now - lastAccessed;
        const noActiveSubscriptions = instance.getActiveSubscriptions() === 0;

        if (idleTime > keepAliveSeconds * 1000 && noActiveSubscriptions) {
          try {
            await instance.close();
            delete instances[streamName];
          } catch (error) {
            console.error(`Error closing stale instance ${streamName}:`, error);
          }
        }
      }
    }, cleanupIntervalMs);
  };

  const stopCleanupInterval = () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  };

  return {
    getStream: async (streamName: string) => {
      if (!instances[streamName]) {
        instances[streamName] = createEventbase({
          streamName,
          statsStreamName: config.getStatsStreamName
            ? config.getStatsStreamName(streamName)
            : undefined,
          nats,
          dbPath: dbPath ? `${dbPath}/${streamName}` : undefined,
          onMessage,
        });
        startCleanupInterval();
      }

      const instance = await instances[streamName];
      return instance;
    },

    closeAll: async () => {
      stopCleanupInterval();

      const closePromises = Object.entries(instances).map(async ([streamName, instanceOrPromise]) => {
        try {
          const instance = await instanceOrPromise;
          await instance.close();
        } catch (error) {
          console.error(`Error closing instance ${streamName}:`, error);
        }
      });

      await Promise.all(closePromises);
      Object.keys(instances).forEach((key) => delete instances[key]);
    },
  };
}
