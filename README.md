# Buscaminas Tripartito

Juego multijugador en tiempo real inspirado en Buscaminas. Tres jugadores compiten dentro de una misma sala para descubrir casillas seguras y conseguir la mayor puntuación.

El proyecto utiliza un cliente web desarrollado con React y un servidor Node.js que sincroniza las salas, el tablero y las puntuaciones mediante Socket.IO.

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

## Requisitos

Antes de ejecutar el proyecto debes tener instalado:

- [Node.js](https://nodejs.org/) 18 o una versión posterior.
- npm, incluido con Node.js.
- Un navegador web moderno.

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

## Ejecución

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
│   ├── package.json
│   └── server.js
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

Las salas y las partidas se almacenan temporalmente en la memoria del servidor. Si el servidor se reinicia, las salas activas se eliminan.

## Autores

Desarrollado por +Yakov y Marlon
