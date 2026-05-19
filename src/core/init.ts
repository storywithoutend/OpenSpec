import path from 'path';
import { select, checkbox } from '@inquirer/prompts';
import ora from 'ora';
import { FileSystemUtils } from '../utils/file-system.js';
import { TemplateManager, ProjectContext } from './templates/index.js';
import { ToolRegistry } from './configurators/registry.js';
import { SlashCommandRegistry } from './configurators/slash/registry.js';
import { AI_TOOLS, OPENSPEC_DIR_NAME } from './config.js';

export interface InitResult {
  created: string[];
  refreshed: string[];
  skipped: string[];
}

export class InitCommand {
  private isExtendMode = false;
  async execute(targetPath: string): Promise<InitResult> {
    const projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    // Validation happens silently in the background
    const initResult = await this.validate(projectPath, openspecPath);

    if (initResult) {
      // Extend mode - skip scaffolding, only configure tools
      this.isExtendMode = true;
      console.log();
      ora().info(`OpenSpec structure already exists at ${openspecPath}`);
      ora().succeed('Skipping core scaffolding, proceeding to AI tool configuration...');
      console.log();

      // Get tools to configure
      const selectedTools = await this.getToolSelection(true, projectPath);

      const result: InitResult = { created: [], refreshed: [], skipped: [] };
      await this.configureTools(projectPath, openspecDir, selectedTools, result);
      this.displaySummary(result);
      return result;
    }

    // Fresh init mode
    const config = await this.getConfiguration();

    // Step 1: Create directory structure
    const structureSpinner = ora({ text: 'Creating OpenSpec structure...', stream: process.stdout }).start();
    await this.createDirectoryStructure(openspecPath);
    await this.generateFiles(openspecPath, config.aiTools);
    structureSpinner.succeed('OpenSpec structure created');

    // Step 2: Configure AI tools
    const toolSpinner = ora({ text: 'Configuring AI tools...', stream: process.stdout }).start();
    const result: InitResult = { created: [], refreshed: [], skipped: [] };
    await this.configureTools(projectPath, openspecDir, config.aiTools, result);
    toolSpinner.succeed('AI tools configured');

    // Success message
    this.displaySuccessMessage(openspecDir, config.aiTools);
    return result;
  }

  private async validate(projectPath: string, openspecPath: string): Promise<boolean> {
    // Check if OpenSpec already exists - enter extend mode if so
    if (await FileSystemUtils.directoryExists(openspecPath)) {
      return true; // Signal extend mode
    }

    // Check write permissions
    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }

    return false; // Fresh init
  }

  private async getToolSelection(isExtendMode: boolean, projectPath?: string): Promise<string[]> {
    if (isExtendMode) {
      // Detect already configured tools
      const configuredTools = await this.detectConfiguredTools(projectPath);
      
      const choices = AI_TOOLS.map(tool => {
        const isConfigured = configuredTools.includes(tool.value);
        const label = isConfigured 
          ? `${tool.name} (already configured)`
          : tool.available 
            ? tool.name
            : `${tool.name} (coming soon)`;
        
        return {
          name: label,
          value: tool.value,
          checked: isConfigured,
          disabled: !tool.available ? true : undefined
        };
      });

      const selected = await checkbox({
        message: 'Select AI tools to configure (space to toggle):',
        choices
      });

      // Return only newly selected tools (not already configured)
      return selected.filter(tool => !configuredTools.includes(tool));
    } else {
      // Fresh init - single select
      const config: { aiTools: string[] } = { aiTools: [] };
      const selectedTool = await select({
        message: 'Which AI tool do you use?',
        choices: AI_TOOLS.map(tool => ({
          name: tool.available ? tool.name : `${tool.name} (coming soon)`,
          value: tool.value,
          disabled: !tool.available
        }))
      });
      config.aiTools = [selectedTool as string];
      return config.aiTools;
    }
  }

  private async detectConfiguredTools(projectPath: string): Promise<string[]> {
    const configured: string[] = [];
    
    // Check for each tool's config file
    for (const tool of AI_TOOLS) {
      const configurator = ToolRegistry.get(tool.value);
      if (configurator) {
        // Resolve path relative to projectPath, not cwd
        const toolPath = path.join(projectPath, configurator.configFileName);
        if (await FileSystemUtils.fileExists(toolPath)) {
          configured.push(tool.value);
        }
      }
      
      // Also check slash command directories
      const slashConfigurator = SlashCommandRegistry.get(tool.value);
      if (slashConfigurator) {
        const targets = slashConfigurator.getTargets();
        if (targets.length > 0) {
          const firstTarget = targets[0];
          const slashPath = path.join(projectPath, firstTarget.path);
          if (await FileSystemUtils.fileExists(slashPath)) {
            if (!configured.includes(tool.value)) {
              configured.push(tool.value);
            }
          }
        }
      }
    }
    
    return configured;
  }

  private async getConfiguration(): Promise<{ aiTools: string[] }> {
    const config: { aiTools: string[] } = { aiTools: [] };

    // Single-select for better UX
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

  private async generateFiles(openspecPath: string, aiTools: string[]): Promise<void> {
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

  private async configureTools(
    projectPath: string, 
    openspecDir: string, 
    toolIds: string[],
    result: InitResult
  ): Promise<void> {
    for (const toolId of toolIds) {
      const configurator = ToolRegistry.get(toolId);
      if (configurator && configurator.isAvailable) {
        await configurator.configure(projectPath, openspecDir);
        result.created.push(configurator.configFileName);
      }

      const slashConfigurator = SlashCommandRegistry.get(toolId);
      if (slashConfigurator && slashConfigurator.isAvailable) {
        const files = await slashConfigurator.generateAll(projectPath, openspecDir);
        result.created.push(...files);
      }
    }
  }

  private displaySuccessMessage(openspecDir: string, aiTools: string[]): void {
    console.log(); // Empty line for spacing
    ora().succeed('OpenSpec initialized successfully!');
    
    // Get the selected tool name for display
    const selectedToolId = aiTools[0];
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

  private displaySummary(result: InitResult): void {
    console.log();
    ora().succeed('AI tool configuration complete!');
    
    console.log('\nSummary:');
    if (result.created.length > 0) {
      console.log(`  Created: ${result.created.join(', ')}`);
    }
    if (result.refreshed.length > 0) {
      console.log(`  Refreshed: ${result.refreshed.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  Skipped: ${result.skipped.join(', ')}`);
    }
    
    console.log('\nUse `openspec update` to update shared content like AGENTS.md and project.md');
  }
}
