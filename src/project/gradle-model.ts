export interface GradleDependencyBlock {
  configuration?: string;
  dependencies: string[];
  versionCatalogs: Record<string, string[]>;
  platformConstraints: string[];
  fileCollections: Array<{ notation: string; path?: string; jars: string[] }>;
}

export interface GradleRepositoryDescriptor {
  kind: string;
  url?: string;
  name?: string;
  contentFilter?: string;
  metadataSources?: string;
}

export interface GradlePluginDescriptor {
  id: string;
  version?: string;
  applyDeclaration?: string;
}

export interface GradlePropertyEntry {
  key: string;
  value: string;
}

export interface GradleProjectModel {
  buildSystem: 'gradle' | 'maven' | 'unknown';
  buildFiles: string[];
  settingsFiles: string[];
  propertyFiles: string[];
  wrapperVersion?: string;
  plugins: GradlePluginDescriptor[];
  repositories: GradleRepositoryDescriptor[];
  dependencies: GradleDependencyBlock;
  properties: Record<string, string>;
  sourceCompatibility?: number;
  targetCompatibility?: number;
  javaToolchain?: number;
  subprojects: string[];
  tasksOfInterest: string[];
  isMultiProject: boolean;
  buildDir?: string;
  libsDir?: string;
}

export interface MavenModel {
  groupId?: string;
  artifactId?: string;
  version?: string;
  packaging?: string;
  properties: Record<string, string>;
  dependencies: Array<{
    groupId: string;
    artifactId: string;
    version?: string;
    scope?: string;
    optional?: boolean;
  }>;
  repositories: Array<{ id: string; url: string }>;
  parent?: { groupId: string; artifactId: string; version?: string };
  buildSourceDirectory?: string;
  mavenCompilerSource?: string;
  mavenCompilerTarget?: string;
  profiles: Array<{ id: string; activation?: string }>;
}