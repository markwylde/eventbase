import { ConnectionOptions } from "@nats-io/transport-node";

export type EventbaseConfig = {
  statsStreamName?: string;
  streamName: string;
  nats: ConnectionOptions;
  dbPath?: string;
  onMessage?: (event: Omit<Event, 'oldData'>) => void;
};

export type Event = {
  type: 'PUT' | 'DELETE';
  id: string;
  data?: any;
  oldData?: any;
  timestamp: number;
};

// Add this to types.ts
export type StatsEvent = {
  operation: 'GET' | 'PUT' | 'DELETE' | 'KEYS' | 'SUBSCRIBE' | 'SUBSCRIBE_EMIT';
  id?: string;
  pattern?: string;
  timestamp: number;
  duration: number;
};

export type Stream = {
  waitUntilReady: () => Promise<void>;
  stop: () => Promise<void>;
};
