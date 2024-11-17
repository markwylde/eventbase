import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import createEventbase from '../src/index.js';

describe('Eventbase', async () => {
  let eventbase1;
  let eventbase2;

  beforeEach(async () => {
    const streamName = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    [eventbase1, eventbase2] = await Promise.all([
      createEventbase({
        nats: {
          servers: ['localhost:4222'],
        },
        streamName,
      }),
      createEventbase({
        nats: {
          servers: ['localhost:4222'],
        },
        streamName,
      })
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      eventbase1.close(),
      eventbase2.close()
    ]);
  });

  test('should store and retrieve data with metadata', async () => {
    const testData = { name: 'John Doe', age: 30 };
    await eventbase1.put('user1', testData);
    const result = await eventbase1.get('user1');
    assert.deepEqual(result.data, testData);
    assert.equal(typeof result.meta.dateCreated, 'string');
    assert.equal(typeof result.meta.dateModified, 'string');
    assert.equal(result.meta.changes, 1);
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

  test('should sync data between instances', async (t) => {
    // Store data in first instance
    const testData = { name: 'John Doe', age: 30 };
    await eventbase1.put('user3', testData);

    // Verify data in second instance
    const result = await eventbase2.get('user3');
    assert.deepEqual(result.data, testData);
  });

  test('should handle concurrent operations', async () => {
    const operations = [];
    for (let i = 0; i < 10; i++) {
      operations.push(
        eventbase1.put(`key${i}`, { value: i })
      );
    }
    await Promise.all(operations);
    // Verify all operations succeeded
    for (let i = 0; i < 10; i++) {
      const result = await eventbase1.get(`key${i}`);
      assert.deepEqual(result.data, { value: i });
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
      array: Array(1000).fill('').map((_, i) => ({ id: i, data: 'test'.repeat(100) }))
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
    const unsubscribe = eventbase1.subscribe('test:*', (key, value) => {
      updates.push({ key, value: value.data });
    });
    await eventbase1.put('test:1', { value: 1 });
    await eventbase1.put('test:2', { value: 2 });
    assert.deepEqual(updates, [
      { key: 'test:1', value: { value: 1 } },
      { key: 'test:2', value: { value: 2 } }
    ]);
    unsubscribe();
  });

  test('should handle multiple subscriptions', async () => {
    const updates1 = [];
    const updates2 = [];
    const unsubscribe1 = eventbase1.subscribe('multi:1', (key, value) => {
      updates1.push({ key, value: value.data });
    });
    const unsubscribe2 = eventbase1.subscribe('multi:2', (key, value) => {
      updates2.push({ key, value: value.data });
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
    const unsubscribe = eventbase1.subscribe('unsub:*', (key, value) => {
      updates.push({ key, value: value.data });
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

    await new Promise(resolve => setTimeout(resolve, 10));
    await eventbase1.put(key, { value: 2 });
    result = await eventbase1.get(key);
    assert.equal(result.meta.changes, 2);
    assert.notEqual(result.meta.dateCreated, result.meta.dateModified);
  });
});
