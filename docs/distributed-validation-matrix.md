# Matriz de validación distribuida

La matriz vincula cada criterio de aceptación con la prueba más específica,
su evidencia observable y el resultado esperado. Las filas marcadas como
manuales no se presentan como pruebas automatizadas: describen límites
arquitectónicos o una demostración operativa que un test no puede certificar.

| Criterio | Comando exacto | Prueba o evidencia | Resultado esperado |
| --- | --- | --- | --- |
| WebSockets entre cliente y servidor | `node --test server/test/game-server.test.js` | `crea una sala, admite tres jugadores e inicia una partida` crea clientes Socket.IO con transporte `websocket`. | Los clientes conectan, reciben actualizaciones y la partida inicia. |
| Tres clientes simultáneos | `node --test server/test/game-server.test.js` | La misma prueba conecta anfitrión, segundo y tercer jugador antes de `start-game`. | La sala tiene tres jugadores y el tablero contiene 81 casillas ocultas. |
| Reloj Lamport para comandos | `node --test server/test/game-command-service.test.js` | `preserva las reglas del lobby y versiona cada transición válida` comprueba la actualización del reloj con comandos entrantes. | Cada mutación válida responde con `lamportClock` creciente. |
| Lock distribuido por sala | `node --test server/test/redis-room-repository.test.js` | `serializa dos transiciones concurrentes de una sala` y `renueva el lease mientras una transición conserva el lock`. | Solo una transición entra a la sección crítica; el lock se renueva y se libera por dueño. |
| Idempotencia y versión de estado | `node --test server/test/game-command-service.test.js` | Pruebas de revelaciones concurrentes, `commandId` repetido y snapshots publicados. | Una revelación se aplica una vez; `stateVersion` avanza secuencialmente y no se repite el puntaje. |
| Cliente no retrocede de versión | `npm run test:e2e -- --spec cypress/e2e/dashboard.cy.js` | `mantiene la versión más reciente ante una actualización atrasada` y `no retrocede una sala si cluster-status llega atrasado`. | El dashboard conserva la mayor `stateVersion` observada. |
| Heartbeats de jugadores | `node --test server/test/game-server.test.js` | `renueva por quince segundos el heartbeat del jugador conectado` y reconciliación de jugadores expirados. | Redis conserva TTL cercano a 15 s; un jugador expirado se marca desconectado y se reasigna anfitrión. |
| Elección y failover del líder | `node --test server/test/failover.test.js` | `un nodo superviviente toma el liderazgo, lo publica y conserva la sala`. | Tras la caída del nodo 3, el nodo 2 publica liderazgo y conserva/avanza la sala. |
| Estado compartido entre nodos | `node --test server/test/game-server.test.js` | `difunde el mismo estado de sala entre dos nodos`. | Seguidor y líder reciben iguales `stateVersion` y celdas. |
| Dashboard distribuido | `npm run test:e2e -- --spec cypress/e2e/dashboard.cy.js` | Cypress verifica líder, tres nodos, reloj Lamport, versión y eventos. | Los selectores del dashboard muestran la telemetría más reciente. |
| QR para compartir la sala | `cypress/e2e/lobby.cy.js` | Al crear una sala, la vista renderiza `QRCodeSVG` y un enlace con la URL LAN/origen `/?room=<código>`. | Cypress valida que el enlace compartido usa el origen público de la página. |
| Redis disponible antes de arrancar | `npm run redis:check` | `redis-cli ping`. | Imprime `PONG`. |
| Límite: una sola instancia Redis, sin Sentinel/HA | `rg -n "Sentinel|réplicas|Redis Cluster|alta disponibilidad" docs/distributed-operation.md` | Revisión estática de la guía operacional. No existe una prueba automática que pueda demostrar tolerancia inexistente; el límite se declara explícitamente. | La documentación afirma dependencia de una sola instancia y no promete HA ni failover de Redis. |
| Cobertura LCOV para SonarQube | `npm run test:coverage` | Archivo `server/coverage/lcov.info` y resumen de c8. | El comando pasa y genera el LCOV que referencia `sonar-project.properties`. |
| Calidad de cliente | `npm run quality:lint && npm run quality:build` | ESLint y build de Vite. | Ambos comandos terminan con código 0. |

La ejecución local del 2026-08-10 está registrada en
[sonarqube-evidence.md](sonarqube-evidence.md). El escaneo autenticado de
SonarQube permanece pendiente hasta que un operador proporcione `SONAR_TOKEN`
solo en su sesión de terminal.
