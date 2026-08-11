function loadConfig(env = process.env) {
  const clusterNodeIds = String(env.CLUSTER_NODE_IDS || '1,2,3')
    .split(',')
    .map((nodeId) => Number(nodeId.trim()))
    .filter(Number.isFinite)

  return {
    nodeId: Number(env.NODE_ID || 1),
    port: Number(env.PORT || 3000),
    publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`,
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    keyPrefix: env.REDIS_KEY_PREFIX || 'buscaminas:',
    clusterNodeIds,
  }
}

module.exports = { loadConfig }
