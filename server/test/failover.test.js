const assert = require('node:assert/strict')
const test = require('node:test')
const Redis = require('ioredis')
const { io: createClient } = require('socket.io-client')

const { createGameServer } = require('../app')
const {
  createClusterCoordinator,
} = require('../services/cluster-coordinator')

function connect(url) {
  return new Promise((resolve, reject) => {
    const client = createClient(url, {
      forceNew: true,
      transports: ['websocket'],
    })

    client.once('connect', () => resolve(client))
    client.once('connect_error', reject)
  })
}

function emitWithAck(client, event, payload) {
  return new Promise((resolve) => client.emit(event, payload, resolve))
}

function waitFor(predicate, timeout = 6500) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(async () => {
      if (await predicate()) {
        clearInterval(timer)
        resolve()
        return
      }

      if (Date.now() - startedAt >= timeout) {
        clearInterval(timer)
        reject(new Error(`Condición no satisfecha en ${timeout} ms`))
      }
    }, 50)
  })
}

function nextEvent(client, event, timeout = 6500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, onEvent)
      reject(new Error(`No se publicó ${event}`))
    }, timeout)
    const onEvent = (payload) => {
      clearTimeout(timer)
      resolve(payload)
    }

    client.once(event, onEvent)
  })
}

async function startNodes(nodeIds, { keyPrefix }) {
  const nodes = new Map()

  for (const nodeId of nodeIds) {
    const redis = new Redis({ host: '127.0.0.1', port: 6379, keyPrefix })
    const coordinator = createClusterCoordinator({
      redis,
      nodeId,
      publicUrl: `http://node-${nodeId}`,
    })
    await coordinator.start()
    const server = createGameServer({
      config: { clientUrl: '*', nodeId, keyPrefix },
      redis,
      coordinator,
    })
    const port = await server.listen(0)
    const clients = new Set()
    let closed = false

    nodes.set(nodeId, {
      coordinator,
      game: server.game,
      repository: server.repository,
      redis,
      url: `http://127.0.0.1:${port}`,
      connect: async () => {
        const client = await connect(`http://127.0.0.1:${port}`)
        clients.add(client)
        return client
      },
      close: async () => {
        if (closed) return
        closed = true
        for (const client of clients) client.close()
        await server.close()
        await coordinator.stop()
        await redis.quit()
      },
    })
  }

  return {
    node: (nodeId) => nodes.get(nodeId),
    stopAll: async () => {
      await Promise.all([...nodes.values()].map((node) => node.close()))
      const cleanup = new Redis({ host: '127.0.0.1', port: 6379 })
      const keys = await cleanup.keys(`${keyPrefix}*`)

      if (keys.length > 0) await cleanup.del(...keys)
      await cleanup.quit()
    },
  }
}

async function createPlayableRoom(node) {
  const host = await node.connect()
  const second = await node.connect()
  const third = await node.connect()
  const created = await emitWithAck(host, 'create-room', {
    playerName: 'Ana',
  })
  await emitWithAck(second, 'join-room', {
    roomCode: created.roomCode,
    playerName: 'Beto',
  })
  await emitWithAck(third, 'join-room', {
    roomCode: created.roomCode,
    playerName: 'Caro',
  })
  await emitWithAck(host, 'start-game', {})

  return created.roomCode
}

test('un nodo superviviente toma el liderazgo, lo publica y conserva la sala', async (t) => {
  const keyPrefix = `buscaminas:test:failover:${Date.now()}:${process.pid}:`
  const cluster = await startNodes([1, 2, 3], { keyPrefix })
  t.after(() => cluster.stopAll())
  const observer = await cluster.node(1).connect()
  const roomCode = await createPlayableRoom(cluster.node(3))
  const recoveryRoomCode = 'RECOV1'
  await cluster.node(3).repository.saveRoom({
    roomCode: recoveryRoomCode,
    status: 'playing',
    hostId: 'recover-host',
    players: [
      {
        id: 'recover-host',
        name: 'Host',
        score: 0,
        ready: false,
        connected: true,
        color: '#8b5cf6',
      },
      {
        id: 'recover-player',
        name: 'Suplente',
        score: 0,
        ready: false,
        connected: true,
        color: '#22c55e',
      },
    ],
    game: null,
    createdAt: Date.now(),
    lamportClock: 0,
    stateVersion: 1,
  })
  await Promise.all([
    cluster.node(3).game.heartbeatPlayer({
      roomCode: recoveryRoomCode,
      playerId: 'recover-host',
    }),
    cluster.node(3).game.heartbeatPlayer({
      roomCode: recoveryRoomCode,
      playerId: 'recover-player',
    }),
  ])
  await cluster.node(3).redis.del(
    `player:${recoveryRoomCode}:recover-host`,
  )
  const leaderChanged = nextEvent(observer, 'leader-changed')

  await cluster.node(3).close()
  await waitFor(() => cluster.node(2).coordinator.isLeader())
  const publishedLeader = await leaderChanged
  await waitFor(async () => {
    const recoveryRoom = await cluster.node(2).repository.getRoom(
      recoveryRoomCode,
    )

    return recoveryRoom.hostId === 'recover-player'
  })
  const room = await cluster.node(2).repository.getRoom(roomCode)
  const recoveredRoom = await cluster.node(2).repository.getRoom(
    recoveryRoomCode,
  )
  const reconnectedHost = await cluster.node(2).connect()
  const reconnected = await emitWithAck(reconnectedHost, 'join-room', {
    roomCode,
    playerName: 'Ana',
  })
  const reveal = await emitWithAck(reconnectedHost, 'reveal-cell', {
    cellIndex: 0,
  })
  const advancedRoom = await cluster.node(2).repository.getRoom(roomCode)

  assert.equal(publishedLeader.nodeId, 2)
  assert.equal(room.roomCode, roomCode)
  assert.equal(room.status, 'playing')
  assert.equal(room.stateVersion > 0, true)
  assert.equal(room.players.length, 3)
  assert.ok(room.players.every((player) => !player.connected))
  assert.equal(recoveredRoom.players[0].connected, false)
  assert.equal(recoveredRoom.hostId, 'recover-player')
  assert.equal(recoveredRoom.stateVersion, 2)
  assert.equal(reconnected.success, true)
  assert.equal(reveal.success, true)
  assert.ok(advancedRoom.stateVersion > room.stateVersion)
})
