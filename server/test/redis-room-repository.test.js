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
      'room:LOCK01',
      'room:LOCK01:command:cmd-1',
      'room:LOCK01:command:cmd-ttl',
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
