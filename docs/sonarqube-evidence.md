# Evidencia de SonarQube

- [ ] Captura de `http://localhost:9000` con el proyecto Buscaminas Tripartito.
- [ ] Captura del resultado `EXECUTION SUCCESS` del primer análisis.
- [ ] Captura del Quality Gate y de las métricas de bugs, vulnerabilidades y code smells.
- [ ] Evidencia de que `npm run quality:lint` y `npm run quality:build` finalizaron correctamente.
- [ ] Evidencia de que `npm audit` finalizó sin vulnerabilidades.
- [ ] Confirmación de que no hay tokens en el repositorio; solo se referencia la variable `SONAR_TOKEN`.

## Estado de instalación

- SonarQube Community Build `26.7.0.124771` se ejecuta en
  `http://localhost:9000` con JDK 25.
- La instancia local usa H2 únicamente para desarrollo y evaluación.
- El token se proporciona en ejecución como `SONAR_TOKEN`; no se versiona.
