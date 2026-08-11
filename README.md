# Buscaminas Tripartito

Juego multijugador en tiempo real inspirado en Buscaminas. Tres jugadores compiten dentro de una misma sala para descubrir casillas seguras y conseguir la mayor puntuación.

El proyecto utiliza un cliente web desarrollado con React y tres nodos Node.js
que sincronizan salas, tablero y puntuaciones mediante Socket.IO y Redis.

## Funciones principales

- Creación de salas mediante un código único.
- Partidas para tres jugadores con colores diferentes.
- Tablero compartido y actualizado en tiempo real.
- Puntuaciones sincronizadas entre todos los participantes.
- Penalización al descubrir una mina.
- Selección automática del ganador o declaración de empate.
- Opción para iniciar una nueva partida con otro tablero.
- Acceso como espectador sin permiso para revelar casillas.
- Reconexión de jugadores desconectados.
- Cambio automático de creador cuando el anfitrión abandona la sala.
- Diseño adaptable para computadoras y dispositivos móviles.
- Ejecución local en tres nodos coordinados por Redis, con elección de líder,
  locks por sala, reloj Lamport, versiones de estado y recuperación del líder.
- Código QR para compartir una sala y dashboard de telemetría del clúster.

## Reglas de puntuación

- Cada casilla segura descubierta suma **1 punto**.
- Cada mina descubierta resta **2 puntos**.
- La puntuación nunca puede ser menor que cero.
- La partida termina cuando se descubren todas las casillas seguras.
- Gana el jugador que tenga la puntuación más alta.

## Tecnologías utilizadas

### Cliente

- React
- Vite
- JavaScript
- CSS
- Socket.IO Client

### Servidor

- Node.js
- Express
- Socket.IO
- CORS
- Redis (`ioredis` y adaptador Redis de Socket.IO)

## Requisitos

Antes de ejecutar el proyecto debes tener instalado:

- [Node.js](https://nodejs.org/) 22.12 o una versión posterior para ejecutar la aplicación, las pruebas Cypress y el análisis con SonarScanner.
- npm, incluido con Node.js.
- Un navegador web moderno.
- Redis local para ejecutar el clúster distribuido.

## Instalación

Clona el repositorio y entra en la carpeta principal:

```bash
git clone https://github.com/ZeroTokita/buscaminas-tripartito.git
cd buscaminas-tripartito
```

Instala las dependencias del cliente:

```bash
cd client
npm install
```

Instala las dependencias del servidor:

```bash
cd ../server
npm install
```

## Ejecución distribuida local

La operación de tres nodos requiere Redis. Inicia el servicio y verifica su
conectividad desde la raíz del proyecto:

```bash
brew services start redis
npm run redis:check
```

Después inicia el clúster:

```bash
npm run start:cluster
```

Los nodos se exponen en los puertos `3001`, `3002` y `3003`; con los tres
activos, el nodo 3 es el líder esperado. El servidor detecta una IPv4 local no
loopback para `PUBLIC_URL`; también puedes fijarla de forma explícita:

```bash
PUBLIC_HOST=192.168.1.20 npm run start:cluster
```

Inicia el cliente. Vite escucha en la red local y el cliente deriva las URLs de
los tres nodos desde el hostname con el que abriste la página:

```bash
npm --prefix client run dev
```

Abre la URL **Network** que imprime Vite (por ejemplo,
`http://192.168.1.20:5173`) para que el QR y los redirects sean utilizables
desde otro dispositivo. `VITE_PUBLIC_URL`, `VITE_SERVER_URL` y
`VITE_CLUSTER_URLS` permiten sobreescribir esas URLs cuando la topología lo
requiere.

La guía de recuperación del líder, la demostración con tres clientes y los
límites de esta configuración están en
[docs/distributed-operation.md](docs/distributed-operation.md). En particular,
esta versión depende de **una sola instancia Redis local**: no implementa
Redis Sentinel, réplicas, Redis Cluster ni alta disponibilidad de Redis.

## Ejecución de un nodo único

El cliente y el servidor deben permanecer activos al mismo tiempo. Abre dos terminales en la carpeta principal del proyecto.

### Terminal 1: servidor

```bash
cd server
node server.js
```

El servidor se ejecutará en:

```text
http://localhost:3000
```

### Terminal 2: cliente

```bash
cd client
npm run dev
```

Abre en el navegador la dirección que muestre Vite, normalmente:

```text
http://localhost:5173
```

## Análisis de calidad con SonarQube

El proyecto se analiza con una instancia local de SonarQube Community Build.
Esta herramienta se ejecuta fuera de la aplicación y no forma parte del
despliegue del cliente ni del servidor.

Antes de iniciar SonarQube, selecciona el JDK 25 compatible:

```bash
export JAVA_HOME="$(brew --prefix openjdk@25)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
cd "$HOME/Applications/sonarqube-26.7.0.124771/bin/macosx-universal-64"
./sonar.sh start
curl --fail --silent http://localhost:9000/api/system/status
```

El último comando debe mostrar `"status":"UP"`. Para detener el servicio de
forma ordenada, ejecuta `./sonar.sh stop` desde esa misma carpeta.

Para analizar este repositorio, desde la carpeta raíz configura el token de
análisis de SonarQube solo en la terminal actual y ejecuta los comandos de
calidad:

```bash
read -s SONAR_TOKEN
export SONAR_TOKEN
export SONAR_HOST_URL=http://localhost:9000
npm install
npm run quality:lint
npm run quality:build
npm run test:coverage
npm run sonar:scan
```

No guardes el token en archivos versionados ni lo compartas. El análisis se
verá en `http://localhost:9000/dashboard?id=buscaminas-tripartito`.

## Pruebas automatizadas

Desde la carpeta raíz, instala las dependencias de prueba y ejecuta todas las
capas con:

```bash
npm install
npm --prefix server install
npm test
```

`npm run test:server` ejecuta las pruebas de integración de Socket.IO con
`node:test`. `npm run test:e2e` inicia un servidor temporal en el puerto 3001,
Vite en el 5173 y ejecuta Cypress en modo headless. Para generar el reporte de
cobertura LCOV que SonarQube importa, usa `npm run test:coverage`.

La [matriz de validación distribuida](docs/distributed-validation-matrix.md)
indica qué prueba cubre WebSockets, clientes simultáneos, Lamport, locks,
versiones, heartbeats, failover, QR/dashboard y el límite de Redis.

## Integración continua con Jenkins

El repositorio contiene un `Jenkinsfile` declarativo para ejecutar la
validación completa desde Jenkins LTS local. El controlador se instala de forma
nativa y se abre en `http://localhost:8080`; SonarQube permanece en
`http://localhost:9000`.

Antes de crear el job, en Jenkins se deben instalar los plugins **Pipeline**,
**NodeJS** y **SonarQube Scanner**. En **Manage Jenkins → Tools**, registra una
instalación NodeJS con el nombre exacto `NodeJS-22`. En **Manage Jenkins →
System → SonarQube servers**, registra el servidor con el nombre exacto
`SonarQube` y la URL `http://localhost:9000`.

Genera un token de análisis en SonarQube y guárdalo en **Manage Jenkins →
Credentials** como credencial de tipo **Secret text** con el ID exacto
`sonarqube-token`. El token no debe copiarse al repositorio, al Jenkinsfile ni
a las capturas.

Para que la etapa **Quality Gate** termine automáticamente, registra en
SonarQube el webhook siguiente desde **Administration → Configuration →
Webhooks**:

```text
http://127.0.0.1:8080/sonarqube-webhook/
```

Después crea un elemento **Pipeline** llamado `buscaminas-tripartito`, elige
**Pipeline script from SCM**, selecciona el repositorio Git y usa `Jenkinsfile`
como Script Path. **Build Now** ejecuta estas etapas:

```text
Install → Redis → Lint → Coverage → E2E → Build → SonarQube → Quality Gate
```

El pipeline evita ejecuciones concurrentes porque Cypress usa puertos locales,
y conserva el reporte LCOV y capturas Cypress como artefactos del build.

## Cómo jugar

1. El primer jugador escribe su nombre y crea una sala.
2. Comparte el código generado con los otros dos jugadores.
3. Los demás escriben su nombre y entran con ese código.
4. Cuando la sala tiene tres jugadores, el creador inicia la partida.
5. Cada participante selecciona casillas para sumar puntos y evitar las minas.
6. Al descubrir todas las casillas seguras, el juego muestra al ganador o el empate.

Para realizar una prueba local se pueden abrir tres sesiones diferentes: una ventana normal, una ventana privada y otro navegador o perfil.

## Modo espectador

Un usuario puede ingresar con el código de la sala como espectador. Podrá observar el tablero y las puntuaciones en tiempo real, pero no podrá revelar casillas ni controlar la partida.

## Estructura general

```text
buscaminas-tripartito/
├── client/
│   ├── public/
│   ├── src/
│   │   ├── App.css
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── socket.js
│   ├── package.json
│   └── vite.config.js
├── server/
│   ├── app.js
│   ├── package.json
│   └── server.js
├── cypress/
│   └── e2e/
└── .gitignore
```

## Pruebas realizadas

Se comprobó correctamente:

- Creación y acceso a salas.
- Entrada de tres jugadores.
- Inicio simultáneo y sincronización de la partida.
- Actualización de casillas y puntuaciones.
- Penalización por minas sin puntuaciones negativas.
- Final de partida, ganador y empate.
- Generación de un tablero nuevo al volver a jugar.
- Entrada y salida de espectadores.
- Bloqueo de acciones para espectadores.
- Reconexión de jugadores.
- Cambio de creador de la sala.
- Adaptación visual a diferentes tamaños de pantalla.

## Consideraciones

Las salas, comandos idempotentes, locks y leases se almacenan en Redis. Un
nodo que caiga puede ser reemplazado por otro nodo vivo y recuperar las salas
desde Redis. Redis sigue siendo un único punto de coordinación en esta
configuración local: si Redis cae, el clúster no puede continuar y no hay
Sentinel, réplica ni failover de Redis configurado.

## Autores

Desarrollado por +Yakov y Marlon
