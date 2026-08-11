const RECENT_EVENT_LIMIT = 20
const CLUSTER_HEARTBEAT_TTL_MILLISECONDS = 6000

function createClusterTelemetryService({
  coordinator,
  repository,
  game,
  redis,
  keyPrefix = '',
  clusterNodeIds = [1, 2, 3],
  now = Date.now,
}) {
  function keyFor(logicalKey) {
    return redis.options?.keyPrefix ? logicalKey : `${keyPrefix}${logicalKey}`
  }

  function eventKey() {
    return keyFor('cluster:events')
  }

  async function recordEvent(type, details = {}) {
    const event = {
      type,
      message: details.message || type,
      timestamp: now(),
      ...details,
    }
    const results = await redis
      .multi()
      .lpush(eventKey(), JSON.stringify(event))
      .ltrim(eventKey(), 0, RECENT_EVENT_LIMIT - 1)
      .exec()
    const failedCommand = results.find(([error]) => error)

    if (failedCommand) {
      throw failedCommand[0]
    }

    return event
  }

  async function getRooms() {
    const roomCodes = await repository.listRoomCodes()
    const rooms = await Promise.all(
      roomCodes.map((roomCode) => game.getRoomState(roomCode)),
    )

    return rooms.filter(Boolean)
  }

  async function getEvents() {
    const serializedEvents = await redis.lrange(
      eventKey(),
      0,
      RECENT_EVENT_LIMIT - 1,
    )

    return serializedEvents.map((event) => JSON.parse(event))
  }

  async function getStatus() {
    const [leader, liveNodes, rooms, events] = await Promise.all([
      coordinator.getLeader?.() || null,
      coordinator.getNodes?.() || [],
      getRooms(),
      getEvents(),
    ])
    const generatedAt = now()
    const liveNodesById = new Map(
      liveNodes.map((node) => [Number(node.nodeId), node]),
    )
    const configuredNodeIds = [...new Set(
      [...clusterNodeIds, ...liveNodesById.keys()].map(Number),
    )].sort((first, second) => first - second)
    const nodes = configuredNodeIds.map((nodeId) => {
      const node = liveNodesById.get(nodeId)

      if (!node) {
        return {
          nodeId,
          alive: false,
          publicUrl: null,
          expiresAt: null,
          heartbeatAgeMs: null,
        }
      }

      return {
        ...node,
        alive: true,
        heartbeatAgeMs: Math.max(
          0,
          generatedAt -
            (Number(node.expiresAt) - CLUSTER_HEARTBEAT_TTL_MILLISECONDS),
        ),
      }
    })
    const publicLeader = leader
      ? {
          ...leader,
          leaseRemainingMs: Math.max(
            0,
            Number(leader.expiresAt) - generatedAt,
          ),
        }
      : null

    return {
      generatedAt,
      leader: publicLeader,
      nodes,
      lamportClock: rooms.reduce(
        (maximum, room) => Math.max(maximum, Number(room.lamportClock) || 0),
        0,
      ),
      rooms,
      events,
    }
  }

  return {
    recordEvent,
    getStatus,
  }
}

module.exports = { createClusterTelemetryService }
