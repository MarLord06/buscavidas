const assert = require('node:assert/strict')
const test = require('node:test')
const Redis = require('ioredis')

const {
  createRedisRoomRepository,
} = require('../repositories/redis-room-repository')

function createRepository(t) {
  const keyPrefix = `buscaminas:test:room:${Date.now()}:${process.pid}:`
  let tokenCount = 0
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  })
  const repository = createRedisRoomRepository({
    redis,
    keyPrefix,
    randomId: () => `lock-token-${++tokenCount}`,
  })

  t.after(async () => {
    await redis.del(
      'room:ROOM01',
      'room:ROOM02',
      'room:LOCK01',
      'room:LOCK01:command:cmd-1',
      'room:LOCK01:command:cmd-ttl',
      'room:LOCK01:command:cmd-atomic',
      'room:LOCK01:command:rejoin-atomic',
      'player:LOCK01:player-1',
      'player-heartbeat:rooms',
      'lock:room:LOCK01',
    )
    await redis.quit()
  })

  return { redis, repository }
}

function createDeferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

test('guarda y recupera una sala serializada en Redis', async (t) => {
  const { repository } = createRepository(t)
  const room = {
    roomCode: 'ROOM01',
    stateVersion: 2,
    players: [{ id: 'player-1', score: 4 }],
  }

  await repository.saveRoom(room)

  assert.deepEqual(await repository.getRoom('ROOM01'), room)
})

test('lista solo códigos de sala y excluye claves de comandos', async (t) => {
  const { repository } = createRepository(t)
  await repository.saveRoom({ roomCode: 'ROOM02', players: [] })
  await repository.saveRoom({ roomCode: 'ROOM01', players: [] })
  await repository.saveCommand('ROOM01', 'cmd-1', { success: true })

  assert.deepEqual(await repository.listRoomCodes(), ['ROOM01', 'ROOM02'])
})

test('aplica keyPrefix si el cliente Redis no tiene uno configurado', async (t) => {
  const keyPrefix = `buscaminas:test:room:raw:${Date.now()}:${process.pid}:`
  const redis = new Redis({ host: '127.0.0.1', port: 6379 })
  const repository = createRedisRoomRepository({ redis, keyPrefix })

  t.after(async () => {
    await redis.del(`${keyPrefix}room:RAW001`)
    await redis.quit()
  })

  await repository.saveRoom({ roomCode: 'RAW001', stateVersion: 0, players: [] })

  assert.equal(
    await redis.get(`${keyPrefix}room:RAW001`),
    '{"roomCode":"RAW001","stateVersion":0,"players":[]}',
  )
})

test('serializa dos transiciones concurrentes de una sala', async (t) => {
  const { repository } = createRepository(t)
  await repository.saveRoom({ roomCode: 'LOCK01', stateVersion: 0, players: [] })
  const order = []
  const firstEntered = createDeferred()
  const releaseFirst = createDeferred()
  let transitionsInFlight = 0
  let maximumTransitionsInFlight = 0

  const first = repository.withRoomLock('LOCK01', async () => {
    transitionsInFlight += 1
    maximumTransitionsInFlight = Math.max(
      maximumTransitionsInFlight,
      transitionsInFlight,
    )
    firstEntered.resolve()
    await releaseFirst.promise
    order.push('first')
    transitionsInFlight -= 1
  })

  await firstEntered.promise

  const second = repository.withRoomLock('LOCK01', async () => {
    transitionsInFlight += 1
    maximumTransitionsInFlight = Math.max(
      maximumTransitionsInFlight,
      transitionsInFlight,
    )
    order.push('second')
    transitionsInFlight -= 1
  })

  await delay(150)
  releaseFirst.resolve()
  await Promise.all([first, second])

  assert.deepEqual(order.sort(), ['first', 'second'])
  assert.equal(maximumTransitionsInFlight, 1)
})

test('renueva el lease mientras una transición conserva el lock', async (t) => {
  const { repository } = createRepository(t)
  const firstEntered = createDeferred()
  const releaseFirst = createDeferred()
  const first = repository.withRoomLock('LOCK01', async () => {
    firstEntered.resolve()
    await releaseFirst.promise
  })

  await firstEntered.promise
  await delay(3100)
  let secondTransitionRan = false

  try {
    await assert.rejects(
      repository.withRoomLock('LOCK01', async () => {
        secondTransitionRan = true
      }),
      (error) => error.code === 'LOCK_UNAVAILABLE',
    )
  } finally {
    releaseFirst.resolve()
    await first
  }

  assert.equal(secondTransitionRan, false)
})

test('devuelve LOCK_UNAVAILABLE después de tres reintentos', async (t) => {
  const { redis, repository } = createRepository(t)
  await redis.set('lock:room:LOCK01', 'other-owner', 'PX', 3000)

  await assert.rejects(
    repository.withRoomLock('LOCK01', async () => {}),
    (error) => error.code === 'LOCK_UNAVAILABLE',
  )
})

test('no libera un lock que ya pertenece a otro token', async (t) => {
  const { redis, repository } = createRepository(t)

  await repository.withRoomLock('LOCK01', async () => {
    await redis.set('lock:room:LOCK01', 'new-owner', 'PX', 3000)
  })

  assert.equal(await redis.get('lock:room:LOCK01'), 'new-owner')
})

test('rechaza el commit si la transición perdió la propiedad del lock', async (t) => {
  const { redis, repository } = createRepository(t)
  const originalRoom = {
    roomCode: 'LOCK01',
    stateVersion: 1,
    players: [{ id: 'player-1', score: 0 }],
  }
  await repository.saveRoom(originalRoom)

  await assert.rejects(
    repository.withRoomLock('LOCK01', async (lock) => {
      await redis.set('lock:room:LOCK01', 'new-owner', 'PX', 3000)
      await repository.saveRoomAndCommand(
        {
          ...originalRoom,
          stateVersion: 2,
          players: [{ id: 'player-1', score: 1 }],
        },
        'stale-command',
        { success: true, stateVersion: 2 },
        lock,
      )
    }),
    (error) => error.code === 'LOCK_LOST',
  )

  assert.deepEqual(await repository.getRoom('LOCK01'), originalRoom)
  assert.equal(
    await repository.getCommand('LOCK01', 'stale-command'),
    null,
  )
})

test('rechaza el commit cuando falla la renovación del lock', async (t) => {
  const keyPrefix = `buscaminas:test:renewal-error:${Date.now()}:${process.pid}:`
  const redis = new Redis({ host: '127.0.0.1', port: 6379, keyPrefix })
  const redisWithFailedRenewal = new Proxy(redis, {
    get(target, property) {
      if (property === 'eval') {
        return async (script, ...argumentsList) => {
          if (script.includes("redis.call('pexpire'")) {
            throw new Error('renewal failed')
          }

          return target.eval(script, ...argumentsList)
        }
      }

      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const repository = createRedisRoomRepository({
    redis: redisWithFailedRenewal,
  })
  const originalRoom = {
    roomCode: 'LOCK01',
    stateVersion: 1,
    players: [],
  }
  t.after(async () => {
    const keys = await redis.keys('*')
    if (keys.length > 0) {
      await redis.del(...keys.map((key) => key.slice(keyPrefix.length)))
    }
    await redis.quit()
  })
  await repository.saveRoom(originalRoom)

  await assert.rejects(
    repository.withRoomLock('LOCK01', async (lock) => {
      await delay(1100)
      await repository.saveRoomAndCommand(
        { ...originalRoom, stateVersion: 2 },
        'renewal-error-command',
        { success: true },
        lock,
      )
    }),
    (error) => error.code === 'LOCK_LOST',
  )

  assert.deepEqual(await repository.getRoom('LOCK01'), originalRoom)
})

test('no guarda heartbeat si el lock cambió de propietario', async (t) => {
  const { redis, repository } = createRepository(t)

  await assert.rejects(
    repository.withRoomLock('LOCK01', async (lock) => {
      await redis.set('lock:room:LOCK01', 'new-owner', 'PX', 3000)
      await repository.savePlayerHeartbeat(
        'player:LOCK01:player-1',
        'player-heartbeat:rooms',
        'LOCK01',
        '1000',
        15_000,
        lock,
      )
    }),
    (error) => error.code === 'LOCK_LOST',
  )

  assert.equal(await redis.exists('player:LOCK01:player-1'), 0)
  assert.equal(await redis.sismember('player-heartbeat:rooms', 'LOCK01'), 0)
})

test('no confirma rejoin ni heartbeat si el lock cambió de propietario', async (t) => {
  const { redis, repository } = createRepository(t)
  const originalRoom = {
    roomCode: 'LOCK01',
    stateVersion: 1,
    players: [{ id: 'player-1', connected: false }],
  }
  await repository.saveRoom(originalRoom)

  await assert.rejects(
    repository.withRoomLock('LOCK01', async (lock) => {
      await redis.set('lock:room:LOCK01', 'new-owner', 'PX', 3000)
      await repository.saveRoomCommandAndPlayerHeartbeat(
        {
          ...originalRoom,
          stateVersion: 2,
          players: [{ id: 'player-1', connected: true }],
        },
        'rejoin-atomic',
        { success: true, stateVersion: 2 },
        {
          key: 'player:LOCK01:player-1',
          roomsKey: 'player-heartbeat:rooms',
          roomCode: 'LOCK01',
          value: '{"connectionId":"new-socket","timestamp":1000}',
          ttlMilliseconds: 15_000,
        },
        lock,
      )
    }),
    (error) => error.code === 'LOCK_LOST',
  )

  assert.deepEqual(await repository.getRoom('LOCK01'), originalRoom)
  assert.equal(await repository.getCommand('LOCK01', 'rejoin-atomic'), null)
  assert.equal(await redis.exists('player:LOCK01:player-1'), 0)
  assert.equal(await redis.sismember('player-heartbeat:rooms', 'LOCK01'), 0)
})

test('recupera el resultado de un commandId ya procesado', async (t) => {
  const { repository } = createRepository(t)

  await repository.saveCommand('LOCK01', 'cmd-1', { success: true, score: 1 })

  assert.deepEqual(
    await repository.getCommand('LOCK01', 'cmd-1'),
    { success: true, score: 1 },
  )
})

test('conserva los resultados de comandos durante una hora', async (t) => {
  const { redis, repository } = createRepository(t)
  await repository.saveCommand('LOCK01', 'cmd-ttl', { success: true })

  const ttl = await redis.ttl('room:LOCK01:command:cmd-ttl')

  assert.equal(ttl > 0 && ttl <= 3600, true)
})

test('guarda la sala y el resultado del comando en una sola transacción', async (t) => {
  const { repository } = createRepository(t)
  const room = {
    roomCode: 'LOCK01',
    stateVersion: 2,
    players: [{ id: 'player-1', score: 1 }],
  }
  const result = {
    success: true,
    commandId: 'cmd-atomic',
    stateVersion: 2,
  }

  await repository.saveRoomAndCommand(room, 'cmd-atomic', result)

  assert.deepEqual(await repository.getRoom('LOCK01'), room)
  assert.deepEqual(
    await repository.getCommand('LOCK01', 'cmd-atomic'),
    result,
  )
})

test('no sobreescribe una sala existente al confirmar una creación', async (t) => {
  const { repository } = createRepository(t)
  const existingRoom = {
    roomCode: 'LOCK01',
    stateVersion: 7,
    players: [{ id: 'existing-player' }],
  }
  await repository.saveRoom(existingRoom)

  const created = await repository.withRoomLock(
    'create:create-collision',
    (lock) => repository.createRoomAndCommand(
      { roomCode: 'LOCK01', stateVersion: 1, players: [] },
      'create-collision',
      { success: true, roomCode: 'LOCK01' },
      lock,
      '__create__',
    ),
  )

  assert.equal(created, false)
  assert.deepEqual(await repository.getRoom('LOCK01'), existingRoom)
})
