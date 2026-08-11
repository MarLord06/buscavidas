# Diseño: Buscaminas Tripartito distribuido

## Objetivo

Convertir el juego Socket.IO de proceso único en un sistema distribuido de tres
nodos backend que mantenga salas y partidas consistentes ante acciones
simultáneas y la caída de un nodo. Redis será la fuente compartida de estado y
coordinación. La interfaz incluirá un dashboard para evidenciar el
comportamiento distribuido en una demostración pública.

## Alcance de esta iteración

- Tres instancias equivalentes del backend, identificadas como nodos `1`, `2` y
  `3`.
- Redis para estado de salas, comandos procesados, locks, heartbeats y lease de
  liderazgo.
- Algoritmo Bully simplificado y determinista: el nodo vivo con mayor
  identificador es el líder.
- Reloj lógico de Lamport, `commandId` idempotente y `stateVersion` por sala.
- Exclusión mutua distribuida para acciones que modifican una sala.
- Heartbeats de nodos y jugadores, reconfiguración tras caída del líder y
  recuperación desde Redis.
- Dashboard `/dashboard`, telemetría visible y código QR de unión a sala.
- Pruebas de integración de concurrencia, orden, recuperación y consistencia.

No se declara tolerancia a la caída de Redis en esta iteración: la instalación
local es una única instancia. Redis Sentinel y réplicas solo se incorporarán y
documentarán como alta disponibilidad cuando estén instalados y probados.

## Arquitectura

```text
 Navegadores Socket.IO
          |
          +---- nodo 1 ----+
          +---- nodo 2 ----+---- Redis
          +---- nodo 3 ----+      |
                                      salas, locks, leases,
                                      heartbeats y eventos
```

Cada nodo ejecuta la misma aplicación con `NODE_ID`, `PORT` y `PUBLIC_URL`
configurables. Todos se suscriben al adaptador Redis de Socket.IO para difundir
el estado de una sala a clientes conectados a nodos distintos. El estado de la
sala no permanece en un `Map`: se serializa en Redis bajo `room:<code>`.

El frontend puede conectarse a cualquiera de los nodos. Cada nodo informa el
líder actual; si recibe una acción de mutación y no es líder, responde con la
URL del líder para que el cliente reconecte sin perder su identidad de jugador.
El dashboard puede conectarse a cualquier nodo, porque sus métricas se leen de
Redis y sus actualizaciones se emiten a través del adaptador.

## Liderazgo y detección de fallos

Cada nodo escribe `cluster:heartbeat:<nodeId>` con TTL de seis segundos y lo
renueva cada dos segundos. Cada ciclo de elección lee los heartbeats vigentes;
el conjunto de nodos vivos se ordena por identificador y el mayor es el líder
esperado. Solo ese nodo puede crear o renovar `cluster:leader` con un lease de
seis segundos.

El valor del lease incluye `nodeId` y un token aleatorio. Su renovación y
liberación se hacen con scripts Lua que verifican el token, para que un nodo
antiguo no borre el lease de un líder nuevo. Cuando expira el heartbeat o lease
del líder, el siguiente nodo vivo adquiere el lease, publica `leader-changed` y
comienza a procesar acciones usando el estado persistido de Redis.

La caída de un cliente se detecta tanto por Socket.IO como por el heartbeat de
jugador, renovado desde el cliente cada cinco segundos con TTL de quince
segundos. El líder marca al jugador desconectado, reasigna el anfitrión si
corresponde y publica una nueva versión de sala. La reconexión conserva el
nombre, restablece el socket y obtiene la versión actual desde Redis.

## Consistencia, orden y exclusión mutua

Cada cliente mantiene `lamportClock`. Una acción mutante contiene:

```js
{
  commandId: 'uuid',
  clientId: 'uuid persistente',
  lamportClock: 42,
  cellIndex: 17,
}
```

El líder actualiza su reloj como
`max(room.lamportClock, command.lamportClock) + 1`. Después adquiere el lock
`lock:room:<code>` mediante `SET key token NX PX 3000`. Dentro del lock vuelve
a leer la sala, rechaza comandos ya presentes en `room:<code>:commands`, valida
el estado y aplica una única transición. Al guardar, incrementa
`stateVersion`, registra el `commandId` con TTL y publica un evento con la
versión, el reloj Lamport y el resultado.

El lock es el punto de linealización: dos revelaciones simultáneas de la misma
casilla se observan en un único orden global. La primera transición válida se
confirma; la siguiente observa la casilla revelada. Los clientes solo aceptan
`room-updated` cuya `stateVersion` sea mayor o igual que su versión local, por
lo que nunca retroceden visualmente por un mensaje tardío.

## Dashboard y experiencia de feria

`/dashboard` muestra el líder, la lista de nodos con estado vivo/caído, el
lease restante, los jugadores conectados, el reloj Lamport y la versión de
cada sala, la latencia de heartbeat y los últimos eventos de liderazgo,
reconexión y comandos. La pantalla de juego expone un QR con la URL y código de
sala para que móviles se unan sin instalar nada. El dashboard es de solo
lectura y puede proyectarse como pantalla maestra.

## Interfaces internas

- `ClusterCoordinator`: publica heartbeats, calcula el líder y expone
  `isLeader()`, `getLeader()` y `start()/stop()`.
- `RedisRoomRepository`: expone `getRoom(code)`, `saveRoom(room)`,
  `withRoomLock(code, fn)` y operaciones idempotentes de comandos.
- `GameCommandService`: valida comandos, actualiza Lamport y versión, y
  devuelve una respuesta estable para duplicados.
- `ClusterTelemetryService`: construye el estado consumido por el dashboard.
- Eventos Socket.IO: `cluster-status`, `leader-changed`, `room-updated` y
  `command-result` incluyen las versiones y metadatos definidos arriba.

## Pruebas y criterios de aceptación

1. Tres clientes conectados a nodos diferentes crean y juegan en una misma
   sala; todos reciben la misma `stateVersion`.
2. Dos comandos concurrentes sobre una casilla aplican una única transición y
   el comando duplicado no cambia la puntuación.
3. Un mismo `commandId` reenviado devuelve el resultado original sin aplicar
   puntos de nuevo.
4. Al detener el líder, un nodo vivo con mayor ID restante se convierte en
   líder antes de seis segundos y las salas continúan desde Redis.
5. Un jugador desconectado pasa a estado no conectado y se puede reconectar sin
   perder su asiento.
6. El dashboard refleja líder, nodos, reloj y eventos; el QR permite abrir la
   página de acceso con el código de sala.

## Riesgos y límites

- La instalación de Redis debe estar iniciada antes de ejecutar el clúster.
- La consistencia prometida es secuencial por sala: el líder serializa cada
  transición, no se intenta una transacción global entre salas.
- Sin Redis Sentinel, una caída de Redis detiene el servicio distribuido. Este
  límite se mostrará explícitamente en la documentación y el dashboard.
- El cambio de líder no migra sockets existentes entre procesos; el cliente se
  reconecta al líder anunciado y vuelve a solicitar el estado de sala.
