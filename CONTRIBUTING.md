# Contributing

CodexRemote is a Windows-first local control plane. Changes should preserve the boundary between the browser, Relay, Runner, and the Codex Desktop owner.

## Development setup

- Windows 10/11
- Node.js 22 or newer
- A locally installed and signed-in Codex Desktop is required for native Desktop integration tests.

Install dependencies with `npm ci`. Run the default test suite with `npm test`. Tests must not use real credentials, send model requests, or write into the user's `.codex` directory; use the existing isolated fixtures.

Before changing the connector package or installer, run the package check used by the release workflow. Do not commit `.relay-data`, generated installers, local migration records, credentials, screenshots of private sessions, or temporary vendor archives.

## Pull requests

Describe the user-visible behavior, the affected execution owner (Runner or Desktop), and the validation run. Changes that alter network exposure, authentication, update signatures, or task ownership need focused tests and a security note.
