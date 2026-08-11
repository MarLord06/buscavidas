# SonarQube Local Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ejecutar SonarQube Community Build de forma nativa en macOS y analizar de manera segura el cliente y servidor de Buscaminas Tripartito.

**Architecture:** SonarQube será un proceso local externo al proyecto, ejecutado con JDK 25 y la base H2 embebida solo para desarrollo y demostración. El repositorio contendrá una configuración de análisis y un comando reproducible; el token permanece fuera de Git, en una variable de entorno local o una credencial de Jenkins.

**Tech Stack:** macOS, Homebrew, OpenJDK 25, SonarQube Community Build 26.7.0.124771, Node.js, SonarScanner for NPM (`@sonar/scan`).

## Global Constraints

- Ejecutar SonarQube Community Build en macOS, sin Docker, con JDK 21 o 25; se usará JDK 25.
- Usar H2 exclusivamente para desarrollo, evaluación y demostración local; no para producción.
- El servidor debe estar disponible en `http://localhost:9000` y no es una dependencia de ejecución de React ni Express.
- Nunca guardar el token ni contraseñas en archivos versionados; usar `SONAR_TOKEN` en local y una credencial secreta en Jenkins.
- Analizar únicamente `client/src` y `server`; excluir dependencias, compilados, cobertura y archivos generados.
- No introducir exclusiones de cobertura para ocultar la ausencia de pruebas; la cobertura se integrará cuando se implementen las pruebas automatizadas.

---

## File Structure

- Create: `package.json` — scripts raíz que coordinan los comandos de calidad de cliente, servidor y SonarQube.
- Create: `sonar-project.properties` — identidad del proyecto y alcance explícito del análisis.
- Modify: `.gitignore` — protege cachés locales del escáner si se ubican dentro del repositorio en un entorno de CI.
- Modify: `README.md` — instalación, arranque, análisis y resolución de incidencias básicas.
- Create: `docs/sonarqube-evidence.md` — lista de evidencia verificable para la rúbrica, sin secretos.

## Task 1: Instalar y verificar el servidor local

**Files:**
- Create: `$HOME/Applications/sonarqube-26.7.0.124771/` — distribución descomprimida, fuera del repositorio.
- Modify: `~/.zshrc` — selecciona JDK 25 para nuevas terminales.
- Test: salida de `java -version`, respuesta HTTP y archivo de log de SonarQube.

**Interfaces:**
- Consumes: Homebrew instalado y acceso a Internet para descargar paquetes y la distribución oficial.
- Produces: servidor SonarQube operativo en `http://localhost:9000` y script `sonar.sh` en `$HOME/Applications/sonarqube-26.7.0.124771/bin/macosx-universal-64/`.

- [ ] **Step 1: Instalar el JDK compatible y seleccionarlo para la sesión**

Run:

```zsh
brew install openjdk@25
export JAVA_HOME="$(brew --prefix openjdk@25)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
java -version
```

Expected: la última línea identifica una versión Java `25` y no la versión `26` instalada actualmente.

- [ ] **Step 2: Persistir la selección de Java sin sobrescribir la configuración existente**

Append these two lines to `~/.zshrc` after any existing Java configuration:

```zsh
export JAVA_HOME="$(brew --prefix openjdk@25)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

Run:

```zsh
source ~/.zshrc
java -version
```

Expected: Java 25 is selected in a new shell. If `brew --prefix openjdk@25` fails, stop and install the JDK before continuing.

- [ ] **Step 3: Descargar y descomprimir la distribución oficial**

In a browser, download the macOS-compatible SonarQube Community Build ZIP version `26.7.0.124771` from `https://www.sonarsource.com/products/sonarqube/downloads/`. Then run:

```zsh
mkdir -p "$HOME/Applications"
unzip "$HOME/Downloads/sonarqube-26.7.0.124771.zip" -d "$HOME/Applications"
test -x "$HOME/Applications/sonarqube-26.7.0.124771/bin/macosx-universal-64/sonar.sh"
```

Expected: the final command exits with status `0`. Do not extract under the repository or a directory whose name starts with a number.

- [ ] **Step 4: Start SonarQube in console mode and verify startup**

Run:

```zsh
export JAVA_HOME="$(brew --prefix openjdk@25)/libexec/openjdk.jdk/Contents/Home"
"$HOME/Applications/sonarqube-26.7.0.124771/bin/macosx-universal-64/sonar.sh" console
```

Expected: the console reports `SonarQube is operational`. Keep this terminal open while validating the first run.

- [ ] **Step 5: Verify the HTTP endpoint from a second terminal**

Run:

```zsh
curl --fail --silent http://localhost:9000/api/system/status
```

Expected:

```json
{"id":"...","status":"UP"}
```

If it does not return `UP`, inspect `$HOME/Applications/sonarqube-26.7.0.124771/logs/sonar.log` and do not continue until the Java version or port conflict is resolved.

## Task 2: Secure the local instance and create the analysis identity

**Files:**
- Modify: SonarQube local data under `$HOME/Applications/sonarqube-26.7.0.124771/`; never version this directory.
- Test: successful authenticated project-analysis token validation.

**Interfaces:**
- Consumes: running server at `http://localhost:9000` from Task 1.
- Produces: project key `buscaminas-tripartito` and a project analysis token supplied at runtime as `SONAR_TOKEN`.

- [ ] **Step 1: Replace the default administrator password**

Open `http://localhost:9000`, sign in with `admin` / `admin`, and set a unique administrator password when the application requests it.

Expected: sign-out and sign-in with the new password work; `admin/admin` is rejected.

- [ ] **Step 2: Create the local project**

In SonarQube, select **Create project** → **Manually**, set both project name and key to `buscaminas-tripartito`, and choose the default **Sonar way** quality profile and quality gate.

Expected: the project dashboard opens with key `buscaminas-tripartito`.

- [ ] **Step 3: Create a least-privilege token and keep it outside Git**

From the project analysis setup screen, create a **project analysis token** for `buscaminas-tripartito`, copy it once, and set it only in the active terminal:

```zsh
read -s SONAR_TOKEN
export SONAR_TOKEN
```

Expected: typing the token shows no characters and `printenv SONAR_TOKEN | wc -c` returns a value greater than `1`. Do not paste the token into the README, shell history, source code, or a committed `.env` file.

## Task 3: Add reproducible repository analysis configuration

**Files:**
- Create: `package.json`
- Create: `sonar-project.properties`
- Modify: `.gitignore`
- Test: `npm run sonar:scan` with `SONAR_TOKEN` set.

**Interfaces:**
- Consumes: `SONAR_TOKEN`, local SonarQube at `http://localhost:9000`, `client/package.json`, and `server/package.json`.
- Produces: `npm run quality:lint`, `npm run quality:build`, and `npm run sonar:scan` at the repository root.

- [ ] **Step 1: Create the root package manifest with isolated quality scripts**

Create `package.json` with:

```json
{
  "name": "buscaminas-tripartito",
  "private": true,
  "version": "1.0.0",
  "scripts": {
    "quality:lint": "npm --prefix client run lint",
    "quality:build": "npm --prefix client run build",
    "sonar:scan": "sonar"
  },
  "devDependencies": {
    "@sonar/scan": "^4.3.5"
  }
}
```

- [ ] **Step 2: Install the scanner and make the command locally resolvable**

Run from the repository root:

```zsh
npm install
npm run sonar:scan -- --help
```

Expected: `package-lock.json` is created and the help output belongs to SonarScanner for NPM. The command may exit before analysis because no properties are present yet; that is acceptable at this step.

- [ ] **Step 3: Define the project identity and analysis scope**

Create `sonar-project.properties` with:

```properties
sonar.projectKey=buscaminas-tripartito
sonar.projectName=Buscaminas Tripartito
sonar.sourceEncoding=UTF-8
sonar.sources=client/src,server
sonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.sonar/**
```

- [ ] **Step 4: Protect scanner artifacts from Git**

Append this line to `.gitignore`:

```gitignore
.sonar/
```

Run:

```zsh
git check-ignore -v .sonar/cache/example
```

Expected: output identifies the new `.sonar/` ignore rule.

- [ ] **Step 5: Verify compilation and perform the first scan**

Run:

```zsh
npm run quality:lint
npm run quality:build
npm run sonar:scan -- -Dsonar.host.url=http://localhost:9000 -Dsonar.token="$SONAR_TOKEN"
```

Expected: lint and build complete successfully, then the scanner ends with `EXECUTION SUCCESS` and links to the `buscaminas-tripartito` dashboard. A failed quality gate is evidence to address in a later code-quality task, not a reason to expose the token or disable rules.

- [ ] **Step 6: Commit the reproducible configuration**

Run:

```zsh
git add .gitignore package.json package-lock.json sonar-project.properties
git commit -m "chore: configure SonarQube analysis"
```

Expected: the commit contains no token, `.sonar` directory, build output, or SonarQube installation files.

## Task 4: Document evidence and safe operation

**Files:**
- Modify: `README.md`
- Create: `docs/sonarqube-evidence.md`
- Test: documented commands work in a fresh terminal after `SONAR_TOKEN` is set.

**Interfaces:**
- Consumes: running instance and scripts from Tasks 1–3.
- Produces: concise setup instructions and a rubric-ready evidence checklist.

- [ ] **Step 1: Add a SonarQube section to the README**

Document these exact commands, explaining that the JDK selection is required because system Java 26 is unsupported by the chosen server version:

```zsh
export JAVA_HOME="$(brew --prefix openjdk@25)/libexec/openjdk.jdk/Contents/Home"
"$HOME/Applications/sonarqube-26.7.0.124771/bin/macosx-universal-64/sonar.sh" start
curl --fail --silent http://localhost:9000/api/system/status
```

Also document stopping it gracefully:

```zsh
"$HOME/Applications/sonarqube-26.7.0.124771/bin/macosx-universal-64/sonar.sh" stop
```

- [ ] **Step 2: Create the evidence checklist**

Create `docs/sonarqube-evidence.md` with the following headings and checkboxes:

```markdown
# Evidencia de SonarQube

- [ ] Captura de `http://localhost:9000` con el proyecto Buscaminas Tripartito.
- [ ] Captura del resultado `EXECUTION SUCCESS` del primer análisis.
- [ ] Captura del Quality Gate y de las métricas de bugs, vulnerabilidades y code smells.
- [ ] Evidencia de que `npm run quality:lint` y `npm run quality:build` finalizaron correctamente.
- [ ] Confirmación de que no hay tokens en el repositorio (`git grep -n "sonar.token"`).
```

- [ ] **Step 3: Verify documentation and secret hygiene**

Run:

```zsh
git grep -n "sonar.token" || true
git status --short
```

Expected: the first command does not show a literal token value; the second only lists intended documentation/configuration files before committing.

- [ ] **Step 4: Commit the operational documentation**

Run:

```zsh
git add README.md docs/sonarqube-evidence.md
git commit -m "docs: document local SonarQube operation"
```

Expected: the commit contains instructions and evidence criteria only, with no credentials.

## Scope Deferred to Later Evaluation Tasks

- Unit and end-to-end tests with LCOV coverage reports; after they exist, configure `sonar.javascript.lcov.reportPaths` with the exact generated report paths.
- Jenkins pipeline and Quality Gate webhook configuration.
- Burp Suite security-testing procedure and findings report.
- Remediation of issues reported by the first scan.


