const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createClusterCoordinator,
} = require('../services/cluster-coordinator')
const Redis = require('ioredis')

function createClock() {
  let time = 1_000_000

  return {
    now: () => time,
    advance: async (milliseconds) => {
      time += milliseconds
    },
  }
}

function createDeferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

test('elige el nodo vivo de ID mayor y reemplaza al líder expirado', async (t) => {
  const keyPrefix = `buscaminas:test:cluster:${Date.now()}:${process.pid}:`
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  })
  const clock = createClock()
  const first = createClusterCoordinator({
    redis,
    nodeId: 1,
    publicUrl: 'http://node-1',
    clock,
  })
  const third = createClusterCoordinator({
    redis,
    nodeId: 3,
    publicUrl: 'http://node-3',
    clock,
  })

  t.after(async () => {
    await Promise.all([first.stop(), third.stop()])
    await redis.del(
      'cluster:heartbeat:1',
      'cluster:heartbeat:3',
      'cluster:leader',
    )
    await redis.quit()
  })

  await first.start()
  await third.start()

  assert.equal(first.isLeader(), false)
  assert.deepEqual(await first.getLeader(), {
    nodeId: 3,
    publicUrl: 'http://node-3',
    expiresAt: clock.now() + 6000,
  })

  await third.stop()
  await clock.advance(6001)
  await first.tick()

  assert.equal(first.isLeader(), true)
})

test('expone el liderazgo al iniciar cuando adquiere el lease', async (t) => {
  const keyPrefix = `buscaminas:test:cluster:start:${Date.now()}:${process.pid}:`
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  })
  const clock = createClock()
  const first = createClusterCoordinator({
    redis,
    nodeId: 1,
    publicUrl: 'http://node-1',
    clock,
  })
  const third = createClusterCoordinator({
    redis,
    nodeId: 3,
    publicUrl: 'http://node-3',
    clock,
  })

  t.after(async () => {
    await Promise.all([first.stop(), third.stop()])
    await redis.del(
      'cluster:heartbeat:1',
      'cluster:heartbeat:3',
      'cluster:leader',
    )
    await redis.quit()
  })

  await first.start()
  await third.start()

  assert.equal(third.isLeader(), true)
})

test('conserva el resultado del tick más reciente cuando se superponen', async () => {
  const clock = createClock()
  const evalStarted = createDeferred()
  const releaseEval = createDeferred()
  let scanCount = 0
  const redis = {
    options: {},
    set: async () => 'OK',
    scan: async () => {
      scanCount += 1

      if (scanCount === 1) {
        return ['0', ['cluster:heartbeat:1']]
      }

      setImmediate(releaseEval.resolve)
      return [
        '0',
        ['cluster:heartbeat:1', 'cluster:heartbeat:3'],
      ]
    },
    get: async (key) => JSON.stringify({
      nodeId: key.endsWith(':3') ? 3 : 1,
      publicUrl: key.endsWith(':3') ? 'http://node-3' : 'http://node-1',
      expiresAt: clock.now() + 6000,
    }),
    eval: async () => {
      evalStarted.resolve()
      await releaseEval.promise
      return 1
    },
  }
  const coordinator = createClusterCoordinator({
    redis,
    nodeId: 1,
    publicUrl: 'http://node-1',
    clock,
  })

  const releaseTimeout = setTimeout(releaseEval.resolve, 25)
  const olderTick = coordinator.tick()
  await evalStarted.promise
  const newerTick = coordinator.tick()

  await Promise.all([olderTick, newerTick])
  clearTimeout(releaseTimeout)

  assert.equal(coordinator.isLeader(), false)
})
