# commission-ai-slack

The Slack connector for [CommissionAI](https://github.com/patrick-lai/commission-ai). It owns the Slack side of the Slack bridge: the Socket Mode connection, the Slack Web API, mrkdwn clean-up, file download and upload, and the retry rules for each call. The CommissionAI daemon keeps everything else (which channels are linked, who may speak, rate limits, de-duplication, queues, replies and tickets) and talks to the connector over its own loopback API.

CommissionAI downloads, verifies and refreshes this package on its own when Slack is set up and Node.js is installed. When the connector is missing, broken, turned off (`COMMISSION_DISABLE_SLACK_CONNECTOR=1`) or Node.js is not available, CommissionAI keeps using its built-in Slack connection and nothing else changes.

## Requirements

- Node.js 20.3 or newer. There are no npm dependencies.
- A running CommissionAI daemon on the same computer.

## Install

```sh
npm install -g @patrick-lai/commission-ai-slack
commission-ai-slack version --json
```

Or download `commission-ai-slack-<version>.tar.gz` from [Releases](https://github.com/patrick-lai/commission-ai-slack/releases) and check it against the signed `manifest.json` (public key in `release-key.pub`).

## Commands

```text
commission-ai-slack version [--json]   Print the version, or {"version", "protocol"} as JSON.
commission-ai-slack manifest [name] [about]   Print the Slack app manifest the connector is approved for.
commission-ai-slack run                Serve the CommissionAI daemon until standard input closes.
```

`run` reads two variables:

- `COMMISSION_ENDPOINT`: the daemon's loopback address, for example `http://127.0.0.1:7433`. Anything else is refused.
- `COMMISSION_CONNECTOR_TOKEN`: a connector token with the `bridge:slack` scope. CommissionAI creates one for the process it starts. To run the connector by hand, create one with `POST /v1/connectors/tokens` from the app; the token is shown once and stored only as a hash.

The process stops when its standard input closes, which is how it ends together with the daemon that started it. It exits with 0 when stopped, 2 when the daemon refuses its token or protocol, and 3 when the daemon stays unreachable. Standard error carries one JSON line per event with secrets removed.

To try the connector without a Slack workspace, point `COMMISSION_SLACK_API_BASE` at a stand-in server on loopback (for example `http://127.0.0.1:9000`); the connector then calls `<base>/api/<method>` and accepts files only from that origin. Any other value is ignored, so the setting cannot send a token off this computer.

Slack's address, proxies and corporate networks: the connector reads `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` like the built-in connection does, and never sends the bot token to a host that is not a Slack file host.

## How it talks to the daemon

Every call is made by the connector, so it needs no open port. All routes live under `/v1/connectors/slack/` and carry the header `x-commission-connector-token`. The token is never accepted from a URL, and the daemon refuses it on every other route.

| Route | Purpose |
| --- | --- |
| `POST session` | Attach, say which protocol and version this is, and long-poll for changes. The reply carries the Slack tokens and a generation number; when the generation changes the connector reconnects. |
| `PUT status` | Report the connection phase, a plain detail and the bot identity. |
| `POST inbound` | Hand over one Slack message. The connector acknowledges the Slack envelope only after the daemon has saved it. |
| `POST outbox/claim`, `POST outbox/{id}/result` | Long-poll for replies that are due, deliver them, and report how each went. |
| `POST commands/next`, `POST commands/{id}/result` | Run the Slack calls that settings screens make (list channels, join, verify tokens, send a test message) and prepare an inbound message (names, text, files). |
| `POST media`, `GET media/{sha}` | Stage a downloaded Slack file with the daemon, or fetch a file to upload to Slack. |

The exact shapes are pinned by the golden vectors in `vectors/contract.json`, which the daemon generates from its own types.

## Golden vectors

`vectors/` holds outputs recorded from CommissionAI's built-in Slack code for the same inputs: which events are kept or dropped and how they are keyed, mrkdwn clean-up, error texts, retry decisions per failed call, the upload flow, the manifest and its permissions, and token-shape redaction. `node --test` makes this client reproduce every transport vector. `policy.json` records the daemon's own rules (gate, rate limit, de-duplication, framing, outbox settling) and is checked by the daemon's test suite, not here.

## Develop

```sh
node --test
scripts/build-dist.sh
npm pack --dry-run --ignore-scripts
```

The tests run against a fake Slack (HTTP and WebSocket) and a fake daemon on loopback, so they need no workspace and no network.

## Release

Set `version` in `package.json`, commit, and push a `v<version>` tag. The release workflow runs the tests, packages one archive for all four platforms, writes and signs `manifest.json` with the repository secret `COMMISSION_AI_SLACK_RELEASE_KEY`, creates the GitHub release and publishes the npm package with provenance. A dry run (`workflow_dispatch`, the default) does everything except publish.

## License

MIT. See `LICENSE`.
