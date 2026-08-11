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
