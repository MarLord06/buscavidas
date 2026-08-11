const { networkInterfaces } = require('node:os')

function resolvePublicHost(interfaces = networkInterfaces()) {
  const addresses = Object.values(interfaces).flatMap((entries) => entries || [])
  const lanAddress = addresses.find(
    (address) =>
      address.family === 'IPv4' &&
      !address.internal,
  )

  return lanAddress?.address || 'localhost'
}

function loadConfig(env = process.env) {
  const clusterNodeIds = String(env.CLUSTER_NODE_IDS || '1,2,3')
    .split(',')
    .map((nodeId) => Number(nodeId.trim()))
    .filter(Number.isFinite)

  const port = Number(env.PORT || 3000)
  const publicHost = env.PUBLIC_HOST || resolvePublicHost()

  return {
    nodeId: Number(env.NODE_ID || 1),
    port,
    publicUrl: env.PUBLIC_URL || `http://${publicHost}:${port}`,
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    keyPrefix: env.REDIS_KEY_PREFIX || 'buscaminas:',
    clusterNodeIds,
  }
}

module.exports = { loadConfig, resolvePublicHost }
