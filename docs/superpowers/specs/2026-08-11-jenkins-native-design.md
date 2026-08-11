# Diseño: Jenkins LTS nativo para Buscaminas Tripartito

## Objetivo

Instalar un controlador Jenkins LTS local en macOS y preparar una integración
continua reproducible para el proyecto. Burp Suite queda fuera de este alcance.

## Decisión

Se usará `jenkins-lts` de Homebrew como servicio local en el puerto 8080. La
fórmula administra Java 21 para el controlador. SonarQube seguirá en su
instancia local actual, puerto 9000 y Java 25; los dos procesos son
independientes.

No se usará Docker ni se ejecutará Jenkins con un archivo WAR desde una
terminal, porque el objetivo es disponer de un servicio local persistente para
la demostración y los commits del proyecto.

## Fase 1: instalación y puesta en marcha

1. Comprobar que el puerto 8080 esté libre y que Homebrew esté disponible.
2. Instalar `jenkins-lts` con Homebrew.
3. Iniciar el servicio de usuario `jenkins-lts`.
4. Comprobar la respuesta HTTP de `http://localhost:8080`.
5. Obtener la contraseña inicial sin exponerla en archivos del repositorio.
6. El equipo completa en el navegador el asistente oficial: desbloqueo,
   plugins sugeridos y usuario administrador.

El asistente requiere interacción y decisión del usuario (contraseña y cuenta
administradora); no se automatizará ni se guardarán secretos en el repositorio.

## Fase 2: configuración del proyecto

Una vez creado el usuario administrador, se instalarán o verificarán los
plugins Pipeline, NodeJS y SonarQube Scanner. Jenkins tendrá:

- una instalación de Node.js compatible con el proyecto;
- una configuración de servidor SonarQube que apunte a
  `http://localhost:9000`;
- una credencial secreta para el token de SonarQube;
- un job Pipeline que lea el `Jenkinsfile` versionado.

El `Jenkinsfile` ejecutará instalación reproducible, Redis disponible, lint,
cobertura, pruebas servidor/E2E, build, análisis SonarQube y espera del
Quality Gate. Un webhook de GitHub o un sondeo SCM activará el job en cada
commit; para una entrega local se documentará ambos mecanismos sin inventar
una integración remota que no se haya configurado.

## Manejo de fallos y evidencia

- Si 8080 está ocupado, se detiene y se elige un puerto explícito antes de
  iniciar el servicio.
- Si Redis o SonarQube no están disponibles, el pipeline falla en la etapa
  correspondiente, con diagnóstico visible.
- Un token nunca se añade a `sonar-project.properties`, al `Jenkinsfile` ni a
  documentación versionada.
- La evidencia final incluye consola de una ejecución exitosa, estado del
  Quality Gate, configuración de credenciales ocultas y capturas de las etapas
  del job.

## Criterios de aceptación

- Jenkins LTS responde localmente en el puerto 8080.
- El usuario administrador puede acceder al panel.
- El Pipeline obtiene el repositorio y ejecuta lint, pruebas, build y Sonar.
- El estado final y el Quality Gate quedan registrados sin secretos.
