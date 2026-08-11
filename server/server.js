const { createGameServer } = require('./app')
const { loadConfig } = require('./config')
const { createClusterCoordinator } = require('./services/cluster-coordinator')
const { createRedisClients } = require('./services/redis-client')

async function startServer() {
  const config = loadConfig()
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
  const { command, subscriber } = createRedisClients(config)
  const coordinator = createClusterCoordinator({
    redis: command,
    nodeId: config.nodeId,
    publicUrl: config.publicUrl,
  })
  const gameServer = createGameServer({
    config: { ...config, clientUrl },
    redis: { command, subscriber },
    coordinator,
  })

  try {
    await coordinator.start()
    const listeningPort = await gameServer.listen(config.port)
    console.log(`Servidor ejecutándose en http://localhost:${listeningPort}`)
  } catch (error) {
    await Promise.allSettled([
      coordinator.stop(),
      command.quit(),
      subscriber.quit(),
    ])
    throw error
  }
}

startServer().catch((error) => {
  console.error('No se pudo iniciar el servidor', error)
  process.exitCode = 1
})
