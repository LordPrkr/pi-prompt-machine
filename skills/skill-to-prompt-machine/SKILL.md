---
name: skill-to-prompt-machine
description: Turn an existing skill into a Mermaid prompt machine in the user's prompt-machines directory. Use when the user asks to convert, visualize, or run a skill as a prompt machine.
---

# Skill to Prompt Machine

1. Resolve the source skill from the user's name or path. Read its complete `SKILL.md` and any linked reference required to understand its steps or branches. Ask only when the source is ambiguous.

2. Translate the skill's process into a flat `stateDiagram-v2`:
   - Give every state one concrete instruction containing its completion criterion.
   - Preserve meaningful branches and loops with outcome-oriented edge labels.
   - Use exactly one start edge and ensure every state can reach `[*]`.
   - Keep reference material in the state where it is needed rather than making reference-only states.

3. Derive a valid machine name from the skill name: lowercase it, replace runs outside `[a-z0-9_-]` with `-`, trim separators, and reject `state` or `transition`. Write the diagram to `~/.pi/agent/prompt-machines/<name>.mmd`, creating the directory when absent. If that file exists, show the proposed path and ask before replacing it.

4. Check the finished diagram against every requirement above, then report the path and the command `/prompt-machine <name>`.

Done when the source skill's complete process and reachable outcomes are represented in a valid machine file in the user's prompt-machines directory.
