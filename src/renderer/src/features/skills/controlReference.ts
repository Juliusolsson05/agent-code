import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature (#1161). The
// assembled control reference adds current commands/bindings itself.
export const controlReference = [
  {
    id: 'skills',
    title: 'Skills',
    purpose:
      'Manage the personal Agent Skills agents can load: install them from the `npx skills add …` commands READMEs and skills.sh publish, write them in Agent Code, choose per provider which agents get each one, and see skills other tools installed.',
    ui: 'Settings → Skills (one grid, a column per enabled provider that supports skills), Add Skill… (paste a command, owner/repo or a GitHub/skills.sh URL), and Check Skill Updates. Agents with the Skills built-in capability can propose skills through skills_* tools; proposals stay off until the user turns them on, and every agent change raises a notice.',
    prerequisites: 'Network access to GitHub for installing and update checks. Only public GitHub sources are supported.',
    workflow: [
      'Paste the install command from the skill\'s README or skills.sh page, or type owner/repo to browse a repository',
      'Review the exact commit, every file and any warnings (for example executable scripts), pick the providers, then install',
      'Tick provider columns to move a skill between providers, or switch it off everywhere with its master switch',
      'Run Check Skill Updates and review each update before applying it',
    ],
    outcome: 'Agent Code writes real copies into ~/.claude/skills and ~/.agents/skills and tracks them in its ownership journal. New agents get changes; Claude and OpenCode also notice them live.',
    cautions:
      'Folders are shared: OpenCode reads both roots and Codex and Pi share ~/.agents/skills, so choosing one provider can make a skill visible to another (the grid marks this "shared"). Skills installed by other tools are listed read-only and cannot be adopted; to manage one, remove its folder and reinstall it here. Agent Code never writes ~/.agents/.skill-lock.json, so `npx skills update` does not touch its skills. There is no limit on how many skills you keep; each CLI shortens descriptions when its listing budget is exceeded.',
    commandIds: ['skills', 'add-skill', 'check-skill-updates'],
  },
] satisfies FeatureReference[]
