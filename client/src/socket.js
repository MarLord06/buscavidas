import { io } from 'socket.io-client'
import {
  createCommandMetadata,
  observeIncomingEvent,
} from './cluster'

const serverUrl =
  import.meta.env.VITE_SERVER_URL || 'http://localhost:3000'

export const socket = io(serverUrl)

let connectedUrl = serverUrl
let connectionAttempt = null
let connectionSequence = 0
const pendingCommands = new Map()

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
    }, 5000)

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

    function handleConnect() {
      finish()
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

function completeCommand(command, response) {
  if (command.completed) {
    return
  }

  command.completed = true
  pendingCommands.delete(command.metadata.commandId)
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
  }
}
