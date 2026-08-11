pipeline {
  agent any

  environment {
    PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  }

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  stages {
    stage('Install') {
      steps {
        sh 'node --version'
        sh 'npm --version'
        sh 'npm ci'
        sh 'npm --prefix server ci'
        sh 'npm --prefix client ci'
      }
    }

    stage('Redis') {
      steps {
        sh 'npm run redis:check'
      }
    }

    stage('Lint') {
      steps {
        sh 'npm run quality:lint'
      }
    }

    stage('Coverage') {
      steps {
        sh 'npm run test:coverage'
      }
    }

    stage('E2E') {
      steps {
        sh 'npm run test:e2e'
      }
    }

    stage('Build') {
      steps {
        sh 'npm run quality:build'
      }
    }

    stage('SonarQube') {
      steps {
        withSonarQubeEnv('SonarQube') {
          withCredentials([string(credentialsId: 'sonarqube-token', variable: 'SONAR_TOKEN')]) {
            sh 'npm run sonar:scan'
          }
        }
      }
    }

  }

  post {
    always {
      archiveArtifacts artifacts: 'server/coverage/lcov.info,cypress/screenshots/**/*', allowEmptyArchive: true
    }
  }
}
