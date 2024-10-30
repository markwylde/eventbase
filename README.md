# Eventbase

A distributed event-sourced database built on NATS JetStream and LevelDB.

## Features
- Event sourcing architecture
- Distributed state management
- Real-time data synchronization
- Simple key-value storage API
- Automatic event replay and state reconstruction

## Installation

```bash
npm install @markwylde/eventbase
```

## Prerequisites

- NATS Server with JetStream enabled running on your network
- Node.js 20 or higher

## Quick Start

```typescript
import createEventbase from '@markwylde/eventbase';

// Initialize eventbase
const eventbase = await createEventbase({
  streamName: 'mytodoapp',
  nats: {
    servers: ["localhost:4442", "localhost:4443"]
  }
});

// Store data
await eventbase.put('user123', { name: 'John Doe' });

// Retrieve data
const user = await eventbase.get('user123');
console.log(user); // { name: 'John Doe' }

// Delete data
await eventbase.delete('user123');

// Close connection
await eventbase.close();
```

## API

### `createEventbase(config)`

Creates a new Eventbase instance.

#### Config Options:
- `streamName`: Name of the NATS stream to use
- `servers`: Array of NATS server addresses

### Methods

### `subscribe(filter: string, callback: function)`
Returns an array of keys that match the given filter.

```js
const unsubscribe = eventbase.subscribe('user:*', (key, data) => {
  console.log(`User ${key} updated:`, data);
});
unsubscribe();
```

### `keys(filter: string)`
Returns an array of keys that match the given filter.

```js
await eventbase.put('user456', { name: 'Jane Smith' });
```

#### `put(id: string, data: any)`
Stores data with the given ID.

```js
await eventbase.put('user123', { name: 'John Doe' });
```

#### `get(id: string)`
Retrieves data for the given ID. Returns null if not found.

```js
const user = await eventbase.get('user123');
console.log(user); // { name: 'John Doe' }
```

#### `delete(id: string)`
Deletes data with the given ID.

```js
await eventbase.delete('user123');
```

#### `close()`
Closes all connections and cleans up resources.

```js
await eventbase.close();
```

## Storage

Data is stored in both:
- LevelDB (local state)
- NATS JetStream (distributed event log)

The local state is automatically rebuilt from the event log on startup.

## Development

```bash
# Start a local nats cluster
docker compose up -d

# Install dependencies
npm install

# Run the demo
npm start

# Run with auto-reload
npm run dev
```
