import type { AppConfig } from '../config/index.js';

export interface Project {
  name: string;
  path: string;
}

/**
 * ProjectsRepo: reads from config only — no DB table per ADR 001 Addendum A3.
 * The `projects` SQLite table is NOT created; config is the sole source of truth.
 */
export class ProjectsRepo {
  private readonly projects: ReadonlyArray<Project>;

  constructor(cfg: AppConfig) {
    this.projects = cfg.projects.map((p) => ({ name: p.name, path: p.path }));
  }

  list(): ReadonlyArray<Project> {
    return this.projects;
  }

  findByName(name: string): Project | undefined {
    return this.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  findByPath(projectPath: string): Project | undefined {
    return this.projects.find((p) => p.path === projectPath);
  }
}
