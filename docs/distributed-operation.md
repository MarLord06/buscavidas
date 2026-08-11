# Operación local del clúster distribuido

Esta guía ejecuta tres nodos Socket.IO coordinados mediante una sola instancia
local de Redis. Está pensada para desarrollo local, no para alta disponibilidad.

## Requisitos

- Node.js 22.12 o posterior y las dependencias instaladas en la raíz, `client`
  y `server`.
- Homebrew y Redis local.
- Puertos locales `3001`, `3002`, `3003` y `5173` disponibles.

Instala Redis si aún no está disponible y arráncalo como servicio local:

```bash
brew install redis
brew services start redis
npm run redis:check
```

El último comando debe imprimir `PONG`. El clúster no debe iniciarse si Redis
no responde, porque Redis conserva las salas, los locks, los heartbeats y el
lease del líder.

## Arranque normal

Desde la raíz del repositorio, inicia los tres nodos:

```bash
npm run start:cluster
```

El comando inicia los siguientes nodos:

| Nodo | Puerto | Rol esperado con los tres vivos |
| --- | --- | --- |
| 1 | `3001` | seguidor |
| 2 | `3002` | seguidor |
| 3 | `3003` | líder |

La elección usa el identificador numérico vivo más alto. Cada nodo renueva un
heartbeat y lease de cuatro segundos cada 500 ms. Los nodos seleccionan una
IPv4 local no loopback para su URL pública; `PUBLIC_URL` o `PUBLIC_HOST`
permiten sobreescribirla. Un cliente que recibe `LEADER_REDIRECT` o
`leader-changed` se conecta a la URL pública del líder. Si el nodo al que estaba
conectado cae y ya no puede emitir ese evento, el cliente consulta
`/cluster/leader` en los tres puertos, descubre al sucesor y vuelve a ingresar a
la sala con su `clientId` persistente.

En otra terminal sirve el cliente apuntando inicialmente al líder:

```bash
npm --prefix client run dev
```

Abre la URL **Network** que informe Vite, por ejemplo
`http://192.168.1.20:5173`. El enlace
**Dashboard** abre `/dashboard` y muestra el líder, nodos, reloj Lamport,
versiones de sala y eventos. Al crear una sala, comparte el código o el QR con
los otros participantes; para una prueba manual usa tres perfiles de navegador
distintos (normal, privado y otro perfil/navegador).

Si la interfaz elegida automáticamente no es la correcta, inicia el clúster y
el cliente con valores explícitos:

```bash
PUBLIC_HOST=192.168.1.20 npm run start:cluster
VITE_PUBLIC_URL=http://192.168.1.20:5173 \
VITE_SERVER_URL=http://192.168.1.20:3003 \
VITE_CLUSTER_URLS=http://192.168.1.20:3001,http://192.168.1.20:3002,http://192.168.1.20:3003 \
npm --prefix client run dev
```

## Demostración de recuperación del líder

Para observar la recuperación de forma controlada, detén el proceso combinado
anterior y levanta cada nodo en una terminal distinta:

```bash
npm run start:node:1
```

```bash
npm run start:node:2
```

```bash
npm run start:node:3
```

Con una partida en curso, detén el proceso de `start:node:3` con `Ctrl-C`.
El sucesor debe asumir en menos de seis segundos; la prueba automatizada de
caída conserva intencionalmente el heartbeat y lease antiguos, como ocurriría
si el proceso terminara sin limpieza. Comprueba el lease compartido:

```bash
redis-cli GET buscaminas:cluster:leader
```

El dashboard debe anunciar el nodo 2 como líder y la sala debe seguir presente
en Redis. La continuidad se puede comprobar conectando de nuevo al nodo 2 y
realizando una acción válida:

```bash
redis-cli --scan --pattern 'buscaminas:room:*'
```

La prueba automatizada equivalente es:

```bash
node --test server/test/failover.test.js
```

## Límites operativos conocidos

- Hay una sola instancia Redis local. Si Redis se detiene o pierde sus datos,
  el clúster no puede coordinar elecciones, locks ni estado de salas.
- Esta configuración no implementa Redis Sentinel, réplicas, Redis Cluster ni
  una conmutación por error de Redis. Por tanto, no afirma tolerancia a la caída
  de Redis ni alta disponibilidad.
- Los tres procesos se ejecutan en una misma máquina para desarrollo; esto no
  constituye una prueba de tolerancia a fallas de red, host ni zona.
- Los comandos mutantes se ordenan por sala bajo lock de Redis; no existe una
  transacción global entre salas.

## Verificación antes de una demostración

```bash
npm run redis:check
npm test
npm run test:coverage
npm run quality:lint
npm run quality:build
```

`npm run test:coverage` genera `server/coverage/lcov.info`, que utiliza el
análisis local de SonarQube. El procedimiento del escaneo y su evidencia están
en [sonarqube-evidence.md](sonarqube-evidence.md).
