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

| Nodo | URL pública | Rol esperado con los tres vivos |
| --- | --- | --- |
| 1 | `http://localhost:3001` | seguidor |
| 2 | `http://localhost:3002` | seguidor |
| 3 | `http://localhost:3003` | líder |

La elección usa el identificador numérico vivo más alto. Cada nodo renueva un
heartbeat y lease de seis segundos cada dos segundos. Un cliente que reciba
`LEADER_REDIRECT` o `leader-changed` se vuelve a conectar a la URL pública del
líder.

En otra terminal sirve el cliente apuntando inicialmente al líder:

```bash
VITE_SERVER_URL=http://localhost:3003 npm --prefix client run dev
```

Abre la URL que informe Vite, normalmente `http://localhost:5173`. El enlace
**Dashboard** abre `/dashboard` y muestra el líder, nodos, reloj Lamport,
versiones de sala y eventos. Al crear una sala, comparte el código o el QR con
los otros participantes; para una prueba manual usa tres perfiles de navegador
distintos (normal, privado y otro perfil/navegador).

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
Espera al menos siete segundos (un lease puede tardar hasta seis segundos en
expirar) y comprueba el lease compartido:

```bash
redis-cli GET buscaminas:cluster:leader
```

El dashboard debe anunciar el nodo 2 como líder y la sala debe seguir presente
en Redis. La continuidad se puede comprobar conectando de nuevo al nodo 2 y
realizando una acción válida:

```bash
VITE_SERVER_URL=http://localhost:3002 npm --prefix client run dev
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
