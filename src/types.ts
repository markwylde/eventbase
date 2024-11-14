import { ConnectionOptions } from "@nats-io/transport-node";

export type EventbaseConfig = {
  streamName: string;
  nats: ConnectionOptions
};

export type Event = {
  type: 'PUT' | 'DELETE';
  id: string;
  data?: any;
  oldData?: any;
  timestamp: number;
};
