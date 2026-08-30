# Field-OS — Cursor/ChatGPT Control

This directory is the installed control pack for `Native-Grace/fieldOS`.

## Identities (do not invent others)

| Role | GitHub identity |
| --- | --- |
| Human owner | `Native-Grace` |
| ChatGPT reviewer | `Native-Grace` |
| Cursor executor | `cursor[bot]` |
| Codex advisory | `chatgpt-codex-connector[bot]` |

- **Native-Grace** is the only human owner. Product, merge, and deploy decisions stay with this identity.
- **Native-Grace** reviews as ChatGPT. Review comments are advisory unless the human owner adopts them.
- **cursor[bot]** is the only executor that may push implementation commits on working branches.
- **chatgpt-codex-connector[bot]** may leave advisory findings only. It does not merge, deploy, or change policy.

## Working rules

- Base branch: `main`.
- Implementation branches must use prefix `agent/field-os-`.
- Do not open or comment on a control issue unless the human owner later asks. Title reserved: Field-OS — Cursor/ChatGPT Control.
- Required status check(s):
- `backend-tests`
- Executor write scope (only these globs):
- `fieldos/**`
- `docs/**`
- `.agents/field-os/**`

## Disabled capabilities

These stay **off** until the human owner enables them in `project.yaml` and in an explicit follow-up:

- merge
- deploy
- credentials
- destructive operations

Do not merge pull requests. Do not deploy. Do not create, rotate, or write credentials. Do not delete branches, issues, releases, environments, or production data.

## Executor (Cursor)

1. Work on a non-default branch whose name starts with `agent/field-os-`.
2. Touch only allowed paths.
3. Keep changes reviewable. Prefer small, test-backed diffs under `fieldos/**`.
4. Leave docs updates in `docs/**` when behaviour or contracts change.
5. Do not expand write scope, identities, or capabilities.

## Reviewer (ChatGPT)

1. Review diffs against this pack and the required check.
2. Flag path, identity, or capability violations.
3. Do not apply patches, merge, or deploy.

## Codex advisory

Codex findings from `chatgpt-codex-connector[bot]` are advisory. The executor may fix confirmed defects inside allowed paths. The reviewer and human owner decide whether a finding is in scope.
