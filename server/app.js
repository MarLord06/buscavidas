const express = require('express')
const http = require('node:http')
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
const {
  createClusterTelemetryService,
} = require('./services/cluster-telemetry-service')

let standaloneServerCount = 0
const PLAYER_RECONCILIATION_INTERVAL_MILLISECONDS = 5000
const CLUSTER_TELEMETRY_INTERVAL_MILLISECONDS = 2000

function createGameServer(options = {}) {
  const config = options.config || {}
  const clientUrl =
    config.clientUrl || options.clientUrl || '*'
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
  let telemetry = null
  const game = createGameCommandService({
    repository,
    coordinator,
    redis: publisher,
    keyPrefix: config.keyPrefix,
    publishRoomUpdated: async (room, change = {}) => {
      if (room) {
        io.to(room.roomCode).emit('room-updated', room)
      }

      if (telemetry) {
        const eventType = change.deleted ? 'room-deleted' : 'command-applied'
        await recordTelemetryEvent(eventType, {
          message: change.deleted
            ? `Sala ${change.roomCode} eliminada`
            : `Sala ${change.roomCode} avanzó a v${change.stateVersion}`,
          roomCode: change.roomCode,
          stateVersion: change.stateVersion,
          lamportClock: change.lamportClock,
        }).catch(() => {})
        publishClusterStatus().catch(() => {})
      }
    },
  })
  telemetry = createClusterTelemetryService({
    coordinator,
    repository,
    game,
    redis: publisher,
    keyPrefix: config.keyPrefix,
    clusterNodeIds: config.clusterNodeIds || [1, 2, 3],
  })
  let reconciliationTimer = null
  let reconciliationQueue = Promise.resolve()
  let telemetryTimer = null
  let telemetryQueue = Promise.resolve()
  let closing = false

  function enqueueTelemetry(operation) {
    const queuedOperation = telemetryQueue.then(operation)
    telemetryQueue = queuedOperation.catch((error) => {
      console.error('Falló una operación de telemetría', error)
    })
    return queuedOperation
  }

  function recordTelemetryEvent(type, details) {
    if (closing) {
      return Promise.resolve(null)
    }

    return enqueueTelemetry(() => telemetry.recordEvent(type, details))
  }

  function publishClusterStatus(target = io.to('dashboard')) {
    if (closing) {
      return Promise.resolve(null)
    }

    return enqueueTelemetry(async () => {
      const status = await telemetry.getStatus()
      target.emit('cluster-status', status)
      return status
    })
  }

  function scheduleTelemetry() {
    publishClusterStatus().catch(() => {})
    telemetryTimer = setInterval(() => {
      publishClusterStatus().catch(() => {})
    }, CLUSTER_TELEMETRY_INTERVAL_MILLISECONDS)
  }

  function stopTelemetry() {
    if (telemetryTimer) {
      clearInterval(telemetryTimer)
      telemetryTimer = null
    }
  }

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
    recordTelemetryEvent('leader-changed', {
      message: leader
        ? `Nodo ${leader.nodeId} elegido líder`
        : 'El clúster no tiene líder',
      nodeId: leader?.nodeId ?? null,
    }).then(() => publishClusterStatus()).catch((error) => {
      console.error('No se pudo registrar el cambio de líder', error)
    })

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
  app.get('/cluster/leader', async (request, response, next) => {
    try {
      response.json({ leader: await coordinator.getLeader() })
    } catch (error) {
      next(error)
    }
  })

  io.adapter(createAdapter(publisher, subscriber))
  io.on('connection', (socket) => {
    socket.on('subscribe-dashboard', async () => {
      await socket.join('dashboard')
      publishClusterStatus(socket).catch(() => {})
    })
  })
  const socketHandlers = attachSocketHandlers({ io, game })
  coordinator.on?.('leader-changed', handleLeaderChanged)

  if (coordinator.isLeader()) {
    scheduleReconciliation()
  }
  scheduleTelemetry()

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
    closing = true
    stopReconciliation()
    stopTelemetry()
    coordinator.off?.('leader-changed', handleLeaderChanged)
    await telemetryQueue
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
    telemetry,
    listen,
    close,
  }
}

module.exports = { createGameServer }
