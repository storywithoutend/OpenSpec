export interface ToolConfigurator {
  name: string;
  configFileName: string;
  isAvailable: boolean;
  isConfigured(projectPath: string): Promise<boolean>;
  configure(projectPath: string, openspecDir: string): Promise<void>;
}