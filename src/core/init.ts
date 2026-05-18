import path from 'path';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import { FileSystemUtils } from '../utils/file-system.js';
import { TemplateManager, ProjectContext } from './templates/index.js';
import { ToolRegistry } from './configurators/registry.js';
import { SlashCommandRegistry } from './configurators/slash/registry.js';
import { OpenSpecConfig, AI_TOOLS, OPENSPEC_DIR_NAME, OPENSPEC_MARKERS } from './config.js';

const SKIP_SENTINEL = '__openspec_skip__';

export class InitCommand {
  async execute(targetPath: string): Promise<void> {
    const projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    const extendMode = await FileSystemUtils.directoryExists(openspecPath);

    if (!await FileSystemUtils.ensureWritePermissions(projectPath)) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }

    if (extendMode) {
      console.log(`OpenSpec is already initialized at ${openspecPath}.`);
      console.log('Skipping base structure; this command will only manage AI tool configuration files.\n');
    }

    const configuredTools = extendMode
      ? await this.detectConfiguredTools(projectPath)
      : new Set<string>();

    const config = await this.getConfiguration(extendMode, configuredTools);

    if (config.aiTools.length === 0) {
      throw new Error(
        `OpenSpec seems to already be initialized at ${openspecPath}.\n` +
        `Use 'openspec update' to update the structure.`
      );
    }

    if (!extendMode) {
      const structureSpinner = ora({ text: 'Creating OpenSpec structure...', stream: process.stdout }).start();
      await this.createDirectoryStructure(openspecPath);
      await this.generateFiles(openspecPath, config);
      structureSpinner.succeed('OpenSpec structure created');
    }

    const selectedToolId = config.aiTools[0];
    const wasAlreadyConfigured = extendMode && configuredTools.has(selectedToolId);
    const toolSpinner = ora({
      text: wasAlreadyConfigured ? 'Refreshing AI tool files...' : 'Configuring AI tools...',
      stream: process.stdout
    }).start();
    await this.configureAITools(projectPath, openspecDir, config.aiTools);
    toolSpinner.succeed(wasAlreadyConfigured ? 'AI tool files refreshed' : 'AI tools configured');

    this.displaySuccessMessage(openspecDir, config, { extendMode, wasAlreadyConfigured });
  }

  private async detectConfiguredTools(projectPath: string): Promise<Set<string>> {
    const configured = new Set<string>();

    for (const tool of AI_TOOLS) {
      if (!tool.available) continue;

      const configurator = ToolRegistry.get(tool.value);
      if (configurator && configurator.isAvailable) {
        const filePath = path.join(projectPath, configurator.configFileName);
        if (await FileSystemUtils.fileExists(filePath)) {
          const content = await FileSystemUtils.readFile(filePath);
          if (content.includes(OPENSPEC_MARKERS.start)) {
            configured.add(tool.value);
            continue;
          }
        }
      }

      const slashConfigurator = SlashCommandRegistry.get(tool.value);
      if (slashConfigurator && slashConfigurator.isAvailable) {
        for (const target of slashConfigurator.getTargets()) {
          if (await FileSystemUtils.fileExists(path.join(projectPath, target.path))) {
            configured.add(tool.value);
            break;
          }
        }
      }
    }

    return configured;
  }

  private async getConfiguration(
    extendMode: boolean,
    configuredTools: Set<string>
  ): Promise<OpenSpecConfig> {
    const config: OpenSpecConfig = {
      aiTools: []
    };

    const choices: Array<{ name: string; value: string; disabled: boolean }> = AI_TOOLS.map(tool => {
      let label = tool.name;
      if (!tool.available) {
        label += ' (coming soon)';
      } else if (extendMode && configuredTools.has(tool.value)) {
        label += ' (already configured — selecting will refresh files)';
      }
      return {
        name: label,
        value: tool.value,
        disabled: !tool.available
      };
    });

    if (extendMode) {
      choices.push({
        name: "Skip — don't add anything",
        value: SKIP_SENTINEL,
        disabled: false
      });
    }

    const selectedTool = await select({
      message: extendMode
        ? 'Which AI tool would you like to add or refresh?'
        : 'Which AI tool do you use?',
      choices
    });

    if (selectedTool !== SKIP_SENTINEL) {
      config.aiTools = [selectedTool as string];
    }

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

  private displaySuccessMessage(
    openspecDir: string,
    config: OpenSpecConfig,
    opts: { extendMode: boolean; wasAlreadyConfigured: boolean }
  ): void {
    console.log(); // Empty line for spacing

    const selectedToolId = config.aiTools[0];
    const selectedTool = AI_TOOLS.find(t => t.value === selectedToolId);
    const toolName = selectedTool ? selectedTool.name : 'your AI assistant';

    if (opts.extendMode) {
      if (opts.wasAlreadyConfigured) {
        ora().succeed(`Refreshed ${toolName} configuration`);
      } else {
        ora().succeed(`Added ${toolName} configuration to existing OpenSpec project`);
      }
      console.log(`\nShared OpenSpec content is still managed via 'openspec update'.\n`);
      return;
    }

    ora().succeed('OpenSpec initialized successfully!');

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
