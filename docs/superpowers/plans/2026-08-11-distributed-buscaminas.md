# Buscaminas Tripartito distribuido Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ejecutar el Buscaminas como tres nodos Socket.IO coordinados por Redis, con liderazgo recuperable, consistencia secuencial por sala y un dashboard visible.

**Architecture:** Cada nodo publica heartbeat y participa en una elección Bully simplificada; Redis conserva el lease de líder, el estado de las salas, locks y comandos idempotentes. El líder procesa las mutaciones bajo lock, asigna reloj Lamport y versión de estado; los demás nodos difunden el estado mediante el adaptador Redis de Socket.IO.

**Tech Stack:** Node.js 22.12+, Express 5, Socket.IO 4, `ioredis`, `@socket.io/redis-adapter`, React 19, Vite 8, `qrcode.react`, Cypress 15, `node:test`, c8 y Redis 8 local.

## Global Constraints

- Redis local debe responder `PONG` en `REDIS_URL` antes de iniciar el clúster.
- Los nodos usan IDs numéricos `1`, `2` y `3`; el ID vivo mayor es el líder esperado.
- Los heartbeats y leases usan TTL de 6 s y se renuevan cada 2 s.
- Las acciones mutantes contienen `commandId`, `clientId` y `lamportClock`.
- La consistencia es secuencial por sala, no una transacción global entre salas.
- Nunca documentar tolerancia a caída de Redis ni Sentinel mientras solo exista una instancia Redis.
- Todo cambio de comportamiento se desarrolla con una prueba roja antes de la implementación.

---

### Task 1: Configuración Redis y coordinador de clúster

**Files:**
- Create: `server/config.js`
- Create: `server/services/cluster-coordinator.js`
- Create: `server/services/redis-client.js`
- Create: `server/test/cluster-coordinator.test.js`
- Modify: `server/package.json`
- Modify: `package.json`
- Modify: `server/server.js`

**Interfaces:**
- Produces `loadConfig(env)` → `{ nodeId, port, publicUrl, redisUrl, keyPrefix }`.
- Produces `createClusterCoordinator({ redis, nodeId, publicUrl, clock })` with `start()`, `stop()`, `isLeader()`, `getLeader()` and `getNodes()`.
- `getLeader()` returns `{ nodeId: number, publicUrl: string, expiresAt: number } | null`.

- [ ] **Step 1: Write the failing coordinator tests**

```js
test('elige el nodo vivo de ID mayor y reemplaza al líder expirado', async (t) => {
  const first = createClusterCoordinator({ redis, nodeId: 1, publicUrl: 'http://node-1', clock })
  const third = createClusterCoordinator({ redis, nodeId: 3, publicUrl: 'http://node-3', clock })
  t.after(async () => Promise.all([first.stop(), third.stop()]))

  await first.start()
  await third.start()

  assert.equal(first.isLeader(), false)
  assert.deepEqual(await first.getLeader(), {
    nodeId: 3,
    publicUrl: 'http://node-3',
    expiresAt: clock.now() + 6000,
  })

  await third.stop()
  await clock.advance(6001)
  await first.tick()
  assert.equal(first.isLeader(), true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `redis-cli ping && node --test server/test/cluster-coordinator.test.js`

Expected: failure because `cluster-coordinator.js` does not exist.

- [ ] **Step 3: Add dependencies and configuration**

Add `ioredis` and `@socket.io/redis-adapter` to `server.dependencies`. Create `loadConfig` with exact defaults:

```js
function loadConfig(env = process.env) {
  return {
    nodeId: Number(env.NODE_ID || 1),
    port: Number(env.PORT || 3000),
    publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`,
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    keyPrefix: env.REDIS_KEY_PREFIX || 'buscaminas:',
  }
}
```

`redis-client.js` creates command and subscriber clients with `keyPrefix`; the coordinator writes `cluster:heartbeat:<nodeId>`, calculates the highest live ID, and acquires or renews `cluster:leader` using compare-and-set Lua scripts.

- [ ] **Step 4: Run coordinator tests**

Run: `node --test server/test/cluster-coordinator.test.js`

Expected: PASS; a stopped ID 3 is replaced by ID 1 after expiry.

- [ ] **Step 5: Add runnable node scripts and commit**

Add root scripts `redis:check`, `start:node:1`, `start:node:2`, `start:node:3` and `start:cluster`; each node gets a distinct port `3001`, `3002`, `3003` and `PUBLIC_URL` matching it. Update `server/server.js` to load config and await coordinator startup before `listen`.

```bash
git add package.json package-lock.json server/package.json server/package-lock.json server/config.js server/services server/server.js server/test/cluster-coordinator.test.js
git commit -m "feat: add Redis cluster leadership"
```

### Task 2: Repositorio Redis, locks e idempotencia

**Files:**
- Create: `server/repositories/redis-room-repository.js`
- Create: `server/test/redis-room-repository.test.js`
- Modify: `server/services/redis-client.js`

**Interfaces:**
- Produces `createRedisRoomRepository({ redis, keyPrefix, now, randomId })`.
- `getRoom(roomCode)`, `saveRoom(room)`, `withRoomLock(roomCode, fn)`, `getCommand(roomCode, commandId)` and `saveCommand(roomCode, commandId, result)`.
- `withRoomLock` rejects with `{ code: 'LOCK_UNAVAILABLE' }` after three retries of 100 ms.

- [ ] **Step 1: Write failing lock and idempotency tests**

```js
test('serializa dos transiciones concurrentes de una sala', async () => {
  await repository.saveRoom({ roomCode: 'LOCK01', stateVersion: 0, players: [] })
  const order = []
  await Promise.all([
    repository.withRoomLock('LOCK01', async () => order.push('first')),
    repository.withRoomLock('LOCK01', async () => order.push('second')),
  ])
  assert.deepEqual(order.sort(), ['first', 'second'])
})

test('recupera el resultado de un commandId ya procesado', async () => {
  await repository.saveCommand('LOCK01', 'cmd-1', { success: true, score: 1 })
  assert.deepEqual(await repository.getCommand('LOCK01', 'cmd-1'), { success: true, score: 1 })
})
```

- [ ] **Step 2: Run to confirm red**

Run: `node --test server/test/redis-room-repository.test.js`

Expected: failure because the repository module is missing.

- [ ] **Step 3: Implement atomic Redis repository**

Store room JSON under `room:<roomCode>`, command responses under
`room:<roomCode>:command:<commandId>` with one-hour TTL, and locks under
`lock:room:<roomCode>`. Release locks only through Lua when the token equals
the holder token:

```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
```

- [ ] **Step 4: Run repository tests and commit**

Run: `node --test server/test/redis-room-repository.test.js`

Expected: PASS.

```bash
git add server/repositories/redis-room-repository.js server/test/redis-room-repository.test.js server/services/redis-client.js
git commit -m "feat: persist rooms with Redis locks"
```

### Task 3: Servicio de comandos consistente y servidor Socket.IO distribuido

**Files:**
- Create: `server/services/game-command-service.js`
- Create: `server/services/socket-handlers.js`
- Create: `server/test/game-command-service.test.js`
- Modify: `server/app.js`
- Modify: `server/test/game-server.test.js`

**Interfaces:**
- `createGameCommandService({ repository, coordinator, now })` exposes `createRoom`, `joinRoom`, `startGame`, `revealCell`, `restartGame`, `leaveRoom` and `heartbeatPlayer`.
- Mutation result is `{ success, commandId, lamportClock, stateVersion, message?, leader? }`.
- `createGameServer({ config, redis, coordinator })` attaches the Redis Socket.IO adapter and returns the existing `listen()`/`close()` API.

- [ ] **Step 1: Add failing tests for concurrency and duplicate commands**

```js
test('aplica solo una revelación concurrente y conserva la versión secuencial', async () => {
  const [first, second] = await Promise.all([
    game.revealCell({ roomCode, playerId, cellIndex: 0, commandId: 'a', clientId: 'one', lamportClock: 4 }),
    game.revealCell({ roomCode, playerId, cellIndex: 0, commandId: 'b', clientId: 'two', lamportClock: 4 }),
  ])
  assert.equal([first.success, second.success].filter(Boolean).length, 1)
  assert.equal((await repository.getRoom(roomCode)).stateVersion, 2)
})

test('un commandId repetido devuelve el resultado original sin cambiar puntaje', async () => {
  const original = await game.revealCell({ roomCode, playerId, cellIndex: 1, commandId: 'same', clientId: 'one', lamportClock: 7 })
  const retried = await game.revealCell({ roomCode, playerId, cellIndex: 1, commandId: 'same', clientId: 'one', lamportClock: 7 })
  assert.deepEqual(retried, original)
})
```

- [ ] **Step 2: Run the service test while red**

Run: `node --test server/test/game-command-service.test.js`

Expected: failure because `game-command-service.js` is absent.

- [ ] **Step 3: Extract game rules into service and attach distributed events**

Move pure board creation/public-state helpers from `server/app.js` into the
command service. On every mutation, require the leader; non-leaders return:

```js
{ success: false, code: 'LEADER_REDIRECT', leader: await coordinator.getLeader() }
```

Inside `withRoomLock`, update Lamport with `Math.max(room.lamportClock,
command.lamportClock) + 1`, increment `stateVersion`, persist, save the command
result and emit `room-updated`. Configure `@socket.io/redis-adapter` with the
publisher and duplicate subscriber client. Preserve all existing game rules and
acknowledgement messages.

- [ ] **Step 4: Add an integration test spanning two node instances**

Extend `game-server.test.js` to start nodes 1 and 3 against the same prefixed
Redis test database. Connect player clients to separate ports, create the room
through the leader, then assert both receive identical `stateVersion` and cell
contents.

- [ ] **Step 5: Run service and integration tests, then commit**

Run: `npm run test:server`

Expected: all existing tests plus concurrent, duplicate and two-node cases
PASS.

```bash
git add server/app.js server/services/game-command-service.js server/services/socket-handlers.js server/test/game-command-service.test.js server/test/game-server.test.js
git commit -m "feat: serialize distributed game commands"
```

### Task 4: Heartbeats de jugadores y recuperación del líder

**Files:**
- Modify: `server/services/game-command-service.js`
- Modify: `server/services/socket-handlers.js`
- Modify: `server/test/game-server.test.js`
- Create: `server/test/failover.test.js`

**Interfaces:**
- `heartbeatPlayer({ roomCode, playerId })` renews `player:<roomCode>:<playerId>` for 15 s.
- `ClusterCoordinator` emits `leader-changed` with a `getLeader()` payload.
- `GameCommandService.reconcileExpiredPlayers(roomCode)` marks expired players disconnected and reassigns host.

- [ ] **Step 1: Write failing failover tests**

```js
test('un nodo superviviente toma el liderazgo y conserva la sala tras la caída del líder', async (t) => {
  const cluster = await startNodes([1, 2, 3], { redisUrl, keyPrefix })
  t.after(() => cluster.stopAll())
  const roomCode = await createPlayableRoom(cluster.node(3))

  await cluster.node(3).close()
  await waitFor(() => cluster.node(2).coordinator.isLeader(), 6500)

  const room = await cluster.node(2).repository.getRoom(roomCode)
  assert.equal(room.roomCode, roomCode)
  assert.equal(room.stateVersion > 0, true)
})
```

- [ ] **Step 2: Verify the failure**

Run: `node --test server/test/failover.test.js`

Expected: failure because nodes neither publish leadership changes nor recover rooms.

- [ ] **Step 3: Implement expiry reconciliation**

On coordinator leader transitions, emit `leader-changed` through the adapter and
schedule scanning of rooms with active player heartbeat keys. Keep the room
JSON in Redis; never depend on in-process `Map` state. On Socket.IO disconnect,
mark the player immediately, but retain the player record during a running
game for reconnection.

- [ ] **Step 4: Run failure tests and commit**

Run: `node --test server/test/failover.test.js && npm run test:server`

Expected: node 2 becomes leader in less than 6.5 seconds, and all server tests
PASS.

```bash
git add server/services server/test/failover.test.js server/test/game-server.test.js
git commit -m "feat: recover games after leader failure"
```

### Task 5: Cliente versionado, reconexión al líder, QR y dashboard

**Files:**
- Create: `client/src/cluster.js`
- Create: `client/src/Dashboard.jsx`
- Create: `client/src/Dashboard.css`
- Modify: `client/src/socket.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/App.css`
- Modify: `client/package.json`
- Modify: `cypress/e2e/lobby.cy.js`
- Create: `cypress/e2e/dashboard.cy.js`

**Interfaces:**
- `createCommandMetadata()` returns `{ commandId, clientId, lamportClock }` and increments Lamport on outgoing commands and incoming events.
- `connectToLeader(leader)` reconnects Socket.IO to `leader.publicUrl`.
- `Dashboard` consumes `cluster-status` and displays `data-testid` values for leader, nodes, Lamport clock, room version and events.

- [ ] **Step 1: Write failing Cypress cases**

```js
it('mantiene la versión más reciente ante una actualización atrasada', () => {
  cy.visit('/')
  cy.window().then((win) => {
    win.__testSocket.emit('room-updated', { roomCode: 'ABC123', stateVersion: 4, players: [], status: 'waiting', game: null })
    win.__testSocket.emit('room-updated', { roomCode: 'ABC123', stateVersion: 3, players: [], status: 'waiting', game: null })
  })
  cy.get('[data-testid="room-version"]').should('have.text', '4')
})

it('muestra el líder y tres nodos en el dashboard', () => {
  cy.visit('/dashboard')
  cy.get('[data-testid="cluster-leader"]').should('contain', 'Nodo 3')
  cy.get('[data-testid="cluster-node"]').should('have.length', 3)
})
```

- [ ] **Step 2: Run Cypress to confirm red**

Run: `npm run test:e2e -- --spec cypress/e2e/dashboard.cy.js`

Expected: failure because the dashboard and version selectors do not exist.

- [ ] **Step 3: Implement client protocol and views**

Persist `clientId` in `localStorage`. Send metadata for `create-room`,
`join-room`, `start-game`, `reveal-cell`, `restart-game`, `leave-room` and
player heartbeat. Keep `lastStateVersion` in React state and ignore lower
versions. Handle `LEADER_REDIRECT`/`leader-changed` by reconnecting before
retrying the pending command once. Add `qrcode.react`; render a QR using the
current room URL and a visible dashboard link. Render `Dashboard` when
`window.location.pathname === '/dashboard'`.

- [ ] **Step 4: Execute full browser suite and commit**

Run: `npm test`

Expected: current lobby cases plus dashboard/version cases PASS.

```bash
git add client/src client/package.json client/package-lock.json cypress/e2e
git commit -m "feat: add distributed dashboard and client ordering"
```

### Task 6: Operación local, documentación y Sonar evidence

**Files:**
- Create: `docs/distributed-operation.md`
- Create: `docs/distributed-validation-matrix.md`
- Modify: `README.md`
- Modify: `sonar-project.properties`
- Modify: `docs/sonarqube-evidence.md`

**Interfaces:**
- Operation guide includes `brew services start redis`, `npm run redis:check`, `npm run start:cluster`, and recovery demonstration commands.
- Validation matrix maps every acceptance criterion to an automated test, evidence and expected result.

- [ ] **Step 1: Write the documentation acceptance checklist**

Add explicit entries for WebSockets, three simultaneous clients, Lamport,
distributed lock, state version, heartbeats, leader failover, Redis limitation,
QR/dashboard and the exact test command that validates each one.

- [ ] **Step 2: Run all technical evidence commands**

Run:

```bash
npm run redis:check
npm test
npm run test:coverage
npm run quality:lint
npm run quality:build
```

Expected: Redis prints `PONG`, all tests pass, coverage report exists at
`server/coverage/lcov.info`, lint and build pass.

- [ ] **Step 3: Scan with SonarQube and capture evidence**

Run:

```bash
export SONAR_HOST_URL=http://localhost:9000
read -s SONAR_TOKEN
export SONAR_TOKEN
npm run sonar:scan
```

Expected: scanner reports `EXECUTION SUCCESS`; document actual quality gate,
coverage, issues and timestamp without storing the token.

- [ ] **Step 4: Commit docs and verified configuration**

```bash
git add README.md docs/distributed-operation.md docs/distributed-validation-matrix.md docs/sonarqube-evidence.md sonar-project.properties
git commit -m "docs: document distributed operation and validation"
```

## Plan self-review

- Spec coverage: Tasks 1–4 implement the three-node cluster, Redis state,
  Bully leader, locks, Lamport, versions, heartbeats and failover. Task 5
  implements dashboard and QR. Task 6 records operational limits and evidence.
- Scope: Jenkins, Burp Suite and the final V&V report are deliberately outside
  this core-distributed plan and require a second design/plan after this code
  is verified.
- Consistency: `stateVersion`, `lamportClock`, `commandId`, `clientId`, lease
  TTLs and node IDs are named consistently in all tasks.
- Placeholder scan: every task gives files, interfaces, concrete tests,
  commands and commit messages.
