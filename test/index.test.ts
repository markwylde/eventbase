// test/index.test.js
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import createEventbase from '../src/index.js';

describe('Eventbase', async () => {
  let eventbase1;
  let eventbase2;

  beforeEach(async () => {
    const streamName = `test-${Date.now()}`;
    [eventbase1, eventbase2] = await Promise.all([
      createEventbase({
        servers: ['localhost:4222'],
        streamName,
      }),
      createEventbase({
        servers: ['localhost:4222'],
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

  test('should store and retrieve data', async () => {
    const testData = { name: 'John Doe', age: 30 };
    await eventbase1.put('user1', testData);
    const result = await eventbase1.get('user1');
    assert.deepEqual(result, testData);
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
    // Add delay helper
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Store data in first instance
    const testData = { name: 'John Doe', age: 30 };
    await eventbase1.put('user3', testData);

    // Wait for sync
    await delay(1000);

    // Verify data in second instance
    const result = await eventbase2.get('user3');
    assert.deepEqual(result, testData);
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
      assert.deepEqual(result, { value: i });
    }
  });

  test('should handle updates to existing keys', async () => {
    const key = 'updateTest';
    await eventbase1.put(key, { version: 1 });
    await eventbase1.put(key, { version: 2 });
    const result = await eventbase1.get(key);
    assert.deepEqual(result, { version: 2 });
  });

  test('should handle large data', async () => {
    const largeData = {
      array: Array(1000).fill().map((_, i) => ({ id: i, data: 'test'.repeat(100) }))
    };
    await eventbase1.put('largeKey', largeData);
    const result = await eventbase1.get('largeKey');
    assert.deepEqual(result, largeData);
  });

  test('should handle special characters in keys', async () => {
    const specialKey = '!@#$%^&*()_+';
    const testData = { test: true };
    await eventbase1.put(specialKey, testData);
    const result = await eventbase1.get(specialKey);
    assert.deepEqual(result, testData);
  });
});