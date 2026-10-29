# Security

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/elad12390/opencode-monitors/security/advisories/new), not in a public issue. You should get a reply within a week.

## What this plugin can do

opencode-monitors runs shell commands that the agent asks it to run, with your user's permissions, in the background. Keep that in mind:

- OpenCode's shell permission rules do not yet apply to monitors.
- The output of a monitored command is sent to the model. Treat logs and feeds from untrusted sources the way you would treat any untrusted text you paste into a chat.
- Monitor output is kept in memory only. The state file (`~/.local/state/opencode-monitors/monitors.json`, mode 600) holds each monitor's command, description, process ID and status, not its output.

Releases are published from GitHub Actions with npm provenance, so you can check that a version was built from this repository.
