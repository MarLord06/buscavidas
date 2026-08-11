# Turnos, banderas y vidas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir turnos sincronizados de 12 segundos, tres vidas y banderas individuales al juego distribuido.

**Architecture:** El turno pertenece a `room.game` y se persiste dentro del lock Redis existente. El líder procesa vencimientos idempotentes y React habilita únicamente al dueño del turno.

**Tech Stack:** Node.js, Redis, Socket.IO, React, Cypress, `node:test` y c8.

## Global Constraints

* `TURN_DURATION_MILLISECONDS` es `12_000` y `INITIAL_PLAYER_LIVES` es `3`.
* Toda mutación pasa por `runRoomCommand`, avanza Lamport y `stateVersion`, y solo la ejecuta el líder.
* Una bandera es individual, no revela ni puntúa y no se pone sobre una celda revelada.
* Espectadores, desconectados, eliminados y jugadores fuera de turno no pueden ejecutar acciones.

---

### Task 1: Modelo de turno, vidas y banderas

**Files:**
- Modify: `server/services/game-command-service.js`
- Test: `server/test/game-command-service.test.js`

**Consumes:** `runRoomCommand`, `createBoard`, `getPublicGame` y locks Redis.

**Produces:** `toggleFlag`, estado público de turno, vidas y banderas por celda.

- [ ] **Step 1: Write the failing test**

Agregar casos que verifiquen primer turno del anfitrión, rechazo fuera de turno, avance tras revelación, vida perdida por mina, eliminación con cero vidas y banderas de dos jugadores en una celda oculta.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/game-command-service.test.js`

Expected: faltan `currentTurnPlayerId`, `lives` y `toggleFlag`.

- [ ] **Step 3: Write minimal implementation**

Declarar `const TURN_DURATION_MILLISECONDS = 12_000` y `const INITIAL_PLAYER_LIVES = 3`; inicializar vidas, `currentTurnPlayerId`, `turnExpiresAt` y `flaggedBy: []` al iniciar o reiniciar; exponerlos sin revelar `isMine` oculto.

Implementar `getEligiblePlayers(room)` para `connected && lives > 0`, `advanceTurn(room, currentTime)` para selección circular y `toggleFlag(command)` con validación de turno e índice. Actualizar `revealCell` para quitar banderas, perder vida y dos puntos al hallar mina, eliminar a cero y finalizar al quedar un jugador elegible o no quedar seguras.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/game-command-service.test.js`

Expected: reglas de turnos, vidas y banderas aprobadas.

- [ ] **Step 5: Commit**

```bash
git add server/services/game-command-service.js server/test/game-command-service.test.js
git commit -m "feat: add turn based game state"
```

### Task 2: Vencimiento y recuperación distribuida

**Files:**
- Modify: `server/services/game-command-service.js`
- Modify: `server/app.js`
- Test: `server/test/failover.test.js`
- Test: `server/test/game-server.test.js`

**Consumes:** Estado de turno de la tarea 1 e intervalo del líder.

**Produces:** `advanceExpiredTurn`, avance único por vencimiento y salto de jugadores no elegibles.

- [ ] **Step 1: Write the failing test**

Con `now` controlado, probar que `advanceExpiredTurn(roomCode)` no muta antes de vencer, avanza una vez después de vencer, no se duplica y un sucesor tras failover procesa el turno vencido. Probar desconexión del jugador actual y salto al siguiente elegible.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/failover.test.js server/test/game-server.test.js`

Expected: no existen el procesador de vencimiento ni el intervalo de turno.

- [ ] **Step 3: Write minimal implementation**

Implementar `advanceExpiredTurn(roomCode)` con `runRoomCommand` y `commandId` que incluya sala y vencimiento; mutar solo si juega, `now() >= turnExpiresAt` y el vencimiento coincide. Exportar `advanceExpiredTurnsInRooms()` y llamarlo desde el intervalo de líder en `server/app.js`. En `leaveRoom` y `reconcileExpiredPlayers`, avanzar si el desconectado tenía el turno.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/failover.test.js server/test/game-server.test.js`

Expected: vencimiento, desconexión y failover conservan una sola secuencia.

- [ ] **Step 5: Commit**

```bash
git add server/app.js server/services/game-command-service.js server/test/failover.test.js server/test/game-server.test.js
git commit -m "feat: recover synchronized turns after failures"
```

### Task 3: Socket.IO e interfaz por turnos

**Files:**
- Modify: `server/services/socket-handlers.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/App.css`
- Test: `server/test/game-server.test.js`

**Consumes:** `toggleFlag`, `currentTurnPlayerId`, vidas y `flaggedBy`.

**Produces:** Evento `toggle-flag`, selector revelar/bandera e indicadores visuales de turno y vidas.

- [ ] **Step 1: Write the failing test**

Extender `game-server.test.js`: el socket dueño del turno emite `toggle-flag`, recibe ACK y `room-updated`; un socket fuera de turno recibe rechazo y no modifica el snapshot.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/game-server.test.js`

Expected: `toggle-flag` no está registrado.

- [ ] **Step 3: Write minimal implementation**

Registrar `toggle-flag` con `registerLimitedHandler` y metadatos de `reveal-cell`. En `App.jsx`, calcular `isCurrentTurn`; mostrar `data-testid="turn-status"`, contador, vidas y eliminación. Añadir modo `revelar` o `bandera`; deshabilitar celdas fuera de turno; emitir el evento elegido; dibujar `flaggedBy` con los colores de propietarios y una etiqueta ARIA con el número de banderas.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/game-server.test.js && npm run quality:lint && npm run quality:build`

Expected: servidor, lint y build pasan.

- [ ] **Step 5: Commit**

```bash
git add server/services/socket-handlers.js server/test/game-server.test.js client/src/App.jsx client/src/App.css
git commit -m "feat: expose turn controls and personal flags"
```

### Task 4: Cypress y evidencia de mecánica

**Files:**
- Modify: `cypress/e2e/lobby.cy.js`
- Modify: `cypress/e2e/dashboard.cy.js`
- Modify: `docs/vv-evidence.md`

**Consumes:** Selectores de turno, vidas y banderas de la tarea 3.

**Produces:** Cobertura visible de turno propio, turno ajeno, banderas y estado de sala actualizado.

- [ ] **Step 1: Write the failing test**

Inyectar un `room-updated` de partida con turno de Ana, tres vidas y bandera coloreada; verificar `turn-status`, contador de vidas y celda deshabilitada para visitante. Cambiar el turno al visitante y comprobar la acción habilitada. Añadir una actualización de dashboard con versión nueva y comprobar que se conserva.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_SERVER_PORT=3101 TEST_CLIENT_PORT=5273 npm run test:e2e`

Expected: faltan selectores y contenido de turnos, vidas o banderas.

- [ ] **Step 3: Write minimal implementation**

Agregar solo los `data-testid` previstos, sin acoplar pruebas a estilos. Actualizar `docs/vv-evidence.md` con los casos de turno, bandera, vida y recuperación, y el comando E2E de puertos aislados.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:coverage && TEST_SERVER_PORT=3101 TEST_CLIENT_PORT=5273 npm run test:e2e && npm run quality:lint && npm run quality:build`

Expected: cobertura LCOV, Cypress, lint y build pasan.

- [ ] **Step 5: Commit**

```bash
git add cypress/e2e/lobby.cy.js cypress/e2e/dashboard.cy.js docs/vv-evidence.md
git commit -m "test: cover turn based game flows"
```
