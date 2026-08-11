const HEARTBEAT_TTL_MS = 6000
const ELECTION_INTERVAL_MS = 2000

const ACQUIRE_OR_RENEW_LEADER = `
local current = redis.call('get', KEYS[1])

if not current then
  redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end

local leader = cjson.decode(current)
local candidate = cjson.decode(ARGV[1])

if leader.nodeId == candidate.nodeId and leader.token == candidate.token then
  redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end

if leader.expiresAt <= tonumber(ARGV[3]) or leader.nodeId < candidate.nodeId then
  redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end

return 0
`

const RELEASE_LEADER = `
local current = redis.call('get', KEYS[1])

if not current then
  return 0
end

local leader = cjson.decode(current)

if leader.nodeId == tonumber(ARGV[1]) and leader.token == ARGV[2] then
  return redis.call('del', KEYS[1])
end

return 0
`

function createClusterCoordinator({
  redis,
  nodeId,
  publicUrl,
  clock = { now: Date.now },
}) {
  const heartbeatKey = `cluster:heartbeat:${nodeId}`
  const leaderKey = 'cluster:leader'
  const token = `${nodeId}:${Math.random().toString(36).slice(2)}`
  let timer = null
  let started = false
  let leader = false
  let tickQueue = Promise.resolve()

  function now() {
    return clock.now()
  }

  function redisKeyPrefix() {
    return redis.options?.keyPrefix || ''
  }

  function toLogicalKey(key) {
    const prefix = redisKeyPrefix()

    return prefix && key.startsWith(prefix)
      ? key.slice(prefix.length)
      : key
  }

  async function getNodes() {
    const prefix = redisKeyPrefix()
    const match = `${prefix}cluster:heartbeat:*`
    const nodes = []
    let cursor = '0'

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', match)
      cursor = nextCursor

      for (const key of keys) {
        const heartbeat = await redis.get(toLogicalKey(key))

        if (!heartbeat) {
          continue
        }

        const node = JSON.parse(heartbeat)

        if (node.expiresAt > now()) {
          nodes.push({
            nodeId: Number(node.nodeId),
            publicUrl: node.publicUrl,
            expiresAt: Number(node.expiresAt),
          })
        }
      }
    } while (cursor !== '0')

    return nodes.sort((first, second) => first.nodeId - second.nodeId)
  }

  async function getLeader() {
    const storedLeader = await redis.get(leaderKey)

    if (!storedLeader) {
      return null
    }

    const currentLeader = JSON.parse(storedLeader)

    if (currentLeader.expiresAt <= now()) {
      return null
    }

    return {
      nodeId: Number(currentLeader.nodeId),
      publicUrl: currentLeader.publicUrl,
      expiresAt: Number(currentLeader.expiresAt),
    }
  }

  async function runTick(shouldElect) {
    const expiresAt = now() + HEARTBEAT_TTL_MS
    await redis.set(
      heartbeatKey,
      JSON.stringify({ nodeId, publicUrl, expiresAt }),
      'PX',
      HEARTBEAT_TTL_MS,
    )

    if (!shouldElect) {
      return
    }

    const nodes = await getNodes()
    const expectedLeader = nodes.at(-1)

    if (!expectedLeader || expectedLeader.nodeId !== nodeId) {
      leader = false
      return
    }

    const candidate = JSON.stringify({
      nodeId,
      publicUrl,
      expiresAt,
      token,
    })
    const acquired = await redis.eval(
      ACQUIRE_OR_RENEW_LEADER,
      1,
      leaderKey,
      candidate,
      HEARTBEAT_TTL_MS,
      now(),
    )

    leader = acquired === 1
  }

  function enqueueTick(operation) {
    const queuedTick = tickQueue.then(operation)
    tickQueue = queuedTick.catch(() => {})

    return queuedTick
  }

  function tick() {
    return enqueueTick(() => runTick(true))
  }

  async function start() {
    if (started) {
      return
    }

    started = true
    await enqueueTick(async () => {
      const clusterHasLiveNodes = (await getNodes()).length > 0
      await runTick(clusterHasLiveNodes)
    })
    timer = setInterval(() => {
      tick().catch((error) => {
        console.error('No se pudo renovar el liderazgo del clúster', error)
      })
    }, ELECTION_INTERVAL_MS)
  }

  async function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }

    started = false
    await tickQueue
    leader = false
    await redis.del(heartbeatKey)
    await redis.eval(RELEASE_LEADER, 1, leaderKey, nodeId, token)
  }

  return { start, stop, tick, isLeader: () => leader, getLeader, getNodes }
}

module.exports = { createClusterCoordinator }
