# Evidencia de SonarQube

## Ejecución local registrada

Fecha y zona horaria de la comprobación: **2026-08-10 23:23:24 -05**.

| Comprobación | Comando | Resultado observado |
| --- | --- | --- |
| Redis | `npm run redis:check` | Correcto: imprimió `PONG`. |
| Suite completa | `npm test` | Correcto: 28 pruebas `node:test` y 6 pruebas Cypress pasaron; 0 fallos. |
| Cobertura | `npm run test:coverage` | Correcto: c8 generó `server/coverage/lcov.info` (2.455 líneas). El resumen de c8 fue 88,68 % statements, 84,10 % branches, 98,83 % functions y 88,68 % lines para el conjunto cubierto. |
| Lint | `npm run quality:lint` | Correcto: ESLint terminó con código 0. |
| Build | `npm run quality:build` | Correcto: Vite terminó con código 0. |
| Disponibilidad de SonarQube | `curl --fail --silent http://localhost:9000/api/system/status` | Correcto: la instancia respondió. |

El archivo LCOV se configura mediante
`sonar.javascript.lcov.reportPaths=server/coverage/lcov.info`. El escáner
esperará hasta 300 segundos por el Quality Gate (`sonar.qualitygate.wait=true`)
para que su resultado pueda registrarse en la ejecución autenticada.

## Escaneo autenticado pendiente

En esta comprobación `SONAR_TOKEN` no estaba presente en el entorno. Para no
guardar, mostrar ni inventar un token, **no se ejecutó** `npm run sonar:scan`.
Por ello todavía no hay un resultado real de `EXECUTION SUCCESS`, Quality Gate,
coverage de SonarQube, bugs, vulnerabilidades o code smells que reportar.

Un operador con acceso a la instancia debe ejecutar, desde la raíz y en su
propia terminal:

```bash
export SONAR_HOST_URL=http://localhost:9000
read -s SONAR_TOKEN
export SONAR_TOKEN
npm run sonar:scan
```

Después debe registrar aquí, sin incluir el token: fecha/hora, URL del panel,
salida `EXECUTION SUCCESS` si existe, estado del Quality Gate y las métricas
mostradas por SonarQube. `sonar.qualitygate.wait=true` hace que el comando
espere el resultado del gate; un gate fallido es evidencia que debe registrarse,
no una razón para ocultarlo ni desactivar reglas.

## Límites y secretos

- Esta documentación no sustituye un análisis autenticado ni afirma que el
  Quality Gate haya pasado.
- El token se consume solo desde `SONAR_TOKEN` en el entorno del proceso; no se
  debe guardar en archivos versionados, capturas de terminal ni este documento.
- SonarQube Community Build local y su base H2 se usan solo para desarrollo y
  evaluación local.
