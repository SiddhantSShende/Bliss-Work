# BlissWork

BlissWork is a comprehensive enterprise communication and collaboration platform. This repository houses both the core application monorepo and the marketing website.

## Structure

- **[Bliss-Work](./Bliss-Work/)**: The main application monorepo. It features a microservice architecture (Go, Python/FastAPI, PostgreSQL, Kafka) and a shared React codebase that powers both a browser-based web app and an Electron desktop app. Key capabilities include real-time messaging, task assignment (with desktop sticky widgets), calls, and integrations with external platforms like Slack and Teams.
- **[Bliss-Website](./Bliss-Website/)**: The public marketing website. A standalone React 19 and Vite 6 project that shares the application's design system and tokens for a unified brand experience.

## Getting Started

See the respective directories for detailed setup instructions:
- [Bliss-Work README](./Bliss-Work/README.md)
- [Bliss-Website README](./Bliss-Website/README.md)