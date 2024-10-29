import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";

export async function setupNats(streamName: string, servers: string[]) {
  const nc = await connect(servers);
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
