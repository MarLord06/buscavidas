# Diseño: pruebas automatizadas para Buscaminas Tripartito

## Objetivo

Incorporar pruebas automatizadas que aporten evidencia reproducible de la
funcionalidad multijugador y del cliente web. La solución debe incluir Cypress
para la interfaz y pruebas de integración de Socket.IO para las reglas que
requieren varios jugadores simultáneos.

## Alcance

- Ejecutar pruebas de servidor con `node:test` y clientes reales de
  `socket.io-client`.
- Ejecutar pruebas de interfaz con Cypress contra el servidor y cliente locales.
- Cubrir la creación de sala, la incorporación de jugadores, el inicio de una
  partida y las restricciones de espectador.
- Exponer scripts raíz para ejecutar todas las pruebas y cada capa por separado.
- Generar reportes LCOV cuando sea posible para que SonarQube pueda importarlos
  en la siguiente configuración de cobertura.

## Arquitectura

El servidor se separará en una función de creación y un punto de arranque. Las
pruebas de integración podrán iniciar una instancia efímera en un puerto libre,
conectarse con tres clientes Socket.IO y cerrarla al terminar cada caso. Esto
elimina la dependencia de un proceso manual y evita compartir estado entre casos.

```text
Cypress -> Vite cliente -> Socket.IO -> servidor efímero
node:test + socket.io-client ----------^ 
```

Cypress se limita a la interacción visible del navegador: validación de campos,
creación o entrada a una sala y estado de espera. Las reglas multijugador se
comprueban directamente con Socket.IO: tres jugadores pueden iniciar la partida,
un espectador no puede revelar casillas y los estados se propagan a los clientes.

## Componentes

- `server/app.js`: crea Express, HTTP y Socket.IO sin escuchar un puerto por sí
  mismo; expone un cierre ordenado para tests.
- `server/server.js`: arranca la aplicación de producción con las variables de
  entorno existentes o sus valores locales.
- `server/test/*.test.js`: casos `node:test` que crean salas y clientes aislados.
- `cypress/e2e/*.cy.js`: pruebas end-to-end de interfaz.
- `cypress.config.mjs`: orden de arranque de Vite/servidor y base URL de Cypress.
- `package.json`: scripts raíz de orquestación; las dependencias de prueba son de
  desarrollo y no se empaquetan en producción.

## Manejo de estado y errores

Cada test espera explícitamente los eventos y callbacks de Socket.IO con límites
de tiempo. Todos los sockets y el servidor se cierran en los hooks de limpieza,
incluso si falla una aserción. Los puertos de prueba se asignan dinámicamente.
Los selectores Cypress usarán atributos `data-testid`, evitando depender de texto
o estilos que puedan cambiar.

## Verificación

Se considerará correcto cuando:

- `npm test` ejecute la capa de servidor sin procesos residuales.
- `npm run test:e2e` complete al menos el flujo visible de creación de sala y sus
  validaciones.
- `npm run test` y `npm run quality:build` terminen correctamente.
- SonarQube pueda recibir las rutas LCOV declaradas una vez que ambas capas
  generen sus reportes.

## Fuera de alcance

- Pruebas de carga, rendimiento o múltiples navegadores físicos simultáneos.
- Automatización de Burp Suite; se tratará como una tarea de seguridad separada.
- Cambios de reglas del juego que no sean necesarios para hacer el servidor
  testeable.
