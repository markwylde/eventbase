# Eventbase
A distributed event-sourced database built on NATS JetStream.

## Features
- Event sourcing with automatic metadata tracking
- Distributed state synchronization across instances
- Real-time data subscriptions with pattern matching
- Simple key-value storage API
- Automatic metadata tracking (creation date, modification date, change count)
- Support for large datasets
- Pattern-based key filtering
- Special character support in keys

## Installation
```bash
npm install @markwylde/eventbase
```

## Prerequisites
- NATS Server with JetStream enabled
- Node.js 20 or higher

## Quick Start
```javascript
import createEventbase from '@markwylde/eventbase';

// Initialize eventbase
const eventbase = await createEventbase({
  nats: {
    servers: ['localhost:4222']
  },
  streamName: 'myapp'
});

// Store data
await eventbase.put('user123', { name: 'John Doe' });

// Retrieve data with metadata
const result = await eventbase.get('user123');
console.log(result);
// {
//   data: { name: 'John Doe' },
//   meta: {
//     dateCreated: '2023-...',
//     dateModified: '2023-...',
//     changes: 1
//   }
// }

// Subscribe to changes
const unsubscribe = eventbase.subscribe('user:*', (key, data, meta, event) => {
  console.log('Update:', { key, data, meta, event });
});

// Clean up
await eventbase.delete('user123');
unsubscribe();
await eventbase.close();
```

## API

### `createEventbase(config)`
Creates a new Eventbase instance.

#### Config Options:
```javascript
{
  nats: {
    servers: ['localhost:4222'] // NATS server addresses
  },
  streamName: 'myapp' // Name of the NATS stream
}
```

### Methods

#### `put(key: string, data: any): Promise<void>`
Stores data with the given key.

#### `get(key: string): Promise<null | { data: any, meta: Metadata }>`
Retrieves data and metadata for the given key. Returns null if not found.
```javascript
type Metadata = {
  dateCreated: string;
  dateModified: string;
  changes: number;
}
```

#### `delete(key: string): Promise<void>`
Deletes data with the given key.

#### `keys(pattern: string): Promise<string[]>`
Returns an array of keys matching the given pattern.
```javascript
const keys = await eventbase.keys('user:*');
```

#### `subscribe(pattern: string, callback: Function): Function`
Subscribes to updates matching the pattern. Returns an unsubscribe function.
```javascript
const unsubscribe = eventbase.subscribe('user:*', (key, data, meta, event) => {
  console.log('Update:', { key, data, meta, event });
});
```
Callback receives:
- `key`: The updated key
- `data`: The current data
- `meta`: Metadata object
- `event`: Event details including type and timestamp

#### `close(): Promise<void>`
Closes the connection and cleans up resources.

## Features in Detail

### Metadata Tracking
Every stored item includes metadata:
- `dateCreated`: When the item was first created
- `dateModified`: When the item was last modified
- `changes`: Number of updates to the item

### Pattern Matching
Supports glob-style patterns for both keys() and subscribe():
```javascript
'user:*'      // Matches all user keys
'order:2023:*' // Matches all 2023 orders
```

### Distributed Synchronization
Multiple instances automatically sync data through NATS JetStream.

## Development
```bash
# Start NATS
docker compose up -d

# Install dependencies
npm install

# Run tests
npm test
```
