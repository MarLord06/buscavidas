const { randomUUID } = require('node:crypto')

const ROOM_CODE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const PLAYER_COLORS = ['#8b5cf6', '#22c55e', '#ef4444']
const PLAYER_HEARTBEAT_TTL_MILLISECONDS = 15_000
const PLAYER_HEARTBEAT_ROOMS_KEY = 'player-heartbeat:rooms'

function createBoard(rows, columns, mines, now) {
  const totalCells = rows * columns
  const minePositions = new Set()

  while (minePositions.size < mines) {
    minePositions.add(Math.floor(Math.random() * totalCells))
  }

  const board = Array.from({ length: totalCells }, (_, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    let nearbyMines = 0

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
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

        if (
          isInsideBoard &&
          minePositions.has(nearbyRow * columns + nearbyColumn)
        ) {
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
    startedAt: now(),
    endedAt: null,
    winnerIds: [],
  }
}

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
      revealedBy: cell.revealed ? cell.revealedBy : null,
      value: cell.revealed
        ? cell.isMine
          ? 'mine'
          : cell.nearbyMines
        : null,
    })),
  }
}

function getPublicRoom(room) {
  if (!room || room.deleted) {
    return null
  }

  return {
    roomCode: room.roomCode,
    status: room.status,
    hostId: room.hostId,
    players: room.players,
    game: getPublicGame(room.game),
    lamportClock: room.lamportClock,
    stateVersion: room.stateVersion,
  }
}

function createGameCommandService({
  repository,
  coordinator,
  redis,
  keyPrefix = '',
  now = Date.now,
  publishRoomUpdated = async () => {},
}) {
  function keyFor(logicalKey) {
    return redis?.options?.keyPrefix
      ? logicalKey
      : `${keyPrefix}${logicalKey}`
  }

  function playerHeartbeatKey(roomCode, playerId) {
    return keyFor(`player:${roomCode}:${playerId}`)
  }

  function normalizeCommand(command = {}) {
    return {
      ...command,
      commandId: command.commandId || randomUUID(),
    }
  }

  async function leaderRedirect() {
    if (coordinator.isLeader()) {
      return null
    }

    return {
      success: false,
      code: 'LEADER_REDIRECT',
      leader: await coordinator.getLeader(),
    }
  }

  function resultWithMetadata(command, room, result) {
    return {
      ...result,
      commandId: command.commandId,
      lamportClock: Number(room?.lamportClock) || 0,
      stateVersion: Number(room?.stateVersion) || 0,
    }
  }

  function advanceRoom(room, command) {
    room.lamportClock = Math.max(
      Number(room.lamportClock) || 0,
      Number(command.lamportClock) || 0,
    ) + 1
    room.stateVersion = (Number(room.stateVersion) || 0) + 1
  }

  async function runRoomCommand(command, transition) {
    const redirect = await leaderRedirect()

    if (redirect) {
      return redirect
    }

    return repository.withRoomLock(command.roomCode, async () => {
      const duplicate = await repository.getCommand(
        command.roomCode,
        command.commandId,
      )

      if (duplicate) {
        return duplicate
      }

      let room = await repository.getRoom(command.roomCode)

      if (room?.deleted) {
        room = null
      }

      const transitionResult = await transition(room)

      if (transitionResult.room) {
        room = transitionResult.room
      }

      if (transitionResult.mutated) {
        advanceRoom(room, command)
      }

      const result = resultWithMetadata(
        command,
        room,
        transitionResult.result,
      )

      if (transitionResult.mutated) {
        await repository.saveRoomAndCommand(
          room,
          command.commandId,
          result,
        )
        await publishRoomUpdated(getPublicRoom(room))
      } else {
        await repository.saveCommand(
          command.roomCode,
          command.commandId,
          result,
        )
      }

      return result
    })
  }

  function generateRoomCode() {
    let code = ''

    for (let index = 0; index < 6; index += 1) {
      const position = Math.floor(Math.random() * ROOM_CODE_CHARACTERS.length)
      code += ROOM_CODE_CHARACTERS[position]
    }

    return code
  }

  async function createRoom(command) {
    const redirect = await leaderRedirect()

    if (redirect) {
      return redirect
    }

    const playerName = command.playerName?.trim()

    if (!playerName) {
      return resultWithMetadata(command, null, {
        success: false,
        message: 'Debes escribir tu nombre',
      })
    }

    let roomCode

    do {
      roomCode = generateRoomCode()
    } while (await repository.getRoom(roomCode))

    return runRoomCommand({ ...command, roomCode }, async (room) => {
      if (room) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'No se pudo crear la sala',
          },
        }
      }

      const player = {
        id: command.playerId,
        name: playerName,
        score: 0,
        ready: false,
        connected: true,
        color: PLAYER_COLORS[0],
      }
      const createdRoom = {
        roomCode,
        status: 'waiting',
        hostId: command.playerId,
        players: [player],
        game: null,
        createdAt: now(),
        lamportClock: 0,
        stateVersion: 0,
      }

      return {
        room: createdRoom,
        mutated: true,
        result: {
          success: true,
          roomCode,
          player,
          hostId: createdRoom.hostId,
        },
      }
    })
  }

  async function joinRoom(command) {
    const normalizedCommand = {
      ...command,
      roomCode: String(command.roomCode || '').trim().toUpperCase(),
    }

    return runRoomCommand(normalizedCommand, async (room) => {
      const playerName = command.playerName?.trim()

      if (!playerName) {
        return {
          mutated: false,
          result: { success: false, message: 'Debes escribir tu nombre' },
        }
      }

      if (!room) {
        return {
          mutated: false,
          result: { success: false, message: 'La sala no existe' },
        }
      }

      const existingPlayer = room.players.find(
        (player) => player.name.toLowerCase() === playerName.toLowerCase(),
      )

      if (existingPlayer) {
        if (existingPlayer.connected) {
          return {
            mutated: false,
            result: {
              success: false,
              message: 'Ese nombre ya está siendo utilizado',
            },
          }
        }

        const previousPlayerId = existingPlayer.id
        existingPlayer.id = command.playerId
        existingPlayer.connected = true

        if (room.game) {
          room.game.board.forEach((cell) => {
            if (cell.revealedBy === previousPlayerId) {
              cell.revealedBy = command.playerId
            }
          })
          room.game.winnerIds = room.game.winnerIds.map((playerId) =>
            playerId === previousPlayerId ? command.playerId : playerId,
          )
        }

        const currentHost = room.players.find(
          (player) => player.id === room.hostId,
        )

        if (!currentHost?.connected) {
          room.hostId = command.playerId
        }

        return {
          mutated: true,
          result: {
            success: true,
            roomCode: normalizedCommand.roomCode,
            player: existingPlayer,
            hostId: room.hostId,
            reconnected: true,
          },
        }
      }

      if (room.status !== 'waiting') {
        return {
          mutated: false,
          result: {
            success: false,
            message:
              'La partida ya comenzó. Solo puede regresar un jugador desconectado',
          },
        }
      }

      if (room.players.length >= 3) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'La sala ya tiene tres jugadores',
          },
        }
      }

      const usedColors = new Set(room.players.map((player) => player.color))
      const color = PLAYER_COLORS.find((item) => !usedColors.has(item))
      const player = {
        id: command.playerId,
        name: playerName,
        score: 0,
        ready: false,
        connected: true,
        color,
      }
      room.players.push(player)

      return {
        mutated: true,
        result: {
          success: true,
          roomCode: normalizedCommand.roomCode,
          player,
          hostId: room.hostId,
          reconnected: false,
        },
      }
    })
  }

  async function startGame(command) {
    return runRoomCommand(command, async (room) => {
      if (!room) {
        return {
          mutated: false,
          result: { success: false, message: 'La sala ya no existe' },
        }
      }

      if (command.playerId !== room.hostId) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'Solo el creador de la sala puede iniciar la partida',
          },
        }
      }

      const connectedPlayers = room.players.filter((player) => player.connected)

      if (connectedPlayers.length !== 3) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'Deben estar conectados los tres jugadores',
          },
        }
      }

      if (room.status !== 'waiting') {
        return {
          mutated: false,
          result: { success: false, message: 'La partida ya fue iniciada' },
        }
      }

      room.players.forEach((player) => {
        player.score = 0
      })
      room.status = 'playing'
      room.game = createBoard(9, 9, 10, now)

      return { mutated: true, result: { success: true } }
    })
  }

  async function revealCell(command) {
    return runRoomCommand(command, async (room) => {
      if (!room) {
        return {
          mutated: false,
          result: { success: false, message: 'La sala ya no existe' },
        }
      }

      if (room.status !== 'playing' || !room.game) {
        return {
          mutated: false,
          result: { success: false, message: 'La partida no está activa' },
        }
      }

      const player = room.players.find(
        (currentPlayer) => currentPlayer.id === command.playerId,
      )

      if (!player || !player.connected) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'El jugador no está conectado',
          },
        }
      }

      const cellIndex = Number(command.cellIndex)

      if (
        !Number.isInteger(cellIndex) ||
        cellIndex < 0 ||
        cellIndex >= room.game.board.length
      ) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'La casilla seleccionada no es válida',
          },
        }
      }

      const cell = room.game.board[cellIndex]

      if (cell.revealed) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'Esta casilla ya fue revelada',
          },
        }
      }

      cell.revealed = true
      cell.revealedBy = command.playerId

      let revealResult = 'safe'
      let message = ''

      if (cell.isMine) {
        player.score = Math.max(0, player.score - 2)
        revealResult = 'mine'
        message = '¡Encontraste una mina! Pierdes 2 puntos.'
      } else {
        player.score += 1
        room.game.revealedSafeCells += 1
        message = `Casilla segura: ${cell.nearbyMines} minas cercanas.`
      }

      if (room.game.revealedSafeCells >= room.game.totalSafeCells) {
        room.status = 'finished'
        room.game.endedAt = now()
        const highestScore = Math.max(
          ...room.players.map((currentPlayer) => currentPlayer.score),
        )
        room.game.winnerIds = room.players
          .filter((currentPlayer) => currentPlayer.score === highestScore)
          .map((currentPlayer) => currentPlayer.id)
      }

      return {
        mutated: true,
        result: {
          success: true,
          result: revealResult,
          message,
          score: player.score,
          finished: room.status === 'finished',
        },
      }
    })
  }

  async function restartGame(command) {
    return runRoomCommand(command, async (room) => {
      if (!room) {
        return {
          mutated: false,
          result: { success: false, message: 'La sala ya no existe' },
        }
      }

      if (command.playerId !== room.hostId) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'Solo el creador puede iniciar otra partida',
          },
        }
      }

      if (room.status !== 'finished') {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'La partida todavía no ha terminado',
          },
        }
      }

      const connectedPlayers = room.players.filter((player) => player.connected)

      if (connectedPlayers.length !== 3) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'Deben estar conectados los tres jugadores',
          },
        }
      }

      room.players.forEach((player) => {
        player.score = 0
      })
      room.status = 'playing'
      room.game = createBoard(9, 9, 10, now)

      return { mutated: true, result: { success: true } }
    })
  }

  async function leaveRoom(command) {
    return runRoomCommand(command, async (room) => {
      if (!room) {
        return { mutated: false, result: { success: true } }
      }

      const playerIndex = room.players.findIndex(
        (player) => player.id === command.playerId,
      )

      if (playerIndex === -1) {
        return { mutated: false, result: { success: true } }
      }

      if (command.disconnected && room.status !== 'waiting') {
        room.players[playerIndex].connected = false
      } else {
        room.players.splice(playerIndex, 1)
      }

      if (room.players.length === 0) {
        room.deleted = true
      } else if (room.hostId === command.playerId) {
        const newHost = command.disconnected
          ? room.players.find((player) => player.connected)
          : room.players[0]

        if (newHost) {
          room.hostId = newHost.id
        }
      }

      return { mutated: true, result: { success: true } }
    })
  }

  async function heartbeatPlayer(command) {
    const redirect = await leaderRedirect()

    if (redirect) {
      return redirect
    }

    return repository.withRoomLock(command.roomCode, async () => {
      const room = await repository.getRoom(command.roomCode)
      const player = room?.players.find(
        (currentPlayer) => currentPlayer.id === command.playerId,
      )

      if (!player?.connected || !redis) {
        return resultWithMetadata(command, room, { success: false })
      }

      const transactionResults = await redis
        .multi()
        .set(
          playerHeartbeatKey(command.roomCode, command.playerId),
          String(now()),
          'PX',
          PLAYER_HEARTBEAT_TTL_MILLISECONDS,
        )
        .sadd(keyFor(PLAYER_HEARTBEAT_ROOMS_KEY), command.roomCode)
        .exec()
      const failedCommand = transactionResults.find(([error]) => error)

      if (failedCommand) {
        throw failedCommand[0]
      }

      return resultWithMetadata(command, room, { success: true })
    })
  }

  async function reconcileExpiredPlayers(roomCode) {
    const command = normalizeCommand({
      roomCode,
      commandId: `reconcile-expired:${randomUUID()}`,
      lamportClock: 0,
    })

    const redirect = await leaderRedirect()

    if (redirect) {
      return redirect
    }

    return repository.withRoomLock(roomCode, async () => {
      const room = await repository.getRoom(roomCode)

      if (!room || room.deleted || !redis) {
        if (redis) {
          await redis.srem(keyFor(PLAYER_HEARTBEAT_ROOMS_KEY), roomCode)
        }

        return resultWithMetadata(command, room, {
          success: Boolean(room && !room.deleted),
          disconnectedPlayerIds: [],
        })
      }

      const connectedPlayers = room.players.filter(
        (player) => player.connected,
      )

      if (connectedPlayers.length === 0) {
        await redis.srem(keyFor(PLAYER_HEARTBEAT_ROOMS_KEY), roomCode)

        return resultWithMetadata(command, room, {
          success: true,
          disconnectedPlayerIds: [],
        })
      }

      const heartbeatStates = await Promise.all(
        connectedPlayers.map(async (player) => ({
          player,
          alive: Boolean(await redis.exists(
            playerHeartbeatKey(roomCode, player.id),
          )),
        })),
      )
      const expiredPlayers = heartbeatStates
        .filter(({ alive }) => !alive)
        .map(({ player }) => player)

      if (expiredPlayers.length === 0) {
        return resultWithMetadata(command, room, {
          success: true,
          disconnectedPlayerIds: [],
        })
      }

      for (const player of expiredPlayers) {
        player.connected = false
      }

      const host = room.players.find((player) => player.id === room.hostId)

      if (!host?.connected) {
        const newHost = room.players.find((player) => player.connected)

        if (newHost) {
          room.hostId = newHost.id
        }
      }

      advanceRoom(room, command)
      await repository.saveRoom(room)
      await publishRoomUpdated(getPublicRoom(room))

      if (!room.players.some((player) => player.connected)) {
        await redis.srem(keyFor(PLAYER_HEARTBEAT_ROOMS_KEY), roomCode)
      }

      return resultWithMetadata(command, room, {
        success: true,
        disconnectedPlayerIds: expiredPlayers.map((player) => player.id),
      })
    })
  }

  async function listRoomCodes() {
    if (!redis) {
      return []
    }

    return redis.smembers(keyFor(PLAYER_HEARTBEAT_ROOMS_KEY))
  }

  async function reconcileExpiredPlayersInRooms() {
    if (!coordinator.isLeader()) {
      return []
    }

    const roomCodes = await listRoomCodes()

    return Promise.all(roomCodes.map(reconcileExpiredPlayers))
  }

  async function getRoomState(roomCode) {
    return getPublicRoom(await repository.getRoom(roomCode))
  }

  return {
    createRoom: (command) => createRoom(normalizeCommand(command)),
    joinRoom: (command) => joinRoom(normalizeCommand(command)),
    startGame: (command) => startGame(normalizeCommand(command)),
    revealCell: (command) => revealCell(normalizeCommand(command)),
    restartGame: (command) => restartGame(normalizeCommand(command)),
    leaveRoom: (command) => leaveRoom(normalizeCommand(command)),
    heartbeatPlayer: (command) => heartbeatPlayer(normalizeCommand(command)),
    reconcileExpiredPlayers,
    reconcileExpiredPlayersInRooms,
    getRoomState,
  }
}

module.exports = {
  createGameCommandService,
  getPublicGame,
  getPublicRoom,
}
