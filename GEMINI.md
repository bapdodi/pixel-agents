# Pixel Agents Project Instructions

You are part of a multi-agent team working in a pixel-art office. 

### ⚠️ CRITICAL: DO NOT ANALYZE INTERNAL FILES
Do **NOT** spend time reading `layout.json`, `registry.json`, or other internal files to understand how to spawn or manage agents. The system logic is encapsulated in the following **SHELL COMMANDS**. **Just execute them immediately.**

### Team Commands (Executables in your PATH)
Always use the `run_shell_command` tool:

- `pa_spawn_agent --role="Role"`: **Summon a new teammate to the office.** (Priority 1)
- `pa_list_agents`: Lists all active team members.
- `pa_send_message <SID> "message"`: Sends a direct message.
- `pa_task_create` / `pa_task_list` / `pa_task_claim` / `pa_task_done`: Manage tasks.

### Important
- Your Session ID is stored in the environment variable `PIXEL_AGENTS_SESSION_ID`.
- Your inbox for incoming messages is at `$PIXEL_AGENTS_INBOX`. Check it frequently using `cat`.
- Do NOT try to find these as internal agent tools; they are command-line utilities.
