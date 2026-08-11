const { randomUUID } = require('node:crypto')

const DEFAULT_MAX_COMMANDS_PER_WINDOW = 12
const DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS = 5000

function metadata(socket, data = {}) {
  return {
    commandId: data.commandId || randomUUID(),
    clientId: data.clientId || socket.id,
    lamportClock: Number(data.lamportClock) || 0,
  }
}

function normalizeDataAndCallback(data, callback) {
  if (typeof data === 'function') return { data: {}, callback: data }

  return { data: data || {}, callback }
}

function consumeCommandAllowance(socket, rateLimit) {
  const currentTime = Date.now()
  const currentWindow = socket.data.commandWindow

  if (!currentWindow || currentTime >= currentWindow.expiresAt) {
    socket.data.commandWindow = {
      count: 1,
      expiresAt: currentTime + rateLimit.windowMilliseconds,
    }
    return true
  }

  if (currentWindow.count >= rateLimit.maxCommands) {
    return false
  }

  currentWindow.count += 1
  return true
}

function registerLimitedHandler(socket, eventName, handler, rateLimit) {
  socket.on(eventName, async (data, callback) => {
    if (!consumeCommandAllowance(socket, rateLimit)) {
      const normalized = normalizeDataAndCallback(data, callback)
      normalized.callback?.({
        success: false,
        code: 'RATE_LIMITED',
        message: 'Demasiadas solicitudes; inténtalo nuevamente en unos segundos',
      })
      return
    }

    await handler(data, callback)
  })
}

function attachSocketHandlers({ io, game, isClosing = () => false, rateLimit = {} }) {
  const pendingDisconnects = new Set()
  const commandRateLimit = {
    maxCommands:
      Number(rateLimit.maxCommands) || DEFAULT_MAX_COMMANDS_PER_WINDOW,
    windowMilliseconds:
      Number(rateLimit.windowMilliseconds) ||
      DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS,
  }

  function trackDisconnect(promise) {
    pendingDisconnects.add(promise)
    promise.finally(() => pendingDisconnects.delete(promise))
  }

  async function emitRoomStateToSocket(socket, roomCode) {
    const room = await game.getRoomState(roomCode)

    if (room) {
      socket.emit('room-updated', room)
    }
  }

  io.on('connection', (socket) => {
    console.log(`Cliente conectado: ${socket.id}`)

    registerLimitedHandler(socket, 'create-room', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const requestData = normalized.data
      const commandMetadata = metadata(socket, requestData)
      const playerId = commandMetadata.clientId
      const result = await game.createRoom({
        ...requestData,
        ...commandMetadata,
        playerId,
        connectionId: socket.id,
      })

      if (result.success) {
        const stablePlayerId = result.player.id
        await socket.join(result.roomCode)
        socket.data.roomCode = result.roomCode
        socket.data.playerId = stablePlayerId
        socket.data.clientId = playerId
        socket.data.role = 'player'
        await game.heartbeatPlayer({
          roomCode: result.roomCode,
          playerId: stablePlayerId,
          connectionId: socket.id,
        })
        console.log(`${result.player.name} creó la sala ${result.roomCode}`)
      }

      normalized.callback?.(result)

      if (result.success) {
        await emitRoomStateToSocket(socket, result.roomCode)
      }
    }, commandRateLimit)

    registerLimitedHandler(socket, 'join-room', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const requestData = normalized.data
      const commandMetadata = metadata(socket, requestData)
      const playerId = commandMetadata.clientId
      const result = await game.joinRoom({
        ...requestData,
        ...commandMetadata,
        playerId,
        connectionId: socket.id,
      })

      if (result.success) {
        const stablePlayerId = result.player.id
        await socket.join(result.roomCode)
        socket.data.roomCode = result.roomCode
        socket.data.playerId = stablePlayerId
        socket.data.clientId = playerId
        socket.data.role = 'player'
        await game.heartbeatPlayer({
          roomCode: result.roomCode,
          playerId: stablePlayerId,
          connectionId: socket.id,
        })
        console.log(
          `${result.player.name} ${
            result.reconnected ? 'se reconectó a' : 'ingresó a'
          } la sala ${result.roomCode}`,
        )
      }

      normalized.callback?.(result)

      if (result.success) {
        await emitRoomStateToSocket(socket, result.roomCode)
      }
    }, commandRateLimit)

    registerLimitedHandler(socket, 'start-game', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = socket.data.roomCode
      const result = await game.startGame({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode,
        playerId: socket.data.playerId || socket.id,
      })

      normalized.callback?.(result)

      if (result.success) {
        console.log(`La partida de la sala ${roomCode} comenzó`)
      }
    }, commandRateLimit)

    registerLimitedHandler(socket, 'reveal-cell', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = socket.data.roomCode
      const result = await game.revealCell({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode,
        playerId: socket.data.playerId || socket.id,
      })

      normalized.callback?.(result)

    }, commandRateLimit)

    registerLimitedHandler(socket, 'toggle-flag', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = socket.data.roomCode
      const result = await game.toggleFlag({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode,
        playerId: socket.data.playerId || socket.id,
      })

      normalized.callback?.(result)
    }, commandRateLimit)

    registerLimitedHandler(socket, 'restart-game', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = socket.data.roomCode
      const result = await game.restartGame({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode,
        playerId: socket.data.playerId || socket.id,
      })

      normalized.callback?.(result)

      if (result.success) {
        console.log(`La sala ${roomCode} inició una nueva partida`)
        io.to(roomCode).emit('game-restarted')
      }
    }, commandRateLimit)

    socket.on('leave-room', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = socket.data.roomCode
      const result = await game.leaveRoom({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode,
        playerId: socket.data.playerId || socket.id,
      })

      if (result.success) {
        await socket.leave(roomCode)
        socket.data.roomCode = null
        socket.data.playerId = null
        socket.data.role = null
      }

      normalized.callback?.(result)

    })

    registerLimitedHandler(socket, 'join-as-spectator', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = String(normalized.data.roomCode || '').trim().toUpperCase()

      if (!roomCode) {
        normalized.callback?.({
          success: false,
          message: 'Debes escribir el código de la sala',
        })
        return
      }

      const room = await game.getRoomState(roomCode)

      if (!room) {
        normalized.callback?.({ success: false, message: 'La sala no existe' })
        return
      }

      await socket.join(roomCode)
      socket.data.roomCode = roomCode
      socket.data.playerId = null
      socket.data.role = 'spectator'
      console.log(`Un espectador ingresó a la sala ${roomCode}`)
      normalized.callback?.({ success: true, roomCode })
      socket.emit('room-updated', room)
    }, commandRateLimit)

    socket.on('player-heartbeat', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const result = await game.heartbeatPlayer({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode: socket.data.roomCode,
        playerId: socket.data.playerId || socket.id,
        connectionId: socket.id,
      })
      normalized.callback?.(result)
    })

    socket.on('disconnect', () => {
      console.log(`Cliente desconectado: ${socket.id}`)

      if (isClosing() || socket.data.role !== 'player' || !socket.data.roomCode) {
        return
      }

      const roomCode = socket.data.roomCode
      const pendingDisconnect = game.leaveRoom({
        roomCode,
        playerId: socket.data.playerId,
        commandId: `disconnect:${socket.data.playerId}:${Date.now()}`,
        clientId: socket.data.clientId || socket.data.playerId,
        connectionId: socket.id,
        lamportClock: 0,
        disconnected: true,
      }).catch((error) => {
        console.error('No se pudo registrar la desconexión del jugador', error)
      })
      trackDisconnect(pendingDisconnect)
    })
  })

  return {
    waitForPendingDisconnects: () => Promise.all(pendingDisconnects),
  }
}

module.exports = { attachSocketHandlers }
