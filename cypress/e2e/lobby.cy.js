describe('sala de espera', () => {
  beforeEach(() => {
    cy.visit('/')
  })

  it('muestra una validación al intentar crear una sala sin nombre', () => {
    cy.get('[data-testid="create-room-button"]').click()

    cy.contains('Debes escribir tu nombre').should('be.visible')
  })

  it('crea una sala y muestra su estado de espera', () => {
    cy.get('[data-testid="player-name-input"]').type('Ana')
    cy.get('[data-testid="create-room-button"]').click()

    cy.get('[data-testid="room-code"]')
      .invoke('text')
      .should('match', /^[A-Z0-9]{6}$/)
    cy.contains('Jugadores conectados: 1/3').should('be.visible')
    cy.contains('Esperando a los demás jugadores...').should('be.visible')
    cy.get('[data-testid="room-qr"]').should('be.visible')
    cy.get('[data-testid="room-share-link"]')
      .should('have.attr', 'href')
      .then((href) => {
        expect(href).to.equal(
          `${Cypress.config('baseUrl')}/?room=${
            Cypress.$('[data-testid="room-code"]').text()
          }`,
        )
      })
    cy.get('[data-testid="dashboard-link"]')
      .should('be.visible')
      .and('have.attr', 'href', '/dashboard')
  })

  it('muestra el turno y bloquea el tablero para quien no lo posee', () => {
    cy.visit('/')
    cy.window()
      .its('__testSocket')
      .invoke('listenerCount', 'room-updated')
      .should('be.greaterThan', 0)
    cy.window().then((win) => {
      win.__testSocket.emit('room-updated', {
        roomCode: 'TURN01',
        status: 'playing',
        hostId: 'player-1',
        players: [
          { id: 'player-1', name: 'Ana', score: 0, lives: 3, connected: true, color: '#8b5cf6' },
          { id: 'player-2', name: 'Beto', score: 0, lives: 3, connected: true, color: '#22c55e' },
          { id: 'player-3', name: 'Caro', score: 0, lives: 3, connected: true, color: '#ef4444' },
        ],
        game: {
          rows: 1,
          columns: 1,
          mines: 0,
          revealedSafeCells: 0,
          totalSafeCells: 1,
          winnerIds: [],
          currentTurnPlayerId: 'player-1',
          turnExpiresAt: Date.now() + 12_000,
          cells: [{ index: 0, revealed: false, revealedBy: null, value: null, flaggedBy: ['player-1'] }],
        },
        lamportClock: 1,
        stateVersion: 1,
      })
    })

    cy.get('[data-testid="turn-status"]').should('contain', 'Turno de Ana')
    cy.get('.score-card').should('have.length', 3).contains('3 vidas')
    cy.get('[aria-label*="1 bandera de Ana"]')
      .should('be.disabled')
      .find('.cell-flag')
      .should('have.length', 1)
  })
})
