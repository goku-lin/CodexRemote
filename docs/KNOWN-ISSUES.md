# Known issues and verification limits

## Desktop input and context compaction

The native desktop bridge submits ordinary input to the desktop-owned thread. Automated checks cover thread selection, user input, image input, steering, approval routing, timeouts and request IDs. Real desktop and mobile input have also been checked.

Long-running behavior across every context-compaction scenario has not been verified. A successful send or a passing bridge test is not proof that compaction preserves every instruction. Older history may contain tool-forwarded input; those records are not rewritten or injected into a new goal.

When reporting a failure, include the application version, bridge status, whether the request was accepted, and a minimal reproduction with private text and identifiers removed. Do not publish raw session logs, account files or conversation IDs.

## Desktop updates and application identity

The launcher resolves the currently installed Windows application package and refreshes the matching CLI path before starting. It preserves official application identity and does not bypass organization policy checks. Failure to verify identity is reported rather than falling back to an ordinary executable launch.

Portable package checks cover launch preparation, stale CLI paths, independent services and signed updates using isolated fixtures. Application policy behavior on another computer still requires verification on that computer.

## Connectivity and notifications

LAN access requires a Windows private network and active firewall rules. Public HTTPS depends on the configured tunnel and the visitor's network. A local health check cannot guarantee that another network can reach the public entry.

Background notifications depend on browser Web Push support and the operating system's background policy. Installing the web app alone does not guarantee background delivery.

## Release checks

The Windows CI runs isolated tests and builds a public candidate. Full installed-desktop package checks are also run locally before release. These checks do not replace real mobile, second-computer or context-compaction verification.
