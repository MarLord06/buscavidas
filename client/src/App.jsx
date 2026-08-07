import { useEffect, useState } from 'react'
import { socket } from './socket'
import './App.css'

function App() {
  const [playerName, setPlayerName] = useState('')
  const [roomInput, setRoomInput] = useState('')
  const [room, setRoom] = useState(null)
  const [currentPlayerId, setCurrentPlayerId] = useState('')
  const [error, setError] = useState('')
  const [isSpectator, setIsSpectator] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pendingCell, setPendingCell] = useState(null)
  const [gameMessage, setGameMessage] = useState(
    'Selecciona una casilla para comenzar.',
  )

  useEffect(() => {
    function handleRoomUpdated(updatedRoom) {
      setRoom(updatedRoom)
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

  function createRoom() {
    if (!playerName.trim()) {
      setError('Debes escribir tu nombre')
      return
    }

    setError('')
    setLoading(true)

    socket.emit(
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
        setRoom({
          roomCode: response.roomCode,
          status: 'waiting',
          hostId: response.hostId,
          players: [response.player],
          game: null,
        })
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

    socket.emit(
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
        setRoom({
          roomCode: response.roomCode,
          status: 'waiting',
          hostId: response.hostId,
          players: [response.player],
          game: null,
        })
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

    socket.emit('start-game', (response) => {
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

  socket.emit('restart-game', (response) => {
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

  socket.emit('leave-room', (response) => {
    setLoading(false)

    if (!response?.success) {
      const message =
        response?.message || 'No se pudo salir de la sala'

      setError(message)
      setGameMessage(message)
      return
    }

    setRoom(null)
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

    socket.emit(
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

  function getNumberColor(value) {
    const colors = {
      1: '#60a5fa',
      2: '#4ade80',
      3: '#f87171',
      4: '#c084fc',
      5: '#fb923c',
      6: '#22d3ee',
      7: '#f8fafc',
      8: '#94a3b8',
    }

    return colors[value] || '#ffffff'
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
                </div>
              </div>
            ))}
          </section>

          <section className="board-section">
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

                const cellContent = cell.revealed
                  ? isMine
                    ? '💣'
                    : cell.value === 0
                      ? ''
                      : cell.value
                  : ''

                const cellDisabled =
                  isSpectator ||
                  cell.revealed ||
                  room.status === 'finished' ||
                  pendingCell !== null

                return (
                  <button
                    className="board-cell covered-cell"
                    type="button"
                    aria-label={`Casilla ${cell.index + 1}`}
                    key={cell.index}
                    onClick={() => {
                      revealCell(cell.index)
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
                      background: cell.revealed
                        ? isMine
                          ? 'linear-gradient(145deg, #dc2626, #7f1d1d)'
                          : '#241b35'
                        : 'linear-gradient(145deg, #6d4ca1, #49316d)',
                      border: cell.revealed
                        ? `2px solid ${
                            revealingPlayer?.color || '#67547e'
                          }`
                        : '1px solid #8b6dbc',
                      borderRadius: '5px',
                      color: isMine
                        ? '#ffffff'
                        : getNumberColor(cell.value),
                      fontSize: '18px',
                      fontWeight: 800,
                      opacity: 1,
                    }}
                  >
                    {cellContent}
                  </button>
                )
              })}
            </div>
          </section>

          <p className="game-message">
  {room.status === 'finished'
    ? finalMessage
    : isSpectator
      ? '👁 Estás observando la partida en tiempo real.'
      : gameMessage}
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

          <h1 className="room-code">{room.roomCode}</h1>

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

          {connectedPlayers < 3 ? (
            <div className="waiting-message">
              Esperando a los demás jugadores...
            </div>
          ) : isHost ? (
            <button
              className="start-button"
              type="button"
              onClick={startGame}
              disabled={loading}
            >
              {loading
                ? 'Iniciando...'
                : 'Iniciar partida'}
            </button>
          ) : (
            <div className="waiting-message ready-message">
              Esperando que{' '}
              {hostPlayer?.name || 'el creador'} inicie la
              partida...
            </div>
          )}
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

        <input
          type="text"
          placeholder="Escribe tu nombre"
          maxLength="15"
          value={playerName}
          onChange={(event) => {
            setPlayerName(event.target.value)
          }}
        />

        <button
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

export default App