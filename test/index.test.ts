// test/eventbase.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import createEventbase from '../src/index.js';
import { setupNats } from '../src/nats.js';
import { StatsEvent } from '../src/types.js';

describe('Eventbase with Stats', async () => {
  let eventbase1;
  let eventbase2;
  let statsEvents: StatsEvent[] = [];
  let statsSubscription;
  let statsNats;
  let streamName: string;
  let statsStreamName: string;

  beforeEach(async () => {
    streamName = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    statsStreamName = streamName + '-stats';

    // Set up stats NATS connection and subscription
    statsNats = await setupNats(statsStreamName, {
      servers: ['localhost:4222'],
      user: 'a',
      pass: 'a',
    });

    // Subscribe to the stats stream
    const sub = statsNats.nc.subscribe(`${statsStreamName}.stats`);
    statsSubscription = (async () => {
      for await (const msg of sub) {
        const statsEvent: StatsEvent = JSON.parse(msg.string());
        statsEvents.push(statsEvent);
      }
    })();

    [eventbase1, eventbase2] = await Promise.all([
      createEventbase({
        dbPath: './test-data/' + streamName + '-node1',
        nats: {
          servers: ['localhost:4222'],
          user: 'a',
          pass: 'a',
        },
        streamName,
        statsStreamName,
      }),
      createEventbase({
        dbPath: './test-data/' + streamName + '-node2',
        nats: {
          servers: ['localhost:4222'],
          user: 'a',
          pass: 'a',
        },
        streamName,
        statsStreamName,
      }),
    ]);
  });

  afterEach(async () => {
    await Promise.all([eventbase1.close(), eventbase2.close()]);

    // Close stats NATS connection
    await statsNats.close();

    // Clear stats events and ensure subscription is cleaned up
    statsEvents = [];
    // We don't need to manually stop statsSubscription; it will end when nc is closed
  });

  test('should publish stats events for get operation', async () => {
    await eventbase1.get('nonexistent');
    // Wait a bit to ensure stats event is received
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(statsEvents.length, 1);
    const statsEvent = statsEvents[0];
    assert.equal(statsEvent.operation, 'GET');
    assert.equal(statsEvent.id, 'nonexistent');
    assert.ok(typeof statsEvent.timestamp === 'number');
    assert.ok(typeof statsEvent.duration === 'number');
  });

  test('should publish stats events for put operation', async () => {
    await eventbase1.put('key1', { value: 123 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(statsEvents.length, 1);
    const statsEvent = statsEvents[0];
    assert.equal(statsEvent.operation, 'PUT');
    assert.equal(statsEvent.id, 'key1');
  });

  test('should publish stats events for delete operation', async () => {
    await eventbase1.put('keyToDelete', { value: 456 });
    statsEvents = []; // Clear previous stats events
    await eventbase1.delete('keyToDelete');
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(statsEvents.length, 1);
    const statsEvent = statsEvents[0];
    assert.equal(statsEvent.operation, 'DELETE');
    assert.equal(statsEvent.id, 'keyToDelete');
  });

  test('should publish stats events for keys operation', async () => {
    await eventbase1.put('key1', {});
    await eventbase1.put('key2', {});
    statsEvents = []; // Clear previous stats events
    await eventbase1.keys('key*');
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(statsEvents.length, 1);
    const statsEvent = statsEvents[0];
    assert.equal(statsEvent.operation, 'KEYS');
    assert.equal(statsEvent.pattern, 'key*');
  });

  test('should publish stats events for subscribe operation', async () => {
    const subscription = eventbase1.subscribe('key*', () => {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(statsEvents.length, 1);
    const statsEvent = statsEvents[0];
    assert.equal(statsEvent.operation, 'SUBSCRIBE');
    assert.equal(statsEvent.pattern, 'key*');

    // Cleanup
    subscription();
  });

  test('should publish stats events for subscribe emit', async () => {
    const updates = [];
    const subscription = eventbase1.subscribe('key*', (key, data) => {
      updates.push({ key, data });
    });

    statsEvents = [];
    await eventbase1.put('key1', { value: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Expecting 3 stats events: one for PUT one for SUBSCRIBE_EMIT and one for SUBSCRIBE
    assert.equal(statsEvents.length, 3);

    const subscribeEmitEvent = statsEvents.find((e) => e.operation === 'SUBSCRIBE_EMIT');
    assert.ok(subscribeEmitEvent);
    assert.equal(subscribeEmitEvent.id, 'key1');
    assert.equal(subscribeEmitEvent.pattern, 'key*');

    // Cleanup
    subscription();
  });

  // Your original tests can continue from here
  test('should store and retrieve data with metadata', async () => {
    const testData = { name: 'John Doe', age: 30 };
    await eventbase1.put('user1', testData);
    const result = await eventbase1.get('user1');
    assert.deepEqual(result.data, testData);
    assert.equal(typeof result.meta.dateCreated, 'string');
    assert.equal(typeof result.meta.dateModified, 'string');
    assert.equal(result.meta.changes, 1);
  });

  test('should resume from stored data', async () => {
    const localStreamName = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const localEventbase1 = await createEventbase({
      dbPath: './test-data/' + localStreamName,
      nats: {
        servers: ['localhost:4222'],
        user: 'a',
        pass: 'a',
      },
      streamName: localStreamName,
    });

    await localEventbase1.put('user1', { name: 'John One', age: 10 });
    await localEventbase1.put('user2', { name: 'John Two', age: 20 });
    await localEventbase1.put('user3', { name: 'John Three', age: 30 });

    await localEventbase1.close();

    const messages = [];
    const localEventbase2 = await createEventbase({
      dbPath: './test-data/' + localStreamName,
      nats: {
        servers: ['localhost:4222'],
        user: 'a',
        pass: 'a',
      },
      streamName: localStreamName,
      onMessage: (message) => {
        messages.push(message);
      },
    });

    const user2 = await localEventbase2.get('user2');
    await localEventbase2.put('user4', { name: 'John Four', age: 40 });
    await localEventbase2.close();

    assert.equal(messages.length, 1);
    assert.deepEqual(user2.data, { name: 'John Two', age: 20 });
  });

  test('should return null for non-existent keys', async () => {
    const result = await eventbase1.get('nonexistent');
    assert.equal(result, null);
  });

  test('should delete data', async () => {
    await eventbase1.put('user2', { name: 'Jane Doe' });
    await eventbase1.delete('user2');
    const result = await eventbase1.get('user2');
    assert.equal(result, null);
  });

  test('should sync data between instances', async () => {
    // Store data in first instance
    const testData = { name: 'John Doe', age: 30 };
    await eventbase1.put('user3', testData);

    // Verify data in second instance
    const result = await eventbase2.get('user3');
    assert.deepEqual(result.data, testData);
  });

  test('should handle concurrent operations', async () => {
    const operations = [];
    const expectedResults = new Map();

    for (let i = 0; i < 10; i++) {
      operations.push(
        eventbase1.put(`key${i}`, { value: i })
          .then(result => ({ success: true, key: `key${i}`, result }))
          .catch(error => ({ success: false, key: `key${i}`, error }))
      );
      expectedResults.set(`key${i}`, { value: i });
    }

    const putResults = await Promise.all(operations);

    // Give processes more time to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Collect all results
    const getOperations = Array.from(expectedResults.keys()).map(key =>
      eventbase1.get(key)
        .then(result => ({ success: true, key, result }))
        .catch(error => ({ success: false, key, error }))
    );
    const results = await Promise.all(getOperations);

    // Verify all operations succeeded without considering order
    const actualResults = new Map();

    results.forEach(result => {
      if (result.success && result.result && result.result.data) {
        actualResults.set(result.key, result.result.data);
      } else {
        console.warn(`Unexpected result for key ${result.key}:`, result);
      }
    });

    assert.equal(actualResults.size, expectedResults.size, 'Number of results should match');

    for (const [key, expectedValue] of expectedResults) {
      if (actualResults.has(key)) {
        assert.deepEqual(actualResults.get(key), expectedValue, `Value for key ${key} should match`);
      } else {
        console.warn(`Key ${key} was not successfully retrieved`);
      }
    }
  });

  test('should handle updates to existing keys', async () => {
    const key = 'updateTest';
    await eventbase1.put(key, { version: 1 });
    await eventbase1.put(key, { version: 2 });
    const result = await eventbase1.get(key);
    assert.deepEqual(result.data, { version: 2 });
    assert.equal(result.meta.changes, 2);
  });

  test('should handle large data', async () => {
    const largeData = {
      array: Array(100)
        .fill('')
        .map((_, i) => ({ id: i, data: 'test'.repeat(50) })),
    };
    await eventbase1.put('largeKey', largeData);
    const result = await eventbase1.get('largeKey');
    assert.deepEqual(result.data, largeData);
  });

  test('should handle special characters in keys', async () => {
    const specialKey = '!@#$%^&*()_+';
    const testData = { test: true };
    await eventbase1.put(specialKey, testData);
    const result = await eventbase1.get(specialKey);
    assert.deepEqual(result.data, testData);
  });

  test('should filter keys based on pattern', async () => {
    await eventbase1.put('something:1', { value: 1 });
    await eventbase1.put('something:2', { value: 2 });
    await eventbase1.put('other:1', { value: 3 });
    const keys = await eventbase1.keys('something:*');
    assert.deepEqual(keys.sort(), ['something:1', 'something:2'].sort());
  });

  test('should subscribe to events and receive updates', async () => {
    const updates = [];
    const unsubscribe = eventbase1.subscribe('test:*', (key, data, meta, event) => {
      updates.push({ key, data, meta, event });
    });
    await eventbase1.put('test:1', { value: 1 });
    await eventbase1.put('test:2', { value: 2 });

    const expectedUpdates = [
      {
        key: 'test:1',
        data: { value: 1 },
        meta: {
          changes: 1,
          dateCreated: updates[0].meta.dateCreated || 'FAILED',
          dateModified: updates[0].meta.dateModified || 'FAILED',
        },
        event: {
          oldData: null,
          data: { value: 1 },
          id: 'test:1',
          type: 'PUT',
          timestamp: updates[0].event.timestamp,
        },
      },
      {
        key: 'test:2',
        data: { value: 2 },
        meta: {
          changes: 1,
          dateCreated: updates[1].meta.dateCreated || 'FAILED',
          dateModified: updates[1].meta.dateModified || 'FAILED',
        },
        event: {
          oldData: null,
          data: { value: 2 },
          id: 'test:2',
          type: 'PUT',
          timestamp: updates[1].event.timestamp,
        },
      },
    ];

    assert.deepEqual(updates, expectedUpdates);
    unsubscribe();
  });

  test('should handle multiple subscriptions', async () => {
    const updates1 = [];
    const updates2 = [];
    const unsubscribe1 = eventbase1.subscribe('multi:1', (key, data) => {
      updates1.push({ key, value: data });
    });
    const unsubscribe2 = eventbase1.subscribe('multi:2', (key, data) => {
      updates2.push({ key, value: data });
    });
    await eventbase1.put('multi:1', { value: 1 });
    await eventbase1.put('multi:2', { value: 2 });

    assert.deepEqual(updates1, [{ key: 'multi:1', value: { value: 1 } }]);
    assert.deepEqual(updates2, [{ key: 'multi:2', value: { value: 2 } }]);
    unsubscribe1();
    unsubscribe2();
  });

  test('should unsubscribe from events', async () => {
    const updates = [];
    const unsubscribe = eventbase1.subscribe('unsub:*', (key, data) => {
      updates.push({ key, value: data });
    });
    await eventbase1.put('unsub:1', { value: 1 });
    unsubscribe();
    await eventbase1.put('unsub:2', { value: 2 });
    assert.deepEqual(updates, [{ key: 'unsub:1', value: { value: 1 } }]);
  });

  test('should update metadata correctly', async () => {
    const key = 'metadataTest';
    await eventbase1.put(key, { value: 1 });
    let result = await eventbase1.get(key);
    assert.equal(result.meta.changes, 1);
    assert.equal(result.meta.dateCreated, result.meta.dateModified);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await eventbase1.put(key, { value: 2 });
    result = await eventbase1.get(key);
    assert.equal(result.meta.changes, 2);
    assert.notEqual(result.meta.dateCreated, result.meta.dateModified);
  });
});
