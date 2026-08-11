const { randomInt, randomUUID } = require('node:crypto')

const ROOM_CODE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const PLAYER_COLORS = ['#8b5cf6', '#22c55e', '#ef4444']
const PLAYER_HEARTBEAT_TTL_MILLISECONDS = 15_000
const PLAYER_HEARTBEAT_ROOMS_KEY = 'player-heartbeat:rooms'
const CREATE_COMMAND_SCOPE = '__create__'
const TURN_DURATION_MILLISECONDS = 12_000
const INITIAL_PLAYER_LIVES = 3

function createBoard(rows, columns, mines, now) {
  const totalCells = rows * columns
  const minePositions = new Set()

  while (minePositions.size < mines) {
    minePositions.add(randomInt(totalCells))
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
      flaggedBy: [],
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
    currentTurnPlayerId: null,
    turnExpiresAt: null,
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
    currentTurnPlayerId: game.currentTurnPlayerId || null,
    turnExpiresAt: game.turnExpiresAt || null,
    cells: game.board.map((cell) => {
      let value = null

      if (cell.revealed) {
        value = cell.isMine ? 'mine' : cell.nearbyMines
      }

      return {
        index: cell.index,
        revealed: cell.revealed,
        revealedBy: cell.revealed ? cell.revealedBy : null,
        value,
        flaggedBy: cell.revealed ? [] : cell.flaggedBy || [],
      }
    }),
  }
}

function getEligiblePlayers(room) {
  return room.players.filter(
    (player) => player.connected && (player.lives ?? INITIAL_PLAYER_LIVES) > 0,
  )
}

function advanceTurn(room, currentTime) {
  const currentIndex = room.players.findIndex(
    (player) => player.id === room.game.currentTurnPlayerId,
  )
  const startIndex = currentIndex === -1 ? 0 : currentIndex + 1

  for (let offset = 0; offset < room.players.length; offset += 1) {
    const candidate = room.players[
      (startIndex + offset) % room.players.length
    ]

    if (candidate.connected && (candidate.lives ?? INITIAL_PLAYER_LIVES) > 0) {
      room.game.currentTurnPlayerId = candidate.id
      room.game.turnExpiresAt = currentTime + TURN_DURATION_MILLISECONDS
      return candidate
    }
  }

  room.game.currentTurnPlayerId = null
  room.game.turnExpiresAt = null
  return null
}

function finishGame(room, winnerIds, currentTime) {
  room.status = 'finished'
  room.game.endedAt = currentTime
  room.game.winnerIds = winnerIds
  room.game.currentTurnPlayerId = null
  room.game.turnExpiresAt = null
}

function advanceTurnOrFinish(room, currentTime, finishIfNoEligible = false) {
  const eligiblePlayers = getEligiblePlayers(room)

  if (eligiblePlayers.length === 1) {
    finishGame(
      room,
      eligiblePlayers.map((player) => player.id),
      currentTime,
    )
    return null
  }

  if (eligiblePlayers.length === 0) {
    if (finishIfNoEligible) {
      finishGame(room, [], currentTime)
      return null
    }

    room.game.currentTurnPlayerId = null
    room.game.turnExpiresAt = null
    return null
  }

  return advanceTurn(room, currentTime)
}

function finishIfOneEligiblePlayer(room, currentTime) {
  if (!room.game) return false

  const eligiblePlayers = getEligiblePlayers(room)

  if (eligiblePlayers.length !== 1) return false

  finishGame(room, [eligiblePlayers[0].id], currentTime)
  return true
}

function finishGameWithHighestScore(room, currentTime) {
  const highestScore = Math.max(
    ...room.players.map((player) => player.score),
  )
  const winnerIds = room.players
    .filter((player) => player.score === highestScore)
    .map((player) => player.id)

  finishGame(room, winnerIds, currentTime)
}

function progressAfterReveal(room, cell, currentTime) {
  if (room.game.revealedSafeCells >= room.game.totalSafeCells) {
    finishGameWithHighestScore(room, currentTime)
    return
  }

  if (room.game.currentTurnPlayerId) {
    advanceTurnOrFinish(room, currentTime, cell.isMine)
  }
}

function getPublicPlayer(player) {
  return Object.fromEntries(
    Object.entries(player).filter(([key]) =>
      key !== 'clientId' && key !== 'connectionId'),
  )
}

function heartbeatBelongsToPlayer(serializedHeartbeat, player) {
  if (!serializedHeartbeat) return false

  try {
    const heartbeat = JSON.parse(serializedHeartbeat)
    if (typeof heartbeat === 'number' && Number.isFinite(heartbeat)) return true

    return (
      heartbeat &&
      typeof heartbeat === 'object' &&
      (heartbeat.connectionId ?? null) === (player.connectionId ?? null)
    )
  } catch {
    return false
  }
}

function normalizeCommand(command = {}) {
  return { ...command, commandId: command.commandId || randomUUID() }
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

function generateRoomCode() {
  let code = ''

  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_CHARACTERS[randomInt(ROOM_CODE_CHARACTERS.length)]
  }

  return code
}

function getPublicRoom(room) {
  if (!room || room.deleted) {
    return null
  }

  return {
    roomCode: room.roomCode,
    status: room.status,
    hostId: room.hostId,
    players: room.players.map(getPublicPlayer),
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

  function playerHeartbeatValue(connectionId) {
    return JSON.stringify({
      connectionId: connectionId ?? null,
      timestamp: now(),
    })
  }

  function playerHeartbeat(roomCode, player) {
    return {
      key: playerHeartbeatKey(roomCode, player.id),
      roomsKey: keyFor(PLAYER_HEARTBEAT_ROOMS_KEY),
      roomCode,
      value: playerHeartbeatValue(player.connectionId),
      ttlMilliseconds: PLAYER_HEARTBEAT_TTL_MILLISECONDS,
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

  async function runRoomCommand(command, transition) {
    const redirect = await leaderRedirect()

    if (redirect) {
      return redirect
    }

    return repository.withRoomLock(command.roomCode, async (lock) => {
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
        if (transitionResult.heartbeat) {
          await repository.saveRoomCommandAndPlayerHeartbeat(
            room,
            command.commandId,
            result,
            transitionResult.heartbeat,
            lock,
          )
        } else {
          await repository.saveRoomAndCommand(
            room,
            command.commandId,
            result,
            lock,
          )
        }
        await publishRoomUpdated(getPublicRoom(room), {
          roomCode: room.roomCode,
          stateVersion: room.stateVersion,
          lamportClock: room.lamportClock,
          deleted: Boolean(room.deleted),
        })
      } else {
        await repository.saveCommand(
          command.roomCode,
          command.commandId,
          result,
          lock,
        )
      }

      return result
    })
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

    return repository.withRoomLock(
      `create:${command.commandId}`,
      async (lock) => {
        const duplicate = await repository.getCommand(
          CREATE_COMMAND_SCOPE,
          command.commandId,
        )

        if (duplicate) {
          return duplicate
        }

        const clientId = command.clientId || command.playerId
        let createdRoom
        let result
        let created = false

        while (!created) {
          const roomCode = generateRoomCode()
          const player = {
            id: randomUUID(),
            clientId,
            connectionId: command.connectionId,
            name: playerName,
            score: 0,
            ready: false,
            connected: true,
            color: PLAYER_COLORS[0],
          }
          createdRoom = {
            roomCode,
            status: 'waiting',
            hostId: player.id,
            players: [player],
            game: null,
            createdAt: now(),
            lamportClock: 0,
            stateVersion: 0,
          }
          advanceRoom(createdRoom, command)
          result = resultWithMetadata(command, createdRoom, {
            success: true,
            roomCode,
            player: getPublicPlayer(player),
            hostId: createdRoom.hostId,
          })
          created = await repository.createRoomAndCommand(
            createdRoom,
            command.commandId,
            result,
            lock,
            CREATE_COMMAND_SCOPE,
          )
        }

        await publishRoomUpdated(getPublicRoom(createdRoom), {
          roomCode: createdRoom.roomCode,
          stateVersion: createdRoom.stateVersion,
          lamportClock: createdRoom.lamportClock,
          deleted: false,
        })
        return result
      },
    )
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

      const clientId = command.clientId || command.playerId
      const existingPlayer = room.players.find(
        (player) =>
          player.clientId === clientId ||
          (!player.clientId && player.id === clientId),
      )

      if (existingPlayer) {
        const wasConnected = existingPlayer.connected
        const previousConnectionId = existingPlayer.connectionId
        existingPlayer.clientId = clientId
        existingPlayer.connectionId = command.connectionId
        existingPlayer.connected = true

        const currentHost = room.players.find(
          (player) => player.id === room.hostId,
        )

        if (!currentHost?.connected) {
          room.hostId = existingPlayer.id
        }

        if (
          room.status === 'playing' &&
          room.game &&
          !room.game.currentTurnPlayerId
        ) {
          advanceTurn(room, now())
        }

        return {
          mutated:
            !wasConnected || previousConnectionId !== command.connectionId,
          heartbeat: redis
            ? playerHeartbeat(normalizedCommand.roomCode, existingPlayer)
            : null,
          result: {
            success: true,
            roomCode: normalizedCommand.roomCode,
            player: getPublicPlayer(existingPlayer),
            hostId: room.hostId,
            reconnected: true,
          },
        }
      }

      const playerWithName = room.players.some(
        (player) => player.name.toLowerCase() === playerName.toLowerCase(),
      )

      if (playerWithName) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'Ese nombre ya está siendo utilizado',
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
        id: randomUUID(),
        clientId,
        connectionId: command.connectionId,
        name: playerName,
        score: 0,
        ready: false,
        connected: true,
        color,
      }
      room.players.push(player)

      return {
        mutated: true,
        heartbeat: redis
          ? playerHeartbeat(normalizedCommand.roomCode, player)
          : null,
        result: {
          success: true,
          roomCode: normalizedCommand.roomCode,
          player: getPublicPlayer(player),
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
        player.lives = INITIAL_PLAYER_LIVES
      })
      room.status = 'playing'
      room.game = createBoard(9, 9, 10, now)
      room.game.currentTurnPlayerId = connectedPlayers[0].id
      room.game.turnExpiresAt = now() + TURN_DURATION_MILLISECONDS

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

      if (!player?.connected) {
        return {
          mutated: false,
          result: {
            success: false,
            message: 'El jugador no está conectado',
          },
        }
      }

      if ((player.lives ?? INITIAL_PLAYER_LIVES) <= 0) {
        return {
          mutated: false,
          result: { success: false, code: 'PLAYER_ELIMINATED', message: 'Ya no tienes vidas' },
        }
      }

      if (
        room.game.currentTurnPlayerId &&
        room.game.currentTurnPlayerId !== command.playerId
      ) {
        return {
          mutated: false,
          result: { success: false, code: 'NOT_YOUR_TURN', message: 'No es tu turno' },
        }
      }

      if (room.game.turnExpiresAt && now() >= room.game.turnExpiresAt) {
        advanceTurnOrFinish(room, now())
        return {
          mutated: true,
          result: { success: false, code: 'TURN_EXPIRED', message: 'Tu turno terminó' },
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
      cell.flaggedBy = []

      let revealResult = 'safe'
      let message = ''

      if (cell.isMine) {
        player.score = Math.max(0, player.score - 2)
        player.lives = Math.max(0, (player.lives ?? INITIAL_PLAYER_LIVES) - 1)
        revealResult = 'mine'
        message = '¡Encontraste una mina! Pierdes 2 puntos.'
      } else {
        player.score += 1
        room.game.revealedSafeCells += 1
        message = `Casilla segura: ${cell.nearbyMines} minas cercanas.`
      }

      progressAfterReveal(room, cell, now())

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

  async function toggleFlag(command) {
    return runRoomCommand(command, async (room) => {
      if (room?.status !== 'playing' || !room.game) {
        return { mutated: false, result: { success: false, message: 'La partida no está activa' } }
      }

      const player = room.players.find((currentPlayer) => currentPlayer.id === command.playerId)
      const cellIndex = Number(command.cellIndex)
      const cell = room.game.board[cellIndex]

      if (!player?.connected || (player.lives ?? INITIAL_PLAYER_LIVES) <= 0) {
        return { mutated: false, result: { success: false, message: 'El jugador no puede realizar esta acción' } }
      }

      if (room.game.currentTurnPlayerId !== command.playerId) {
        return { mutated: false, result: { success: false, code: 'NOT_YOUR_TURN', message: 'No es tu turno' } }
      }

      if (room.game.turnExpiresAt && now() >= room.game.turnExpiresAt) {
        advanceTurnOrFinish(room, now())
        return {
          mutated: true,
          result: { success: false, code: 'TURN_EXPIRED', message: 'Tu turno terminó' },
        }
      }

      if (!Number.isInteger(cellIndex) || !cell || cell.revealed) {
        return { mutated: false, result: { success: false, message: 'La casilla no admite banderas' } }
      }

      cell.flaggedBy ??= []
      const flagIndex = cell.flaggedBy.indexOf(command.playerId)
      const flagged = flagIndex === -1

      if (flagged) cell.flaggedBy.push(command.playerId)
      else cell.flaggedBy.splice(flagIndex, 1)

      advanceTurnOrFinish(room, now())
      return { mutated: true, result: { success: true, flagged } }
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
        player.lives = INITIAL_PLAYER_LIVES
      })
      room.status = 'playing'
      room.game = createBoard(9, 9, 10, now)
      room.game.currentTurnPlayerId = connectedPlayers[0].id
      room.game.turnExpiresAt = now() + TURN_DURATION_MILLISECONDS

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

      if (
        command.disconnected &&
        room.players[playerIndex].connectionId !== command.connectionId
      ) {
        return { mutated: false, result: { success: true } }
      }

      const wasCurrentTurn =
        room.status === 'playing' &&
        room.game?.currentTurnPlayerId === command.playerId

      room.players[playerIndex].connected = false

      if (wasCurrentTurn) {
        advanceTurnOrFinish(room, now())
      } else if (room.status === 'playing') {
        finishIfOneEligiblePlayer(room, now())
      }

      if (!command.disconnected) {
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

    return repository.withRoomLock(command.roomCode, async (lock) => {
      const room = await repository.getRoom(command.roomCode)
      const player = room?.players.find(
        (currentPlayer) => currentPlayer.id === command.playerId,
      )

      if (!player?.connected || !redis) {
        return resultWithMetadata(command, room, { success: false })
      }

      if (player.connectionId == null && command.connectionId != null) {
        player.connectionId = command.connectionId
        advanceRoom(room, command)
        const result = resultWithMetadata(command, room, { success: true })
        await repository.saveRoomAndPlayerHeartbeat(
          room,
          playerHeartbeat(command.roomCode, player),
          lock,
        )
        await publishRoomUpdated(getPublicRoom(room), {
          roomCode: room.roomCode,
          stateVersion: room.stateVersion,
          lamportClock: room.lamportClock,
          deleted: Boolean(room.deleted),
        })
        return result
      }

      if (player.connectionId !== command.connectionId) {
        return resultWithMetadata(command, room, { success: false })
      }

      await repository.savePlayerHeartbeat(
        playerHeartbeatKey(command.roomCode, command.playerId),
        keyFor(PLAYER_HEARTBEAT_ROOMS_KEY),
        command.roomCode,
        playerHeartbeatValue(command.connectionId),
        PLAYER_HEARTBEAT_TTL_MILLISECONDS,
        lock,
      )

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

    return repository.withRoomLock(roomCode, async (lock) => {
      const room = await repository.getRoom(roomCode)

      if (!room || room.deleted || !redis) {
        if (redis) {
          await repository.removeHeartbeatRoom(
            keyFor(PLAYER_HEARTBEAT_ROOMS_KEY),
            roomCode,
            lock,
          )
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
        await repository.removeHeartbeatRoom(
          keyFor(PLAYER_HEARTBEAT_ROOMS_KEY),
          roomCode,
          lock,
        )

        return resultWithMetadata(command, room, {
          success: true,
          disconnectedPlayerIds: [],
        })
      }

      const heartbeatStates = await Promise.all(
        connectedPlayers.map(async (player) => ({
          player,
          alive: heartbeatBelongsToPlayer(
            await redis.get(playerHeartbeatKey(roomCode, player.id)),
            player,
          ),
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

      if (
        room.status === 'playing' &&
        expiredPlayers.some(
          (player) => player.id === room.game?.currentTurnPlayerId,
        )
      ) {
        advanceTurnOrFinish(room, now())
      } else if (room.status === 'playing') {
        finishIfOneEligiblePlayer(room, now())
      }

      const host = room.players.find((player) => player.id === room.hostId)

      if (!host?.connected) {
        const newHost = room.players.find((player) => player.connected)

        if (newHost) {
          room.hostId = newHost.id
        }
      }

      advanceRoom(room, command)
      await repository.saveRoom(room, lock)
      await publishRoomUpdated(getPublicRoom(room), {
        roomCode: room.roomCode,
        stateVersion: room.stateVersion,
        lamportClock: room.lamportClock,
        deleted: Boolean(room.deleted),
      })

      if (!room.players.some((player) => player.connected)) {
        await repository.removeHeartbeatRoom(
          keyFor(PLAYER_HEARTBEAT_ROOMS_KEY),
          roomCode,
          lock,
        )
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

  async function advanceExpiredTurn(roomCode) {
    const room = await repository.getRoom(roomCode)
    const expiresAt = room?.game?.turnExpiresAt

    if (!expiresAt || now() < expiresAt) return { success: false }

    return runRoomCommand({
      roomCode,
      commandId: `turn-expired:${roomCode}:${expiresAt}`,
      lamportClock: 0,
    }, async (currentRoom) => {
      if (
        currentRoom?.status !== 'playing' ||
        currentRoom?.game?.turnExpiresAt !== expiresAt ||
        now() < expiresAt
      ) {
        return { mutated: false, result: { success: false } }
      }

      advanceTurnOrFinish(currentRoom, now())
      return { mutated: true, result: { success: true } }
    })
  }

  async function advanceExpiredTurnsInRooms() {
    if (!coordinator.isLeader()) return []

    return Promise.all((await listRoomCodes()).map(advanceExpiredTurn))
  }

  async function getRoomState(roomCode) {
    return getPublicRoom(await repository.getRoom(roomCode))
  }

  return {
    createRoom: (command) => createRoom(normalizeCommand(command)),
    joinRoom: (command) => joinRoom(normalizeCommand(command)),
    startGame: (command) => startGame(normalizeCommand(command)),
    revealCell: (command) => revealCell(normalizeCommand(command)),
    toggleFlag: (command) => toggleFlag(normalizeCommand(command)),
    restartGame: (command) => restartGame(normalizeCommand(command)),
    leaveRoom: (command) => leaveRoom(normalizeCommand(command)),
    heartbeatPlayer: (command) => heartbeatPlayer(normalizeCommand(command)),
    reconcileExpiredPlayers,
    reconcileExpiredPlayersInRooms,
    advanceExpiredTurn,
    advanceExpiredTurnsInRooms,
    getRoomState,
  }
}

module.exports = {
  createGameCommandService,
  getPublicGame,
  getPublicRoom,
}
