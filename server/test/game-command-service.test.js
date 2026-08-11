const assert = require('node:assert/strict')
const test = require('node:test')
const Redis = require('ioredis')

const {
  createRedisRoomRepository,
} = require('../repositories/redis-room-repository')
const {
  createGameCommandService,
} = require('../services/game-command-service')

function createGame(t, coordinator = {
  isLeader: () => true,
  getLeader: async () => ({
    nodeId: 3,
    publicUrl: 'http://node-3',
    expiresAt: 9_999_999,
  }),
}, serviceOptions = {}) {
  const keyPrefix = `buscaminas:test:commands:${Date.now()}:${process.pid}:`
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  })
  const repository = createRedisRoomRepository({ redis })
  const game = createGameCommandService({
    repository,
    coordinator,
    now: () => 1_000_000,
    ...serviceOptions,
  })

  t.after(async () => {
    const keys = await redis.keys('*')

    if (keys.length > 0) {
      await redis.del(...keys.map((key) => key.slice(keyPrefix.length)))
    }

    await redis.quit()
  })

  return { game, repository, redis }
}

function createDeferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

function playableRoom(roomCode = 'PLAY01') {
  return {
    roomCode,
    status: 'playing',
    hostId: 'player-1',
    players: [
      {
        id: 'player-1',
        name: 'Ana',
        score: 0,
        ready: false,
        connected: true,
        color: '#8b5cf6',
      },
    ],
    game: {
      rows: 1,
      columns: 3,
      mines: 1,
      board: [
        {
          index: 0,
          isMine: false,
          nearbyMines: 0,
          revealed: false,
          revealedBy: null,
        },
        {
          index: 1,
          isMine: false,
          nearbyMines: 1,
          revealed: false,
          revealedBy: null,
        },
        {
          index: 2,
          isMine: true,
          nearbyMines: 0,
          revealed: false,
          revealedBy: null,
        },
      ],
      revealedSafeCells: 0,
      totalSafeCells: 2,
      startedAt: 900_000,
      endedAt: null,
      winnerIds: [],
    },
    createdAt: 800_000,
    lamportClock: 0,
    stateVersion: 1,
  }
}

test('aplica solo una revelación concurrente y conserva la versión secuencial', async (t) => {
  const { game, repository } = createGame(t)
  const roomCode = 'PLAY01'
  await repository.saveRoom(playableRoom(roomCode))

  const [first, second] = await Promise.all([
    game.revealCell({
      roomCode,
      playerId: 'player-1',
      cellIndex: 0,
      commandId: 'a',
      clientId: 'one',
      lamportClock: 4,
    }),
    game.revealCell({
      roomCode,
      playerId: 'player-1',
      cellIndex: 0,
      commandId: 'b',
      clientId: 'two',
      lamportClock: 4,
    }),
  ])

  assert.equal([first.success, second.success].filter(Boolean).length, 1)
  assert.equal((await repository.getRoom(roomCode)).stateVersion, 2)
})

test('un commandId repetido devuelve el resultado original sin cambiar puntaje', async (t) => {
  const { game, repository } = createGame(t)
  const roomCode = 'PLAY02'
  await repository.saveRoom(playableRoom(roomCode))

  const command = {
    roomCode,
    playerId: 'player-1',
    cellIndex: 1,
    commandId: 'same',
    clientId: 'one',
    lamportClock: 7,
  }
  const original = await game.revealCell(command)
  const retried = await game.revealCell(command)

  assert.deepEqual(retried, original)
  assert.equal((await repository.getRoom(roomCode)).players[0].score, 1)
})

test('un commandId repetido al crear devuelve la misma sala sin generar otra', async (t) => {
  const { game, repository } = createGame(t)
  const command = {
    playerId: 'socket-old',
    playerName: 'Ana',
    commandId: 'same-create',
    clientId: 'stable-client',
    lamportClock: 2,
  }

  const original = await game.createRoom(command)
  const retried = await game.createRoom({
    ...command,
    playerId: 'socket-new',
  })

  assert.deepEqual(retried, original)
  assert.deepEqual(await repository.listRoomCodes(), [original.roomCode])
})

test('solo el mismo clientId puede recuperar un jugador desconectado', async (t) => {
  const { game, repository } = createGame(t)
  const created = await game.createRoom({
    playerId: 'socket-old',
    playerName: 'Ana',
    commandId: 'identity-create',
    clientId: 'stable-client',
    lamportClock: 1,
  })
  const room = await repository.getRoom(created.roomCode)
  room.status = 'playing'
  await repository.saveRoom(room)
  await game.leaveRoom({
    roomCode: created.roomCode,
    playerId: created.player.id,
    commandId: 'identity-disconnect',
    clientId: 'stable-client',
    disconnected: true,
  })

  const impersonation = await game.joinRoom({
    roomCode: created.roomCode,
    playerId: 'attacker-socket',
    playerName: 'Ana',
    commandId: 'identity-attacker',
    clientId: 'attacker-client',
  })
  const reconnected = await game.joinRoom({
    roomCode: created.roomCode,
    playerId: 'socket-new',
    playerName: 'Ana',
    commandId: 'identity-owner',
    clientId: 'stable-client',
  })

  assert.equal(impersonation.success, false)
  assert.equal(reconnected.success, true)
  assert.equal(reconnected.reconnected, true)
  assert.equal(reconnected.player.id, created.player.id)
  assert.equal('clientId' in reconnected.player, false)
  assert.equal(
    'clientId' in (await game.getRoomState(created.roomCode)).players[0],
    false,
  )
})

test('una desconexión antigua no deshace una reconexión más reciente', async (t) => {
  const { game, repository } = createGame(t)
  const created = await game.createRoom({
    playerName: 'Ana',
    commandId: 'connection-create',
    clientId: 'stable-client',
    connectionId: 'old-socket',
  })
  const reconnected = await game.joinRoom({
    roomCode: created.roomCode,
    playerName: 'Ana',
    commandId: 'connection-rejoin',
    clientId: 'stable-client',
    connectionId: 'new-socket',
  })
  await game.leaveRoom({
    roomCode: created.roomCode,
    playerId: created.player.id,
    commandId: 'connection-old-disconnect',
    clientId: 'stable-client',
    connectionId: 'old-socket',
    disconnected: true,
  })
  await game.leaveRoom({
    roomCode: created.roomCode,
    playerId: created.player.id,
    commandId: 'connection-unfenced-disconnect',
    clientId: 'stable-client',
    disconnected: true,
  })

  const room = await repository.getRoom(created.roomCode)
  assert.equal(reconnected.success, true)
  assert.equal(room.players[0].connected, true)
  assert.equal(room.players[0].connectionId, 'new-socket')
})

test('linealiza un disconnect viejo que llega durante el commit del rejoin', async (t) => {
  const { repository, redis } = createGame(t)
  const roomCode = 'RACE02'
  const room = playableRoom(roomCode)
  room.players[0].clientId = 'stable-client'
  room.players[0].connectionId = 'old-socket'
  room.players[0].connected = false
  await repository.saveRoom(room)
  const rejoinCommitStarted = createDeferred()
  const releaseRejoinCommit = createDeferred()
  const pausedRepository = {
    ...repository,
    saveRoomCommandAndPlayerHeartbeat: async (...argumentsList) => {
      rejoinCommitStarted.resolve()
      await releaseRejoinCommit.promise
      return repository.saveRoomCommandAndPlayerHeartbeat(...argumentsList)
    },
  }
  const game = createGameCommandService({
    repository: pausedRepository,
    redis,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
  })

  const rejoin = game.joinRoom({
    roomCode,
    playerName: 'Ana',
    commandId: 'racing-rejoin',
    clientId: 'stable-client',
    connectionId: 'new-socket',
  })
  await rejoinCommitStarted.promise
  const staleDisconnect = game.leaveRoom({
    roomCode,
    playerId: 'player-1',
    commandId: 'racing-stale-disconnect',
    clientId: 'stable-client',
    connectionId: 'old-socket',
    disconnected: true,
  })
  releaseRejoinCommit.resolve()
  await Promise.all([rejoin, staleDisconnect])
  const savedRoom = await repository.getRoom(roomCode)

  assert.equal(savedRoom.players[0].connected, true)
  assert.equal(savedRoom.players[0].connectionId, 'new-socket')
})

test('el rejoin establece su heartbeat antes de que la reconciliación pueda desconectarlo', async (t) => {
  const { repository, redis } = createGame(t)
  const game = createGameCommandService({
    repository,
    redis,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
    now: () => 1_000_000,
  })
  const roomCode = 'REJOIN'
  const room = playableRoom(roomCode)
  room.players[0].clientId = 'stable-client'
  room.players[0].connectionId = 'old-socket'
  room.players[0].connected = false
  await repository.saveRoom(room)

  const reconnected = await game.joinRoom({
    roomCode,
    playerName: 'Ana',
    commandId: 'rejoin-with-heartbeat',
    clientId: 'stable-client',
    connectionId: 'new-socket',
  })
  const reconciliation = await game.reconcileExpiredPlayers(roomCode)
  const recoveredRoom = await repository.getRoom(roomCode)
  const serializedHeartbeat = await redis.get(`player:${roomCode}:player-1`)
  const staleHeartbeat = await game.heartbeatPlayer({
    roomCode,
    playerId: 'player-1',
    connectionId: 'old-socket',
  })

  assert.equal(reconnected.success, true)
  assert.deepEqual(reconciliation.disconnectedPlayerIds, [])
  assert.equal(recoveredRoom.players[0].connected, true)
  assert.equal(staleHeartbeat.success, false)
  assert.notEqual(serializedHeartbeat, null)
  const heartbeat = JSON.parse(serializedHeartbeat)
  assert.equal(heartbeat.connectionId, 'new-socket')
})

test('acepta durante la migración un heartbeat numérico todavía vigente', async (t) => {
  const { repository, redis } = createGame(t)
  const game = createGameCommandService({
    repository,
    redis,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
  })
  const roomCode = 'LEGACY'
  const room = playableRoom(roomCode)
  room.players[0].connectionId = 'current-socket'
  await repository.saveRoom(room)
  await redis.set(
    `player:${roomCode}:player-1`,
    '1000000',
    'PX',
    15_000,
  )

  const reconciliation = await game.reconcileExpiredPlayers(roomCode)
  const savedRoom = await repository.getRoom(roomCode)

  assert.deepEqual(reconciliation.disconnectedPlayerIds, [])
  assert.equal(savedRoom.players[0].connected, true)
})

test('un heartbeat adopta atómicamente la primera generación de una sesión legada', async (t) => {
  const { repository, redis } = createGame(t)
  const game = createGameCommandService({
    repository,
    redis,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
    now: () => 1_000_000,
  })
  const roomCode = 'ADOPT1'
  await repository.saveRoom(playableRoom(roomCode))

  const heartbeatResult = await game.heartbeatPlayer({
    roomCode,
    playerId: 'player-1',
    connectionId: 'adopted-socket',
  })
  const savedRoom = await repository.getRoom(roomCode)
  const savedHeartbeat = JSON.parse(
    await redis.get(`player:${roomCode}:player-1`),
  )

  assert.equal(heartbeatResult.success, true)
  assert.equal(savedRoom.players[0].connectionId, 'adopted-socket')
  assert.equal(savedHeartbeat.connectionId, 'adopted-socket')
})

test('genera un commandId cuando el servicio recibe un comando sin identificador', async (t) => {
  const { game, repository } = createGame(t)
  const roomCode = 'PLAY03'
  await repository.saveRoom(playableRoom(roomCode))

  const result = await game.revealCell({
    roomCode,
    playerId: 'player-1',
    cellIndex: 0,
    clientId: 'one',
    lamportClock: 2,
  })

  assert.equal(result.success, true)
  assert.match(result.commandId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(
    await repository.getCommand(roomCode, result.commandId),
    result,
  )
})

test('una caída antes del commit atómico permite reintentar sin reaplicar la transición', async (t) => {
  const { repository } = createGame(t)
  const roomCode = 'PLAY04'
  await repository.saveRoom(playableRoom(roomCode))
  let failNextCommit = true
  const faultInjectingRepository = {
    ...repository,
    saveRoomAndCommand: async (...argumentsList) => {
      if (failNextCommit) {
        failNextCommit = false
        throw new Error('simulated process failure')
      }

      return repository.saveRoomAndCommand(...argumentsList)
    },
  }
  const game = createGameCommandService({
    repository: faultInjectingRepository,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
    now: () => 1_000_000,
  })
  const command = {
    roomCode,
    playerId: 'player-1',
    cellIndex: 0,
    commandId: 'retry-after-crash',
    clientId: 'one',
    lamportClock: 4,
  }

  await assert.rejects(game.revealCell(command), /simulated process failure/)
  const unchangedRoom = await repository.getRoom(roomCode)
  assert.equal(unchangedRoom.stateVersion, 1)
  assert.equal(unchangedRoom.players[0].score, 0)
  assert.equal(unchangedRoom.game.board[0].revealed, false)

  const retried = await game.revealCell(command)
  const savedRoom = await repository.getRoom(roomCode)

  assert.equal(retried.success, true)
  assert.equal(savedRoom.stateVersion, 2)
  assert.equal(savedRoom.players[0].score, 1)
  assert.deepEqual(
    await repository.getCommand(roomCode, command.commandId),
    retried,
  )
})

test('publica dentro del lock el snapshot correspondiente a cada versión', async (t) => {
  const publishedRooms = []
  const { game, repository } = createGame(t, undefined, {
    publishRoomUpdated: async (room) => {
      publishedRooms.push(structuredClone(room))
    },
  })
  const roomCode = 'PLAY05'
  await repository.saveRoom(playableRoom(roomCode))

  const results = await Promise.all([
    game.revealCell({
      roomCode,
      playerId: 'player-1',
      cellIndex: 0,
      commandId: 'publish-a',
      clientId: 'one',
      lamportClock: 4,
    }),
    game.revealCell({
      roomCode,
      playerId: 'player-1',
      cellIndex: 1,
      commandId: 'publish-b',
      clientId: 'one',
      lamportClock: 4,
    }),
  ])

  assert.deepEqual(
    results.map((result) => result.stateVersion).sort(),
    [2, 3],
  )
  assert.deepEqual(
    publishedRooms.map((room) => room.stateVersion),
    [2, 3],
  )
  assert.deepEqual(
    publishedRooms.map(
      (room) => room.game.cells.filter((cell) => cell.revealed).length,
    ),
    [1, 2],
  )
})

test('preserva las reglas del lobby y versiona cada transición válida', async (t) => {
  const { game, repository } = createGame(t)
  const created = await game.createRoom({
    playerId: 'player-1',
    playerName: ' Ana ',
    commandId: 'create',
    clientId: 'one',
    lamportClock: 2,
  })

  assert.equal(created.success, true)
  assert.match(created.roomCode, /^[A-Z0-9]{6}$/)
  assert.equal(created.player.name, 'Ana')
  assert.equal(created.lamportClock, 3)
  assert.equal(created.stateVersion, 1)

  const second = await game.joinRoom({
    roomCode: created.roomCode,
    playerId: 'player-2',
    playerName: 'Beto',
    commandId: 'join-2',
    clientId: 'two',
    lamportClock: 1,
  })
  const third = await game.joinRoom({
    roomCode: created.roomCode,
    playerId: 'player-3',
    playerName: 'Caro',
    commandId: 'join-3',
    clientId: 'three',
    lamportClock: 8,
  })

  assert.equal(second.success, true)
  assert.equal(third.success, true)
  assert.equal(third.stateVersion, 3)
  assert.equal(third.lamportClock, 9)

  const started = await game.startGame({
    roomCode: created.roomCode,
    playerId: created.player.id,
    commandId: 'start',
    clientId: 'one',
    lamportClock: 9,
  })
  const startedRoom = await repository.getRoom(created.roomCode)

  assert.equal(started.success, true)
  assert.equal(started.stateVersion, 4)
  assert.equal(startedRoom.game.board.length, 81)
  assert.equal(startedRoom.game.board.filter((cell) => cell.isMine).length, 10)

  startedRoom.status = 'finished'
  await repository.saveRoom(startedRoom)

  const restarted = await game.restartGame({
    roomCode: created.roomCode,
    playerId: created.player.id,
    commandId: 'restart',
    clientId: 'one',
    lamportClock: 10,
  })
  const left = await game.leaveRoom({
    roomCode: created.roomCode,
    playerId: second.player.id,
    commandId: 'leave',
    clientId: 'two',
    lamportClock: 11,
  })
  const finalRoom = await repository.getRoom(created.roomCode)

  assert.equal(restarted.success, true)
  assert.equal(left.success, true)
  assert.equal(finalRoom.players.length, 2)
  assert.equal(finalRoom.stateVersion, 6)
})

test('un nodo no líder redirige sin crear la sala', async (t) => {
  const leader = {
    nodeId: 3,
    publicUrl: 'http://node-3',
    expiresAt: 9_999_999,
  }
  const { game, repository } = createGame(t, {
    isLeader: () => false,
    getLeader: async () => leader,
  })

  const result = await game.createRoom({
    playerId: 'player-1',
    playerName: 'Ana',
    commandId: 'create',
    clientId: 'one',
    lamportClock: 1,
  })

  assert.deepEqual(result, {
    success: false,
    code: 'LEADER_REDIRECT',
    leader,
  })
  assert.equal(await repository.getRoom(result.roomCode), null)
})

test('linealiza heartbeat y expiración para no revivir una key desconectada', async (t) => {
  const { repository, redis } = createGame(t)
  const roomCode = 'RACE01'
  await repository.saveRoom(playableRoom(roomCode))
  const heartbeatChecked = createDeferred()
  const releaseReconciliation = createDeferred()
  const heartbeatWriteStarted = createDeferred()
  const heartbeatLockRequested = createDeferred()
  let lockCalls = 0
  const delayedRedis = new Proxy(redis, {
    get(target, property) {
      if (property === 'get') {
        return async (...argumentsList) => {
          const result = await target.get(...argumentsList)
          heartbeatChecked.resolve()
          await releaseReconciliation.promise
          return result
        }
      }

      if (property === 'set') {
        return async (...argumentsList) => {
          heartbeatWriteStarted.resolve()
          return target.set(...argumentsList)
        }
      }

      if (property === 'multi') {
        return (...argumentsList) => {
          heartbeatWriteStarted.resolve()
          return target.multi(...argumentsList)
        }
      }

      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const instrumentedRepository = {
    ...repository,
    withRoomLock: (...argumentsList) => {
      lockCalls += 1

      if (lockCalls === 2) {
        heartbeatLockRequested.resolve()
      }

      return repository.withRoomLock(...argumentsList)
    },
  }
  const game = createGameCommandService({
    repository: instrumentedRepository,
    redis: delayedRedis,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
    now: () => 1_000_000,
  })

  const reconciliation = game.reconcileExpiredPlayers(roomCode)
  await heartbeatChecked.promise
  const heartbeat = game.heartbeatPlayer({
    roomCode,
    playerId: 'player-1',
  })
  await Promise.race([
    heartbeatWriteStarted.promise,
    heartbeatLockRequested.promise,
  ])
  releaseReconciliation.resolve()
  const [reconciliationResult, heartbeatResult] = await Promise.all([
    reconciliation,
    heartbeat,
  ])
  const room = await repository.getRoom(roomCode)

  assert.equal(reconciliationResult.success, true)
  assert.equal(room.players[0].connected, false)
  assert.equal(heartbeatResult.success, false)
  assert.equal(await redis.exists(`player:${roomCode}:player-1`), 0)
})

test('no elimina el índice de heartbeats después de perder el lock', async (t) => {
  const { repository, redis } = createGame(t)
  const roomCode = 'INDEX1'
  const room = playableRoom(roomCode)
  room.players[0].connected = false
  await repository.saveRoom(room)
  await redis.sadd('player-heartbeat:rooms', roomCode)
  const repositoryWithStolenLock = {
    ...repository,
    removeHeartbeatRoom: async (...argumentsList) => {
      await redis.set(
        `lock:room:${roomCode}`,
        'new-owner',
        'PX',
        3000,
      )
      return repository.removeHeartbeatRoom(...argumentsList)
    },
  }
  const game = createGameCommandService({
    repository: repositoryWithStolenLock,
    redis,
    coordinator: {
      isLeader: () => true,
      getLeader: async () => null,
    },
    now: () => 1_000_000,
  })

  await assert.rejects(
    game.reconcileExpiredPlayers(roomCode),
    (error) => error.code === 'LOCK_LOST',
  )
  assert.equal(
    await redis.sismember('player-heartbeat:rooms', roomCode),
    1,
  )
})
