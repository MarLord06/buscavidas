# Evidencias de Verificación y Validación

Este documento reúne los resultados reproducibles del proyecto Buscaminas
Tripartito para el informe técnico final. Los secretos de SonarQube y Jenkins
no se incluyen en el repositorio ni en las capturas.

## Entorno evaluado

| Componente | Evidencia |
| --- | --- |
| Backend distribuido | Tres nodos Node.js coordinados por Redis y Socket.IO. |
| Calidad estática | SonarQube Community Build local, proyecto `buscaminas-tripartito`. |
| Integración continua | Jenkins LTS local, job `buscaminas-tripartito`, rama `main`. |
| Pruebas funcionales | Cypress en modo headless. |
| Persistencia y coordinación | Redis local, comprobado con `npm run redis:check`. |

## Resultados de pruebas

| Capa | Comando | Resultado comprobado |
| --- | --- | --- |
| Unitarias e integración | `npm run test:coverage` | 47 pruebas aprobadas, 0 fallidas. |
| Cobertura del servidor | `npm run test:coverage` | 91.62 % de líneas globales; 93.55 % en `server/`. |
| Calidad de cliente | `npm run quality:lint` | ESLint finaliza sin errores. |
| Compilación | `npm run quality:build` | Vite genera el build de producción correctamente. |
| End-to-end | `TEST_SERVER_PORT=3101 TEST_CLIENT_PORT=5273 npm run test:e2e` | 7 pruebas Cypress aprobadas, 0 fallidas. |
| Calidad estática | Etapa `SonarQube` en Jenkins | Quality Gate aprobado. |

La ejecución E2E usa puertos configurables para no reutilizar una instancia
de juego que esté abierta en la máquina. Esta propiedad es especialmente útil
para que Jenkins ejecute las pruebas contra su propia revisión del código.

## Cobertura de requisitos distribuidos

| Requisito | Evidencia automatizada |
| --- | --- |
| Comunicación bidireccional | Pruebas Socket.IO de creación, unión, espectador y difusión de estado. |
| Tres clientes concurrentes | Caso de integración que crea una sala, conecta a Ana, Beto y Caro e inicia la partida. |
| Orden lógico | Pruebas de versión de estado y reloj Lamport que rechazan actualizaciones atrasadas. |
| Exclusión mutua | Pruebas de locks Redis y revelaciones concurrentes; una sola transición queda confirmada. |
| Idempotencia | Pruebas de `commandId` repetido que devuelven el resultado original sin reaplicar la operación. |
| Detección de fallos | Heartbeats con TTL y reconciliación de jugadores expirados. |
| Reconfiguración | Pruebas de failover donde el nodo superviviente asume el liderazgo y conserva la sala. |
| Interfaz de feria | Código QR de sala, enlace compartible y dashboard de clúster en tiempo real. |

La matriz detallada que enlaza cada requisito con su prueba está en
[`distributed-validation-matrix.md`](distributed-validation-matrix.md).

## Integración continua

El `Jenkinsfile` ejecuta, en este orden: instalación de dependencias,
verificación de Redis, lint, cobertura, Cypress E2E, build y SonarQube. El
scanner espera el Quality Gate y hace fallar el build cuando este no se
aprueba.

El job usa la rama `main` y sondeo SCM `H/5 * * * *`: Jenkins consulta GitHub
cada cinco minutos y ejecuta el pipeline cuando detecta un commit nuevo. Esta
alternativa no necesita exponer Jenkins local por Internet ni configurar un
webhook hacia una dirección loopback.

## Capturas que deben adjuntarse al informe

1. Pantalla principal con nombre, creación de sala y enlace al dashboard.
2. Sala creada con código QR y tres jugadores conectados.
3. Dashboard mostrando líder, nodos, reloj Lamport, salas y eventos.
4. Demostración de caída de un nodo y elección del líder sucesor.
5. Resultado de Cypress: `7 passing` y `All specs passed`.
6. Consola de Jenkins con todas las etapas y `Finished: SUCCESS`.
7. Overview de SonarQube con Quality Gate aprobado, cobertura y duplicación.

## Próxima actividad de V&V

## Pruebas de seguridad con Burp Suite

Las pruebas se realizaron contra la instancia local del equipo usando el
navegador integrado de Burp Suite Community Edition. El alcance fue el juego
local y sus mensajes Socket.IO; no se realizaron pruebas contra sistemas de
terceros.

| ID | Prueba | Resultado |
| --- | --- | --- |
| SEC-01 | Modificar `create-room` y enviar `playerName` con solo espacios. | Aprobada: el backend respondió `success: false` y `Debes escribir tu nombre`. |
| SEC-02 | Reenviar una creación válida con el mismo `commandId`. | Aprobada: devolvió el mismo `roomCode`, jugador y versión original; no creó otra sala. |
| SEC-03 | Inspeccionar `cluster-status` recibido por un cliente de juego. | Hallazgo corregido: antes exponía salas, jugadores y partidas de todo el clúster. Ahora solo el dashboard se suscribe y recibe resúmenes sin jugadores ni tablero. |
| SEC-04 | Enviar 13 comandos `create-room` inválidos desde una misma conexión Socket.IO. | Aprobada: los primeros 12 fueron validados normalmente; el decimotercero recibió `success: false` y código `RATE_LIMITED`, sin crear salas. Los heartbeats permanecen disponibles para no desconectar al jugador. |

Las correcciones de SEC-03 y SEC-04 tienen pruebas de regresión de servidor.
La primera verifica que un socket no suscrito no reciba telemetría y que el
resumen del dashboard no contenga las propiedades `players` ni `game`; la
segunda configura dos comandos por ventana, confirma el rechazo del tercero y
comprueba que `player-heartbeat` no quede limitado.
