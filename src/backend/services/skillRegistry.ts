import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SkillRecord } from "../../shared/types";

interface SkillManifest {
  id?: string;
  name?: string;
  description?: string;
}

export class SkillRegistry {
  constructor(private readonly skillsRoot = path.resolve(process.cwd(), "skills")) {}

  list(): SkillRecord[] {
    if (!existsSync(this.skillsRoot)) {
      return [];
    }
    return readdirSync(this.skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readSkill(entry.name))
      .filter((skill): skill is SkillRecord => Boolean(skill));
  }

  get(id: string | undefined): SkillRecord | undefined {
    if (!id) {
      return undefined;
    }
    return this.list().find((skill) => skill.id === id);
  }

  private readSkill(folderName: string): SkillRecord | null {
    const folder = path.join(this.skillsRoot, folderName);
    const manifestPath = path.join(folder, "skill.json");
    const readmePath = path.join(folder, "README.md");
    if (!existsSync(manifestPath)) {
      return null;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SkillManifest;
    const instructions = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
    return {
      id: manifest.id ?? folderName,
      name: manifest.name ?? folderName,
      description: manifest.description ?? "",
      instructions
    };
  }
}
