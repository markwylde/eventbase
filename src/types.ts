export type EventbaseConfig = {
  nodeName: string;
  streamName: string;
  servers: string[];
};

export type Event = {
  type: 'PUT' | 'DELETE';
  id: string;
  data?: any;
  timestamp: number;
};
