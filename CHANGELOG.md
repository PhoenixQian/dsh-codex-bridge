# Changelog

## 0.3.1

- Add verified compatibility with DSH Desktop 0.2.2-rc.3 while retaining 0.2.2-rc.1 support. Other versions remain explicit unsupported states.
- Read complete multi-frame native conversation logs in both the DSH Node 24 carrier and Node 26; reject damaged, truncated or oversized logs rather than silently losing public messages.
- Preserve runtime version and safe failure details when discovering DSH models or starting isolated tasks. Show the reason in both discussion and task dialogs, and retry failed discovery when reopening a dialog.
- Keep OpenRouter routes available to their configured Desktop Host; do not offer them as isolated task routes without authentication.

## 0.3.0

- First community release: a self-contained macOS DSH bundle, named local Codex–DSH discussions, readable native conversation views, and optional local Codex skill setup.
