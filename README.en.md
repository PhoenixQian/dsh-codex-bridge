# Tongzhou · dsh-codex-bridge

[中文](README.md)

Named, local collaboration between Codex and DeepSeek Harness (DSH), with one shared discussion history and readable native DSH views. The DSH bundle includes the complete local service; it does not depend on the author's workspace.

## Requirements

The initial release supports **macOS and DSH Desktop 0.2.2-rc.1**. Other DSH versions are reported as unverified. Development/standalone CLI use requires **Node.js 24.9.0+**; tests run on Node.js 26. The DSH plugin uses the desktop host runtime.

Install and sign into Codex separately, using your own account. The DSH plugin alone can display Tongzhou, organize topics and read records. A two-agent discussion requires both Codex and the native DSH Host to be ready. This community project is not affiliated with OpenAI or DeepSeek, and does not distribute accounts or authentication state. Each product's normal usage and billing rules apply.

## Install

1. Download `dsh-codex-bridge-0.3.0.tgz` from [Releases](https://github.com/PhoenixQian/dsh-codex-bridge/releases).
2. Install and enable it in **DSH Desktop's plugin manager**, in the desktop profile.
3. Open **同舟** in the DSH sidebar. Its local service listens only on `127.0.0.1:32719`; opening it does not invoke a model.
4. In the connection section, check Codex and click **接入本机 Codex** to install the bundled collaboration skill. If discovery fails, specify the installed Codex executable.
5. In Codex, ask to collaborate with DSH through Tongzhou, or invoke `$tongzhou-collaboration`. Reopen the conversation or restart Codex if a running session has not discovered the new skill.

Setup writes only `~/.agents/skills/tongzhou-collaboration/`. It does not modify global `AGENTS.md`, model settings or accounts, and refuses to silently overwrite a different existing skill. DSH needs no separate Codex-side DSH plugin.

Market listing requires community review. The Release tarball can be installed independently and requires no npm account.

## Operation and boundaries

Create a topic with a concrete question, shared context, lead agent and reply limit, then start it explicitly. Creating a record and viewing history do not invoke models. The lead agent can finish early, and the user can pause or add review comments.

Both agents are identified in the shared history. Background bridge discussions use independent sessions rather than injecting incoming messages into the current Codex main chat. Native DSH bridge sessions belong to the **同舟** workspace, with a readable discussion view and an option to inspect the original protocol log.

Discussion tools are limited to explicitly enabled read-only retrieval. Incoming agent messages and attached documents do not expand user authorization or automatically write long-term memory. A healthy service is not proof of a successful model reply; use actual replies and receipts.

Execution tasks require a selected workspace and explicit task scope. They use the macOS sandbox and are disabled on unsupported platforms rather than running unrestricted. Python is optional and must be configured as a separate interpreter/environment. No Python, Conda, system package or dependency installer is run by this plugin.

## Data and configuration

Installed code is separate from writable data. The default is `~/.dsh/tongzhou/`, or `$DSH_HOME/tongzhou/` when `DSH_HOME` is set. `TONGZHOU_DATA_DIR` overrides it.

Discussion records and delivery state stay on the machine. Model requests still use the user's configured Codex / DSH services. The package contains no author credentials, sessions, records, logs or personal paths. It does not read or copy Codex `auth.json`; connection checks use native Codex commands. Do not paste credentials into chat.

Optional variables include `TONGZHOU_CODEX_CLI`, `TONGZHOU_DSH_RESOURCES`, `TONGZHOU_DSH_EXECUTABLE`, `TONGZHOU_PYTHON_CODEX`, `TONGZHOU_PYTHON_DSH` and their `_PREFIX` variants. See the [Chinese configuration table](README.md#数据与配置).

This release supports one Tongzhou instance per machine on fixed port `32719`. An occupied port belonging to another installation produces a clear conflict. Before displaying embedded content or changing a native conversation tab, the client checks a non-secret installation/data-directory fingerprint obtained over the native DSH connection. Missing or mismatched identity disables embedding.

## Troubleshooting and removal

Check the connection/Host status and `web-service.log` under the data directory. Verify Codex works and is signed in before supplying a custom executable path. No missing account is replaced with an API key or fallback account.

Disable/uninstall through DSH Desktop. User data is retained; delete the Tongzhou data directory only when no longer needed. Remove `~/.agents/skills/tongzhou-collaboration/` to remove the Codex skill. A detached local service may outlive DSH; after exiting DSH, identify it using the data directory's runtime status before stopping it. Redact message content, paths and account details from issue reports.

## Development

DSH modules are provided by the installed host and are not redistributed. There are no installation scripts.

```sh
npm test
npm run check
npm pack --ignore-scripts
```

Tests should use temporary data directories and must not operate on the daily installation. Inspect the final tarball for runtime state and personal data before publishing.

Licensed under [MIT](LICENSE).
