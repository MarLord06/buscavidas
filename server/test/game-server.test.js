const assert = require('node:assert/strict');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');

const { createGameServer } = require('../app');

function connect(url) {
  return new Promise((resolve, reject) => {
    const client = createClient(url, {
      forceNew: true,
      transports: ['websocket'],
    });

    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

function emitWithAck(client, event, payload) {
  return new Promise((resolve) => {
    if (payload === undefined) {
      client.emit(event, resolve);
      return;
    }

    client.emit(event, payload, resolve);
  });
}

function nextRoomUpdate(client, predicate) {
  return new Promise((resolve) => {
    const onUpdate = (room) => {
      if (predicate(room)) {
        client.off('room-updated', onUpdate);
        resolve(room);
      }
    };

    client.on('room-updated', onUpdate);
  });
}

test('expone un servidor iniciable en un puerto efímero', async (t) => {
  const gameServer = createGameServer({ clientUrl: '*' });
  t.after(async () => gameServer.close());

  const port = await gameServer.listen(0);

  assert.ok(Number.isInteger(port));
  assert.ok(port > 0);
});

test('crea una sala, admite tres jugadores e inicia una partida', async (t) => {
  const gameServer = createGameServer({ clientUrl: '*' });
  const port = await gameServer.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const host = await connect(url);
  const secondPlayer = await connect(url);
  const thirdPlayer = await connect(url);
  const spectator = await connect(url);
  t.after(async () => {
    host.close();
    secondPlayer.close();
    thirdPlayer.close();
    spectator.close();
    await gameServer.close();
  });

  const created = await emitWithAck(host, 'create-room', {
    playerName: 'Ana',
  });

  assert.equal(created.success, true);
  assert.match(created.roomCode, /^[A-Z0-9]{6}$/);

  const secondJoined = await emitWithAck(secondPlayer, 'join-room', {
    playerName: 'Beto',
    roomCode: created.roomCode,
  });
  const thirdJoined = await emitWithAck(thirdPlayer, 'join-room', {
    playerName: 'Caro',
    roomCode: created.roomCode,
  });

  assert.equal(secondJoined.success, true);
  assert.equal(thirdJoined.success, true);

  const startedRoom = nextRoomUpdate(
    host,
    (room) => room.status === 'playing',
  );
  const started = await emitWithAck(host, 'start-game');

  assert.equal(started.success, true);
  const room = await startedRoom;
  assert.equal(room.players.length, 3);
  assert.equal(room.game.cells.length, 81);
  assert.ok(room.game.cells.every((cell) => cell.value === null));

  const joinedAsSpectator = await emitWithAck(
    spectator,
    'join-as-spectator',
    { roomCode: created.roomCode },
  );
  const spectatorReveal = await emitWithAck(
    spectator,
    'reveal-cell',
    { cellIndex: 0 },
  );

  assert.equal(joinedAsSpectator.success, true);
  assert.equal(spectatorReveal.success, false);
  assert.equal(spectatorReveal.message, 'El jugador no está conectado');
});
