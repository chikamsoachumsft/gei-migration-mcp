import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface MigrationRecord {
  id: string;
  sourceOrg: string;
  targetOrg: string;
  repoName: string;
  state: string;
  startedAt: string;
  completedAt?: string;
  source: "github" | "ado";
}

interface StateData {
  activeMigrations: MigrationRecord[];
  migrationHistory: MigrationRecord[];
  migrationSources: Record<string, string>; // key: sourceOrgUrl, value: migrationSourceId
}

const STATE_DIR = path.join(os.homedir(), ".gei-mcp");
const STATE_FILE = path.join(STATE_DIR, "state.json");

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadState(): StateData {
  ensureStateDir();
  if (!fs.existsSync(STATE_FILE)) {
    return { activeMigrations: [], migrationHistory: [], migrationSources: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function saveState(state: StateData): void {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function addActiveMigration(migration: MigrationRecord): void {
  const state = loadState();
  state.activeMigrations.push(migration);
  saveState(state);
}

export function updateMigrationState(id: string, newState: string): void {
  const state = loadState();
  const migration = state.activeMigrations.find(m => m.id === id);
  if (migration) {
    migration.state = newState;
    if (["SUCCEEDED", "FAILED", "FAILED_VALIDATION"].includes(newState)) {
      migration.completedAt = new Date().toISOString();
      state.migrationHistory.push(migration);
      state.activeMigrations = state.activeMigrations.filter(m => m.id !== id);
    }
  }
  saveState(state);
}

export function getActiveMigrations(): MigrationRecord[] {
  return loadState().activeMigrations;
}

export function getMigrationHistory(): MigrationRecord[] {
  return loadState().migrationHistory;
}

export function saveMigrationSource(sourceOrgUrl: string, migrationSourceId: string): void {
  const state = loadState();
  state.migrationSources[sourceOrgUrl] = migrationSourceId;
  saveState(state);
}

export function getMigrationSource(sourceOrgUrl: string): string | undefined {
  const state = loadState();
  return state.migrationSources[sourceOrgUrl];
}
