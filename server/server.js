const { createGameServer } = require('./app')

const port = Number(process.env.PORT || 3000)
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
const gameServer = createGameServer({ clientUrl })

gameServer.listen(port).then((listeningPort) => {
  console.log(
    `Servidor ejecutándose en http://localhost:${listeningPort}`,
  )
})
