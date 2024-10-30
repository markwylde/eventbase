import createEventbase from '../src/index';

async function main() {
  const eventbase = await createEventbase({
    streamName: 'mytodoapp',
    nats: {
      servers: ["localhost:4442", "localhost:4443"]
    }
  });

  // Use the eventbase
  await eventbase.put('testid', { a: 1 });
  const data = await eventbase.get('testid'); // { a: 1 }
  await eventbase.delete('testid');

  console.log('DATA', data);

  await eventbase.close();
}

main().catch(console.error);
