import path from 'path';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import { FileSystemUtils } from '../utils/file-system.js';
import { TemplateManager, ProjectContext } from './templates/index.js';
import { ToolRegistry } from './configurators/registry.js';
import { SlashCommandRegistry } from './configurators/slash/registry.js';
import { OpenSpecConfig, AI_TOOLS, OPENSPEC_DIR_NAME } from './config.js';

export class InitCommand {
  async execute(targetPath: string): Promise<void> {
    const projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    const extending = await FileSystemUtils.directoryExists(openspecPath);

    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }

    if (extending) {
      ora({ stream: process.stdout }).info(
        'OpenSpec is already initialized. Skipping core scaffolding — only AI tool configuration will be updated.'
      );
    }

    const configuredTools = extending ? await this.detectConfiguredTools(projectPath) : [];
    const config = await this.getConfiguration(extending, configuredTools, openspecPath);

    if (!extending) {
      const structureSpinner = ora({ text: 'Creating OpenSpec structure...', stream: process.stdout }).start();
      await this.createDirectoryStructure(openspecPath);
      await this.generateFiles(openspecPath, config);
      structureSpinner.succeed('OpenSpec structure created');
    }

    const toolSpinner = ora({ text: 'Configuring AI tools...', stream: process.stdout }).start();
    await this.configureAITools(projectPath, openspecDir, config.aiTools);
    toolSpinner.succeed('AI tools configured');

    if (extending) {
      this.displayExtendSummary(config, configuredTools);
    } else {
      this.displaySuccessMessage(openspecDir, config);
    }
  }

  private async detectConfiguredTools(projectPath: string): Promise<string[]> {
    const configured: string[] = [];
    for (const tool of AI_TOOLS) {
      if (!tool.available) continue;
      const slashConfigurator = SlashCommandRegistry.get(tool.value);
      if (slashConfigurator) {
        const targets = slashConfigurator.getTargets();
        if (targets.length > 0 && await FileSystemUtils.fileExists(path.join(projectPath, targets[0].path))) {
          configured.push(tool.value);
        }
      }
    }
    return configured;
  }

  private async getConfiguration(extending: boolean, configuredTools: string[], openspecPath: string): Promise<OpenSpecConfig> {
    const config: OpenSpecConfig = {
      aiTools: []
    };

    const choices: Array<{ name: string; value: string; disabled: boolean }> = AI_TOOLS.map(tool => {
      const isConfigured = configuredTools.includes(tool.value);
      let name = tool.name;
      if (!tool.available) {
        name += ' (coming soon)';
      } else if (extending && isConfigured) {
        name += ' (already configured)';
      }
      return {
        name,
        value: tool.value,
        disabled: !tool.available
      };
    });

    if (extending) {
      choices.push({ name: 'None — keep current configuration', value: 'none', disabled: false });
    }

    const selectedTool = await select({
      message: extending ? 'Which AI tool would you like to add?' : 'Which AI tool do you use?',
      choices
    });

    if (selectedTool === 'none') {
      throw new Error(
        `OpenSpec seems to already be initialized at ${openspecPath}.\n` +
        `Use 'openspec update' to update the structure.`
      );
    }

    config.aiTools = [selectedTool as string];

    return config;
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

  private async configureAITools(projectPath: string, openspecDir: string, toolIds: string[]): Promise<void> {
    for (const toolId of toolIds) {
      const configurator = ToolRegistry.get(toolId);
      if (configurator && configurator.isAvailable) {
        await configurator.configure(projectPath, openspecDir);
      }

      const slashConfigurator = SlashCommandRegistry.get(toolId);
      if (slashConfigurator && slashConfigurator.isAvailable) {
        await slashConfigurator.generateAll(projectPath, openspecDir);
      }
    }
  }

  private displayExtendSummary(config: OpenSpecConfig, configuredTools: string[]): void {
    console.log();
    ora().succeed('AI tool configuration updated!');

    const selectedToolId = config.aiTools[0];
    const selectedTool = AI_TOOLS.find(t => t.value === selectedToolId);
    const wasConfigured = configuredTools.includes(selectedToolId);

    console.log();
    if (wasConfigured) {
      console.log(`  Refreshed: ${selectedTool?.name ?? selectedToolId}`);
    } else {
      console.log(`  Created: ${selectedTool?.name ?? selectedToolId}`);
    }

    const skippedTools = AI_TOOLS
      .filter(t => t.available && t.value !== selectedToolId && configuredTools.includes(t.value));
    for (const skipped of skippedTools) {
      console.log(`  Skipped: ${skipped.name} (unchanged)`);
    }

    console.log(`\nUse 'openspec update' to update shared content across all configured tools.\n`);
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
}
