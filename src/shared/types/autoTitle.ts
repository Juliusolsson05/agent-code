/** The model writes this label itself, so no background model call or native
 * provider title becomes a second writer of Agent Code's workspace title. */
export const AUTO_TITLE_SKILL_NAME = 'agent-code-auto-title'
export const AUTO_TITLE_SKILL_DESCRIPTION = 'Keep this agent’s short current-job title when Auto Title MCP is available. Set it for new substantive work; change it only when the job changes.'
export const AUTO_TITLE_INSTRUCTIONS = `When Auto Title MCP is available in this session, use title_set to name your current substantive job in 3–7 words, at most 60 characters. Set it as soon as you understand a new task, before substantial work. Change it when the job or requested outcome changes. Leave it alone for routine progress, minor follow-ups, acknowledgements, and status milestones; those belong in TLDR when available. Goal is the fuller purpose, while this title is the short label visible in the pane and agent list.

Examples: “Repair queued prompt delivery”; “Review workspace recovery”; “Design automatic agent titles”.

Only title your own session with the available tool. A manual title or a manual clear pauses automatic changes; the tool will refuse those writes until the user resumes Auto Title. If the capability is unavailable, do not edit files or provider session names as a substitute.`
