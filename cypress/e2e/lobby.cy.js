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
})
