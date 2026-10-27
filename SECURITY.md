# Security policy

Please do not open a public issue for a suspected vulnerability. Send a private report to the repository maintainer with:

- the affected version or commit;
- reproduction steps that do not include credentials or private conversation data;
- impact and a minimal safe proof;
- any proposed mitigation.

Remove tokens, cookies, private keys, `.relay-data`, screenshots, and local absolute paths before sharing logs. The project is local-first, but enabling LAN mode or a public HTTPS tunnel changes the exposure boundary; include that configuration in a report.

There is currently no guaranteed response or disclosure timeline. Do not assume a report is accepted until the maintainer acknowledges it privately.

Account switching uses files on the execution computer's desktop, outside the repository. It does not bundle account snapshots with connectors. Quota responses select usage fields and omit login tokens, email addresses and account IDs. Paired browsers can still control tasks and see conversation content; only pair devices you trust.

Both Git and npm exclusions cover local account folders, authentication JSON, environment files and private keys. Connector builds also reject private filenames. Before publishing source or a release, inspect the actual export and Git history for credentials and identifying information; ignore files do not remove previously tracked history. Do not publish `.relay-data`, desktop account folders or browser profiles.
