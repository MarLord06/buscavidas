const assert = require('node:assert/strict');
const test = require('node:test');
const Redis = require('ioredis');
const { io: createClient } = require('socket.io-client');

const { createGameServer } = require('../app');
const {
  createClusterCoordinator,
} = require('../services/cluster-coordinator');

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

test('difunde el mismo estado de sala entre dos nodos', async (t) => {
  const keyPrefix = `buscaminas:test:game-server:${Date.now()}:${process.pid}:`;
  const firstRedis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  });
  const thirdRedis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  });
  const firstCoordinator = createClusterCoordinator({
    redis: firstRedis,
    nodeId: 1,
    publicUrl: 'http://node-1',
  });
  const thirdCoordinator = createClusterCoordinator({
    redis: thirdRedis,
    nodeId: 3,
    publicUrl: 'http://node-3',
  });

  await firstCoordinator.start();
  await thirdCoordinator.start();

  const firstServer = createGameServer({
    config: { clientUrl: '*', nodeId: 1 },
    redis: firstRedis,
    coordinator: firstCoordinator,
  });
  const thirdServer = createGameServer({
    config: { clientUrl: '*', nodeId: 3 },
    redis: thirdRedis,
    coordinator: thirdCoordinator,
  });
  const firstPort = await firstServer.listen(0);
  const thirdPort = await thirdServer.listen(0);
  const followerClient = await connect(`http://127.0.0.1:${firstPort}`);
  const host = await connect(`http://127.0.0.1:${thirdPort}`);
  const secondPlayer = await connect(`http://127.0.0.1:${thirdPort}`);
  const thirdPlayer = await connect(`http://127.0.0.1:${thirdPort}`);

  t.after(async () => {
    followerClient.close();
    host.close();
    secondPlayer.close();
    thirdPlayer.close();
    await Promise.all([firstServer.close(), thirdServer.close()]);
    await Promise.all([firstCoordinator.stop(), thirdCoordinator.stop()]);
    const keys = await firstRedis.keys('*');

    if (keys.length > 0) {
      await firstRedis.del(
        ...keys.map((key) => key.slice(keyPrefix.length)),
      );
    }

    await Promise.all([firstRedis.quit(), thirdRedis.quit()]);
  });

  assert.equal(thirdCoordinator.isLeader(), true);

  const created = await emitWithAck(host, 'create-room', {
    playerName: 'Ana',
    commandId: 'create',
    clientId: 'host-client',
    lamportClock: 1,
  });
  const spectatorJoined = await emitWithAck(
    followerClient,
    'join-as-spectator',
    { roomCode: created.roomCode },
  );

  assert.equal(created.success, true);
  assert.equal(spectatorJoined.success, true);

  const redirected = await emitWithAck(followerClient, 'reveal-cell', {
    cellIndex: 0,
    commandId: 'follower-command',
    clientId: 'follower-client',
    lamportClock: 2,
  });

  assert.equal(redirected.success, false);
  assert.equal(redirected.code, 'LEADER_REDIRECT');
  assert.equal(redirected.leader.nodeId, 3);

  await emitWithAck(secondPlayer, 'join-room', {
    roomCode: created.roomCode,
    playerName: 'Beto',
    commandId: 'join-2',
    clientId: 'second-client',
    lamportClock: 2,
  });
  await emitWithAck(thirdPlayer, 'join-room', {
    roomCode: created.roomCode,
    playerName: 'Caro',
    commandId: 'join-3',
    clientId: 'third-client',
    lamportClock: 3,
  });

  const leaderUpdate = nextRoomUpdate(
    host,
    (room) => room.status === 'playing',
  );
  const followerUpdate = nextRoomUpdate(
    followerClient,
    (room) => room.status === 'playing',
  );
  const started = await emitWithAck(host, 'start-game', {
    commandId: 'start',
    clientId: 'host-client',
    lamportClock: 4,
  });
  const [leaderRoom, followerRoom] = await Promise.all([
    leaderUpdate,
    followerUpdate,
  ]);

  assert.equal(started.success, true);
  assert.equal(followerRoom.stateVersion, leaderRoom.stateVersion);
  assert.deepEqual(followerRoom.game.cells, leaderRoom.game.cells);
});

test('renueva por quince segundos el heartbeat del jugador conectado', async (t) => {
  const keyPrefix = `buscaminas:test:player-heartbeat:${Date.now()}:${process.pid}:`;
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  });
  const gameServer = createGameServer({
    config: { clientUrl: '*' },
    redis,
  });
  const port = await gameServer.listen(0);
  const host = await connect(`http://127.0.0.1:${port}`);

  t.after(async () => {
    host.close();
    await gameServer.close();
    const keys = await redis.keys('*');

    if (keys.length > 0) {
      await redis.del(...keys.map((key) => key.slice(keyPrefix.length)));
    }

    await redis.quit();
  });

  const created = await emitWithAck(host, 'create-room', {
    playerName: 'Ana',
  });
  const heartbeat = await emitWithAck(host, 'player-heartbeat', {});
  const ttl = await redis.pttl(
    `player:${created.roomCode}:${created.player.id}`,
  );

  assert.equal(heartbeat.success, true);
  assert.ok(ttl > 14_000 && ttl <= 15_000, `TTL inesperado: ${ttl}`);

  const room = await gameServer.repository.getRoom(created.roomCode);
  room.status = 'playing';
  await gameServer.repository.saveRoom(room);
});

test('reconcilia jugadores expirados y reasigna el anfitrión desde Redis', async (t) => {
  const keyPrefix = `buscaminas:test:player-expiry:${Date.now()}:${process.pid}:`;
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    keyPrefix,
  });
  const gameServer = createGameServer({
    config: { clientUrl: '*' },
    redis,
  });
  const port = await gameServer.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const host = await connect(url);
  const secondPlayer = await connect(url);
  const thirdPlayer = await connect(url);

  await gameServer.repository.saveRoom({
    roomCode: 'NOHB01',
    status: 'playing',
    hostId: 'ghost-player',
    players: [{
      id: 'ghost-player',
      name: 'Fantasma',
      score: 0,
      ready: false,
      connected: true,
      color: '#8b5cf6',
    }],
    game: null,
    createdAt: 800_000,
    lamportClock: 0,
    stateVersion: 1,
  });

  t.after(async () => {
    host.close();
    secondPlayer.close();
    thirdPlayer.close();
    await gameServer.close();
    const keys = await redis.keys('*');

    if (keys.length > 0) {
      await redis.del(...keys.map((key) => key.slice(keyPrefix.length)));
    }

    await redis.quit();
  });

  const created = await emitWithAck(host, 'create-room', {
    playerName: 'Ana',
  });
  const secondJoined = await emitWithAck(secondPlayer, 'join-room', {
    playerName: 'Beto',
    roomCode: created.roomCode,
  });
  await emitWithAck(thirdPlayer, 'join-room', {
    playerName: 'Caro',
    roomCode: created.roomCode,
  });
  await Promise.all([
    emitWithAck(host, 'player-heartbeat', {}),
    emitWithAck(secondPlayer, 'player-heartbeat', {}),
    emitWithAck(thirdPlayer, 'player-heartbeat', {}),
  ]);
  await emitWithAck(host, 'start-game');
  await redis.del(`player:${created.roomCode}:${created.player.id}`);

  const results = await gameServer.game.reconcileExpiredPlayersInRooms();
  const room = await gameServer.repository.getRoom(created.roomCode);
  const roomWithoutHeartbeat = await gameServer.repository.getRoom('NOHB01');
  const reconciliationCommands = await redis.keys(
    `${keyPrefix}room:${created.roomCode}:command:reconcile-expired:*`,
  );

  assert.ok(results.some((result) => result.success));
  assert.equal(room.players[0].connected, false);
  assert.equal(room.hostId, secondJoined.player.id);
  assert.equal(room.stateVersion, 5);
  assert.equal(roomWithoutHeartbeat.players[0].connected, true);
  assert.equal(roomWithoutHeartbeat.stateVersion, 1);
  assert.deepEqual(reconciliationCommands, []);
});
