const express = require('express')
const http = require('http')
const cors = require('cors')
const Redis = require('ioredis')
const { Server } = require('socket.io')
const { createAdapter } = require('@socket.io/redis-adapter')

const {
  createRedisRoomRepository,
} = require('./repositories/redis-room-repository')
const {
  createGameCommandService,
} = require('./services/game-command-service')
const { attachSocketHandlers } = require('./services/socket-handlers')

let standaloneServerCount = 0
const PLAYER_RECONCILIATION_INTERVAL_MILLISECONDS = 5000

function createGameServer(options = {}) {
  const config = options.config || {}
  const clientUrl =
    config.clientUrl || options.clientUrl || 'http://localhost:5173'
  const app = express()
  const httpServer = http.createServer(app)
  const io = new Server(httpServer, {
    cors: {
      origin: clientUrl,
      methods: ['GET', 'POST'],
    },
  })
  let ownsPublisher = false
  let ownsSubscriber = false
  let publisher
  let subscriber

  if (typeof options.redis?.command?.duplicate === 'function') {
    publisher = options.redis.command
    subscriber = options.redis.subscriber || publisher.duplicate()
    ownsSubscriber = !options.redis.subscriber
  } else if (options.redis) {
    publisher = options.redis
    subscriber = publisher.duplicate()
    ownsSubscriber = true
  } else {
    standaloneServerCount += 1
    const keyPrefix =
      config.keyPrefix ||
      `buscaminas:standalone:${process.pid}:${standaloneServerCount}:`
    publisher = new Redis(
      config.redisUrl || 'redis://127.0.0.1:6379',
      { keyPrefix },
    )
    subscriber = publisher.duplicate()
    ownsPublisher = true
    ownsSubscriber = true
  }

  const coordinator = options.coordinator || {
    isLeader: () => true,
    getLeader: async () => null,
  }
  const repository = createRedisRoomRepository({
    redis: publisher,
    keyPrefix: config.keyPrefix,
  })
  const game = createGameCommandService({
    repository,
    coordinator,
    redis: publisher,
    keyPrefix: config.keyPrefix,
    publishRoomUpdated: async (room) => {
      io.to(room.roomCode).emit('room-updated', room)
    },
  })
  let reconciliationTimer = null
  let reconciliationQueue = Promise.resolve()

  function reconcileRooms() {
    if (!coordinator.isLeader()) {
      stopReconciliation()
      return Promise.resolve([])
    }

    const reconciliation = reconciliationQueue.then(() =>
      game.reconcileExpiredPlayersInRooms(),
    )
    reconciliationQueue = reconciliation.catch((error) => {
      console.error('No se pudieron reconciliar jugadores expirados', error)
    })

    return reconciliation
  }

  function stopReconciliation() {
    if (reconciliationTimer) {
      clearInterval(reconciliationTimer)
      reconciliationTimer = null
    }
  }

  function scheduleReconciliation() {
    stopReconciliation()
    reconcileRooms().catch(() => {})
    reconciliationTimer = setInterval(() => {
      reconcileRooms().catch(() => {})
    }, PLAYER_RECONCILIATION_INTERVAL_MILLISECONDS)
  }

  function handleLeaderChanged(leader) {
    io.emit('leader-changed', leader)

    if (coordinator.isLeader()) {
      scheduleReconciliation()
    } else {
      stopReconciliation()
    }
  }

  app.use(cors({ origin: clientUrl }))
  app.use(express.json())
  app.get('/', (request, response) => {
    response.json({
      success: true,
      message: 'Servidor del Buscaminas Tripartito funcionando',
    })
  })

  io.adapter(createAdapter(publisher, subscriber))
  const socketHandlers = attachSocketHandlers({ io, game })
  coordinator.on?.('leader-changed', handleLeaderChanged)

  if (coordinator.isLeader()) {
    scheduleReconciliation()
  }

  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, () => {
        httpServer.off('error', reject)
        const address = httpServer.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    })
  }

  async function close() {
    stopReconciliation()
    coordinator.off?.('leader-changed', handleLeaderChanged)
    await new Promise((resolve, reject) => {
      io.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
    await socketHandlers.waitForPendingDisconnects()
    await reconciliationQueue

    const clientsToClose = []

    if (ownsSubscriber) {
      clientsToClose.push(subscriber.quit())
    }

    if (ownsPublisher) {
      clientsToClose.push(publisher.quit())
    }

    await Promise.all(clientsToClose)
  }

  return {
    app,
    httpServer,
    io,
    repository,
    game,
    listen,
    close,
  }
}

module.exports = { createGameServer }
