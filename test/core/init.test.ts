import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { InitCommand } from '../../src/core/init.js';
import * as prompts from '@inquirer/prompts';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  checkbox: vi.fn()
}));

describe('InitCommand', () => {
  let testDir: string;
  let initCommand: InitCommand;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `openspec-init-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    initCommand = new InitCommand();
    
    // Mock console.log to suppress output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('should create OpenSpec directory structure', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      
      await initCommand.execute(testDir);
      
      const openspecPath = path.join(testDir, 'openspec');
      expect(await directoryExists(openspecPath)).toBe(true);
      expect(await directoryExists(path.join(openspecPath, 'specs'))).toBe(true);
      expect(await directoryExists(path.join(openspecPath, 'changes'))).toBe(true);
      expect(await directoryExists(path.join(openspecPath, 'changes', 'archive'))).toBe(true);
    });

    it('should create AGENTS.md and project.md', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);

      await initCommand.execute(testDir);

      const openspecPath = path.join(testDir, 'openspec');
      expect(await fileExists(path.join(openspecPath, 'AGENTS.md'))).toBe(true);
      expect(await fileExists(path.join(openspecPath, 'project.md'))).toBe(true);

      const agentsContent = await fs.readFile(path.join(openspecPath, 'AGENTS.md'), 'utf-8');
      expect(agentsContent).toContain('OpenSpec Instructions');
      
      const projectContent = await fs.readFile(path.join(openspecPath, 'project.md'), 'utf-8');
      expect(projectContent).toContain('Project Context');
    });

    it('should create CLAUDE.md when Claude Code is selected', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      
      await initCommand.execute(testDir);
      
      const claudePath = path.join(testDir, 'CLAUDE.md');
      expect(await fileExists(claudePath)).toBe(true);
      
      const content = await fs.readFile(claudePath, 'utf-8');
      expect(content).toContain('<!-- OPENSPEC:START -->');
      expect(content).toContain('OpenSpec Project');
      expect(content).toContain('<!-- OPENSPEC:END -->');
    });

    it('should update existing CLAUDE.md with markers', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      
      const claudePath = path.join(testDir, 'CLAUDE.md');
      const existingContent = '# My Project Instructions\nCustom instructions here';
      await fs.writeFile(claudePath, existingContent);
      
      await initCommand.execute(testDir);
      
      const updatedContent = await fs.readFile(claudePath, 'utf-8');
      expect(updatedContent).toContain('<!-- OPENSPEC:START -->');
      expect(updatedContent).toContain('OpenSpec Project');
      expect(updatedContent).toContain('<!-- OPENSPEC:END -->');
      expect(updatedContent).toContain('Custom instructions here');
    });

    it('should create Claude dash command files with templates', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);

      await initCommand.execute(testDir);

      const claudeProposal = path.join(testDir, '.claude/commands/openspec/proposal.md');
      const claudeApply = path.join(testDir, '.claude/commands/openspec/apply.md');
      const claudeArchive = path.join(testDir, '.claude/commands/openspec/archive.md');

      expect(await fileExists(claudeProposal)).toBe(true);
      expect(await fileExists(claudeApply)).toBe(true);
      expect(await fileExists(claudeArchive)).toBe(true);

      const proposalContent = await fs.readFile(claudeProposal, 'utf-8');
      expect(proposalContent).toContain('name: OpenSpec: Proposal');
      expect(proposalContent).toContain('<!-- OPENSPEC:START -->');
      expect(proposalContent).toContain('**Guardrails**');

      const applyContent = await fs.readFile(claudeApply, 'utf-8');
      expect(applyContent).toContain('name: OpenSpec: Apply');
      expect(applyContent).toContain('Work through tasks sequentially');

      const archiveContent = await fs.readFile(claudeArchive, 'utf-8');
      expect(archiveContent).toContain('name: OpenSpec: Archive');
      expect(archiveContent).toContain('openspec archive <id>');
      expect(archiveContent).toContain('`--skip-specs` only for tooling-only work');
    });

    it('should create Cursor dash command files with templates', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['cursor']);

      await initCommand.execute(testDir);

      const cursorProposal = path.join(testDir, '.cursor/commands/openspec-proposal.md');
      const cursorApply = path.join(testDir, '.cursor/commands/openspec-apply.md');
      const cursorArchive = path.join(testDir, '.cursor/commands/openspec-archive.md');

      expect(await fileExists(cursorProposal)).toBe(true);
      expect(await fileExists(cursorApply)).toBe(true);
      expect(await fileExists(cursorArchive)).toBe(true);

      const proposalContent = await fs.readFile(cursorProposal, 'utf-8');
      expect(proposalContent).toContain('name: /openspec-proposal');
      expect(proposalContent).toContain('<!-- OPENSPEC:END -->');

      const applyContent = await fs.readFile(cursorApply, 'utf-8');
      expect(applyContent).toContain('id: openspec-apply');
      expect(applyContent).toContain('Work through tasks sequentially');

      const archiveContent = await fs.readFile(cursorArchive, 'utf-8');
      expect(archiveContent).toContain('name: /openspec-archive');
      expect(archiveContent).toContain('openspec list --specs');
    });

    it('should handle non-existent target directory', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      
      const newDir = path.join(testDir, 'new-project');
      await initCommand.execute(newDir);
      
      const openspecPath = path.join(newDir, 'openspec');
      expect(await directoryExists(openspecPath)).toBe(true);
    });

    it('should display success message with selected tool name', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      const logSpy = vi.spyOn(console, 'log');
      
      await initCommand.execute(testDir);
      
      const calls = logSpy.mock.calls.flat().join('\n');
      expect(calls).toContain('Copy these prompts to Claude Code');
    });
  });

  describe('extend mode', () => {
    it('should NOT throw error when OpenSpec already exists (extend mode)', async () => {
      // Create existing openspec directory
      const openspecPath = path.join(testDir, 'openspec');
      await fs.mkdir(openspecPath, { recursive: true });
      await fs.mkdir(path.join(openspecPath, 'specs'), { recursive: true });
      await fs.mkdir(path.join(openspecPath, 'changes'), { recursive: true });
      
      vi.mocked(prompts.checkbox).mockResolvedValue(['cursor']);
      
      // Should not throw - it enters extend mode
      await expect(initCommand.execute(testDir)).resolves.not.toThrow();
    });

    it('should skip creating directory structure in extend mode', async () => {
      const openspecPath = path.join(testDir, 'openspec');
      await fs.mkdir(openspecPath, { recursive: true });
      
      vi.mocked(prompts.checkbox).mockResolvedValue(['cursor']);
      await initCommand.execute(testDir);
      
      // openspec/ exists but only because we created it, init skips recreating
      // Cursor files should be created
      const cursorProposal = path.join(testDir, '.cursor/commands/openspec-proposal.md');
      expect(await fileExists(cursorProposal)).toBe(true);
    });

    it('should configure new tool when one is already present', async () => {
      // Set up: Claude is already configured
      const openspecPath = path.join(testDir, 'openspec');
      await fs.mkdir(openspecPath, { recursive: true });
      await fs.mkdir(path.join(openspecPath, 'specs'), { recursive: true });
      
      // Create CLAUDE.md to simulate existing Claude config
      await fs.writeFile(path.join(testDir, 'CLAUDE.md'), '# Existing Claude config');

      // User selects cursor (new tool)
      vi.mocked(prompts.checkbox).mockResolvedValue(['cursor']);
      await initCommand.execute(testDir);

      // Cursor files should be created
      const cursorProposal = path.join(testDir, '.cursor/commands/openspec-proposal.md');
      expect(await fileExists(cursorProposal)).toBe(true);

      // CLAUDE.md should still exist (unmodified since cursor was selected)
      expect(await fileExists(path.join(testDir, 'CLAUDE.md'))).toBe(true);
    });

    it('should return gracefully when user declines to add any tools in extend mode', async () => {
      const openspecPath = path.join(testDir, 'openspec');
      await fs.mkdir(openspecPath, { recursive: true });

      // User selects nothing (simulates declining)
      vi.mocked(prompts.checkbox).mockResolvedValue([]);
      
      const logSpy = vi.spyOn(console, 'log');
      await expect(initCommand.execute(testDir)).resolves.not.toThrow();
      
      const calls = logSpy.mock.calls.flat().join('\n');
      expect(calls).toContain('already initialized');
    });

    it('should allow refreshing an already-configured tool', async () => {
      const openspecPath = path.join(testDir, 'openspec');
      await fs.mkdir(openspecPath, { recursive: true });
      
      // Simulate Claude being configured
      await fs.writeFile(path.join(testDir, 'CLAUDE.md'), '# Existing');
      
      // User selects Claude again (should refresh)
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);

      await initCommand.execute(testDir);

      // CLAUDE.md should be updated with markers (refreshed)
      const claudeContent = await fs.readFile(path.join(testDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeContent).toContain('<!-- OPENSPEC:START -->');
      expect(claudeContent).toContain('OpenSpec Project');
    });
  });

  describe('AI tool selection', () => {
    it('should prompt for AI tool selection using checkbox', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      
      await initCommand.execute(testDir);
      
      expect(prompts.checkbox).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.any(String),
        })
      );
    });

    it('should handle different AI tool selections', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['claude']);
      
      await initCommand.execute(testDir);
      
      const claudePath = path.join(testDir, 'CLAUDE.md');
      expect(await fileExists(claudePath)).toBe(true);
    });

    it('should handle cursor tool selection without existing CLAUDE.md', async () => {
      vi.mocked(prompts.checkbox).mockResolvedValue(['cursor']);
      
      await initCommand.execute(testDir);
      
      // CLAUDE.md should NOT be created
      const claudePath = path.join(testDir, 'CLAUDE.md');
      expect(await fileExists(claudePath)).toBe(false);
      
      // Cursor files should be created
      const cursorProposal = path.join(testDir, '.cursor/commands/openspec-proposal.md');
      expect(await fileExists(cursorProposal)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should provide helpful error for insufficient permissions', async () => {
      const readOnlyDir = path.join(testDir, 'readonly');
      await fs.mkdir(readOnlyDir);
      
      const originalCheck = fs.writeFile;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (filePath: any, ...args: any[]) => {
        if (typeof filePath === 'string' && filePath.includes('.openspec-test-')) {
          throw new Error('EACCES: permission denied');
        }
        return originalCheck.call(fs, filePath, ...args);
      });
      
      await expect(initCommand.execute(readOnlyDir)).rejects.toThrow(
        /Insufficient permissions/
      );
    });
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
