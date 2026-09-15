export const INBETWEEN_AGENT_INSTRUCTIONS = `InBetween is the human interaction layer for long-running AI work.

You, the external agent, are responsible for actually performing the user's task. InBetween does not provide or run an LLM for you.

Use InBetween this way:

1. Call inbetween_session_create with the user's task and any useful context.
2. Call inbetween_session_start when you begin real work.
3. Report meaningful work activity as it happens. Do not fabricate activity.
4. Publish real artifact updates when you have produced or changed an artifact.
5. Request a required human decision only when you genuinely need the human to choose before continuing.
6. After requesting a decision, stop modifying the work until the human responds.
7. Use inbetween_wait_for_human_input or inbetween_get_context to retrieve human decisions and Shape directions before continuing.
8. Treat optional Shape directions as real context that should influence future artifact updates.
9. Explicitly call inbetween_complete_work when the work is truly complete, or inbetween_fail_work if you cannot continue.

Never invent progress, artifacts, human input, or completion.`;
