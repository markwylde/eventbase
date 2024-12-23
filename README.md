# Eventbase

A distributed, event-sourced, key-value database built on top of **NATS JetStream**. Eventbase provides a simple yet powerful API for storing, retrieving, and subscribing to data changes, with automatic state synchronization across distributed instances and built-in stats tracking.

## Features

- **Event Sourcing**: All changes are captured as events, enabling a complete history of data modifications.
- **Distributed Synchronization**: Instances automatically synchronize state via NATS JetStream.
- **Real-time Subscriptions**: Subscribe to data changes with pattern matching support.
- **Metadata Tracking**: Automatic tracking of creation date, modification date, and change count for each key.
- **Persistent Storage**: Supports persistent storage with configurable data paths.
- **Pattern-based Key Filtering**: Retrieve keys based on patterns using regex.
- **Special Character Support**: Keys can contain special characters; they are base64-encoded when used in NATS subjects.
- **Multi-instance Management**: Efficiently manage multiple Eventbase instances with automatic cleanup of inactive streams.
- **Resilience**: Automatically resumes from stored data after restarts or failures.
- **Stats Integration**: Built-in stats publishing for all major operations.
- **Improved Error Handling**: Enhanced error handling throughout the codebase.
- **Concurrent Operations**: Better handling of concurrent operations.
- **Customizable Stats Stream Names**: Ability to customize stats stream names for each Eventbase Manager instance.

## Table of Contents

- [Installation](#installation)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Usage](#usage)
  - [Storing Data](#storing-data)
  - [Retrieving Data](#retrieving-data)
  - [Deleting Data](#deleting-data)
  - [Listing Keys](#listing-keys)
  - [Querying Data](#querying-data)
  - [Subscribing to Changes](#subscribing-to-changes)
  - [Closing the Connection](#closing-the-connection)
- [Eventbase Manager](#eventbase-manager)
  - [Event Emission](#event-emission)
- [API](#api)
  - [Eventbase](#eventbase)
  - [EventbaseManager](#eventbasemanager)
- [Examples](#examples)
  - [Listening to Stream Events](#listening-to-stream-events)
  - [Advanced Subscription](#advanced-subscription)
  - [Using with Multiple Streams](#using-with-multiple-streams)
  - [Using Stats Integration](#using-stats-integration)
- [Development](#development)
- [Stats Integration](#stats-integration)
- [Error Handling](#error-handling)
- [Concurrent Operations](#concurrent-operations)

## Installation

```bash
npm install @markwylde/eventbase
```

## Prerequisites

- **NATS Server** with JetStream enabled.
- **Node.js 20** or higher.

## Quick Start

```javascript
import createEventbase from '@markwylde/eventbase';

// Initialize Eventbase
const eventbase = await createEventbase({
  streamName: 'myapp',
  statsStreamName: 'myapp_stats',
  nats: {
    servers: ['localhost:4222'],
  },
  dbPath: './data',
  onMessage: (event) => {
    console.log('Event received:', event);
  },
});

// Store data with auto-generated ID
const { id, data } = await eventbase.insert({ name: 'John Doe' });

// Store data with custom ID
await eventbase.put('user123', { name: 'John Doe' });

// Retrieve data with metadata
const result = await eventbase.get('user123');
console.log(result);
// Output:
// {
//   data: { name: 'John Doe' },
//   meta: {
//     dateCreated: '2023-...',
//     dateModified: '2023-...',
//     changes: 1,
//   },
// }

// Subscribe to changes using query object
const unsubscribe = eventbase.subscribe(
  { name: { $eq: 'John Doe' } },
  (key, data, meta, event) => {
    console.log('Data changed:', { key, data, meta, event });
  }
);

// Clean up when done
await eventbase.delete('user123');
unsubscribe();
await eventbase.close();
```

## Usage

### Storing Data

```javascript
// With auto-generated ID
const { id, data } = await eventbase.insert({ name: 'John Doe', email: 'john@example.com' });

// With custom ID
await eventbase.put('user123', { name: 'John Doe', email: 'john@example.com' });
```

- **Key**: A string identifier for your data. Supports special characters.
- **Data**: Any JSON-serializable object.

### Retrieving Data

```javascript
const result = await eventbase.get('user123');
if (result) {
  const { data, meta } = result;
  console.log('Data:', data);
  console.log('Metadata:', meta);
} else {
  console.log('Key not found');
}
```

- Retrieves data and metadata for a given key.
- Returns `null` if the key does not exist.

### Deleting Data

```javascript
await eventbase.delete('user123');
```

- Removes the data associated with the given key.

### Listing Keys

```javascript
const keys = await eventbase.keys('user*'); // Supports regex patterns
console.log('Keys:', keys);
```

- Retrieves a list of keys matching the provided pattern.

### Querying Data

```javascript
// Query is now generic typed
interface User {
  firstName: string;
  age: number;
}

const queryObject = { firstName: { $eq: 'Joe' }, age: { $gt: 21 } };
const result = await eventbase.query<User>(queryObject);
console.log('Query Result:', result);
```

- Queries the database using a complex query object.
- Supports various operators like `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$exists`, and `$not`.

### Subscribing to Changes

```javascript
// Subscribe using query objects
const unsubscribe = eventbase.subscribe(
  {
    type: 'user',
    age: { $gte: 18 }
  },
  (key, data, meta, event) => {
    console.log('Change detected:', { key, data, meta, event });
  }
);

// Available query operators:
// $lt, $lte, $gt, $gte - Compare numbers
// $eq, $ne - Compare any value
// $in, $nin - Check if value is in array
// $regex - Match string against regular expression

// Examples:
eventbase.subscribe({ age: { $lt: 18 } }, callback); // age less than 18
eventbase.subscribe({ status: { $in: ['active', 'pending'] } }, callback); // status is active or pending
eventbase.subscribe({ name: { $regex: '^John' } }, callback); // name starts with John

// To unsubscribe
unsubscribe();
```

### Closing the Connection

```javascript
await eventbase.close();
```

- Closes the Eventbase instance and cleans up resources.

## Eventbase Manager

The `createEventbaseManager` function provides an efficient way to manage multiple Eventbase instances. It handles the creation, retrieval, and automatic cleanup of instances based on inactivity. Additionally, it emits events when streams are opened and closed.

```javascript
import { createEventbaseManager } from '@markwylde/eventbase';

const manager = createEventbaseManager({
  dbPath: './data',
  nats: {
    servers: ['localhost:4222'],
  },
  keepAliveSeconds: 3600, // Keep streams alive for 1 hour of inactivity
  getStatsStreamName: (streamName) => `${streamName}_stats`, // Custom stats stream name generator
});

// Listen to stream events
manager.on('stream:opened', (streamName) => {
  console.log(`Stream opened: ${streamName}`);
});

manager.on('stream:closed', (streamName) => {
  console.log(`Stream closed: ${streamName}`);
});

const eventbase = await manager.getStream('streamName');

// Use the eventbase instance
await eventbase.put('key', { data: 'value' });

// Close all instances when done
await manager.closeAll();
```

### Event Emission

- **`stream:opened`**: Emitted when a new stream is opened.
- **`stream:closed`**: Emitted when a stream is closed due to inactivity or when `closeAll` is called.

**Example:**

```javascript
manager.on('stream:opened', (streamName) => {
  console.log(`Stream opened: ${streamName}`);
});

manager.on('stream:closed', (streamName) => {
  console.log(`Stream closed: ${streamName}`);
});
```

## API

### Eventbase

#### `createEventbase(config)`

Creates a new Eventbase instance.

##### Config Options:

- **`streamName`**: *(string, required)* Name of the NATS JetStream.
- **`statsStreamName`**: *(string, optional)* Name of the NATS JetStream for publishing stats events.
- **`nats`**: *(ConnectionOptions, required)* NATS connection options.
- **`dbPath`**: *(string, optional)* Path for persistent storage. Defaults to a temporary directory.
- **`onMessage`**: *(function, optional)* Callback for every event received.

##### Example:

```javascript
const eventbase = await createEventbase({
  streamName: 'myapp',
  statsStreamName: 'myapp_stats',
  nats: {
    servers: ['localhost:4222'],
  },
  dbPath: './data',
  onMessage: (event) => {
    console.log('Event received:', event);
  },
});
```

#### Methods

##### `insert(data: object): Promise<{ id: string; data: object }>`

Stores data with an auto-generated ID.

##### `put(key: string, data: object): Promise<{ meta: MetaData; data: T }>`

Stores data under the specified key.

##### `get<T>(key: string): Promise<{ meta: MetaData; data: T } | null>`

Retrieves data and metadata for the specified key.

##### `delete(key: string): Promise<{ purged: number }>`

Deletes the data associated with the specified key.

##### `keys(pattern: string): Promise<string[]>`

Returns a list of keys matching the provided pattern (supports regex).

##### `query<T>(queryObject: object): Promise<T[]>`

Queries the database using a complex query object.

- **`queryObject`**: An object containing fields and operators to filter the records.

##### `subscribe<T>(queryObject: object, callback: SubscriptionCallback<T>): () => void`

Subscribes to changes on keys matching the query object. Returns an `unsubscribe` function.

- **`queryObject`**: An object containing fields and operators to filter the records.
- **`callback`**: Function called with `(key, data, meta, event)` whenever a matching key changes.

##### `close(): Promise<void>`

Closes the Eventbase instance and cleans up resources.

### EventbaseManager

#### `createEventbaseManager(config)`

Creates a new `EventbaseManager` instance to manage multiple Eventbase instances.

##### Config Options:

- **`dbPath`**: *(string, optional)* Base path for persistent storage.
- **`nats`**: *(ConnectionOptions, required)* NATS connection options.
- **`keepAliveSeconds`**: *(number, optional)* Time in seconds to keep inactive streams alive. Default is `3600` (1 hour).
- **`onMessage`**: *(function, optional)* Global event handler for all streams.
- **`cleanupIntervalMs`**: *(number, optional)* Interval in milliseconds for cleaning up inactive streams. Default is `60000` (60 seconds).
- **`getStatsStreamName`**: *(function, optional)* A function that takes a stream name and returns the corresponding stats stream name. If not provided, stats stream names will not be set.

##### Example:

```javascript
const manager = createEventbaseManager({
  dbPath: './data',
  nats: {
    servers: ['localhost:4222'],
  },
  keepAliveSeconds: 3600, // 1 hour
  getStatsStreamName: (streamName) => `${streamName}_stats`,
});
```

#### Methods

##### `getStream(streamName: string): Promise<EventbaseInstance>`

Gets or creates an Eventbase instance for the given stream name.

- **Emits**: `stream:opened` if a new stream is created.

##### `closeAll(): Promise<void>`

Closes all managed Eventbase instances and stops the cleanup interval.

- **Emits**: `stream:closed` for each stream that is closed.

#### Event Emission

The `EventbaseManager` is an `EventEmitter` that emits the following events:

- **`stream:opened`**: Emitted when a new stream is opened.

  **Listener Signature**:

  ```typescript
  (streamName: string) => void
  ```

- **`stream:closed`**: Emitted when a stream is closed due to inactivity or when `closeAll` is called.

  **Listener Signature**:

  ```typescript
  (streamName: string) => void
  ```

**Example:**

```javascript
manager.on('stream:opened', (streamName) => {
  console.log(`Stream opened: ${streamName}`);
});

manager.on('stream:closed', (streamName) => {
  console.log(`Stream closed: ${streamName}`);
});
```

## Examples

### Listening to Stream Events

Using the `EventbaseManager` to listen to stream events:

```javascript
import { createEventbaseManager } from '@markwylde/eventbase';

const manager = createEventbaseManager({
  nats: {
    servers: ['localhost:4222'],
  },
});

// Listen for when streams are opened
manager.on('stream:opened', (streamName) => {
  console.log(`Stream opened: ${streamName}`);
});

// Listen for when streams are closed
manager.on('stream:closed', (streamName) => {
  console.log(`Stream closed: ${streamName}`);
});

// Get streams as needed
const ordersBase = await manager.getStream('orders');
const usersBase = await manager.getStream('users');

// Use the streams
await ordersBase.put('order123', { item: 'Laptop', quantity: 1 });
await usersBase.put('user123', { name: 'Alice' });

// Close all streams when done
await manager.closeAll();
```

### Advanced Subscription

Subscribe to changes on keys that match a complex pattern:

```javascript
// Subscribe using query objects
const unsubscribe = eventbase.subscribe(
  {
    type: 'user',
    age: { $gte: 18 }
  },
  (key, data, meta, event) => {
    console.log('Change detected:', { key, data, meta, event });
  }
);

// Available query operators:
// $lt, $lte, $gt, $gte - Compare numbers
// $eq, $ne - Compare any value
// $in, $nin - Check if value is in array
// $regex - Match string against regular expression

// Examples:
eventbase.subscribe({ age: { $lt: 18 } }, callback); // age less than 18
eventbase.subscribe({ status: { $in: ['active', 'pending'] } }, callback); // status is active or pending
eventbase.subscribe({ name: { $regex: '^John' } }, callback); // name starts with John

// To unsubscribe
unsubscribe();
```

### Using with Multiple Streams

Using the `EventbaseManager` to handle multiple streams:

```javascript
const manager = createEventbaseManager({
  nats: {
    servers: ['localhost:4222'],
  },
});

manager.on('stream:opened', (streamName) => {
  console.log(`Stream opened: ${streamName}`);
});

manager.on('stream:closed', (streamName) => {
  console.log(`Stream closed: ${streamName}`);
});

const ordersBase = await manager.getStream('orders');
const usersBase = await manager.getStream('users');

// Work with the 'orders' stream
await ordersBase.put('order123', { item: 'Laptop', quantity: 1 });

// Work with the 'users' stream
await usersBase.put('user123', { name: 'Alice' });

// Close all streams when done
await manager.closeAll();
```

### Using Stats Integration

Here's an example of how to set up Eventbase with stats integration and stream the stats:

```javascript
import createEventbase from '@markwylde/eventbase';
import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';

// Set up Eventbase with stats
const eventbase = await createEventbase({
  streamName: 'myEventStream',
  statsStreamName: 'myStatsStream',
  nats: {
    servers: ['nats://localhost:4222'],
  },
  dbPath: './myEventbaseDb'
});

// Connect to NATS for streaming stats
const nc = await connect({ servers: ['nats://localhost:4222'] });
const js = jetstream(nc);

// Subscribe to the stats stream
const sub = js.subscribe('myStatsStream.stats');

(async () => {
  for await (const msg of sub) {
    const statsEvent = JSON.parse(msg.string());
    console.log('Received stats event:', statsEvent);
    msg.ack();
  }
})().catch(err => console.error('Error in stats subscription:', err));

// Perform some operations to generate stats
await eventbase.put('user:1', { name: 'Alice', age: 30 });
const user1 = await eventbase.get('user:1');
await eventbase.delete('user:1');

// Clean up
await eventbase.close();
await nc.close();
```

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/markwylde/eventbase.git
cd eventbase
npm install
```

Start NATS server using Docker Compose:

```bash
docker compose up -d
```

Run tests:

```bash
npm test
```
