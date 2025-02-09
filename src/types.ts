import { ConnectionOptions } from "@nats-io/transport-node";
import createEventbase from ".";

export type EventbaseInstance = Awaited<ReturnType<typeof createEventbase>>;

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

export type StatsEvent = {
  operation: 'GET' | 'QUERY' |  'PUT' | 'DELETE' | 'KEYS' | 'SUBSCRIBE' | 'SUBSCRIBE_EMIT';
  id?: string;
  pattern?: string;
  query?: object;
  queryResultCount?: number;
  timestamp: number;
  duration: number;
};

export type Stream = {
  waitUntilReady: () => Promise<void>;
  stop: () => Promise<void>;
};
