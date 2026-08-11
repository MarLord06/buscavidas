import { useEffect, useState } from 'react'
import {
  getLamportClock,
  subscribeLamportClock,
} from './cluster'
import { socket } from './socket'
import './Dashboard.css'

const EMPTY_STATUS = {
  leader: null,
  nodes: [],
  rooms: [],
  events: [],
}

function normalizeRooms(rooms) {
  if (Array.isArray(rooms)) {
    return rooms
  }

  return Object.values(rooms || {})
}

function latestRoom(currentRoom, incomingRoom) {
  const currentVersion = Number(currentRoom?.stateVersion) || 0
  const incomingVersion = Number(incomingRoom?.stateVersion) || 0
  return incomingVersion >= currentVersion ? incomingRoom : currentRoom
}

function updateClusterStatus(currentStatus, clusterStatus) {
  return {
    ...EMPTY_STATUS,
    ...clusterStatus,
    nodes: clusterStatus.nodes || [],
    rooms: normalizeRooms(clusterStatus.rooms).map((incomingRoom) => {
      const currentRoom = currentStatus.rooms.find(
        (room) => room.roomCode === incomingRoom.roomCode,
      )
      return latestRoom(currentRoom, incomingRoom)
    }),
    events: clusterStatus.events || [],
  }
}

function updateLeader(currentStatus, leader) {
  return {
    ...currentStatus,
    leader,
    events: [
      {
        type: 'leader-changed',
        message: `Nodo ${leader?.nodeId ?? 'desconocido'} es el líder`,
      },
      ...currentStatus.events,
    ].slice(0, 12),
  }
}

function updateRoom(currentStatus, room) {
  const currentRoom = currentStatus.rooms.find(
    (candidate) => candidate.roomCode === room.roomCode,
  )
  const otherRooms = currentStatus.rooms.filter(
    (candidate) => candidate.roomCode !== room.roomCode,
  )

  return {
    ...currentStatus,
    rooms: [...otherRooms, latestRoom(currentRoom, room)],
  }
}

function Dashboard() {
  const [status, setStatus] = useState(EMPTY_STATUS)
  const [localClock, setLocalClock] = useState(getLamportClock())

  useEffect(() => {
    function handleClusterStatus(clusterStatus = {}) {
      setStatus((currentStatus) =>
        updateClusterStatus(currentStatus, clusterStatus),
      )
    }

    function handleLeaderChanged(leader) {
      setStatus((currentStatus) => updateLeader(currentStatus, leader))
    }

    function handleRoomUpdated(room) {
      setStatus((currentStatus) => updateRoom(currentStatus, room))
    }

    const unsubscribeClock = subscribeLamportClock(setLocalClock)
    socket.on('cluster-status', handleClusterStatus)
    socket.on('leader-changed', handleLeaderChanged)
    socket.on('room-updated', handleRoomUpdated)
    socket.emit('subscribe-dashboard')

    return () => {
      unsubscribeClock()
      socket.off('cluster-status', handleClusterStatus)
      socket.off('leader-changed', handleLeaderChanged)
      socket.off('room-updated', handleRoomUpdated)
    }
  }, [])

  const clock = status.lamportClock ?? localClock

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">Telemetría distribuida</p>
          <h1>Dashboard del clúster</h1>
        </div>
        <a href="/">Volver al juego</a>
      </header>

      <section className="dashboard-summary">
        <article className="dashboard-card leader-card">
          <span>Líder actual</span>
          <strong data-testid="cluster-leader">
            {status.leader
              ? `Nodo ${status.leader.nodeId}`
              : 'Sin líder anunciado'}
          </strong>
          <small>{status.leader?.publicUrl || 'Esperando telemetría'}</small>
        </article>

        <article className="dashboard-card">
          <span>Reloj Lamport</span>
          <strong data-testid="lamport-clock">{clock}</strong>
          <small>Orden lógico observado</small>
        </article>

        <article className="dashboard-card">
          <span>Salas observadas</span>
          <strong>{status.rooms.length}</strong>
          <small>Estado compartido en Redis</small>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="dashboard-panel">
          <h2>Nodos</h2>
          <div className="node-list">
            {status.nodes.length === 0 ? (
              <p className="empty-dashboard">Esperando cluster-status…</p>
            ) : (
              status.nodes.map((node) => {
                const alive = node.alive ?? node.status !== 'down'

                return (
                  <div
                    className="node-row"
                    data-testid="cluster-node"
                    key={node.nodeId}
                  >
                    <span className={alive ? 'node-dot alive' : 'node-dot'} />
                    <div>
                      <strong>Nodo {node.nodeId}</strong>
                      <small>{node.publicUrl}</small>
                    </div>
                    <span>{alive ? 'Vivo' : 'Caído'}</span>
                  </div>
                )
              })
            )}
          </div>
        </article>

        <article className="dashboard-panel">
          <h2>Salas</h2>
          {status.rooms.length === 0 ? (
            <p className="empty-dashboard">No hay salas activas.</p>
          ) : (
            status.rooms.map((room) => (
              <div className="room-row" key={room.roomCode}>
                <div>
                  <strong>{room.roomCode}</strong>
                  <small>{room.playerCount ?? room.players?.length ?? 0} jugadores</small>
                </div>
                <span>
                  {'v'}<b data-testid="room-version">
                    {room.stateVersion ?? 0}
                  </b>
                </span>
              </div>
            ))
          )}
        </article>

        <article className="dashboard-panel events-panel">
          <h2>Últimos eventos</h2>
          {status.events.length === 0 ? (
            <p className="empty-dashboard">Aún no hay eventos.</p>
          ) : (
            <ol className="event-list">
              {status.events.map((event, index) => (
                <li data-testid="cluster-event" key={`${event.type}-${index}`}>
                  <span>{event.type || 'evento'}</span>
                  <p>{event.message || String(event)}</p>
                </li>
              ))}
            </ol>
          )}
        </article>
      </section>

      <p className="redis-warning">
        Redis es el punto compartido de coordinación; sin Redis el clúster no
        puede continuar.
      </p>
    </main>
  )
}

export default Dashboard
