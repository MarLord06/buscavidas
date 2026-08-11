const Redis = require('ioredis')

function createRedisClients({ redisUrl, keyPrefix }) {
  const command = new Redis(redisUrl, { keyPrefix })
  const subscriber = command.duplicate({ keyPrefix })

  return { command, subscriber }
}

module.exports = { createRedisClients }
