# Informe Técnico Final — Buscaminas Tripartito

**Materia:** Gestión y Validación del Software  
**Docente:** Ing. Victor Alonzo Palacios  
**Estudiantes:** Mateo Coveña, Anthony Martinez, Marlon Mendoza  
**Tema:** Proyecto Final  
**Semestre:** Sexto A  
**Fecha:** 11/08/2026  
**PAO:** 2025 – 01

---

## 1. Descripción del sistema

Buscaminas Tripartito es un videojuego web multijugador en tiempo real para
tres jugadores. Los participantes crean o ingresan a una sala mediante un
código, revelan casillas sobre un tablero común de 9 × 9 con 10 minas y
compiten por la puntuación más alta. Las acciones y el tablero se sincronizan
en tiempo real; además, un modo espectador permite observar una partida sin
alterarla.

El sistema funciona como un laboratorio de sistemas distribuidos. El cliente
React se comunica mediante Socket.IO con un clúster de tres nodos Node.js.
Redis actúa como estado compartido y como mecanismo de coordinación. La
interfaz incluye el juego y un dashboard que muestra líder, nodos, salas,
reloj Lamport y eventos del clúster.

### 1.1 Interfaces disponibles

| Interfaz | Propósito |
| --- | --- |
| Juego y sala de espera | Crear o ingresar a una sala, jugar y observar puntajes. |
| Código QR y enlace compartible | Facilitar el ingreso desde otros dispositivos. |
| Modo espectador | Visualizar una sala sin permiso para revelar casillas. |
| Dashboard `/dashboard` | Mostrar el estado distribuido y los cambios de liderazgo. |

### 1.2 Arquitectura física y lógica

```text
Clientes web y espectadores
React + Vite + Socket.IO Client
          │ WebSocket
          ▼
┌──────────────────────────────────────────────┐
│ Nodo 1 :3001 │ Nodo 2 :3002 │ Nodo 3 :3003  │
│ Express + Socket.IO + coordinador distribuido │
└──────────────────────────────────────────────┘
          │ adaptador Socket.IO, estado y locks
          ▼
       Redis local compartido
  salas · comandos · locks · heartbeats · líder
```

Los nodos ejecutan el mismo backend. Cada uno publica un heartbeat en Redis y
calcula el líder vivo con mayor identificador; con los tres nodos activos, el
nodo 3 es el líder esperado. Los clientes pueden descubrir al líder mediante
`/cluster/leader`, recibir `leader-changed` y reconectarse preservando su
`clientId`.

La configuración demostrada utiliza una sola instancia Redis local. Aporta
coordinación compartida, pero no implementa Redis Sentinel, réplicas, Redis
Cluster ni conmutación por error de Redis.

## 2. Mecanismos distribuidos implementados

| Requisito | Implementación |
| --- | --- |
| Comunicación bidireccional | Socket.IO sobre WebSocket para comandos, salas, líder y telemetría. |
| Concurrencia real | Tres clientes pueden entrar a la misma sala; las pruebas conectan a Ana, Beto y Caro. |
| Ordenamiento lógico | Cada transición válida actualiza `lamportClock` y `stateVersion`; el cliente descarta actualizaciones atrasadas. |
| Exclusión mutua | Locks Redis por sala serializan comandos mutantes y se renuevan durante la transición. |
| Consistencia | Redis conserva la sala y los nodos emiten el snapshot confirmado mediante Socket.IO. |
| Idempotencia | `commandId` devuelve el resultado original si un comando se reintenta. |
| Detección de fallos | Heartbeats de nodos con TTL de 4 s y de jugadores con TTL de 15 s. |
| Reconfiguración | El nodo vivo de mayor ID toma el lease y publica el nuevo liderazgo. |
| Recuperación | El cliente descubre al líder sucesor y vuelve a ingresar con su identidad persistente. |

### 2.1 Flujo de un comando de juego

1. El jugador emite un comando Socket.IO con `commandId`, `clientId` y reloj Lamport.
2. El nodo receptor verifica el liderazgo; un seguidor redirige al líder.
3. El líder valida identidad, versión, reglas de sala y límite de solicitudes.
4. Se adquiere el lock Redis y se aplica una transición atómica de sala,
   resultado idempotente y heartbeat.
5. Se incrementan `stateVersion` y `lamportClock`, se libera el lock y se
   publica el snapshot confirmado.
6. Los clientes conservan la versión más nueva y no retroceden ante mensajes
   atrasados.

### 2.2 Tolerancia a fallos

Si el nodo 3 se detiene durante una partida, su heartbeat vence y el nodo 2
asume el liderazgo en menos de seis segundos. La sala permanece en Redis y el
cliente puede recuperar su conexión contra el sucesor. Esta recuperación está
cubierta por pruebas de failover y por
[distributed-operation.md](distributed-operation.md).

El alcance no promete tolerancia a la caída de Redis ni a la caída física de la
máquina anfitriona: los tres procesos y Redis se ejecutan localmente para fines
de desarrollo, pruebas y feria.

## 3. Pruebas automatizadas y validación distribuida

### 3.1 Herramientas utilizadas

| Herramienta | Uso |
| --- | --- |
| Node.js 26.7.0, `node:test` y `socket.io-client` | Pruebas unitarias e integración con clientes Socket.IO reales. |
| c8 10.1.3 | Cobertura de código y generación de `server/coverage/lcov.info`. |
| Cypress 15.20.1 | Pruebas end-to-end de juego, dashboard, consistencia y recuperación. |
| Electron 138 Headless | Navegador de ejecución de Cypress. |
| Redis 8.10.0 local | Estado compartido, locks, heartbeats y elección de líder. |
| SonarQube Community Build 26.7.0.124771 | Análisis estático, cobertura LCOV y Quality Gate. |
| Jenkins 2.568.2 | Integración continua y automatización del pipeline. |
| Burp Suite Community Edition 2026.7.3 | Inspección y manipulación controlada de mensajes Socket.IO. |

### 3.2 Resultados obtenidos

| Capa | Comando o evidencia | Resultado comprobado |
| --- | --- | --- |
| Servidor e integración | `npm run test:coverage` | 47 pruebas aprobadas, 0 fallidas. |
| Cobertura | `npm run test:coverage` | 93.55 % de líneas en `server/`; aproximadamente 91.5 % global. |
| Lint | `npm run quality:lint` | ESLint finalizó sin errores. |
| Build | `npm run quality:build` | Vite generó el build de producción correctamente. |
| End-to-end | `TEST_SERVER_PORT=3101 TEST_CLIENT_PORT=5273 npm run test:e2e` | 7 casos Cypress aprobados, 0 fallidos. |
| Redis | `npm run redis:check` | Respuesta `PONG`. |
| Dependencias | `npm audit` en raíz, `server` y `client` | 0 vulnerabilidades tras actualizar dependencias transitivas. |
| SonarQube | Etapa SonarQube de Jenkins | Quality Gate aprobado en la ejecución verificada. |

La prueba E2E usa los puertos aislados `3101` y `5273`, evitando conflictos
con una partida local de demostración que use `3001` y `5173`.

### 3.3 Casos funcionales y distribuidos relevantes

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| DIST-01 | Tres jugadores crean, ingresan e inician una sala. | Sala sincronizada con tres participantes y tablero de 81 casillas. |
| DIST-02 | Revelaciones concurrentes en una sala. | Un lock permite una sola transición confirmada por versión. |
| DIST-03 | Repetición del mismo `commandId`. | Se devuelve el resultado original sin repetir puntaje ni mutación. |
| DIST-04 | Heartbeat y reconciliación de jugador. | Un jugador expirado se marca desconectado y el anfitrión se reasigna. |
| DIST-05 | Caída del líder. | Un nodo superviviente asume liderazgo y conserva el estado de sala. |
| E2E-01 | Validación de nombre y creación de sala. | La interfaz muestra errores y un código de sala válido. |
| E2E-02 | Dashboard de clúster. | Se visualizan líder, nodos, Lamport, eventos y versiones. |
| E2E-03 | Estado recibido fuera de orden. | El dashboard conserva la versión más reciente. |
| E2E-04 | Recuperación tras pérdida de conexión. | El cliente descubre al líder y recupera su sesión. |

La trazabilidad completa entre requisito, prueba y evidencia se encuentra en
[distributed-validation-matrix.md](distributed-validation-matrix.md).

## 4. Calidad de código e integración continua

### 4.1 SonarQube

[`sonar-project.properties`](../sonar-project.properties) define las fuentes,
las pruebas y el reporte LCOV. El análisis excluye dependencias y archivos
generados, incluye pruebas de servidor y Cypress, e importa
`server/coverage/lcov.info`.

El escáner espera el Quality Gate hasta 300 segundos. Un análisis fallido
devuelve código de error y detiene Jenkins. La ejecución verificada aprobó el
Quality Gate. Las métricas y capturas exactas del panel se adjuntan desde
SonarQube sin exponer el token de acceso.

### 4.2 Jenkins

El `Jenkinsfile` ejecuta en `main` por sondeo SCM cada cinco minutos o mediante
**Build Now**. Sus etapas son:

```text
Install → Redis → Lint → Coverage → E2E → Build → SonarQube
```

La instalación usa `npm ci` en raíz, backend y cliente. E2E usa puertos
aislados. El pipeline archiva LCOV y capturas Cypress, y consume el secreto
Jenkins `sonarqube-token` sin guardarlo en Git.

## 5. Pruebas de seguridad

Las pruebas se realizaron contra la instancia local del proyecto, usando Burp
Suite Community Edition y mensajes Socket.IO controlados.

| ID | Prueba | Resultado |
| --- | --- | --- |
| SEC-01 | Crear sala con nombre formado solo por espacios. | Rechazo con `success: false` y `Debes escribir tu nombre`. |
| SEC-02 | Reenviar una creación con el mismo `commandId`. | Resultado original sin crear otra sala. |
| SEC-03 | Inspeccionar `cluster-status` desde el juego. | Corregido: solo dashboard suscrito recibe resúmenes sin jugadores ni tablero. |
| SEC-04 | Enviar 13 comandos inválidos desde una conexión. | El decimotercero devuelve `RATE_LIMITED`, sin crear una sala. |
| SEC-05 | Ejecutar `npm audit` en raíz, backend y cliente. | Los tres reportes finales muestran 0 vulnerabilidades. |

SEC-04 limita por defecto a 12 comandos mutables por conexión cada cinco
segundos. `player-heartbeat` queda excluido para que la protección contra
flooding no desconecte a un jugador legítimo. La evidencia reproducible está
en [vv-evidence.md](vv-evidence.md).

## 6. Matriz resumida de cumplimiento

| Eje de evaluación | Evidencia |
| --- | --- |
| Sistemas distribuidos | Tres nodos, Redis compartido, Socket.IO, líder, Lamport, locks e idempotencia. |
| Sincronización y consistencia | `stateVersion`, reloj Lamport, lock por sala y snapshots confirmados. |
| Tolerancia a fallos | Expiración de heartbeats, elección de sucesor y recuperación de cliente. |
| Calidad | SonarQube con LCOV y Quality Gate integrado al pipeline. |
| Integración continua | Jenkins ejecuta instalación, Redis, lint, cobertura, Cypress, build y SonarQube. |
| Pruebas automatizadas | 47 pruebas de servidor y 7 pruebas end-to-end aprobadas. |
| Seguridad | Validación de entradas, replay, telemetría restringida, rate limiting y auditoría de dependencias. |
| Perfil de feria | Sala compartible, QR, interacción móvil y dashboard proyectable. |

## 7. Evidencias visuales por adjuntar

Para la entrega en PDF se deben insertar capturas reales, sin mostrar tokens ni
datos sensibles, en los siguientes puntos:

1. Pantalla de inicio, QR y enlace para unirse a una sala.
2. Tres jugadores conectados y tablero en curso.
3. Dashboard con nodos 1, 2 y 3, líder, Lamport y eventos.
4. Demostración de caída de un nodo y elección del sucesor.
5. Salida Cypress con `7 passing` y `All specs passed`.
6. Jenkins con todas las etapas y `Finished: SUCCESS`.
7. Overview de SonarQube con el Quality Gate aprobado.
8. Burp Suite mostrando la respuesta Socket.IO `RATE_LIMITED`.

## 8. Conclusiones

Buscaminas Tripartito cumple el propósito de un sistema distribuido de tiempo
real: varios clientes actúan sobre el mismo recurso, los comandos se ordenan
mediante reloj Lamport y versiones, los conflictos se serializan con locks de
Redis y los nodos se reconfiguran cuando el líder falla. Socket.IO permite que
el juego y el dashboard reflejen los cambios sin polling HTTP.

El proceso de V&V acompaña la implementación: las pruebas cubren concurrencia,
reintentos, recuperación y UI; Jenkins automatiza el pipeline; SonarQube
consume la cobertura; Burp Suite validó entradas, replay, exposición de datos
y flooding; y `npm audit` no reporta vulnerabilidades al cierre.

La principal limitación documentada es Redis único local. Una evolución de
producción requeriría Sentinel, réplicas o un servicio administrado de Redis,
junto con nodos en hosts independientes. Esta limitación no invalida la
demostración académica, porque está declarada y las pruebas de fallos se
concentran en nodos de aplicación, liderazgo y consistencia de sala.
