
## Complexity Management

**Default to minimal solutions:**
- Propose <100 lines of new code for features
- Prefer single-file implementations until proven insufficient
- Avoid frameworks, abstractions, and optimizations without clear justification
- Choose boring, well-understood patterns over novel approaches

**Question requests for complexity:**
- Caching? → Ask for performance data and targets
- New framework? → Suggest plain code first
- Extra layers? → Start with the thinnest viable design

**Justify complexity with data:**
- Performance metrics showing current solution is too slow
- Concrete scale requirements (e.g., >1000 users, >100MB data)
- Multiple proven use cases requiring an abstraction

## Package Manager
Always use pnpm (NOT npm or yarn) for all Node.js package management:
- Install dependencies: `pnpm install`
- Add packages: `pnpm add [package]`
- Run scripts: `pnpm run [script]`

## Git Commits
Use conventional commits with these rules:
- Format: `type(scope): subject` (e.g., `fix: resolve auth error`, `feat(api): add user endpoint`)
- Keep commit messages to ONE line only - no body or footer
- Common types: feat, fix, docs, style, refactor, test, chore
- Never add co-authorship lines or attribution
