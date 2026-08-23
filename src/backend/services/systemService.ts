import type { AgentAdapterRecord, SettingRecord } from "../../shared/types";
import { db } from "../db";
import { AgentAdapterRepository, SettingRepository } from "../repositories";

export interface SchemaMigrationRecord {
  id: string;
  name: string;
  appliedAt: string;
}

export class SystemService {
  constructor(
    private readonly adapters: AgentAdapterRepository,
    private readonly settings: SettingRepository
  ) {}

  agentAdapters(): AgentAdapterRecord[] {
    return this.adapters.list();
  }

  settingsList(): SettingRecord[] {
    return this.settings.list();
  }

  setSetting(input: { key?: string; value?: unknown }): SettingRecord {
    if (!input.key?.trim()) {
      throw new Error("Setting key is required");
    }
    return this.settings.set(input.key.trim(), input.value ?? null);
  }

  migrations(): SchemaMigrationRecord[] {
    return db
      .prepare(`SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC`)
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        appliedAt: row.applied_at
      }));
  }
}
