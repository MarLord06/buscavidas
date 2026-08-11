import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import Dashboard from './Dashboard'
import { emitCommand, socket } from './socket'
import './App.css'

const NUMBER_COLORS = {
  1: '#60a5fa',
  2: '#4ade80',
  3: '#f87171',
  4: '#c084fc',
  5: '#fb923c',
  6: '#22d3ee',
  7: '#f8fafc',
  8: '#94a3b8',
}

function getNumberColor(value) {
  return NUMBER_COLORS[value] || '#ffffff'
}

function getCellContent(cell, isMine) {
  if (!cell.revealed || cell.value === 0) return ''
  return isMine ? '💣' : cell.value
}

function getCellBackground(cell, isMine) {
  if (!cell.revealed) return 'linear-gradient(145deg, #6d4ca1, #49316d)'
  return isMine ? 'linear-gradient(145deg, #dc2626, #7f1d1d)' : '#241b35'
}

function getCellBorder(cell, revealingPlayer) {
  if (!cell.revealed) return '1px solid #8b6dbc'
  return `2px solid ${revealingPlayer?.color || '#67547e'}`
}

function getDisplayedGameMessage(room, isSpectator, finalMessage, gameMessage) {
  if (room.status === 'finished') return finalMessage
  if (isSpectator) return '👁 Estás observando la partida en tiempo real.'
  return gameMessage
}

function getFlagOwners(cell, players) {
  return (cell.flaggedBy || [])
    .map((playerId) => players.find((player) => player.id === playerId))
    .filter(Boolean)
}

function getTurnSecondsRemaining(turnExpiresAt, currentTime) {
  if (!turnExpiresAt) return 0
  return Math.max(0, Math.ceil((turnExpiresAt - currentTime) / 1000))
}

function LobbyAction({ connectedPlayers, isHost, loading, onStart, hostName }) {
  if (connectedPlayers < 3) {
    return (
      <div className="waiting-message">
        Esperando a los demás jugadores...
      </div>
    )
  }

  if (isHost) {
    return (
      <button
        className="start-button"
        type="button"
        onClick={onStart}
        disabled={loading}
      >
        {loading ? 'Iniciando...' : 'Iniciar partida'}
      </button>
    )
  }

  return (
    <div className="waiting-message ready-message">
      Esperando que {hostName || 'el creador'} inicie la partida...
    </div>
  )
}

function GameApp() { // NOSONAR -- coordinador de estado, eventos Socket.IO y tres vistas del juego.
  const publicClientUrl = (
    import.meta.env.VITE_PUBLIC_URL || window.location.origin
  ).replace(/\/$/, '')
  const [playerName, setPlayerName] = useState('')
  const [roomInput, setRoomInput] = useState(() => {
    const roomCode = new URLSearchParams(window.location.search).get('room')
    return roomCode?.trim().toUpperCase() || ''
  })
  const [room, setRoom] = useState(null)
  const [lastStateVersion, setLastStateVersion] = useState(0)
  const [currentPlayerId, setCurrentPlayerId] = useState('')
  const [error, setError] = useState('')
  const [isSpectator, setIsSpectator] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pendingCell, setPendingCell] = useState(null)
  const [actionMode, setActionMode] = useState('reveal')
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [gameMessage, setGameMessage] = useState(
    'Selecciona una casilla para comenzar.',
  )

  useEffect(() => {
    function handleRoomUpdated(updatedRoom) {
      const incomingVersion = Number(updatedRoom?.stateVersion) || 0

      setLastStateVersion((currentVersion) =>
        Math.max(currentVersion, incomingVersion),
      )
      setRoom((currentRoom) => {
        const currentVersion = Number(currentRoom?.stateVersion) || 0
        return incomingVersion >= currentVersion ? updatedRoom : currentRoom
      })
    }

    function handleConnectionError() {
      setLoading(false)
      setPendingCell(null)
      setError('No se pudo conectar con el servidor')
    }

    function handleGameRestarted() {
    setPendingCell(null)
    setError('')
    setGameMessage(
      'Nueva partida iniciada. Selecciona una casilla.',
    )
  }
    socket.on('room-updated', handleRoomUpdated)
    socket.on('connect_error', handleConnectionError)
    socket.on('game-restarted', handleGameRestarted)

    return () => {
      socket.off('room-updated', handleRoomUpdated)
      socket.off('connect_error', handleConnectionError)
      socket.off('game-restarted', handleGameRestarted)
    }
  }, [])

  useEffect(() => {
    if (!room?.roomCode || isSpectator) {
      return undefined
    }

    const heartbeat = () => {
      emitCommand('player-heartbeat', {})
    }
    const heartbeatTimer = window.setInterval(heartbeat, 5000)

    return () => window.clearInterval(heartbeatTimer)
  }, [room?.roomCode, isSpectator])

  useEffect(() => {
    if (room?.status !== 'playing' || !room.game?.turnExpiresAt) {
      return undefined
    }

    const timer = window.setInterval(() => setCurrentTime(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [room?.status, room?.game?.turnExpiresAt])

  function createRoom() {
    if (!playerName.trim()) {
      setError('Debes escribir tu nombre')
      return
    }

    setError('')
    setLoading(true)

    emitCommand(
      'create-room',
      {
        playerName: playerName.trim(),
      },
      (response) => {
        setLoading(false)

        if (!response?.success) {
          setError(response?.message || 'No se pudo crear la sala')
          return
        }

        setCurrentPlayerId(response.player.id)
        setIsSpectator(false)
        const createdRoom = {
          roomCode: response.roomCode,
          status: 'waiting',
          hostId: response.hostId,
          players: [response.player],
          game: null,
          lamportClock: response.lamportClock,
          stateVersion: response.stateVersion,
        }
        setRoom(createdRoom)
        setLastStateVersion(Number(response.stateVersion) || 0)
      },
    )
  }

  function joinRoom() {
    if (!playerName.trim()) {
      setError('Debes escribir tu nombre')
      return
    }

    if (!roomInput.trim()) {
      setError('Debes escribir el código de la sala')
      return
    }

    setError('')
    setLoading(true)

    emitCommand(
      'join-room',
      {
        playerName: playerName.trim(),
        roomCode: roomInput.trim().toUpperCase(),
      },
      (response) => {
        setLoading(false)

        if (!response?.success) {
          setError(response?.message || 'No se pudo ingresar a la sala')
          return
        }

        setCurrentPlayerId(response.player.id)
        setIsSpectator(false)
        const joinedRoom = {
          roomCode: response.roomCode,
          status: 'waiting',
          hostId: response.hostId,
          players: [response.player],
          game: null,
          lamportClock: response.lamportClock,
          stateVersion: response.stateVersion,
        }
        setRoom(joinedRoom)
        setLastStateVersion(Number(response.stateVersion) || 0)
      },
    )
  }
function joinAsSpectator() {
  if (!roomInput.trim()) {
    setError('Debes escribir el código de la sala')
    return
  }

  setError('')
  setLoading(true)
  setIsSpectator(true)

  socket.emit(
    'join-as-spectator',
    {
      roomCode: roomInput.trim().toUpperCase(),
    },
    (response) => {
      setLoading(false)

      if (!response?.success) {
        setIsSpectator(false)
        setError(
          response?.message ||
            'No se pudo entrar como espectador',
        )
        return
      }

      setCurrentPlayerId('')
      setGameMessage(
        'Estás observando la partida en tiempo real.',
      )
    },
  )
}
  function startGame() {
    setError('')
    setLoading(true)

    emitCommand('start-game', {}, (response) => {
      setLoading(false)

      if (!response?.success) {
        setError(response?.message || 'No se pudo iniciar la partida')
        return
      }

      setGameMessage('La partida comenzó. Selecciona una casilla.')
    })
  }
function restartGame() {
  setLoading(true)
  setError('')
  setGameMessage('Preparando una nueva partida...')

  emitCommand('restart-game', {}, (response) => {
    setLoading(false)

    if (!response?.success) {
      setGameMessage(
        response?.message || 'No se pudo iniciar otra partida',
      )
      return
    }

    setGameMessage(
      'Nueva partida iniciada. Selecciona una casilla.',
    )
  })
}
function returnToMenu() {
  setLoading(true)
  setError('')

  emitCommand('leave-room', {}, (response) => {
    setLoading(false)

    if (!response?.success) {
      const message =
        response?.message || 'No se pudo salir de la sala'

      setError(message)
      setGameMessage(message)
      return
    }

    setRoom(null)
    setLastStateVersion(0)
    setCurrentPlayerId('')
    setIsSpectator(false)
    setRoomInput('')
    setPendingCell(null)
    setGameMessage('Selecciona una casilla para comenzar.')
  })
}
  function revealCell(cellIndex) {
  if (
    isSpectator ||
    room?.status !== 'playing' ||
    pendingCell !== null
  ) {
    return
  }

    setPendingCell(cellIndex)
    setGameMessage('Revelando casilla...')

    emitCommand(
      'reveal-cell',
      {
        cellIndex,
      },
      (response) => {
        setPendingCell(null)

        if (!response?.success) {
          setGameMessage(
            response?.message || 'No se pudo revelar la casilla',
          )
          return
        }

        setGameMessage(response.message)
      },
    )
  }

  function toggleFlag(cellIndex) {
    if (isSpectator || room?.status !== 'playing' || pendingCell !== null) return

    setPendingCell(cellIndex)
    emitCommand('toggle-flag', { cellIndex }, (response) => {
      setPendingCell(null)
      setGameMessage(
        response?.success
          ? response.flagged ? 'Bandera colocada.' : 'Bandera retirada.'
          : response?.message || 'No se pudo cambiar la bandera',
      )
    })
  }

  if (
    room?.status === 'playing' ||
    room?.status === 'finished'
  ) {
    const rows = room.game?.rows || 9
    const columns = room.game?.columns || 9
    const mines = room.game?.mines || 10
    const totalCells = rows * columns

    const cells =
      room.game?.cells ||
      Array.from({ length: totalCells }, (_, index) => ({
        index,
        revealed: false,
        revealedBy: null,
        value: null,
      }))

    const winnerIds = room.game?.winnerIds || []
    const currentTurnPlayerId = room.game?.currentTurnPlayerId
    const currentTurnPlayer = room.players.find(
      (player) => player.id === currentTurnPlayerId,
    )
    const isCurrentTurn = currentTurnPlayerId === currentPlayerId
    const turnSecondsRemaining = getTurnSecondsRemaining(
      room.game?.turnExpiresAt,
      currentTime,
    )

    const winnerNames = room.players
      .filter((player) => winnerIds.includes(player.id))
      .map((player) => player.name)

    let finalMessage = 'La partida terminó.'

    if (winnerNames.length === 1) {
      finalMessage = `🏆 Ganador: ${winnerNames[0]}`
    } else if (winnerNames.length > 1) {
      finalMessage = `🤝 Empate entre: ${winnerNames.join(', ')}`
    }

    return (
      <main className="game-page">
        <section className="game-container">
          <header className="game-header">
            <div>
              <p className="game-title">
                Buscaminas Tripartito
              </p>

              <p className="game-room">
                Sala: {room.roomCode}
                {' · '}Versión {lastStateVersion}
              </p>
              {isSpectator && (
                <div className="spectator-badge">
                  👁 Modo espectador
                </div>
                )}
            </div>

            <div className="mines-counter">
              💣 Minas: {mines}
            </div>
          </header>

          <section className="scoreboard">
            {room.players.map((player) => (
              <div
                className={
                  player.id === currentPlayerId
                    ? 'score-card current-player'
                    : 'score-card'
                }
                key={player.id}
              >
                <span
                  className="player-color"
                  style={{
                    backgroundColor: player.color,
                  }}
                />

                <div className="score-info">
                  <span className="score-name">
                    {player.name}
                    {player.id === currentPlayerId
                      ? ' (Tú)'
                      : ''}
                  </span>

                  <span className="score-points">
                    {player.score ?? 0} puntos
                  </span>
                  <span className="score-points">
                    {(player.lives ?? 3) > 0
                      ? `${player.lives ?? 3} vidas`
                      : 'Eliminado'}
                  </span>
                </div>
              </div>
            ))}
          </section>

          <section className="board-section">
            <p data-testid="turn-status" className="game-message">
              {currentTurnPlayer
                ? `Turno de ${currentTurnPlayer.name} · ${turnSecondsRemaining}s`
                : 'Esperando turno'}
            </p>
            {!isSpectator && room.status === 'playing' && (
              <div className="game-actions">
                <button
                  className={actionMode === 'reveal' ? 'action-mode active' : 'action-mode'}
                  type="button"
                  onClick={() => setActionMode('reveal')}
                  disabled={!isCurrentTurn}
                >
                  Revelar
                </button>
                <button
                  className={actionMode === 'flag' ? 'action-mode active' : 'action-mode'}
                  type="button"
                  onClick={() => setActionMode('flag')}
                  disabled={!isCurrentTurn}
                >
                  Bandera
                </button>
              </div>
            )}
            <div
              className="game-board"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {cells.map((cell) => {
                const revealingPlayer = room.players.find(
                  (player) =>
                    player.id === cell.revealedBy,
                )

                const isMine =
                  cell.revealed && cell.value === 'mine'

                const cellContent = getCellContent(cell, isMine)
                const flagOwners = getFlagOwners(cell, room.players)
                const flagDescription = flagOwners.length > 0
                  ? `, ${flagOwners.length} bandera${flagOwners.length === 1 ? '' : 's'} de ${flagOwners.map((player) => player.name).join(', ')}`
                  : ''

                const cellDisabled =
                  isSpectator ||
                  cell.revealed ||
                  room.status === 'finished' ||
                  pendingCell !== null ||
                  !isCurrentTurn

                return (
                  <button
                    className="board-cell covered-cell"
                    type="button"
                    aria-label={`Casilla ${cell.index + 1}${flagDescription}`}
                    key={cell.index}
                    onClick={() => {
                      if (actionMode === 'flag') toggleFlag(cell.index)
                      else revealCell(cell.index)
                    }}
                    disabled={cellDisabled}
                    style={{
                      width: '100%',
                      minWidth: 0,
                      aspectRatio: '1 / 1',
                      padding: 0,
                      cursor: cellDisabled
                        ? 'default'
                        : 'pointer',
                      background: getCellBackground(cell, isMine),
                      border: getCellBorder(cell, revealingPlayer),
                      borderRadius: '5px',
                      color: isMine
                        ? '#ffffff'
                        : getNumberColor(cell.value),
                      fontSize: '18px',
                      fontWeight: 800,
                      opacity: 1,
                    }}
                  >
                    {flagOwners.length > 0 && !cell.revealed ? (
                      <span className="cell-flags" aria-hidden="true">
                        {flagOwners.map((player) => (
                          <span
                            className="cell-flag"
                            key={player.id}
                            style={{ backgroundColor: player.color }}
                          >
                            ⚑
                          </span>
                        ))}
                      </span>
                    ) : cellContent}
                  </button>
                )
              })}
            </div>
          </section>

          <p className="game-message">
            {getDisplayedGameMessage(
              room,
              isSpectator,
              finalMessage,
              gameMessage,
            )}
          </p>

{isSpectator && room.status === 'playing' && (
  <div className="game-actions">
    <button
      className="menu-button"
      type="button"
      onClick={returnToMenu}
      disabled={loading}
    >
      🏠 Volver al menú
    </button>
  </div>
)}

{room.status === 'finished' && (
  <div className="game-actions">
    {!isSpectator &&
      (currentPlayerId === room.hostId ? (
        <button
          className="restart-button"
          type="button"
          onClick={restartGame}
          disabled={loading}
        >
          {loading
            ? 'Preparando...'
            : '🔄 Jugar de nuevo'}
        </button>
      ) : (
        <div className="restart-waiting">
          Esperando que el creador inicie otra partida...
        </div>
      ))}

    <button
      className="menu-button"
      type="button"
      onClick={returnToMenu}
      disabled={loading}
    >
      🏠 Volver al menú
    </button>
  </div>
)}
        </section>
      </main>
    )
  }

  if (room) {
    const connectedPlayers = room.players.filter(
      (player) => player.connected,
    ).length

    const isHost = currentPlayerId === room.hostId

    const hostPlayer = room.players.find(
      (player) => player.id === room.hostId,
    )

    return (
      <main className="home">
        <section className="menu lobby">
          <div className="mine-icon">💣</div>

          <p className="room-label">Código de la sala</p>

          <h1 className="room-code" data-testid="room-code">
            {room.roomCode}
          </h1>

          <p className="room-version-label">
            Versión{' '}
            <span data-testid="room-version">{lastStateVersion}</span>
          </p>

          <div className="room-share">
            <a
              data-testid="room-share-link"
              href={`${publicClientUrl}/?room=${encodeURIComponent(room.roomCode)}`}
            >
              <QRCodeSVG
                data-testid="room-qr"
                value={`${publicClientUrl}/?room=${encodeURIComponent(room.roomCode)}`}
                size={148}
                bgColor="#ffffff"
                fgColor="#160f25"
                level="M"
                title={`Abrir sala ${room.roomCode}`}
              />
            </a>
            <span>Escanea para abrir la sala {room.roomCode}</span>
          </div>

          <a
            className="dashboard-link"
            data-testid="dashboard-link"
            href="/dashboard"
          >
            Ver dashboard del clúster
          </a>

          <p>Jugadores conectados: {connectedPlayers}/3</p>
            {isSpectator && (
              <div className="spectator-badge">
                👁 Modo espectador
              </div>
      )}
          <div className="players-list">
            {room.players.map((player, index) => (
              <div className="player-card" key={player.id}>
                <span
                  className="player-color"
                  style={{
                    backgroundColor: player.color,
                  }}
                />

                <span className="player-name">
                  {index + 1}. {player.name}
                  {player.id === currentPlayerId
                    ? ' (Tú)'
                    : ''}
                  {player.id === room.hostId ? ' 👑' : ''}
                </span>

                <span
                  className={
                    player.connected
                      ? 'connection connected'
                      : 'connection disconnected'
                  }
                >
                  {player.connected
                    ? 'Conectado'
                    : 'Desconectado'}
                </span>
              </div>
            ))}
          </div>

          <LobbyAction
            connectedPlayers={connectedPlayers}
            isHost={isHost}
            loading={loading}
            onStart={startGame}
            hostName={hostPlayer?.name}
          />
          {isSpectator && (
            <button
              className="menu-button spectator-leave-button"
              type="button"
              onClick={returnToMenu}
              disabled={loading}
            >
              🏠 Volver al menú
            </button>
          )}
          {error && (
            <div className="error-message">{error}</div>
          )}
        </section>
      </main>
    )
  }

  return (
    <main className="home">
      <section className="menu">
        <div className="mine-icon">💣</div>

        <h1>Buscaminas Tripartito</h1>

        <p>Partida competitiva para tres jugadores</p>

        <a
          className="dashboard-link dashboard-link-home"
          data-testid="dashboard-link"
          href="/dashboard"
        >
          Ver dashboard del clúster
        </a>

        <input
          data-testid="player-name-input"
          type="text"
          placeholder="Escribe tu nombre"
          maxLength="15"
          value={playerName}
          onChange={(event) => {
            setPlayerName(event.target.value)
          }}
        />

        <button
          data-testid="create-room-button"
          className="create-button"
          type="button"
          onClick={createRoom}
          disabled={loading}
        >
          {loading ? 'Procesando...' : 'Crear partida'}
        </button>

        <div className="separator">
          <span>o ingresa a una sala</span>
        </div>

        <input
          type="text"
          placeholder="Código de sala"
          maxLength="6"
          value={roomInput}
          onChange={(event) => {
            const value = event.target.value
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, '')

            setRoomInput(value)
          }}
        />

        <button
          className="join-button"
          type="button"
          onClick={joinRoom}
          disabled={loading}
        >
          {loading
            ? 'Procesando...'
            : 'Unirse a la partida'}
        </button>

        <button
          className="spectator-button"
          type="button"
          onClick={joinAsSpectator}
          disabled={loading}
        >
          {loading
            ? 'Procesando...'
            : 'Entrar como espectador'}
        </button>

        {error && (
          <div className="error-message">{error}</div>
        )}
      </section>
    </main>
  )
}

function App() {
  if (window.location.pathname === '/dashboard') {
    return <Dashboard />
  }

  return <GameApp />
}

export default App
