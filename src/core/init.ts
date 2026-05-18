import path from 'path';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import { FileSystemUtils } from '../utils/file-system.js';
import { TemplateManager, ProjectContext } from './templates/index.js';
import { ToolRegistry } from './configurators/registry.js';
import { SlashCommandRegistry } from './configurators/slash/registry.js';
import { OpenSpecConfig, AI_TOOLS, OPENSPEC_DIR_NAME } from './config.js';

interface ConfigureToolResult {
  toolId: string;
  toolName: string;
  status: 'created' | 'refreshed' | 'skipped';
}

export class InitCommand {
  async execute(targetPath: string): Promise<void> {
    const projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    // Check if OpenSpec already exists
    const alreadyInitialized = await FileSystemUtils.directoryExists(openspecPath);

    if (alreadyInitialized) {
      await this.executeExtend(projectPath, openspecPath);
    } else {
      await this.executeFresh(projectPath, openspecPath);
    }
  }

  private async executeFresh(projectPath: string, openspecPath: string): Promise<void> {
    // Check write permissions
    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }

    // Get configuration (after validation to avoid prompts if validation fails)
    const config = await this.getConfiguration([]);

    // Step 1: Create directory structure
    const structureSpinner = ora({ text: 'Creating OpenSpec structure...', stream: process.stdout }).start();
    await this.createDirectoryStructure(openspecPath);
    await this.generateFiles(openspecPath, config);
    structureSpinner.succeed('OpenSpec structure created');

    // Step 2: Configure AI tools
    const toolSpinner = ora({ text: 'Configuring AI tools...', stream: process.stdout }).start();
    await this.configureAITools(projectPath, OPENSPEC_DIR_NAME, config.aiTools);
    toolSpinner.succeed('AI tools configured');

    // Success message
    this.displaySuccessMessage(OPENSPEC_DIR_NAME, config);
  }

  private async executeExtend(projectPath: string, openspecPath: string): Promise<void> {
    // Still protect against missing write permissions
    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }

    console.log();
    ora().info('OpenSpec is already initialized. Skipping structure creation.');
    console.log('You can add configuration for additional AI tools.\n');

    // Detect which tools are already configured
    const alreadyConfigured = await this.detectConfiguredTools(projectPath);

    // Get configuration, showing already-configured tools
    const config = await this.getConfiguration(alreadyConfigured);

    if (config.aiTools.length === 0) {
      throw new Error(
        `OpenSpec seems to already be initialized at ${openspecPath}.\n` +
        `Use 'openspec update' to update the structure.`
      );
    }

    // Configure selected tools with tracking
    const toolSpinner = ora({ text: 'Configuring AI tools...', stream: process.stdout }).start();
    const results = await this.configureAIToolsWithTracking(
      projectPath, OPENSPEC_DIR_NAME, config.aiTools, alreadyConfigured
    );
    toolSpinner.succeed('AI tools configured');

    // Summary
    this.displayExtendSummary(results);
  }

  private async detectConfiguredTools(projectPath: string): Promise<string[]> {
    const configured: string[] = [];

    for (const tool of AI_TOOLS) {
      if (!tool.available) continue;

      const configurator = ToolRegistry.get(tool.value);
      if (configurator && await configurator.isConfigured(projectPath)) {
        if (!configured.includes(tool.value)) {
          configured.push(tool.value);
        }
      }

      const slashConfigurator = SlashCommandRegistry.get(tool.value);
      if (slashConfigurator && await slashConfigurator.isConfigured(projectPath)) {
        if (!configured.includes(tool.value)) {
          configured.push(tool.value);
        }
      }
    }

    return configured;
  }

  private async getConfiguration(alreadyConfigured: string[]): Promise<OpenSpecConfig> {
    const config: OpenSpecConfig = {
      aiTools: []
    };

    // Single-select for better UX
    const selectedTool = await select({
      message: 'Which AI tool do you use?',
      choices: AI_TOOLS.map(tool => {
        const isConfigured = alreadyConfigured.includes(tool.value);
        const configuredLabel = isConfigured ? ' (already configured)' : '';
        return {
          name: tool.available
            ? `${tool.name}${configuredLabel}`
            : `${tool.name} (coming soon)`,
          value: tool.value,
          disabled: !tool.available
        };
      })
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

  private async configureAIToolsWithTracking(
    projectPath: string,
    openspecDir: string,
    toolIds: string[],
    alreadyConfigured: string[]
  ): Promise<ConfigureToolResult[]> {
    const results: ConfigureToolResult[] = [];

    for (const toolId of toolIds) {
      const toolInfo = AI_TOOLS.find(t => t.value === toolId);
      const toolName = toolInfo ? toolInfo.name : toolId;
      const wasConfigured = alreadyConfigured.includes(toolId);

      const configurator = ToolRegistry.get(toolId);
      if (configurator && configurator.isAvailable) {
        await configurator.configure(projectPath, openspecDir);
      }

      const slashConfigurator = SlashCommandRegistry.get(toolId);
      if (slashConfigurator && slashConfigurator.isAvailable) {
        await slashConfigurator.generateAll(projectPath, openspecDir);
      }

      results.push({
        toolId,
        toolName,
        status: wasConfigured ? 'refreshed' : 'created'
      });
    }

    return results;
  }

  private displayExtendSummary(results: ConfigureToolResult[]): void {
    console.log();
    console.log('── Summary ──');

    const created = results.filter(r => r.status === 'created');
    const refreshed = results.filter(r => r.status === 'refreshed');

    for (const result of created) {
      ora().succeed(`Created ${result.toolName} configuration`);
    }
    for (const result of refreshed) {
      ora().succeed(`Refreshed ${result.toolName} configuration`);
    }

    // Show skipped (already configured but not selected)
    console.log();
    console.log(
      'Future updates to shared content still come from \'openspec update\'.'
    );

    if (created.length > 0) {
      const toolName = created[0].toolName;
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
