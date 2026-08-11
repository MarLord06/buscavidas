# Diseño: turnos sincronizados, banderas y vidas

## Objetivo

Convertir Buscaminas Tripartito en una partida competitiva por turnos para
tres jugadores: cada jugador tiene tres vidas, dispone de doce segundos por
turno y puede revelar una casilla o gestionar una bandera propia.

## Reglas de juego

* Una partida activa mantiene `currentTurnPlayerId` y `turnExpiresAt`.
* Solo el jugador conectado, no eliminado y dueño del turno puede ejecutar
  `reveal-cell` o `toggle-flag`.
* Toda acción válida consume el turno. El orden avanza al siguiente jugador
  conectado que conserve al menos una vida.
* Una mina reduce una vida y mantiene la penalización existente de dos puntos,
  sin permitir puntuaciones negativas.
* Con cero vidas, un jugador queda eliminado y no vuelve a recibir turnos.
* Cada jugador puede poner o retirar su propia bandera en una casilla oculta.
  Varias banderas de distintos jugadores pueden coexistir y muestran su color.
* La partida termina al revelar todas las casillas seguras o cuando solo queda
  un jugador con vidas. El resultado usa la puntuación para determinar
  ganador o empate.

## Sincronización y recuperación

* El líder conserva turno, vencimiento y banderas en el estado Redis de la
  sala; los cambios usan el lock Redis y avanzan `stateVersion` y Lamport.
* Un temporizador del líder procesa vencimientos. Tras failover, el sucesor
  compara `turnExpiresAt` con su reloj y avanza el turno si ya venció.
* Si se desconecta el jugador actual o queda eliminado, el turno avanza en la
  misma transición que actualiza la conectividad o la vida.
* Espectadores no pueden ejecutar acciones de juego.

## Interfaz

La sala mostrará el jugador del turno, cuenta regresiva, vidas por jugador y
banderas coloreadas por propietario. Las casillas se deshabilitan fuera del
turno propio y el dashboard recibe el estado de sala resumido existente.

## Criterios de aceptación

1. Un jugador fuera de turno recibe un rechazo sin modificar el estado.
2. Una revelación válida avanza exactamente un turno y conserva versiones
   secuenciales.
3. El vencimiento de doce segundos avanza el turno una sola vez, incluso con
   dos nodos intentando procesarlo.
4. Las banderas son individuales, persistentes y no se pueden poner sobre una
   casilla revelada.
5. Una mina reduce una vida; el jugador eliminado es omitido.
6. Una desconexión o caída del líder durante un turno no congela la partida.
7. Cypress verifica los flujos visibles; `node:test` cubre concurrencia,
   idempotencia y failover de las transiciones nuevas.
