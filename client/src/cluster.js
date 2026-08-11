const CLIENT_ID_KEY = 'buscaminas-client-id'

let lamportClock = 0
const clockSubscribers = new Set()

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function notifyClockSubscribers() {
  clockSubscribers.forEach((subscriber) => subscriber(lamportClock))
}

export function getClientId() {
  const storedClientId = globalThis.localStorage?.getItem(CLIENT_ID_KEY)

  if (storedClientId) {
    return storedClientId
  }

  const clientId = createId()
  globalThis.localStorage?.setItem(CLIENT_ID_KEY, clientId)
  return clientId
}

export function getLamportClock() {
  return lamportClock
}

export function observeIncomingEvent(remoteClock = 0) {
  lamportClock = Math.max(lamportClock, Number(remoteClock) || 0) + 1
  notifyClockSubscribers()
  return lamportClock
}

export function createCommandMetadata() {
  lamportClock += 1
  notifyClockSubscribers()

  return {
    commandId: createId(),
    clientId: getClientId(),
    lamportClock,
  }
}

export function subscribeLamportClock(subscriber) {
  clockSubscribers.add(subscriber)
  return () => clockSubscribers.delete(subscriber)
}
