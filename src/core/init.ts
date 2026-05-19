import path from 'path';
import { select, checkbox } from '@inquirer/prompts';
import ora from 'ora';
import { FileSystemUtils } from '../utils/file-system.js';
import { TemplateManager, ProjectContext } from './templates/index.js';
import { ToolRegistry } from './configurators/registry.js';
import { SlashCommandRegistry } from './configurators/slash/registry.js';
import { OpenSpecConfig, AI_TOOLS, OPENSPEC_DIR_NAME } from './config.js';

type ToolStatus = 'created' | 'refreshed';

interface ToolSummary {
  cliTool: string;
  files: string[];
  status: ToolStatus;
}

function getToolDisplayName(toolId: string): string {
  const tool = AI_TOOLS.find(t => t.value === toolId);
  return tool ? tool.name : toolId;
}

async function isToolAlreadyConfigured(projectPath: string, toolId: string): Promise<boolean> {
  switch (toolId) {
    case 'claude':
      return FileSystemUtils.fileExists(path.join(projectPath, 'CLAUDE.md'));
    case 'cursor':
      return FileSystemUtils.directoryExists(path.join(projectPath, '.cursor/commands/openspec'));
    default:
      // Fallback: check slash command targets
      return FileSystemUtils.directoryExists(path.join(projectPath, '.cursor', 'commands'));
  }
}

export class InitCommand {
  private extendMode = false;

  async execute(targetPath: string): Promise<void> {
    const projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    // Detection: extend or fresh mode
    this.extendMode = await FileSystemUtils.directoryExists(openspecPath);
    await this.validate(projectPath, openspecPath);

    // Get configuration (after validation to avoid prompts if validation fails)
    const config = await this.getConfiguration(projectPath);

    // In extend mode, guard against no new work requested
    if (this.extendMode && config.aiTools.length === 0) {
      console.log(
        `\nOpenSpec is already initialized and no additional tools were selected.\n` +
        `Use 'openspec update' to refresh existing instruction files.`
      );
      return;
    }

    // Step 1: Create directory structure (skip in extend mode)
    const structureSpinner = ora({ text: 'Creating OpenSpec structure...', stream: process.stdout }).start();
    if (!this.extendMode) {
      await this.createDirectoryStructure(openspecPath);
      await this.generateFiles(openspecPath, config);
      structureSpinner.succeed('OpenSpec structure created');
    } else {
      structureSpinner.succeed('OpenSpec structure already exists — skipping scaffolding');
    }

    // Step 2: Configure AI tools
    const toolSpinner = ora({ text: 'Configuring AI tools...', stream: process.stdout }).start();
    const summary = await this.configureAITools(projectPath, config.aiTools);
    toolSpinner.succeed('AI tools configured');

    // Success message
    if (this.extendMode) {
      this.displayExtendSummary(summary);
    } else {
      this.displaySuccessMessage(openspecDir, config);
    }
  }

  private async validate(projectPath: string, openspecPath: string): Promise<void> {
    if (!this.extendMode) {
      // Fresh mode: OpenSpec must NOT exist (checked above)
      if (await FileSystemUtils.directoryExists(openspecPath)) {
        throw new Error(
          `OpenSpec seems to already be initialized at ${openspecPath}.\n` +
          `Use 'openspec update' to update the structure.`
        );
      }
    }
    // Check write permissions (always)
    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }
  }

  private async getConfiguration(projectPath: string): Promise<OpenSpecConfig> {
    const config: OpenSpecConfig = {
      aiTools: []
    };

    const configuredTools = await this.getAlreadyConfiguredTools(projectPath);
    const availableTools = AI_TOOLS.filter(tool => tool.available);

    // Build choices indicating already-configured tools
    const choices = availableTools.map(tool => {
      const alreadyConfigured = configuredTools.has(tool.value);
      return {
        name: alreadyConfigured
          ? `${tool.name} (already configured)`
          : tool.name,
        value: tool.value,
        checked: false,
        disabled: false,
      };
    });

    // In extend mode, if no new tools available, skip prompt
    if (this.extendMode && choices.length === 0) {
      return config;
    }

    // Filter and potentially show prompt
    if (choices.length === 0) {
      // Fallback to select if no checkbox options
      const selectedTool = await select({
        message: 'Which AI tool do you use?',
        choices: AI_TOOLS.map(tool => ({
          name: tool.available ? tool.name : `${tool.name} (coming soon)`,
          value: tool.value,
          disabled: !tool.available
        }))
      });
      config.aiTools = [selectedTool as string];
      return config;
    }

    const selectedTools = await this.checkboxPrompt(
      this.extendMode
        ? 'Which AI tools do you want to configure?'
        : 'Which AI tool do you use?',
      choices,
      false
    );

    config.aiTools = Array.isArray(selectedTools) ? selectedTools : [selectedTools];

    return config;
  }

  private async getAlreadyConfiguredTools(projectPath: string): Promise<Set<string>> {
    const configured = new Set<string>();
    const availableTools = AI_TOOLS.filter(tool => tool.available);

    for (const tool of availableTools) {
      if (await isToolAlreadyConfigured(projectPath, tool.value)) {
        configured.add(tool.value);
      }
    }

    return configured;
  }

  private async checkboxPrompt(
    message: string,
    choices: { name: string; value: string; disabled?: boolean; checked?: boolean }[],
    loop = false
  ): Promise<string[]> {
    const result = await checkbox({ message, choices, loop });
    return Array.isArray(result) ? result : [result];
  }

  private async createDirectoryStructure(openspecPath: string): Promise<void> {
    const directories = [
      openspecPath,
      path.join(openspecPath, 'specs'),
      path.join(openspecPath, 'changes'),
      path.join(openspecPath, 'changes', 'archive')
    ];

    for (const dir of directories) {
      await FileSystemUtils.createDirectory(dir);
    }
  }

  private async generateFiles(openspecPath: string, config: OpenSpecConfig): Promise<void> {
    const context: ProjectContext = {
      // Could be enhanced with prompts for project details
    };

    const templates = TemplateManager.getTemplates(context);

    for (const template of templates) {
      const filePath = path.join(openspecPath, template.path);
      const content = typeof template.content === 'function'
        ? template.content(context)
        : template.content;

      await FileSystemUtils.writeFile(filePath, content);
    }
  }

  private async configureAITools(
    projectPath: string,
    toolIds: string[]
  ): Promise<ToolSummary[]> {
    const summary: ToolSummary[] = [];

    for (const toolId of toolIds) {
      const toolSummary: ToolSummary = {
        cliTool: getToolDisplayName(toolId),
        files: [],
        status: 'created'
      };

      const wasConfigured = await isToolAlreadyConfigured(projectPath, toolId);
      if (wasConfigured) {
        toolSummary.status = 'refreshed';
      }

      // Tool config files (e.g., CLAUDE.md)
      const configurator = ToolRegistry.get(toolId);
      if (configurator && configurator.isAvailable) {
        await configurator.configure(projectPath, OPENSPEC_DIR_NAME);
        toolSummary.files.push(configurator.configFileName);
      }

      // Slash command files
      const slashConfigurator = SlashCommandRegistry.get(toolId);
      if (slashConfigurator && slashConfigurator.isAvailable) {
        const createdFiles = await slashConfigurator.generateAll(projectPath, OPENSPEC_DIR_NAME);
        toolSummary.files.push(...createdFiles);
      }

      summary.push(toolSummary);
    }

    return summary;
  }

  private displaySuccessMessage(openspecDir: string, config: OpenSpecConfig): void {
    console.log(); // Empty line for spacing
    ora().succeed('OpenSpec initialized successfully!');

    // Get the selected tool name for display
    const selectedToolId = config.aiTools[0];
    const selectedTool = AI_TOOLS.find(t => t.value === selectedToolId);
    const toolName = selectedTool ? selectedTool.name : 'your AI assistant';

    console.log(`\nNext steps - Copy these prompts to ${toolName}:\n`);
    console.log('────────────────────────────────────────────────────────────');
    console.log('1. Populate your project context:');
    console.log('   "Please read openspec/project.md and help me fill it out');
    console.log('    with details about my project, tech stack, and conventions"\n');
    console.log('2. Create your first change proposal:');
    console.log('   "I want to add [YOUR FEATURE HERE]. Please create an');
    console.log('    OpenSpec change proposal for this feature"\n');
    console.log('3. Learn the OpenSpec workflow:');
    console.log('   "Please explain the OpenSpec workflow from openspec/AGENTS.md');
    console.log('    and how I should work with you on this project"');
    console.log('────────────────────────────────────────────────────────────\n');
  }

  private displayExtendSummary(summary: ToolSummary[]): void {
    console.log();

    // Group by status
    const created = summary.filter(s => s.status === 'created');
    const refreshed = summary.filter(s => s.status === 'refreshed');

    if (created.length > 0) {
      console.log('');
      for (const item of created) {
        console.log(`  ✓ ${item.cliTool} — configured`);
        for (const file of item.files) {
          console.log(`    ${file}`);
        }
      }
    }

    if (refreshed.length > 0) {
      console.log('');
      for (const item of refreshed) {
        console.log(`  ↻ ${item.cliTool} — refreshed`);
        for (const file of item.files) {
          console.log(`    ${file}`);
        }
      }
    }

    console.log('\nUse "openspec update" to refresh all instruction files in the future.\n');
    ora().succeed('OpenSpec extended successfully!');
  }
}
