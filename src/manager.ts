// manager.ts
import { EventEmitter } from 'events';
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

export class EventbaseManager extends EventEmitter {
  private instances: EventbaseInstances = {};
  private dbPath?: string;
  private nats: EventbaseConfig['nats'];
  private keepAliveSeconds: number;
  private onMessage?: EventbaseConfig['onMessage'];
  private cleanupIntervalMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private getStatsStreamName?: (streamName: string) => string;

  constructor(private config: EventbaseManagerConfig) {
    super();
    const {
      dbPath,
      nats,
      keepAliveSeconds = 3600, // Default to 1 hour
      onMessage,
      cleanupIntervalMs = 60000, // Default to 60 seconds
      getStatsStreamName,
    } = config;
    this.dbPath = dbPath;
    this.nats = nats;
    this.keepAliveSeconds = keepAliveSeconds;
    this.onMessage = onMessage;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.getStatsStreamName = getStatsStreamName;
  }

  private startCleanupInterval() {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();

      for (const [streamName, instanceOrPromise] of Object.entries(this.instances)) {
        const instance = await instanceOrPromise;
        const lastAccessed = instance.getLastAccessed();
        const idleTime = now - lastAccessed;
        const noActiveSubscriptions = instance.getActiveSubscriptions() === 0;

        if (idleTime > this.keepAliveSeconds * 1000 && noActiveSubscriptions) {
          try {
            await instance.close();
            delete this.instances[streamName];

            // Emit 'stream:closed' event
            this.emit('stream:closed', streamName);
          } catch (error) {
            console.error(`Error closing stale instance ${streamName}:`, error);
          }
        }
      }
    }, this.cleanupIntervalMs);
  }

  private stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async getStream(streamName: string) {
    if (!this.instances[streamName]) {
      this.instances[streamName] = createEventbase({
        streamName,
        statsStreamName: this.getStatsStreamName
          ? this.getStatsStreamName(streamName)
          : undefined,
        nats: this.nats,
        dbPath: this.dbPath ? `${this.dbPath}/${streamName}` : undefined,
        onMessage: this.onMessage,
      });
      this.startCleanupInterval();

      // Emit 'stream:opened' event
      this.emit('stream:opened', streamName);
    }

    const instance = await this.instances[streamName];
    return instance;
  }

  async closeAll() {
    this.stopCleanupInterval();

    const closePromises = Object.entries(this.instances).map(async ([streamName, instanceOrPromise]) => {
      try {
        const instance = await instanceOrPromise;
        await instance.close();

        // Emit 'stream:closed' event
        this.emit('stream:closed', streamName);
      } catch (error) {
        console.error(`Error closing instance ${streamName}:`, error);
      }
    });

    await Promise.all(closePromises);
    this.instances = {};
  }
}

export function createEventbaseManager(config: EventbaseManagerConfig) {
  return new EventbaseManager(config);
}
