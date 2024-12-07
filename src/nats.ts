import { ConnectionOptions, NatsConnection, connect } from "@nats-io/transport-node";
import { JetStreamClient, JetStreamManager, jetstream, jetstreamManager } from "@nats-io/jetstream";

export type EventbaseNats = {
  nc: NatsConnection,
  js: JetStreamClient,
  jsm: JetStreamManager,
  close: () => Promise<void>
}

export async function setupNats(streamName: string, options: ConnectionOptions) : Promise<EventbaseNats> {
  const nc = await connect(options);
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);

  // Ensure stream exists
  try {
    await jsm.streams.info(streamName);
  } catch {
    await jsm.streams.add({
      name: streamName,
      subjects: [`${streamName}.*`]
    });
  }

  const close = async () => {
    await nc.close();
  }

  return { nc, js, jsm, close };
}
