import { io } from 'socket.io-client'
import {
  createCommandMetadata,
  observeIncomingEvent,
} from './cluster'

const browserProtocol =
  window.location.protocol === 'https:' ? 'https:' : 'http:'
const browserHost = window.location.hostname
const serverUrl =
  import.meta.env.VITE_SERVER_URL || `${browserProtocol}//${browserHost}:3003`
const configuredClusterUrls = String(
  import.meta.env.VITE_CLUSTER_URLS || '',
)
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)
const clusterUrls = [...new Set([
  serverUrl,
  ...configuredClusterUrls,
  ...[3001, 3002, 3003].map(
    (port) => `${browserProtocol}//${browserHost}:${port}`,
  ),
])]

export const socket = io(serverUrl, { reconnection: false })

let connectedUrl = serverUrl
let connectionAttempt = null
let connectionSequence = 0
const pendingCommands = new Map()
let activeSession = null
let recoveryAttempt = null
let rejoinCount = 0

socket.onAny((_eventName, payload) => {
  observeIncomingEvent(payload?.lamportClock)
})

function normalizeUrl(url) {
  try {
    return new URL(url, window.location.origin).origin
  } catch {
    return url
  }
}

export function connectToLeader(leader) {
  if (!leader?.publicUrl) {
    return Promise.resolve(socket)
  }

  const leaderUrl = normalizeUrl(leader.publicUrl)

  if (normalizeUrl(connectedUrl) === leaderUrl && socket.connected) {
    return Promise.resolve(socket)
  }

  if (connectionAttempt?.url === leaderUrl) {
    return connectionAttempt.promise
  }

  connectionAttempt?.cancel()
  connectionSequence += 1
  const attemptId = connectionSequence
  let cancelAttempt
  const promise = new Promise((resolve, reject) => {
    let settled = false
    const timeout = window.setTimeout(() => {
      finish(new Error(`No se pudo conectar con ${leaderUrl}`))
    }, 1500)

    function cleanup() {
      window.clearTimeout(timeout)
      socket.off('connect', handleConnect)
    }

    function finish(error) {
      if (settled) {
        return
      }

      settled = true
      cleanup()

      const isCurrentAttempt = connectionAttempt?.id === attemptId

      if (isCurrentAttempt) {
        connectionAttempt = null
      }

      if (error) {
        if (isCurrentAttempt) {
          socket.disconnect()
        }
        reject(error)
        return
      }

      connectedUrl = leaderUrl
      resolve(socket)
    }

    async function handleConnect() {
      try {
        await rejoinActiveSession()
        finish()
      } catch (error) {
        finish(error)
      }
    }

    cancelAttempt = () => finish(new Error('Conexión reemplazada'))

    socket.once('connect', handleConnect)
    socket.disconnect()
    socket.io.uri = leaderUrl
    socket.connect()
  })

  connectionAttempt = {
    id: attemptId,
    url: leaderUrl,
    promise,
    cancel: cancelAttempt,
  }
  return promise
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

async function fetchLeader(candidateUrl) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 750)

  try {
    const response = await fetch(
      `${normalizeUrl(candidateUrl)}/cluster/leader`,
      { signal: controller.signal },
    )

    if (!response.ok) {
      return null
    }

    const payload = await response.json()
    return payload?.leader?.publicUrl ? payload.leader : null
  } catch {
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

async function discoverLeader(deadline) {
  while (Date.now() < deadline) {
    const candidates = await Promise.all(clusterUrls.map(fetchLeader))
    const leader = candidates.find(Boolean)

    if (leader) {
      return leader
    }

    await wait(250)
  }

  throw new Error('No se encontró un líder disponible')
}

async function rejoinActiveSession() {
  if (!activeSession) {
    return
  }

  const metadata = createCommandMetadata()
  const response = await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('No se pudo recuperar la sala'))
    }, 5000)

    socket.emit(
      'join-room',
      { ...activeSession, ...metadata },
      (result) => {
        window.clearTimeout(timeout)
        resolve(result)
      },
    )
  })
  observeIncomingEvent(response?.lamportClock)

  if (!response?.success) {
    throw new Error(response?.message || 'No se pudo recuperar la sala')
  }

  rejoinCount += 1
}

export function recoverConnection() {
  if (recoveryAttempt) {
    return recoveryAttempt
  }

  recoveryAttempt = (async () => {
    const deadline = Date.now() + 10_000
    let lastError = new Error('No se encontró un líder disponible')

    while (Date.now() < deadline) {
      try {
        const leader = await discoverLeader(deadline)
        return await connectToLeader(leader)
      } catch (error) {
        lastError = error
        await wait(250)
      }
    }

    throw lastError
  })()
    .finally(() => {
      recoveryAttempt = null
    })
  return recoveryAttempt
}

function completeCommand(command, response) {
  if (command.completed) {
    return
  }

  command.completed = true
  pendingCommands.delete(command.metadata.commandId)

  if (response?.success) {
    if (
      command.eventName === 'create-room' ||
      command.eventName === 'join-room'
    ) {
      activeSession = {
        roomCode: response.roomCode,
        playerName: command.payload.playerName,
      }
    } else if (command.eventName === 'leave-room') {
      activeSession = null
    }
  }

  command.callback?.(response)
}

function sendCommand(command) {
  if (command.completed) {
    return
  }

  socket.emit(
    command.eventName,
    { ...command.payload, ...command.metadata },
    (response) => {
      if (command.completed) {
        return
      }

      observeIncomingEvent(response?.lamportClock)

      if (
        response?.code === 'LEADER_REDIRECT' &&
        response.leader?.publicUrl &&
        !command.retried
      ) {
        command.retried = true
        connectToLeader(response.leader)
          .then(() => sendCommand(command))
          .catch(() => completeCommand(command, response))
        return
      }

      completeCommand(command, response)
    },
  )
}

export function emitCommand(eventName, payload = {}, callback) {
  const normalizedPayload = typeof payload === 'function' ? {} : payload
  const normalizedCallback =
    typeof payload === 'function' ? payload : callback
  const metadata = createCommandMetadata()
  const command = {
    eventName,
    payload: normalizedPayload,
    callback: normalizedCallback,
    metadata,
    retried: false,
    completed: false,
  }

  pendingCommands.set(metadata.commandId, command)
  sendCommand(command)
  return metadata.commandId
}

socket.on('leader-changed', (leader) => {
  connectToLeader(leader)
    .then(() => {
      pendingCommands.forEach((command) => {
        if (!command.retried && !command.completed) {
          command.retried = true
          sendCommand(command)
        }
      })
    })
    .catch(() => {})
})

socket.on('disconnect', (reason) => {
  if (reason !== 'io client disconnect') {
    recoverConnection().catch(() => {})
  }
})

socket.on('connect_error', () => {
  if (!connectionAttempt) {
    recoverConnection().catch(() => {})
  }
})

if (typeof window !== 'undefined' && window.Cypress) {
  window.__testSocket = {
    emit(eventName, ...args) {
      socket.emitEvent([eventName, ...args])
    },
    listenerCount(eventName) {
      return socket.listeners(eventName).length
    },
    connectionState() {
      return {
        connected: socket.connected,
        reconnecting: socket.io._reconnecting,
        url: socket.io.uri,
      }
    },
    forceTransportClose() {
      socket.io.engine?.close()
    },
    sessionState() {
      return {
        connected: socket.connected,
        rejoinCount,
        roomCode: activeSession?.roomCode || null,
      }
    },
  }
}
