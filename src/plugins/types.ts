import type { ModLoaderAdapter } from '../core/types.js';
import type { MappingProvider } from '../mappings/types.js';
import type { Diagnostic } from '../core/types.js';

export type PluginKind = 'loader' | 'mappings' | 'toolchain' | 'compiler' | 'remapper' | 'dependency' | 'validator';

export interface ValidatorContext {
  artifactPath: string;
  buildContext: import('../core/types.js').BuildContext;
}

export interface ValidatorPlugin {
  id: string;
  validate(context: ValidatorContext): Promise<Diagnostic[]>;
}

export interface PluginDescriptor {
  id: string;
  displayName: string;
  kind: PluginKind;
  version: string;
  capabilities: string[];
}

export interface PluginRegistration {
  descriptor: PluginDescriptor;
  adapter?: ModLoaderAdapter;
  mappingProvider?: MappingProvider;
  validator?: ValidatorPlugin;
  activate?(): Promise<void> | void;
}

export interface PluginModuleShape {
  name?: string;
  version?: string;
  capabilities?: string[];
  description?: string;
  adapters?: ModLoaderAdapter[];
  mappingProviders?: MappingProvider[];
  validators?: ValidatorPlugin[];
  activate?: () => Promise<void> | void;
}