import path from 'path';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import { FileSystemUtils } from '../utils/file-system.js';
import { TemplateManager, ProjectContext } from './templates/index.js';
import { ToolRegistry } from './configurators/registry.js';
import { SlashCommandRegistry } from './configurators/slash/registry.js';
import { OpenSpecConfig, AI_TOOLS, OPENSPEC_DIR_NAME } from './config.js';

export class InitCommand {
  private isExtendMode = false;
  private projectPath = '';

  async execute(targetPath: string): Promise<void> {
    this.projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(this.projectPath, openspecDir);

    // Validation happens silently in the background
    await this.validate(this.projectPath, openspecPath);

    // Get configuration (after validation to avoid prompts if validation fails)
    const config = await this.getConfiguration();

    // Step 1: Create directory structure (skip in extend mode)
    if (!this.isExtendMode) {
      const structureSpinner = ora({ text: 'Creating OpenSpec structure...', stream: process.stdout }).start();
      await this.createDirectoryStructure(openspecPath);
      await this.generateFiles(openspecPath, config);
      structureSpinner.succeed('OpenSpec structure created');
    }

    // Step 2: Configure AI tools
    if (config.aiTools.length === 0) {
      // User declined to add any tools in extend mode
      throw new Error(
        `OpenSpec seems to already be initialized at ${openspecPath}.\n` +
        `Use 'openspec update' to update the structure.`
      );
    }

    const toolSpinner = ora({ text: 'Configuring AI tools...', stream: process.stdout }).start();
    const toolResults = await this.configureAITools(this.projectPath, openspecDir, config.aiTools);
    toolSpinner.succeed('AI tools configured');

    // Success message
    this.displaySuccessMessage(openspecDir, config, toolResults);
  }

  private async validate(projectPath: string, openspecPath: string): Promise<void> {
    // Check if OpenSpec already exists → enter extend mode
    if (await FileSystemUtils.directoryExists(openspecPath)) {
      this.isExtendMode = true;
      console.log('OpenSpec structure already exists. Entering extend mode — only AI tool configuration will be managed.');
    }

    // Check write permissions (needed in both modes)
    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }
  }

  private async getConfiguration(): Promise<OpenSpecConfig> {
    const config: OpenSpecConfig = {
      aiTools: []
    };

    // Determine which tools are already configured
    const configuredTools = this.isExtendMode ? await this.getDetectedConfiguredTools() : new Set<string>();

    const choices = AI_TOOLS.map(tool => {
      const isConfigured = configuredTools.has(tool.value);
      const suffix = isConfigured ? ' (already configured)' : '';
      const name = tool.available ? `${tool.name}${suffix}` : `${tool.name} (coming soon)`;
      return {
        name,
        value: tool.value,
        disabled: !tool.available
      };
    });

    // In extend mode, offer a way to decline adding new tools
    if (this.isExtendMode) {
      choices.push({
        name: 'None — exit without changes',
        value: '_none',
        disabled: false
      });
    }

    const selectedTool = await select({
      message: this.isExtendMode
        ? 'Which AI tool do you want to add? (already configured tools are marked)'
        : 'Which AI tool do you use?',
      choices
    });

    if (selectedTool === '_none') {
      config.aiTools = [];
    } else {
      config.aiTools = [selectedTool as string];
    }

    return config;
  }

  private async getDetectedConfiguredTools(): Promise<Set<string>> {
    const configured = new Set<string>();
    for (const tool of AI_TOOLS) {
      if (!tool.available) continue;
      if (await this.isToolAlreadyConfigured(this.projectPath, tool.value)) {
        configured.add(tool.value);
      }
    }
    return configured;
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

  private async configureAITools(projectPath: string, openspecDir: string, toolIds: string[]): Promise<{ created: string[]; refreshed: string[]; skipped: string[] }> {
    const created: string[] = [];
    const refreshed: string[] = [];
    const skipped: string[] = [];

    for (const toolId of toolIds) {
      // Check if this tool's files already exist (refresh vs create)
      const isAlreadyConfigured = await this.isToolAlreadyConfigured(projectPath, toolId);

      const configurator = ToolRegistry.get(toolId);
      if (configurator && configurator.isAvailable) {
        await configurator.configure(projectPath, openspecDir);
        if (isAlreadyConfigured) {
          refreshed.push(configurator.name);
        } else {
          created.push(configurator.name);
        }
      }

      const slashConfigurator = SlashCommandRegistry.get(toolId);
      if (slashConfigurator && slashConfigurator.isAvailable) {
        await slashConfigurator.generateAll(projectPath, openspecDir);
        const toolName = AI_TOOLS.find(t => t.value === toolId)?.name ?? toolId;
        if (isAlreadyConfigured) {
          refreshed.push(`${toolName} commands`);
        } else {
          created.push(`${toolName} commands`);
        }
      }
    }

    // Track tools that were not selected
    for (const tool of AI_TOOLS) {
      if (!tool.available || toolIds.includes(tool.value)) continue;
      if (await this.isToolAlreadyConfigured(projectPath, tool.value)) {
        skipped.push(tool.name);
      }
    }

    return { created, refreshed, skipped };
  }

  private async isToolAlreadyConfigured(projectPath: string, toolId: string): Promise<boolean> {
    const configurator = ToolRegistry.get(toolId);
    if (configurator) {
      const configPath = path.join(projectPath, configurator.configFileName);
      return await FileSystemUtils.fileExists(configPath);
    }
    return false;
  }

  private displaySuccessMessage(openspecDir: string, config: OpenSpecConfig, toolResults: { created: string[]; refreshed: string[]; skipped: string[] }): void {
    console.log(); // Empty line for spacing
    ora().succeed('OpenSpec initialized successfully!');

    // Show summary of tool results
    if (this.isExtendMode) {
      if (toolResults.created.length > 0) {
        console.log(`  Created: ${toolResults.created.join(', ')}`);
      }
      if (toolResults.refreshed.length > 0) {
        console.log(`  Refreshed: ${toolResults.refreshed.join(', ')}`);
      }
      if (toolResults.skipped.length > 0) {
        console.log(`  Skipped: ${toolResults.skipped.join(', ')}`);
      }
      console.log('\nUse \'openspec update\' to refresh shared content in the future.');
    } else {
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
}
