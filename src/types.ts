import { ConnectionOptions } from "@nats-io/transport-node";

export type EventbaseConfig = {
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

export type Stream = {
  waitUntilReady: () => Promise<void>;
  stop: () => Promise<void>;
};
