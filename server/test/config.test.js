const assert = require('node:assert/strict')
const test = require('node:test')

const { loadConfig, resolvePublicHost } = require('../config')

test('PUBLIC_HOST produce redirects alcanzables desde la red local', () => {
  const config = loadConfig({
    PORT: '3002',
    PUBLIC_HOST: '192.168.1.20',
  })

  assert.equal(config.publicUrl, 'http://192.168.1.20:3002')
})

test('elige una IPv4 no loopback para la URL pública por defecto', () => {
  const host = resolvePublicHost({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  })

  assert.equal(host, '192.168.1.20')
})
