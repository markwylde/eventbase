import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEventbaseManager } from '../src/manager.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('EventbaseManager', () => {
  let manager;
  let dbPath;

  beforeEach(() => {
    dbPath = mkdtempSync(join(tmpdir(), 'eventbase-test-'));
    manager = createEventbaseManager({
      dbPath,
      nats: {
        servers: ['localhost:4222'],
        user: 'a',
        pass: 'a',
      },
      keepAliveSeconds: 60,
      cleanupIntervalMs: 60000,
    });
  });

  afterEach(async () => {
    await manager.closeAll();
    rmSync(dbPath, { recursive: true, force: true });
  });

  test('should create and retrieve streams', async () => {
    const streamName = `testStream-${Date.now()}`;
    const eventbase1 = await manager.getStream(streamName);
    assert.ok(eventbase1);

    const eventbase2 = await manager.getStream(streamName);
    assert.strictEqual(eventbase1, eventbase2);
  });

  test('should manage multiple streams independently', async () => {
    const streamName1 = `stream1-${Date.now()}`;
    const streamName2 = `stream2-${Date.now()}`;
    const eventbase1 = await manager.getStream(streamName1);
    const eventbase2 = await manager.getStream(streamName2);

    assert.notStrictEqual(eventbase1, eventbase2);

    await eventbase1.put('key1', { data: 'value1' });
    const result1 = await eventbase1.get('key1');
    assert.deepEqual(result1.data, { id: 'key1', data: 'value1' });

    const result2 = await eventbase2.get('key1');
    assert.strictEqual(result2, null);
  });

  test('should automatically close streams after keepAliveSeconds', async () => {
    const shortManager = createEventbaseManager({
      dbPath,
      nats: {
        servers: ['localhost:4222'],
        user: 'a',
        pass: 'a',
      },
      keepAliveSeconds: 1,
      cleanupIntervalMs: 500,
    });

    try {
      const streamName = `autoCloseStream-${Date.now()}`;
      const eventbase = await shortManager.getStream(streamName);
      await eventbase.put('key', { data: 'value' });

      // Wait for longer than keepAliveSeconds
      await new Promise(resolve => setTimeout(resolve, 2000));

      const newEventbase = await shortManager.getStream(streamName);
      assert.notStrictEqual(eventbase, newEventbase);

      const result = await newEventbase.get('key');
      assert.deepEqual(result.data, { id: 'key', data: 'value' });
    } finally {
      await shortManager.closeAll();
    }
  });

  test('should close all instances when closeAll is called', async () => {
    const streamName = `streamToClose-${Date.now()}`;
    const eventbase = await manager.getStream(streamName);
    assert.ok(eventbase);

    await manager.closeAll();

    const newEventbase = await manager.getStream(streamName);
    assert.notStrictEqual(eventbase, newEventbase);
  });

  test('should pass onMessage to Eventbase instances', async () => {
    let messageReceived = false;
    const messageManager = createEventbaseManager({
      dbPath,
      nats: {
        servers: ['localhost:4222'],
        user: 'a',
        pass: 'a'
      },
      onMessage: (event) => {
        messageReceived = true;
        assert.ok(event);
      },
      keepAliveSeconds: 60,
      cleanupIntervalMs: 60000,
    });

    try {
      const streamName = `onMessageStream-${Date.now()}`;
      const eventbase = await messageManager.getStream(streamName);
      await eventbase.put('key', { data: 'value' });

      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(messageReceived);
    } finally {
      await messageManager.closeAll();
    }
  });
});
