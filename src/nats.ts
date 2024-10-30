import { ConnectionOptions, connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";

export async function setupNats(streamName: string, options: ConnectionOptions) {
  // @ts-expect-error
  const nc = await connect(options.servers);
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

  return { nc, js, jsm };
}
