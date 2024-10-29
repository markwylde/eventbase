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
  servers: ["localhost:4442", "localhost:4443"]
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

#### `put(id: string, data: any)`
Stores data with the given ID.

#### `get(id: string)`
Retrieves data for the given ID. Returns null if not found.

#### `delete(id: string)`
Deletes data with the given ID.

#### `close()`
Closes all connections and cleans up resources.

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
