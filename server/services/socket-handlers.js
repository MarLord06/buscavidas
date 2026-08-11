const { randomUUID } = require('node:crypto')

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

function attachSocketHandlers({ io, game }) {
  const pendingDisconnects = new Set()

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

    socket.on('create-room', async (data, callback) => {
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
    })

    socket.on('join-room', async (data, callback) => {
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
    })

    socket.on('start-game', async (data, callback) => {
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
    })

    socket.on('reveal-cell', async (data, callback) => {
      const normalized = normalizeDataAndCallback(data, callback)
      const roomCode = socket.data.roomCode
      const result = await game.revealCell({
        ...normalized.data,
        ...metadata(socket, normalized.data),
        roomCode,
        playerId: socket.data.playerId || socket.id,
      })

      normalized.callback?.(result)

    })

    socket.on('restart-game', async (data, callback) => {
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
    })

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

    socket.on('join-as-spectator', async (data, callback) => {
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
    })

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

      if (socket.data.role !== 'player' || !socket.data.roomCode) {
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
