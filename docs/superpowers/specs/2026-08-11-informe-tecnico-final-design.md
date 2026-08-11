# Diseño del informe técnico final — Buscaminas Tripartito

## Objetivo

Sustituir el borrador obsoleto por un informe técnico final en Markdown, listo
para exportarse a PDF, que describa únicamente la arquitectura distribuida y
los resultados de V&V comprobados en el repositorio.

## Alcance

El informe incluirá portada académica, descripción funcional, arquitectura,
mecanismos distribuidos, flujos críticos, pruebas automatizadas, SonarQube,
Jenkins, Burp Suite, seguridad de dependencias, matriz de trazabilidad,
evidencias pendientes de captura y conclusiones.

## Fuentes de verdad

* `docs/vv-evidence.md` para comandos, resultados y casos SEC-01 a SEC-05.
* `docs/distributed-validation-matrix.md` para la trazabilidad entre criterios
  distribuidos y pruebas.
* `Jenkinsfile`, `sonar-project.properties` y los scripts de `package.json`
  para la configuración reproducible.
* Resultados comprobados: 47 pruebas de servidor aprobadas, cobertura global
  de 91.62 %, Cypress 7/7 y `npm audit` sin vulnerabilidades.

## Criterios de precisión

* Se describirán tres nodos Node.js coordinados por Redis, Socket.IO, locks,
  reloj Lamport, idempotencia, heartbeats y elección de líder.
* No se atribuirán métricas de SonarQube distintas de las mostradas en la
  instancia local ni se inventarán fechas, versiones o capturas.
* Las evidencias visuales se listarán como espacios a completar con capturas
  reales del equipo, no como resultados ya adjuntos.

## Entregable

El archivo `docs/informe-tecnico-final-buscaminas-tripartito.md` contendrá el
informe completo y referenciará los documentos de evidencia y trazabilidad.
