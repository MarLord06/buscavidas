const express = require('express')
const http = require('http')
const cors = require('cors')
const { Server } = require('socket.io')


function createGameServer({ clientUrl = 'http://localhost:5173' } = {}) {
  const app = express()
  const httpServer = http.createServer(app)

  // Las salas se almacenan temporalmente en memoria
  const rooms = new Map()

app.use(
  cors({
    origin: clientUrl,
  }),
)

app.use(express.json())

const io = new Server(httpServer, {
  cors: {
    origin: clientUrl,
    methods: ['GET', 'POST'],
  },
})

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Servidor del Buscaminas Tripartito funcionando',
  })
})

// Genera un código de sala de seis caracteres
function generateRoomCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''

  do {
    code = ''

    for (let i = 0; i < 6; i += 1) {
      const position = Math.floor(Math.random() * characters.length)
      code += characters[position]
    }
  } while (rooms.has(code))

  return code
}

// Crea el tablero y coloca las minas aleatoriamente
function createGame(rows, columns, mines) {
  const totalCells = rows * columns
  const minePositions = new Set()

  while (minePositions.size < mines) {
    const position = Math.floor(Math.random() * totalCells)
    minePositions.add(position)
  }

  const board = Array.from({ length: totalCells }, (_, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    let nearbyMines = 0

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (
        let columnOffset = -1;
        columnOffset <= 1;
        columnOffset += 1
      ) {
        if (rowOffset === 0 && columnOffset === 0) {
          continue
        }

        const nearbyRow = row + rowOffset
        const nearbyColumn = column + columnOffset

        const isInsideBoard =
          nearbyRow >= 0 &&
          nearbyRow < rows &&
          nearbyColumn >= 0 &&
          nearbyColumn < columns

        if (!isInsideBoard) {
          continue
        }

        const nearbyIndex =
          nearbyRow * columns + nearbyColumn

        if (minePositions.has(nearbyIndex)) {
          nearbyMines += 1
        }
      }
    }

    return {
      index,
      isMine: minePositions.has(index),
      nearbyMines,
      revealed: false,
      revealedBy: null,
    }
  })

  return {
    rows,
    columns,
    mines,
    board,
    revealedSafeCells: 0,
    totalSafeCells: totalCells - mines,
    startedAt: Date.now(),
    endedAt: null,
    winnerIds: [],
  }
}

// Crea una versión pública sin revelar la ubicación de las minas
function getPublicGame(game) {
  if (!game) {
    return null
  }

  return {
    rows: game.rows,
    columns: game.columns,
    mines: game.mines,
    revealedSafeCells: game.revealedSafeCells,
    totalSafeCells: game.totalSafeCells,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    winnerIds: game.winnerIds,

    cells: game.board.map((cell) => ({
      index: cell.index,
      revealed: cell.revealed,

      revealedBy: cell.revealed
        ? cell.revealedBy
        : null,

      value: cell.revealed
        ? cell.isMine
          ? 'mine'
          : cell.nearbyMines
        : null,
    })),
  }
}

// Envía el estado actualizado a todos los jugadores
function sendRoomState(roomCode) {
  const room = rooms.get(roomCode)

  if (!room) {
    return
  }

  io.to(roomCode).emit('room-updated', {
    roomCode,
    status: room.status,
    hostId: room.hostId,
    players: room.players,
    game: getPublicGame(room.game),
  })
}

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`)

  // Crear una sala
  socket.on('create-room', (data = {}, callback) => {
    const playerName = data.playerName?.trim()

    if (!playerName) {
      callback?.({
        success: false,
        message: 'Debes escribir tu nombre',
      })
      return
    }

    const roomCode = generateRoomCode()

    const player = {
      id: socket.id,
      name: playerName,
      score: 0,
      ready: false,
      connected: true,
      color: '#8b5cf6',
    }

    const room = {
      roomCode,
      status: 'waiting',
      hostId: socket.id,
      players: [player],
      game: null,
      createdAt: Date.now(),
    }

    rooms.set(roomCode, room)
    socket.join(roomCode)

    socket.data.roomCode = roomCode
    socket.data.playerId = player.id
    socket.data.role = 'player'
    console.log(`${playerName} creó la sala ${roomCode}`)

    callback?.({
      success: true,
      roomCode,
      player,
      hostId: room.hostId,
    })

    sendRoomState(roomCode)
  })

    // Unirse o reconectarse a una sala
  socket.on('join-room', (data = {}, callback) => {
    const playerName = data.playerName?.trim()

    const roomCode = String(data.roomCode || '')
      .trim()
      .toUpperCase()

    if (!playerName) {
      callback?.({
        success: false,
        message: 'Debes escribir tu nombre',
      })
      return
    }

    const room = rooms.get(roomCode)

    if (!room) {
      callback?.({
        success: false,
        message: 'La sala no existe',
      })
      return
    }

    // Buscar si ese jugador ya pertenecía a la sala
    const existingPlayer = room.players.find(
      (player) =>
        player.name.toLowerCase() ===
        playerName.toLowerCase(),
    )

    if (existingPlayer) {
  if (existingPlayer.connected) {
    callback?.({
      success: false,
      message: 'Ese nombre ya está siendo utilizado',
    })
    return
  }

  // Guardar el ID anterior antes de reemplazarlo
  const previousPlayerId = existingPlayer.id

  // Asignar el nuevo socket al jugador
  existingPlayer.id = socket.id
  existingPlayer.connected = true

  // Actualizar las casillas y ganadores que tenían el ID anterior
  if (room.game) {
    room.game.board.forEach((cell) => {
      if (cell.revealedBy === previousPlayerId) {
        cell.revealedBy = socket.id
      }
    })

    room.game.winnerIds = room.game.winnerIds.map(
      (playerId) =>
        playerId === previousPlayerId
          ? socket.id
          : playerId,
    )
  }

  socket.join(roomCode)

  socket.data.roomCode = roomCode
  socket.data.playerId = socket.id
  socket.data.role = 'player'

  const currentHost = room.players.find(
    (player) => player.id === room.hostId,
  )

  if (!currentHost?.connected) {
    room.hostId = socket.id
  }

  console.log(
    `${playerName} se reconectó a la sala ${roomCode}`,
  )

  callback?.({
    success: true,
    roomCode,
    player: existingPlayer,
    hostId: room.hostId,
    reconnected: true,
  })

  sendRoomState(roomCode)
  return
}

    // Los jugadores nuevos solo pueden entrar mientras se espera
    if (room.status !== 'waiting') {
      callback?.({
        success: false,
        message:
          'La partida ya comenzó. Solo puede regresar un jugador desconectado',
      })
      return
    }

    if (room.players.length >= 3) {
      callback?.({
        success: false,
        message: 'La sala ya tiene tres jugadores',
      })
      return
    }

    const colors = ['#8b5cf6', '#22c55e', '#ef4444']

    const usedColors = new Set(
      room.players.map((player) => player.color),
    )

    const availableColor =
      colors.find((color) => !usedColors.has(color)) ||
      colors[room.players.length]

    const player = {
      id: socket.id,
      name: playerName,
      score: 0,
      ready: false,
      connected: true,
      color: availableColor,
    }

    room.players.push(player)
    socket.join(roomCode)

    socket.data.roomCode = roomCode
    socket.data.playerId = player.id
    socket.data.role = 'player'

    console.log(`${playerName} ingresó a la sala ${roomCode}`)

    callback?.({
      success: true,
      roomCode,
      player,
      hostId: room.hostId,
      reconnected: false,
    })

    sendRoomState(roomCode)
  })

  // Iniciar la partida
  socket.on('start-game', (callback) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)

    if (!room) {
      callback?.({
        success: false,
        message: 'La sala ya no existe',
      })
      return
    }

    if (socket.id !== room.hostId) {
      callback?.({
        success: false,
        message:
          'Solo el creador de la sala puede iniciar la partida',
      })
      return
    }

    const connectedPlayers = room.players.filter(
      (player) => player.connected,
    )

    if (connectedPlayers.length !== 3) {
      callback?.({
        success: false,
        message:
          'Deben estar conectados los tres jugadores',
      })
      return
    }

    if (room.status !== 'waiting') {
      callback?.({
        success: false,
        message: 'La partida ya fue iniciada',
      })
      return
    }

    // Reinicia los puntos antes de comenzar
    room.players.forEach((player) => {
      player.score = 0
    })

    room.status = 'playing'
    room.game = createGame(9, 9, 10)

    console.log(`La partida de la sala ${roomCode} comenzó`)

    callback?.({
      success: true,
    })

    sendRoomState(roomCode)
  })

  // Revelar una casilla
  socket.on('reveal-cell', (data = {}, callback) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)

    if (!room) {
      callback?.({
        success: false,
        message: 'La sala ya no existe',
      })
      return
    }

    if (room.status !== 'playing' || !room.game) {
      callback?.({
        success: false,
        message: 'La partida no está activa',
      })
      return
    }

    const player = room.players.find(
      (currentPlayer) => currentPlayer.id === socket.id,
    )

    if (!player || !player.connected) {
      callback?.({
        success: false,
        message: 'El jugador no está conectado',
      })
      return
    }

    const cellIndex = Number(data.cellIndex)

    if (
      !Number.isInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= room.game.board.length
    ) {
      callback?.({
        success: false,
        message: 'La casilla seleccionada no es válida',
      })
      return
    }

    const cell = room.game.board[cellIndex]

    if (cell.revealed) {
      callback?.({
        success: false,
        message: 'Esta casilla ya fue revelada',
      })
      return
    }

    cell.revealed = true
    cell.revealedBy = socket.id

    let result = 'safe'
    let message = ''

    if (cell.isMine) {
      // Encontrar una mina resta dos puntos
      player.score = Math.max(0, player.score - 2)

      result = 'mine'
      message = '¡Encontraste una mina! Pierdes 2 puntos.'
    } else {
      // Cada casilla segura entrega un punto
      player.score += 1
      room.game.revealedSafeCells += 1

      message = `Casilla segura: ${cell.nearbyMines} minas cercanas.`
    }

    // Terminar cuando todas las casillas seguras sean reveladas
    if (
      room.game.revealedSafeCells >=
      room.game.totalSafeCells
    ) {
      room.status = 'finished'
      room.game.endedAt = Date.now()

      const highestScore = Math.max(
        ...room.players.map((currentPlayer) => currentPlayer.score),
      )

      room.game.winnerIds = room.players
        .filter(
          (currentPlayer) =>
            currentPlayer.score === highestScore,
        )
        .map((currentPlayer) => currentPlayer.id)

      console.log(`La partida de la sala ${roomCode} terminó`)
    }

    callback?.({
      success: true,
      result,
      message,
      score: player.score,
      finished: room.status === 'finished',
    })

    sendRoomState(roomCode)
  })
// Volver a jugar en la misma sala
socket.on('restart-game', (callback) => {
  const roomCode = socket.data.roomCode
  const room = rooms.get(roomCode)

  if (!room) {
    callback?.({
      success: false,
      message: 'La sala ya no existe',
    })
    return
  }

  if (socket.id !== room.hostId) {
    callback?.({
      success: false,
      message: 'Solo el creador puede iniciar otra partida',
    })
    return
  }

  if (room.status !== 'finished') {
    callback?.({
      success: false,
      message: 'La partida todavía no ha terminado',
    })
    return
  }

  const connectedPlayers = room.players.filter(
    (player) => player.connected,
  )

  if (connectedPlayers.length !== 3) {
    callback?.({
      success: false,
      message: 'Deben estar conectados los tres jugadores',
    })
    return
  }

  room.players.forEach((player) => {
    player.score = 0
  })

  room.status = 'playing'
  room.game = createGame(9, 9, 10)

  console.log(`La sala ${roomCode} inició una nueva partida`)

  callback?.({
    success: true,
  })

  io.to(roomCode).emit('game-restarted')
  sendRoomState(roomCode)
})

// Salir de la sala y volver al menú
socket.on('leave-room', (callback) => {
  const roomCode = socket.data.roomCode
  const room = rooms.get(roomCode)

  if (!room) {
    socket.data.roomCode = null
    socket.data.playerId = null
    socket.data.role = null
    callback?.({
      success: true,
    })
    return
  }

  const playerIndex = room.players.findIndex(
    (player) => player.id === socket.id,
  )

  if (playerIndex !== -1) {
    room.players.splice(playerIndex, 1)
  }

  socket.leave(roomCode)

  socket.data.roomCode = null
  socket.data.playerId = null
  socket.data.role = null
  
  if (room.players.length === 0) {
    rooms.delete(roomCode)
  } else {
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id
    }

    sendRoomState(roomCode)
  }

  callback?.({
    success: true,
  })
})
// Entrar a una sala como espectador
socket.on('join-as-spectator', ({ roomCode }, callback) => {
  const normalizedRoomCode = roomCode
    ?.trim()
    .toUpperCase()

  if (!normalizedRoomCode) {
    callback?.({
      success: false,
      message: 'Debes escribir el código de la sala',
    })
    return
  }

  const room = rooms.get(normalizedRoomCode)

  if (!room) {
    callback?.({
      success: false,
      message: 'La sala no existe',
    })
    return
  }

  // El espectador entra al canal de la sala,
  // pero no se agrega a room.players
  socket.join(normalizedRoomCode)

  socket.data.roomCode = normalizedRoomCode
  socket.data.playerId = null
  socket.data.role = 'spectator'

  console.log(
    `Un espectador ingresó a la sala ${normalizedRoomCode}`,
  )

  callback?.({
    success: true,
    roomCode: normalizedRoomCode,
  })

  // Envía inmediatamente el estado actual al espectador
  sendRoomState(normalizedRoomCode)
})
  // Detectar cuando un jugador se desconecta
socket.on('disconnect', () => {
  console.log(`Cliente desconectado: ${socket.id}`)

  const roomCode = socket.data.roomCode
  const room = rooms.get(roomCode)

  if (!room) {
    return
  }

  const playerIndex = room.players.findIndex(
    (player) => player.id === socket.id,
  )

  // Si era espectador, no pertenece a room.players
  if (playerIndex === -1) {
    return
  }

  // En la sala de espera se elimina al jugador
  if (room.status === 'waiting') {
    const wasHost = room.hostId === socket.id

    room.players.splice(playerIndex, 1)

    if (room.players.length === 0) {
      rooms.delete(roomCode)
      return
    }

    if (wasHost) {
      room.hostId = room.players[0].id
    }
  } else {
    // Durante o después de la partida conserva su puesto
    room.players[playerIndex].connected = false

    // Transferir el control si salió el creador
    if (room.hostId === socket.id) {
      const newHost = room.players.find(
        (player) => player.connected,
      )

      if (newHost) {
        room.hostId = newHost.id

        console.log(
          `${newHost.name} es el nuevo creador de la sala ${roomCode}`,
        )
      }
    }
  }

  sendRoomState(roomCode)
})
})

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

  function close() {
    return new Promise((resolve, reject) => {
      io.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  return { app, httpServer, io, listen, close }
}

module.exports = { createGameServer }

