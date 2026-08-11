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

  return { game, repository }
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
    playerId: 'player-1',
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
    playerId: 'player-1',
    commandId: 'restart',
    clientId: 'one',
    lamportClock: 10,
  })
  const left = await game.leaveRoom({
    roomCode: created.roomCode,
    playerId: 'player-2',
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
