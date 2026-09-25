import type { CommandDef } from '@renderer/features/command-palette/types'

/**
 * Skill commands (#1161), modelled on the MCP family (#1143): open the page,
 * add by paste, and the one bulk action the page offers.
 *
 * WHY no per-skill commands: the catalog is context-free (it cannot read
 * stores at module scope; see catalog.ts), so it cannot generate a command
 * per installed skill. The grid lists them instead.
 */
export const skillsCommands: CommandDef[] = [
  {
    id: 'skills',
    category: 'preferences',
    surface: 'app',
    title: 'Skills',
    description:
      '**What it does:** Opens **Settings → Skills**: every personal skill your agents can load — installed, written in Agent Code, and found on this machine — with one column per provider.\n\n**Use when:** You want to turn a skill on or off, choose which providers get it, or see what other tools installed.\n\n**Notes:** There is no limit on how many skills you keep.',
    keywords: ['skills', 'skill', 'installed', 'personal', 'settings', 'npx', 'skills.sh', 'conventions', 'custom'],
    run: ({ ui }) => {
      ui.openSettings('skills')
    },
  },
  {
    id: 'add-skill',
    category: 'preferences',
    surface: 'app',
    title: 'Add Skill…',
    description:
      '**What it does:** Installs skills from the command a README or skills.sh publishes, such as `npx skills add owner/repo --skill name`, or from `owner/repo` or a GitHub URL.\n\n**Use when:** A skill\'s documentation tells you to run `npx skills add`.\n\n**Notes:** You review the exact commit and every file first; nothing from the repository is run.',
    keywords: ['skill', 'skills', 'add', 'install', 'npx', 'skills.sh', 'github', 'repository', 'paste', '--skill'],
    run: ({ ui }) => {
      ui.closePalette()
      ui.openAddSkillDialog()
    },
  },
  {
    id: 'check-skill-updates',
    category: 'preferences',
    surface: 'app',
    title: 'Check Skill Updates',
    description:
      '**What it does:** Opens **Settings → Skills** and checks every installed skill\'s source for a newer commit.\n\n**Use when:** You want the latest version of your installed skills.\n\n**Notes:** Nothing changes until you review and apply each update.',
    keywords: ['skill', 'skills', 'update', 'updates', 'check', 'upgrade', 'newer', 'refresh'],
    run: ({ ui }) => {
      ui.openSettings('skills')
      ui.requestSkillUpdateCheck()
    },
  },
]
