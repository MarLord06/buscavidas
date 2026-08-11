const { randomUUID } = require('node:crypto')

const COMMAND_TTL_SECONDS = 60 * 60
const LOCK_TTL_MILLISECONDS = 3000
const LOCK_RETRY_DELAY_MILLISECONDS = 100
const LOCK_RETRIES = 3
const LOCK_RENEWAL_INTERVAL_MILLISECONDS = 1000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function lockLostError() {
  return Object.assign(new Error('Se perdió el lock de la sala'), {
    code: 'LOCK_LOST',
  })
}

function lockUnavailableError() {
  return Object.assign(new Error('No se pudo obtener el lock de la sala'), {
    code: 'LOCK_UNAVAILABLE',
  })
}

const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

const RENEW_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`

const SAVE_ROOM_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2])
return 1
`

const SAVE_COMMAND_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`

const SAVE_ROOM_AND_COMMAND_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2])
redis.call('set', KEYS[3], ARGV[3], 'EX', ARGV[4])
return 1
`

const CREATE_ROOM_AND_COMMAND_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return -1
end
if redis.call('exists', KEYS[2]) == 1 then
  return 0
end
redis.call('set', KEYS[2], ARGV[2])
redis.call('set', KEYS[3], ARGV[3], 'EX', ARGV[4])
return 1
`

const SAVE_PLAYER_HEARTBEAT_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('sadd', KEYS[3], ARGV[4])
return 1
`

const SAVE_ROOM_COMMAND_AND_HEARTBEAT_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2])
redis.call('set', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('set', KEYS[4], ARGV[5], 'PX', ARGV[6])
redis.call('sadd', KEYS[5], ARGV[7])
return 1
`

const SAVE_ROOM_AND_HEARTBEAT_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2])
redis.call('set', KEYS[3], ARGV[3], 'PX', ARGV[4])
redis.call('sadd', KEYS[4], ARGV[5])
return 1
`

const REMOVE_HEARTBEAT_ROOM_WITH_LOCK = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('srem', KEYS[2], ARGV[2])
return 1
`

function createRedisRoomRepository({
  redis,
  keyPrefix = '',
  now = Date.now,
  randomId = randomUUID,
}) {
  function keyFor(logicalKey) {
    return redis.options?.keyPrefix ? logicalKey : `${keyPrefix}${logicalKey}`
  }

  function roomKey(roomCode) {
    return keyFor(`room:${roomCode}`)
  }

  function commandKey(roomCode, commandId) {
    return keyFor(`room:${roomCode}:command:${commandId}`)
  }

  function lockKey(roomCode) {
    return keyFor(`lock:room:${roomCode}`)
  }

  function renewLock(key, token) {
    return redis.eval(
      RENEW_LOCK,
      1,
      key,
      token,
      LOCK_TTL_MILLISECONDS,
    )
  }

  async function getRoom(roomCode) {
    const serializedRoom = await redis.get(roomKey(roomCode))

    return serializedRoom ? JSON.parse(serializedRoom) : null
  }

  async function listRoomCodes() {
    const physicalPrefix = redis.options?.keyPrefix || keyPrefix
    const roomKeyPattern = `${physicalPrefix}room:*`
    const roomCodes = []
    let cursor = '0'

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        roomKeyPattern,
        'COUNT',
        100,
      )
      cursor = nextCursor

      keys.forEach((key) => {
        const logicalKey = physicalPrefix
          ? key.slice(physicalPrefix.length)
          : key
        const match = /^room:([^:]+)$/.exec(logicalKey)

        if (match) {
          roomCodes.push(match[1])
        }
      })
    } while (cursor !== '0')

    return roomCodes.sort((first, second) => first.localeCompare(second))
  }

  async function saveRoom(room, lock) {
    if (!lock) {
      await redis.set(roomKey(room.roomCode), JSON.stringify(room))
      return
    }

    lock.throwIfLost()
    const saved = await redis.eval(
      SAVE_ROOM_WITH_LOCK,
      2,
      lock.key,
      roomKey(room.roomCode),
      lock.token,
      JSON.stringify(room),
    )

    if (saved !== 1) {
      throw lockLostError()
    }
  }

  async function withRoomLock(roomCode, fn) {
    const key = lockKey(roomCode)
    const token = `${now()}:${randomId()}`

    for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
      const acquired = await redis.set(
        key,
        token,
        'PX',
        LOCK_TTL_MILLISECONDS,
        'NX',
      )

      if (acquired === 'OK') {
        let latestRenewal = Promise.resolve()
        let renewalFailure = null
        const lock = {
          key,
          token,
          throwIfLost() {
            if (renewalFailure) {
              throw lockLostError()
            }
          },
        }
        const renewalTimer = setInterval(() => {
          latestRenewal = latestRenewal.then(async () => {
            try {
              const renewed = await renewLock(key, token)

              if (renewed !== 1) {
                renewalFailure = lockLostError()
              }
            } catch (error) {
              renewalFailure = error
            }
          })
        }, LOCK_RENEWAL_INTERVAL_MILLISECONDS)

        try {
          const result = await fn(lock)
          await latestRenewal
          lock.throwIfLost()
          return result
        } finally {
          clearInterval(renewalTimer)
          await latestRenewal
          await redis.eval(RELEASE_LOCK, 1, key, token)
        }
      }

      if (attempt < LOCK_RETRIES) {
        await delay(LOCK_RETRY_DELAY_MILLISECONDS)
      }
    }

    throw lockUnavailableError()
  }

  async function getCommand(roomCode, commandId) {
    const serializedResult = await redis.get(commandKey(roomCode, commandId))

    return serializedResult ? JSON.parse(serializedResult) : null
  }

  async function saveCommand(roomCode, commandId, result, lock) {
    if (!lock) {
      await redis.set(
        commandKey(roomCode, commandId),
        JSON.stringify(result),
        'EX',
        COMMAND_TTL_SECONDS,
      )
      return
    }

    lock.throwIfLost()
    const saved = await redis.eval(
      SAVE_COMMAND_WITH_LOCK,
      2,
      lock.key,
      commandKey(roomCode, commandId),
      lock.token,
      JSON.stringify(result),
      COMMAND_TTL_SECONDS,
    )

    if (saved !== 1) {
      throw lockLostError()
    }
  }

  async function saveRoomAndCommand(
    room,
    commandId,
    result,
    lock,
    commandScope = room.roomCode,
  ) {
    if (lock) {
      lock.throwIfLost()
      const saved = await redis.eval(
        SAVE_ROOM_AND_COMMAND_WITH_LOCK,
        3,
        lock.key,
        roomKey(room.roomCode),
        commandKey(commandScope, commandId),
        lock.token,
        JSON.stringify(room),
        JSON.stringify(result),
        COMMAND_TTL_SECONDS,
      )

      if (saved !== 1) {
        throw lockLostError()
      }

      return
    }

    const transactionResults = await redis
      .multi()
      .set(roomKey(room.roomCode), JSON.stringify(room))
      .set(
        commandKey(commandScope, commandId),
        JSON.stringify(result),
        'EX',
        COMMAND_TTL_SECONDS,
      )
      .exec()
    const failedCommand = transactionResults.find(([error]) => error)

    if (failedCommand) {
      throw failedCommand[0]
    }
  }

  async function createRoomAndCommand(
    room,
    commandId,
    result,
    lock,
    commandScope = room.roomCode,
  ) {
    lock.throwIfLost()
    const created = await redis.eval(
      CREATE_ROOM_AND_COMMAND_WITH_LOCK,
      3,
      lock.key,
      roomKey(room.roomCode),
      commandKey(commandScope, commandId),
      lock.token,
      JSON.stringify(room),
      JSON.stringify(result),
      COMMAND_TTL_SECONDS,
    )

    if (created === -1) {
      throw lockLostError()
    }

    return created === 1
  }

  async function savePlayerHeartbeat(
    heartbeatKey,
    roomsKey,
    roomCode,
    timestamp,
    ttlMilliseconds,
    lock,
  ) {
    lock.throwIfLost()
    const saved = await redis.eval(
      SAVE_PLAYER_HEARTBEAT_WITH_LOCK,
      3,
      lock.key,
      heartbeatKey,
      roomsKey,
      lock.token,
      timestamp,
      ttlMilliseconds,
      roomCode,
    )

    if (saved !== 1) {
      throw lockLostError()
    }
  }

  async function saveRoomCommandAndPlayerHeartbeat(
    room,
    commandId,
    result,
    heartbeat,
    lock,
    commandScope = room.roomCode,
  ) {
    lock.throwIfLost()
    const saved = await redis.eval(
      SAVE_ROOM_COMMAND_AND_HEARTBEAT_WITH_LOCK,
      5,
      lock.key,
      roomKey(room.roomCode),
      commandKey(commandScope, commandId),
      heartbeat.key,
      heartbeat.roomsKey,
      lock.token,
      JSON.stringify(room),
      JSON.stringify(result),
      COMMAND_TTL_SECONDS,
      heartbeat.value,
      heartbeat.ttlMilliseconds,
      heartbeat.roomCode,
    )

    if (saved !== 1) {
      throw lockLostError()
    }
  }

  async function saveRoomAndPlayerHeartbeat(room, heartbeat, lock) {
    lock.throwIfLost()
    const saved = await redis.eval(
      SAVE_ROOM_AND_HEARTBEAT_WITH_LOCK,
      4,
      lock.key,
      roomKey(room.roomCode),
      heartbeat.key,
      heartbeat.roomsKey,
      lock.token,
      JSON.stringify(room),
      heartbeat.value,
      heartbeat.ttlMilliseconds,
      heartbeat.roomCode,
    )

    if (saved !== 1) {
      throw lockLostError()
    }
  }

  async function removeHeartbeatRoom(roomsKey, roomCode, lock) {
    lock.throwIfLost()
    const removed = await redis.eval(
      REMOVE_HEARTBEAT_ROOM_WITH_LOCK,
      2,
      lock.key,
      roomsKey,
      lock.token,
      roomCode,
    )

    if (removed !== 1) {
      throw lockLostError()
    }
  }

  return {
    getRoom,
    listRoomCodes,
    saveRoom,
    withRoomLock,
    getCommand,
    saveCommand,
    saveRoomAndCommand,
    createRoomAndCommand,
    savePlayerHeartbeat,
    saveRoomCommandAndPlayerHeartbeat,
    saveRoomAndPlayerHeartbeat,
    removeHeartbeatRoom,
  }
}

module.exports = { createRedisRoomRepository }
