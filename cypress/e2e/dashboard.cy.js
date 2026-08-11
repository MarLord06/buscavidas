describe('cliente distribuido', () => {
  it('mantiene la versión más reciente ante una actualización atrasada', () => {
    cy.visit('/')

    cy.window()
      .its('__testSocket')
      .invoke('listenerCount', 'room-updated')
      .should('be.greaterThan', 0)
    cy.window().then((win) => {
      win.__testSocket.emit('room-updated', {
        roomCode: 'ABC123',
        stateVersion: 4,
        lamportClock: 8,
        players: [],
        status: 'waiting',
        game: null,
      })
      win.__testSocket.emit('room-updated', {
        roomCode: 'ABC123',
        stateVersion: 3,
        lamportClock: 7,
        players: [],
        status: 'waiting',
        game: null,
      })
    })

    cy.get('[data-testid="room-version"]').should('have.text', '4')
    cy.get('[data-testid="room-code"]').should('have.text', 'ABC123')
  })

  it('muestra el líder y tres nodos en el dashboard', () => {
    cy.visit('/dashboard')

    cy.window()
      .its('__testSocket')
      .invoke('listenerCount', 'cluster-status')
      .should('be.greaterThan', 0)
    cy.window().then((win) => {
      win.__testSocket.emit('cluster-status', {
        leader: { nodeId: 3, publicUrl: 'http://localhost:3003' },
        nodes: [
          { nodeId: 1, alive: true, publicUrl: 'http://localhost:3001' },
          { nodeId: 2, alive: true, publicUrl: 'http://localhost:3002' },
          { nodeId: 3, alive: true, publicUrl: 'http://localhost:3003' },
        ],
        lamportClock: 12,
        rooms: [
          { roomCode: 'ABC123', stateVersion: 4, players: [] },
        ],
        events: [
          { type: 'leader-elected', message: 'Nodo 3 elegido líder' },
        ],
      })
      win.__testSocket.emit('room-updated', {
        roomCode: 'ABC123',
        stateVersion: 3,
        lamportClock: 11,
        players: [],
        status: 'waiting',
        game: null,
      })
    })

    cy.get('[data-testid="cluster-leader"]').should('contain', 'Nodo 3')
    cy.get('[data-testid="cluster-node"]').should('have.length', 3)
    cy.get('[data-testid="lamport-clock"]').should('contain', '12')
    cy.get('[data-testid="room-version"]').should('contain', '4')
    cy.get('[data-testid="cluster-event"]')
      .should('contain', 'Nodo 3 elegido líder')
  })

  it('no retrocede una sala si cluster-status llega atrasado', () => {
    cy.visit('/dashboard')

    cy.window()
      .its('__testSocket')
      .invoke('listenerCount', 'room-updated')
      .should('be.greaterThan', 0)
    cy.get('[data-testid="cluster-node"]').should('have.length', 3)
    cy.window().then((win) => {
      win.__testSocket.emit('room-updated', {
        roomCode: 'LATEST',
        stateVersion: 5,
        lamportClock: 15,
        players: [],
        status: 'waiting',
        game: null,
      })
      win.__testSocket.emit('cluster-status', {
        leader: { nodeId: 3, publicUrl: 'http://localhost:3003' },
        nodes: [],
        lamportClock: 14,
        rooms: [{ roomCode: 'LATEST', stateVersion: 4, players: [] }],
        events: [],
      })
    })

    cy.get('[data-testid="room-version"]').should('have.text', '5')
  })

  it('detiene los reintentos internos cuando vence la reconexión', () => {
    cy.visit('/dashboard')

    cy.window()
      .its('__testSocket')
      .invoke('listenerCount', 'leader-changed')
      .should('be.greaterThan', 0)
    cy.window().then((win) => {
      win.__testSocket.emit('leader-changed', {
        nodeId: 3,
        publicUrl: 'http://127.0.0.1:65534',
      })
    })
    cy.wait(5250)
    cy.window()
      .its('__testSocket')
      .invoke('connectionState')
      .should((state) => {
        expect(state.connected).to.equal(false)
        expect(state.reconnecting).to.equal(false)
        expect(state.url).to.equal('http://127.0.0.1:65534')
      })
  })
})
