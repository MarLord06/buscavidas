const { randomUUID } = require('node:crypto')

const COMMAND_TTL_SECONDS = 60 * 60
const LOCK_TTL_MILLISECONDS = 3000
const LOCK_RETRY_DELAY_MILLISECONDS = 100
const LOCK_RETRIES = 3
const LOCK_RENEWAL_INTERVAL_MILLISECONDS = 1000

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

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
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

  async function saveRoom(room) {
    await redis.set(roomKey(room.roomCode), JSON.stringify(room))
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
        const renewalTimer = setInterval(() => {
          latestRenewal = renewLock(key, token).catch(() => 0)
        }, LOCK_RENEWAL_INTERVAL_MILLISECONDS)

        try {
          return await fn()
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

    throw { code: 'LOCK_UNAVAILABLE' }
  }

  async function getCommand(roomCode, commandId) {
    const serializedResult = await redis.get(commandKey(roomCode, commandId))

    return serializedResult ? JSON.parse(serializedResult) : null
  }

  async function saveCommand(roomCode, commandId, result) {
    await redis.set(
      commandKey(roomCode, commandId),
      JSON.stringify(result),
      'EX',
      COMMAND_TTL_SECONDS,
    )
  }

  return {
    getRoom,
    saveRoom,
    withRoomLock,
    getCommand,
    saveCommand,
  }
}

module.exports = { createRedisRoomRepository }
