import { ConnectionOptions } from "@nats-io/transport-node";

export type EventbaseConfig = {
  nodeName: string;
  streamName: string;
  servers: ConnectionOptions;
};

export type Event = {
  type: 'PUT' | 'DELETE';
  id: string;
  data?: any;
  timestamp: number;
};
