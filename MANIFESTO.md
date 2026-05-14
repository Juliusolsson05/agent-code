This is a duplicate of the post on juliusolsson.com/agent-code.

Agent Code is an open-source Electron-based AI-native IDE built by me. This post is about showcasing it.

## Why build this?

OpenCode is amazing. Cursor is amazing. The issue with these is that their software models are facing a hard time. Because of one reason:

OAuth is being killed.

You can no longer use Anthropic models properly in OpenCode, and Cursor's pricing is getting more brutal by the day if you do not lock yourself into their internal models.

But everybody wants to use SOTA models, which basically means Claude's latest and Codex's latest releases. Codex is liberal with OAuth usage as of me writing this, but my prediction is that that will not last forever. This is history repeating itself; in the 2010s the definition of the internet was "open." Everybody had free APIs to access their whole software suite. Facebook, Google, Yahoo, etc. This just slowly got killed by the companies. The difference is that, as with everything in AI, it is compressing the internet's timeline into 5 years instead of 20, and we already saw Anthropic banning OAuth.

## What Agent Code does differently

Instead of trying to go around Claude Code and Codex, it is just the middleman. When you use the app, a headless CLI for Claude and Codex is spawned. Do not confuse this with the SDK that is natively exposed, because that is limited and drops 75% of the functionality that lives in Codex and Claude. What Agent Code runs in a PTY is the FULL native Claude Code and Codex. This allows us to keep and maintain all new and custom functionality that these providers expose.

## So why do this?

Building an app like this lets me add any abstractions that I want, but the main motivations behind it were the following:

**1. Provider switching.**
I built a package that Agent Code calls for this sole purpose: [agent-transcript-parser](https://github.com/Juliusolsson05/agent-transcript-parser). This allows you to have a Codex session open, open the command palette and switch to Claude in one click, by natively translating the JSONL transcript between the two providers.

**2. Heavy development focus.**
This might be the most important part. Codex and Claude's apps focus on having one session on the screen and feel like they are built for lightweight agent development. Using agents properly requires having 5 running at all times. Agent Code gives you excellent tiling built in to manage all of your agents in a grid structure.

**3. Custom rendering.**
Because we are positioning Agent Code as a middleman, we rewrite all the rendering in React. This allows us to do whatever we want. For example, we built a better UI to see what the agents committed and ran for git commands.

**4. Opinionated for efficiency.**
The whole app is built for efficient development. All terminals are tmux-persistent by default alongside all agents. There are 50+ commands which are all excellent to boost productivity on top of the agents.

## Structure

One of the principles I understood early is that getting open-source contributors on board with something like this is hard. So Agent Code is dependent on 4 separate projects that it imports as packages, all more broadly scoped, which will hopefully attract more open-source attention.

## Structure

One of the principles I understood early is that getting open-source contributors on board with something like this is hard. So Agent Code is dependent on 4 separate projects that it imports as packages — all more broadly scoped, which will hopefully attract more open-source attention.

**1. Headless Claude Code and Codex**
[claude-code-headless](https://github.com/Juliusolsson05/claude-code-headless) · [codex-headless](https://github.com/Juliusolsson05/codex-headless)
This is basically the core of the app. It takes the full Claude CLI and Codex CLI and exposes them as an API, so that you can control all actions that you would be able to do in the CLI programmatically instead. For example, detecting the state when the agent is running a compaction or when the agent is asking for folder permission. You could take this and make it the backend of any project you want.

**2. [Agent Transcript Parser](https://github.com/Juliusolsson05/agent-transcript-parser)**
As mentioned before — takes a JSONL transcript from Codex and converts it to Claude or vice versa with complete roundtrip safety.

**3. [Agent Voice Dictation](https://github.com/Juliusolsson05/agent-voice-dictation)**
This is a clone of WhisprFlow that is fully open-source but built on Deepgram, which allows you to get $200 in free credits that will last you a lifetime. The repo does ship an Electron app if you prefer to consume it that way, but also a client that Agent Code relies on so that all agent inputs can ship voice dictation natively.

Worth mentioning that Agent Code is opinionated with cleverness over the whole suite. For instance: WhisprFlow is stupid — they are trying to correct spelling mistakes on the wrong level. They are trying to make their AI correct the mistakes before passing it into the model. It is the model that has all the context; the model can do the correction itself. So in Agent Code the simple solution is just wrapping the voice dictation in a custom tag explaining to Claude Code or Codex that the prompt may contain obvious mistakes:

```xml
<stt note="Speech-to-text; may contain transcription mistakes.">
Now I am speaking.
</stt>
```
