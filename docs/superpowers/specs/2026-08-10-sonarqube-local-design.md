# Diseño: SonarQube local para Buscaminas Tripartito

## Objetivo

Preparar una instancia local y nativa de SonarQube Community Build para analizar
la calidad del código del cliente React y el servidor Node.js. La instalación debe
ser reproducible para una demostración académica y no debe cambiar el
comportamiento ni los artefactos desplegables de la aplicación.

## Alcance

- Ejecutar SonarQube Community Build en macOS sin Docker.
- Usar JDK 21 y la base H2 embebida, exclusivamente para desarrollo y evaluación.
- Exponer la interfaz local en `http://localhost:9000`.
- Crear un proyecto de SonarQube y un token de análisis con alcance de proyecto.
- Preparar posteriormente el repositorio para que el escáner analice `client/` y
  `server/`, y para que Jenkins publique y espere el Quality Gate.

## Arquitectura

SonarQube se ejecutará como proceso local independiente de la aplicación. El
escáner se invocará durante la integración continua y enviará su informe al
servidor local o a la instancia configurada en Jenkins. Los resultados se
consultan en la interfaz web de SonarQube.

```text
Código fuente -> pruebas y análisis -> SonarScanner -> SonarQube :9000
                                          ^
                                      Jenkins (más adelante)
```

Los procesos de Vite y Express no dependen de SonarQube. Las pruebas y el
análisis se ejecutan antes del empaquetado o despliegue; no se distribuyen con la
aplicación ni se ejecutan en producción. Jenkins podrá configurar el Quality Gate
como obligatorio o solo informativo mediante una opción explícita del pipeline.

## Instalación y seguridad

La instancia usará la distribución ZIP de Community Build y el script nativo de
macOS. H2 se acepta únicamente para esta instancia local de demostración. Tras el
primer acceso se sustituirá la contraseña inicial y se creará un token de análisis
específico del proyecto. El token nunca se guardará en archivos versionados;
Jenkins lo almacenará después como una credencial secreta.

## Verificación

La instalación se considera correcta si el comando de estado informa que
SonarQube está operativo, la interfaz abre en `http://localhost:9000`, el acceso
inicial cambia de contraseña y se puede crear el proyecto. La integración del
repositorio se verificará posteriormente con un análisis que finalice en éxito y
muestre métricas de cliente y servidor.
