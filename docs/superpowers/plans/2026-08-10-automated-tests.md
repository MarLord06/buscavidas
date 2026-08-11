# Automated Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir pruebas de integración Socket.IO y pruebas E2E Cypress reproducibles, con scripts raíz y cobertura LCOV del servidor.

**Architecture:** Extraer la construcción de Express/HTTP/Socket.IO a `createGameServer(options)` para que el arranque de producción y los tests creen instancias independientes. Las pruebas Node conectan clientes Socket.IO reales a un puerto efímero; Cypress arranca el cliente Vite y el servidor de prueba con URL configurable y valida los flujos visibles.

**Tech Stack:** Node.js 22.12+, node:test, c8, Socket.IO Client, Cypress, start-server-and-test, concurrently, React 19, Vite 8.

## Global Constraints

- Mantener las reglas actuales del juego; los cambios al servidor solo habilitan arranque aislado y testeable.
- Cada prueba debe cerrar sockets, HTTP y Socket.IO, incluso cuando falle una aserción.
- Usar puertos efímeros en integración y los puertos 3001/5173 únicamente en el proceso E2E.
- Los E2E usan `data-testid`; no dependen de contenido decorativo ni estilos.
- No guardar secretos en configuración de pruebas.
- Generar `server/coverage/lcov.info` y configurarlo para SonarQube; no declarar cobertura ficticia de Cypress.
- Las nuevas dependencias son de desarrollo y no cambian el artefacto desplegable.

---

## File Structure

- Create: `server/app.js` — fábrica `createGameServer(options)`, con todas las reglas Socket.IO existentes.
- Modify: `server/server.js` — punto de arranque que importa la fábrica.
- Create: `server/test/game-server.test.js` — integración de sala, inicio y espectador.
- Modify: `server/package.json` and `server/package-lock.json` — script de test y Socket.IO Client de desarrollo.
- Modify: `client/src/socket.js` — URL por `VITE_SERVER_URL` con valor local por defecto.
- Modify: `client/src/App.jsx` — `data-testid` para los controles E2E.
- Create: `cypress.config.mjs` — base URL y vídeos desactivados, en ESM compatible con Cypress actual.
- Create: `cypress/e2e/lobby.cy.js` — validaciones y creación visible de sala.
- Modify: `package.json` and `package-lock.json` — scripts de orquestación y dependencias E2E.
- Modify: `sonar-project.properties` — exclusiones de tests e importación de LCOV.
- Modify: `README.md` and `docs/sonarqube-evidence.md` — ejecución y evidencia de pruebas.

### Task 1: Convertir el servidor en una fábrica testeable

**Files:**
- Create: `server/app.js`
- Modify: `server/server.js`
- Test: `server/test/game-server.test.js`

**Interfaces:**
- Produces: `createGameServer({ clientUrl?: string }) => { app, httpServer, io, listen(port?: number): Promise<number>, close(): Promise<void> }`.
- Consumes: `PORT` y `CLIENT_URL` en el ejecutable de producción; ningún test depende del puerto 3000.

- [ ] **Step 1: Escribir el test de inicio aislado que falla**

Create `server/test/game-server.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createGameServer } = require('../app')

test('inicia una instancia aislada en un puerto efímero', async (t) => {
  const gameServer = createGameServer({ clientUrl: '*' })
  t.after(async () => gameServer.close())

  const port = await gameServer.listen(0)
  assert.ok(Number.isInteger(port))
  assert.ok(port > 0)
})
```

- [ ] **Step 2: Ejecutar el test para confirmar el fallo**

Run: `node --test server/test/game-server.test.js`

Expected: FAIL with `Cannot find module '../app'`.

- [ ] **Step 3: Extraer la fábrica sin modificar los controladores Socket.IO**

Move the Express, HTTP, CORS, Map de salas, funciones auxiliares y el bloque `io.on('connection')` de `server/server.js` into `server/app.js`. Wrap them in:

```js
function createGameServer({ clientUrl = 'http://localhost:5173' } = {}) {
  const app = express()
  const httpServer = http.createServer(app)
  const rooms = new Map()
  const io = new Server(httpServer, {
    cors: { origin: clientUrl, methods: ['GET', 'POST'] },
  })

  async function listen(port = 0) {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, () => {
        httpServer.off('error', reject)
        resolve()
      })
    })
    return httpServer.address().port
  }

  async function close() {
    await new Promise((resolve) => io.close(resolve))
    if (httpServer.listening) {
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    }
  }

  return { app, httpServer, io, listen, close }
}

module.exports = { createGameServer }
```

Keep every existing event name, validation message, board rule and room update unchanged. Replace `server/server.js` with:

```js
const { createGameServer } = require('./app')

const port = Number(process.env.PORT || 3000)
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
const gameServer = createGameServer({ clientUrl })

gameServer.listen(port).then((listeningPort) => {
  console.log(`Servidor ejecutándose en http://localhost:${listeningPort}`)
})
```

- [ ] **Step 4: Ejecutar el test y el servidor de producción**

Run:

```zsh
node --test server/test/game-server.test.js
PORT=3100 CLIENT_URL=http://localhost:5173 node server/server.js
```

Expected: test PASS; the second command logs port 3100 and `curl http://localhost:3100/` returns the existing JSON health response. Stop the manual process with Ctrl-C.

- [ ] **Step 5: Commit**

```zsh
git add server/app.js server/server.js server/test/game-server.test.js
git commit -m "refactor: make game server testable"
```

### Task 2: Probar las reglas multijugador con clientes Socket.IO reales

**Files:**
- Modify: `server/test/game-server.test.js`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Test: `server/test/game-server.test.js`

**Interfaces:**
- Consumes: `createGameServer` from Task 1.
- Produces: `npm --prefix server test` and `npm --prefix server run test:coverage`.

- [ ] **Step 1: Añadir la dependencia y scripts de prueba**

In `server/package.json`, add:

```json
"scripts": {
  "start": "node server.js",
  "dev": "nodemon server.js",
  "test": "node --test test/**/*.test.js",
  "test:coverage": "c8 --reporter=text --reporter=lcov --reports-dir=coverage node --test test/**/*.test.js"
},
"devDependencies": {
  "c8": "^10.1.3",
  "nodemon": "^3.1.14",
  "socket.io-client": "^4.8.3"
}
```

Run `npm install --prefix server`.

- [ ] **Step 2: Añadir auxiliares de clientes que inicialmente no existen**

At the top of `server/test/game-server.test.js`, require `io` from `socket.io-client`, then define:

```js
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], forceNew: true })
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function emitAck(socket, event, data) {
  return new Promise((resolve) => {
    if (data === undefined) socket.emit(event, resolve)
    else socket.emit(event, data, resolve)
  })
}
```

Create a failing test named `tres jugadores crean una sala e inician una partida` that creates the server, connects Ana/Bruno/Carla, invokes `create-room`, invokes `join-room` twice, calls `start-game` as Ana, and asserts `success === true`.

- [ ] **Step 3: Ejecutar el test para verificar el comportamiento de integración**

Run: `npm --prefix server test`

Expected: PASS after Task 1 and the installed `socket.io-client`; if it fails due to a callback timeout, inspect the event/ack invocation before changing game rules.

- [ ] **Step 4: Añadir el caso de espectador bloqueado**

Add a second test that starts a three-player game as above, connects a fourth socket, calls:

```js
const spectatorJoin = await emitAck(spectator, 'join-as-spectator', { roomCode })
const reveal = await emitAck(spectator, 'reveal-cell', { cellIndex: 0 })
assert.equal(spectatorJoin.success, true)
assert.equal(reveal.success, false)
assert.equal(reveal.message, 'El jugador no está conectado')
```

Register every socket with `t.after(() => socket.disconnect())` and close the server with `t.after(() => gameServer.close())`.

- [ ] **Step 5: Ejecutar cobertura y confirmar el archivo LCOV**

Run:

```zsh
npm --prefix server run test:coverage
test -s server/coverage/lcov.info
```

Expected: all integration tests PASS and LCOV exists with nonzero size.

- [ ] **Step 6: Commit**

```zsh
git add server/package.json server/package-lock.json server/test/game-server.test.js
git commit -m "test: cover multiplayer Socket.IO rules"
```

### Task 3: Añadir pruebas E2E Cypress del lobby

**Files:**
- Modify: `client/src/socket.js`
- Modify: `client/src/App.jsx`
- Create: `cypress.config.mjs`
- Create: `cypress/e2e/lobby.cy.js`
- Modify: `package.json` and `package-lock.json`

**Interfaces:**
- Consumes: server configured with `PORT=3001` and `CLIENT_URL=http://127.0.0.1:5173`.
- Produces: `npm run test:e2e`, which starts both apps then runs Cypress headlessly.

- [ ] **Step 1: Write failing Cypress specs**

Create `cypress/e2e/lobby.cy.js`:

```js
describe('lobby', () => {
  beforeEach(() => cy.visit('/'))

  it('muestra una validación si falta el nombre', () => {
    cy.get('[data-testid=\"create-room-button\"]').click()
    cy.contains('Debes escribir tu nombre').should('be.visible')
  })

  it('crea una sala y muestra el código y la espera', () => {
    cy.get('[data-testid=\"player-name-input\"]').type('Ana')
    cy.get('[data-testid=\"create-room-button\"]').click()

    cy.get('[data-testid=\"room-code\"]').invoke('text').should('match', /^[A-Z0-9]{6}$/)
    cy.contains('Jugadores conectados: 1/3').should('be.visible')
    cy.contains('Esperando a los demás jugadores...').should('be.visible')
  })
})
```

- [ ] **Step 2: Run Cypress to verify the initial failure**

Run: `npx cypress run --spec cypress/e2e/lobby.cy.js`

Expected: FAIL because Cypress is not installed and the required selectors do not exist.

- [ ] **Step 3: Add stable selectors and configurable server URL**

In `client/src/socket.js`, use:

```js
const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000'
export const socket = io(serverUrl)
```

In `client/src/App.jsx`, add these attributes without changing text or handlers:

```jsx
<input data-testid=\"player-name-input\" ... />
<button data-testid=\"create-room-button\" ...>...</button>
<input data-testid=\"room-code-input\" ... />
<button data-testid=\"join-room-button\" ...>...</button>
<h1 data-testid=\"room-code\" className=\"room-code\">...</h1>
```

- [ ] **Step 4: Configure Cypress and orchestration**

Create `cypress.config.mjs`:

```js
import { defineConfig } from 'cypress'

export default defineConfig({
  e2e: {
    baseUrl: 'http://127.0.0.1:5173',
    video: false,
  },
})
```

Add root dependencies `cypress`, `concurrently`, and `start-server-and-test`, then set scripts:

```json
"start:test-server": "PORT=3001 CLIENT_URL=http://127.0.0.1:5173 npm --prefix server start",
"start:test-client": "VITE_SERVER_URL=http://127.0.0.1:3001 npm --prefix client run dev -- --host 127.0.0.1 --port 5173 --strictPort",
"start:test-app": "concurrently --kill-others-on-fail \"npm run start:test-server\" \"npm run start:test-client\"",
"test:e2e": "start-server-and-test \"npm run start:test-app\" \"http://127.0.0.1:3001|http://127.0.0.1:5173\" \"cypress run\""
```

Run `npm install`.

- [ ] **Step 5: Execute the E2E suite and verify no residual processes**

Run:

```zsh
npm run test:e2e
curl --fail http://127.0.0.1:3001/ && exit 1 || true
```

Expected: Cypress reports 2 passing tests, then the final command does not find a process listening on port 3001.

- [ ] **Step 6: Commit**

```zsh
git add client/src/App.jsx client/src/socket.js cypress.config.mjs cypress/e2e/lobby.cy.js package.json package-lock.json
git commit -m "test: add Cypress lobby coverage"
```

### Task 4: Unify execution, SonarQube coverage, and documentation

**Files:**
- Modify: `package.json`
- Modify: `sonar-project.properties`
- Modify: `README.md`
- Modify: `docs/sonarqube-evidence.md`

**Interfaces:**
- Consumes: `test:server`, `test:e2e`, and `server/coverage/lcov.info`.
- Produces: root `npm test`, `npm run test:coverage`, and SonarQube import of the server LCOV report.

- [ ] **Step 1: Add root test scripts**

Set these root scripts:

```json
"test:server": "npm --prefix server test",
"test:coverage": "npm --prefix server run test:coverage",
"test": "npm run test:server && npm run test:e2e"
```

- [ ] **Step 2: Configure SonarQube scope and LCOV**

Append to `sonar-project.properties`:

```properties
sonar.tests=server/test,cypress
sonar.test.inclusions=server/test/**/*.test.js,cypress/**/*.cy.js
sonar.javascript.lcov.reportPaths=server/coverage/lcov.info
```

- [ ] **Step 3: Document the commands and evidence**

In `README.md`, add:

```bash
npm test
npm run test:coverage
npm run test:e2e
```

Explain that Cypress downloads a browser on the first `npm install`, and that the coverage currently comes from server integration tests. Add unchecked screenshots/log entries for `npm test`, Cypress result and coverage import to `docs/sonarqube-evidence.md`.

- [ ] **Step 4: Run full verification**

Run:

```zsh
npm test
npm run test:coverage
npm run quality:lint
npm run quality:build
npm audit
git diff --check
```

Expected: server tests and Cypress pass, LCOV exists, lint/build pass, audit reports 0 vulnerabilities, and diff check has no output.

- [ ] **Step 5: Commit**

```zsh
git add package.json package-lock.json sonar-project.properties README.md docs/sonarqube-evidence.md
git commit -m "docs: document automated test workflow"
```
